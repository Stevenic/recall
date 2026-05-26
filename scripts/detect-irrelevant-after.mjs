#!/usr/bin/env node
/**
 * Detect Q&A pairs that need an `irrelevant_after` field.
 *
 * The pattern this catches:
 *   - Question is UNPINNED (no "as of YYYY-MM-DD", "in the first week",
 *     "on 2026-..", etc.) — phrased as if the answer is timeless.
 *   - Reference answer encodes a value that comes from EARLY in the
 *     question's relevant_days window.
 *   - Later in the corpus (beyond relevant_days), a different value
 *     appears for the same fact — i.e. the corpus revised it.
 *   - At checkpoints past the revision, the agent correctly surfaces
 *     the NEW value and "fails" against the now-stale reference.
 *
 * The fix is to add `irrelevant_after: <day before the revision>` so
 * the bench stops asking the question once the corpus has moved past
 * its premise. See packages/recall-bench/src/dataset.ts for how the
 * eligibility filter uses it.
 *
 * Approach:
 *   For each Q&A pair:
 *     1. Extract candidate "signature values" from the reference
 *        (numeric values like $250M, 2.8x, dates, named entities).
 *     2. For each signature value, scan dailies AFTER the pair's
 *        max(relevant_days) for a contradicting value of the same
 *        shape (e.g. a different $-amount near "leverage ceiling").
 *     3. If a credible contradiction is found, ask an LLM to confirm
 *        the contradiction is a revision (not just a coincidence) and
 *        identify the revision day.
 *     4. Emit a suggested irrelevant_after = revision_day - 1.
 *
 * Pass 1 + 2 are pure regex/scan (fast). Pass 3 is one LLM call per
 * candidate (a few cents per candidate × maybe 30-50 candidates =
 * ~$0.30-1.00 total).
 *
 * Usage:
 *   PERSONA_DIR=packages/recall-bench/personas/executive-assistant \
 *   QA_SUBDIR=qa-500d \
 *   MEMORIES_SUBDIR=memories-500d \
 *   node scripts/detect-irrelevant-after.mjs
 *
 * Output: <PERSONA_DIR>/<QA_SUBDIR>/irrelevant-after-suggestions.jsonl
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { config as dotenvConfig } from "dotenv";
import YAML from "yaml";
import { AzureOpenAI } from "openai";

// --- Config ----------------------------------------------------------

dotenvConfig({ path: resolve(process.cwd(), ".env") });

const personaDir = process.env.PERSONA_DIR;
if (!personaDir) {
    console.error("Set PERSONA_DIR (e.g. packages/recall-bench/personas/executive-assistant)");
    process.exit(2);
}
const qaSubdir = process.env.QA_SUBDIR || "qa-180d";
const memoriesSubdir = process.env.MEMORIES_SUBDIR || "memories-180d";
const epoch = process.env.EPOCH || "2026-01-01";
const concurrency = Number(process.env.DETECT_CONCURRENCY || 3);
const deployment = process.env.DETECT_MODEL || "gpt-5.4-mini";

const qaPath = resolve(personaDir, qaSubdir, "questions.yaml");
const reportPath = resolve(personaDir, qaSubdir, "irrelevant-after-suggestions.jsonl");
const memoriesDir = resolve(personaDir, memoriesSubdir);

const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureApiKey = process.env.AZURE_OPENAI_API_KEY;
const azureApiVersion = process.env.AZURE_OPENAI_API_VERSION;
if (!azureEndpoint || !azureApiKey || !azureApiVersion) {
    console.error("Missing AZURE_OPENAI_* env vars.");
    process.exit(2);
}

const client = new AzureOpenAI({
    apiKey: azureApiKey,
    endpoint: azureEndpoint,
    apiVersion: azureApiVersion,
    deployment,
    maxRetries: 5,
});

// --- Signature extraction --------------------------------------------

/**
 * Pull out high-signal tokens from a reference answer that could be the
 * fact under test. Numeric values, percentages, ratios, ISO dates, and
 * Title-Cased proper nouns are the targets — those are the things that
 * get revised in corpora.
 */
function extractSignatures(text) {
    const signatures = new Set();
    // Money: $250M, $1.5B, $620M-$760M
    for (const m of text.matchAll(/\$\d+(?:\.\d+)?[MB]?/g)) signatures.add(m[0]);
    // Ratios: 2.8x, 3.2x
    for (const m of text.matchAll(/\b\d+(?:\.\d+)?x\b/g)) signatures.add(m[0]);
    // Percentages: 50%, 12.5%
    for (const m of text.matchAll(/\b\d+(?:\.\d+)?%/g)) signatures.add(m[0]);
    // Times: 7:00 AM, 6:30 AM
    for (const m of text.matchAll(/\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/gi)) signatures.add(m[0]);
    // ISO dates
    for (const m of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) signatures.add(m[0]);
    // Multi-word Title Case proper nouns (Northstar Components, Project Condor)
    for (const m of text.matchAll(/\b(?:[A-Z][a-z]+\s+){1,3}[A-Z][a-z]+(?:,?\s+Inc\.?)?\b/g)) {
        signatures.add(m[0]);
    }
    return [...signatures];
}

/**
 * Categorize a signature so we can pair contradicting candidates: a $250M
 * isn't superseded by a "Project Condor" — they're different shapes.
 */
function signatureKind(sig) {
    if (/^\$/.test(sig)) return "money";
    if (/x$/.test(sig) && /^\d/.test(sig)) return "ratio";
    if (/%$/.test(sig)) return "percent";
    if (/\d{4}-\d{2}-\d{2}/.test(sig)) return "isodate";
    if (/AM|PM/i.test(sig)) return "time";
    return "name";
}

// --- Corpus scan -----------------------------------------------------

function dayNumberToIso(n) {
    const d = new Date(epoch + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n - 1);
    return d.toISOString().slice(0, 10);
}

function loadDailyMap() {
    if (!existsSync(memoriesDir)) {
        console.error(`memories dir not found: ${memoriesDir}`);
        process.exit(2);
    }
    const files = readdirSync(memoriesDir)
        .filter((f) => /^day-\d{4}\.md$/.test(f))
        .sort();
    const map = new Map(); // day number -> { iso, content }
    for (const f of files) {
        const n = Number(f.match(/^day-(\d{4})\.md$/)[1]);
        const content = readFileSync(join(memoriesDir, f), "utf-8");
        map.set(n, { iso: dayNumberToIso(n), content });
    }
    return map;
}

// --- Heuristic candidate identification ------------------------------

/**
 * For each Q&A pair, look for signature values from its reference that
 * appear with CONFLICTING neighbors in later dailies. The conflict
 * heuristic is shape-aware:
 *   - money/ratio/percent/time/isodate: a different number of the same
 *     kind appearing in a similar context window (±60 chars around the
 *     reference's shared anchor word like "leverage", "synergy",
 *     "briefing").
 *   - name: a different Title-Cased phrase referring to the same
 *     concept (harder; we mostly flag and let the LLM verify).
 */
function candidateRevisionDays(pair, dailyMap) {
    const refSignatures = extractSignatures(pair.answer);
    if (refSignatures.length === 0) return [];
    const maxRelevant = Math.max(...(pair.relevant_days ?? [0]));
    if (maxRelevant === 0) return [];

    // Anchor words: meaningful nouns from the reference (length > 4, lower-cased)
    // that we expect to appear near contradicting values in later dailies.
    const anchorWords = (pair.answer.toLowerCase().match(/\b[a-z]{5,}\b/g) ?? [])
        .filter((w) => !["which", "where", "answer", "should", "across", "always", "later", "first", "after", "before", "without", "memory", "based"].includes(w));
    const uniqueAnchors = [...new Set(anchorWords)].slice(0, 8);

    const candidates = []; // { revisionDay, signatures: [{ refSig, candidateSig, kind, anchor, snippet }] }

    for (const [day, { content }] of dailyMap) {
        if (day <= maxRelevant) continue;
        // Look for any anchor word in this daily
        const matchedAnchors = uniqueAnchors.filter((a) =>
            content.toLowerCase().includes(a),
        );
        if (matchedAnchors.length === 0) continue;
        // For each anchor, find ±60-char windows and look for conflicting signatures
        const windowSigs = []; // { sig, kind, anchor, snippet }
        for (const anchor of matchedAnchors) {
            let idx = 0;
            while ((idx = content.toLowerCase().indexOf(anchor, idx)) !== -1) {
                const start = Math.max(0, idx - 80);
                const end = Math.min(content.length, idx + anchor.length + 80);
                const window = content.slice(start, end);
                const sigs = extractSignatures(window);
                for (const sig of sigs) {
                    windowSigs.push({
                        sig,
                        kind: signatureKind(sig),
                        anchor,
                        snippet: window,
                    });
                }
                idx += anchor.length;
            }
        }
        // For each refSig, check if a different-but-same-kind signature
        // appears in a window with the same anchor.
        const conflicts = [];
        for (const refSig of refSignatures) {
            const refKind = signatureKind(refSig);
            if (refKind === "name") continue; // names handled differently
            for (const ws of windowSigs) {
                if (ws.kind !== refKind) continue;
                if (ws.sig === refSig) continue;
                // Skip near-duplicates (e.g. $250M vs $250M — already same)
                conflicts.push({
                    refSig,
                    candidateSig: ws.sig,
                    kind: ws.kind,
                    anchor: ws.anchor,
                    snippet: ws.snippet.trim().slice(0, 240),
                });
                break; // one conflict per refSig per day is enough
            }
        }
        if (conflicts.length > 0) {
            candidates.push({ revisionDay: day, signatures: conflicts });
        }
    }
    return candidates;
}

// --- LLM verification ------------------------------------------------

const VERIFIER_PROMPT = `You verify whether a candidate "revision" in a memory corpus is a real revision of the fact in a Q&A reference, or just a coincidence.

Given:
  - A Q&A pair (question + reference answer + relevant_days)
  - A "candidate revision" — a daily memory from a later day in the corpus that contains a value of the same shape as a value in the reference, in a similar context.

Decide:
  1. Is the candidate value a REVISION of the reference's value? (e.g. "leverage ceiling was 2.8x" → later "leverage ceiling raised to 3.2x" → YES.)
  2. Is the candidate value an UNRELATED value? (e.g. reference is "$250M term loan", candidate is "$250M annual revenue" — same number, different fact → NO.)
  3. Or just a re-statement of the same value with different wording? (NO revision.)

If YES, the question's reference becomes stale once the revision is in the corpus, so the bench should stop asking it after the revision day.

Respond with a single JSON object:
{
  "is_revision": true | false,
  "confidence": "high" | "medium" | "low",
  "reasoning": "one sentence explaining the decision"
}

Be conservative: when in doubt, "is_revision": false. False positives drop valid questions from the test set.`;

async function verifyCandidate(pair, candidate) {
    const refDate = pair.relevant_days?.length
        ? dayNumberToIso(Math.max(...pair.relevant_days))
        : "unknown";
    const candidateDate = dayNumberToIso(candidate.revisionDay);
    const userPrompt = `<QA_PAIR>
Question: ${pair.question}
Reference answer: ${pair.answer}
Relevant days: ${pair.relevant_days.join(", ")} (latest = ${refDate})

<CANDIDATE_REVISION>
Day: ${candidate.revisionDay} (${candidateDate})
Conflicting signatures (reference vs candidate, same shape, in a shared anchor window):
${candidate.signatures
    .map(
        (s) =>
            `  - anchor "${s.anchor}": reference says ${s.refSig}, daily says ${s.candidateSig}\n    daily snippet: ${s.snippet}`,
    )
    .join("\n")}
`;
    let attempt = 0;
    let delay = 2000;
    while (attempt < 5) {
        attempt++;
        try {
            const resp = await client.chat.completions.create({
                model: deployment,
                messages: [
                    { role: "system", content: VERIFIER_PROMPT },
                    { role: "user", content: userPrompt },
                ],
                temperature: 0,
                response_format: { type: "json_object" },
                max_completion_tokens: 200,
            });
            const text = resp.choices[0]?.message?.content ?? "{}";
            return JSON.parse(text);
        } catch (err) {
            if (err?.status === 429 && attempt < 5) {
                await new Promise((r) => setTimeout(r, delay));
                delay *= 2;
                continue;
            }
            throw err;
        }
    }
    return { is_revision: false, confidence: "low", reasoning: "verifier exhausted retries" };
}

// --- Main ------------------------------------------------------------

const allPairs = YAML.parse(readFileSync(qaPath, "utf-8"));
const dailyMap = loadDailyMap();
console.log(`Loaded ${allPairs.length} Q&A pairs, ${dailyMap.size} daily memories`);

// Skip pairs that are already gated, or that are explicitly time-pinned
// in their question text. Time-pinned questions don't need
// irrelevant_after — the agent's answer is anchored to a specific date
// regardless of later revisions.
function isTimePinned(q) {
    const s = q.toLowerCase();
    return /\b(on 20\d{2}-\d{2}-\d{2}|recorded on 20\d{2}-\d{2}-\d{2}|as of 20\d{2}-\d{2}-\d{2}|in the first week of|in the week of 20\d{2}|on the day)\b/.test(s);
}

const eligible = allPairs.filter(
    (p) => p.irrelevant_after === undefined && !isTimePinned(p.question),
);
console.log(`Considering ${eligible.length} unpinned, ungated pairs`);

// Heuristic pass: find candidates
const heuristicCandidates = []; // { pair, candidates: [{revisionDay, signatures}] }
for (const pair of eligible) {
    const cands = candidateRevisionDays(pair, dailyMap);
    if (cands.length === 0) continue;
    // Take the earliest revision day — that's the one that matters for
    // irrelevant_after (latest revision-aware-day is most conservative).
    cands.sort((a, b) => a.revisionDay - b.revisionDay);
    heuristicCandidates.push({ pair, candidates: cands.slice(0, 1) });
}
console.log(`Heuristic flagged ${heuristicCandidates.length} pairs with possible revisions`);

// LLM verification pass
writeFileSync(reportPath, "", "utf-8");
let done = 0;
let confirmed = 0;
let rejected = 0;

async function worker(queue) {
    while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        const { pair, candidates } = item;
        const cand = candidates[0];
        let verdict;
        try {
            verdict = await verifyCandidate(pair, cand);
        } catch (err) {
            verdict = {
                is_revision: false,
                confidence: "low",
                reasoning: `verifier error: ${err.message || String(err)}`,
            };
        }
        const record = {
            id: pair.id,
            category: pair.category,
            relevant_days: pair.relevant_days,
            revision_day: cand.revisionDay,
            suggested_irrelevant_after: verdict.is_revision
                ? cand.revisionDay - 1
                : null,
            confidence: verdict.confidence,
            reasoning: verdict.reasoning,
            signatures: cand.signatures,
            question: pair.question,
            reference: pair.answer,
        };
        const fs = await import("node:fs");
        fs.appendFileSync(reportPath, JSON.stringify(record) + "\n");
        done++;
        if (verdict.is_revision && verdict.confidence !== "low") {
            confirmed++;
            console.log(
                `[${done}/${heuristicCandidates.length}] ✓ ${pair.id} → irrelevant_after=${record.suggested_irrelevant_after} (${verdict.confidence}: ${verdict.reasoning?.slice(0, 80)})`,
            );
        } else {
            rejected++;
            // Quiet — only report confirmed.
        }
    }
}

const queue = [...heuristicCandidates];
const workers = Array.from({ length: concurrency }, () => worker(queue));
await Promise.all(workers);

console.log(`\nDone. ${confirmed} confirmed revisions, ${rejected} rejected.`);
console.log(`Report: ${reportPath}`);
