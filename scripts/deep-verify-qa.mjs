#!/usr/bin/env node
/**
 * Deep, strict, per-pair Q&A verification — pass 2 of the cleanup.
 *
 * The existing verify-qa-corpus.mjs asks "is every CLAIM in the
 * reference supported by these dailies?" That catches outright
 * hallucinations but misses three more subtle defect classes:
 *
 *   1. ANSWERABILITY: the memory mentions the topic but doesn't state
 *      it in a way a careful agent could produce the reference answer.
 *      (e.g., reference says "$28M base / $38M upside" — memory says
 *       "raised synergy case roughly 50%" — supported by inference but
 *       not answerable without it.)
 *   2. UNIQUENESS: the corpus contains multiple values for the same
 *      fact across days. The reference picks one. Without a time pin
 *      in the question, any of the values is a legitimate answer.
 *   3. AMBIGUITY: the question's wording allows multiple answers from
 *      the corpus, only one of which is the reference.
 *
 * This pass uses gpt-5.4, a wider context window (±3 days around
 * relevant_days plus a "freshness scan" of the LATEST mention of
 * the topic in the corpus), and a stricter judge prompt that classifies
 * problems into ANSWERABLE / NEEDS_CLEANUP / DEFECTIVE.
 *
 * Cost: ~$0.01-0.02 per pair × 878 pairs ≈ $10-20 total. Worth it for
 * the 500d corpus baseline.
 *
 * Usage:
 *   PERSONA_DIR=packages/recall-bench/personas/executive-assistant \
 *   QA_SUBDIR=qa-500d \
 *   MEMORIES_SUBDIR=memories-500d \
 *   node scripts/deep-verify-qa.mjs
 *
 * Output: <PERSONA_DIR>/<QA_SUBDIR>/deep-verification.jsonl
 *
 * Optional env:
 *   ONLY_ID=executive-assistant-q022   verify just this one
 *   DEEP_MODEL=gpt-5.4                 model deployment
 *   DEEP_CONCURRENCY=2                 parallel workers (watch TPM)
 *   RESUME=true                        skip ids already in the report
 *   CONTEXT_BUFFER_DAYS=3              days around relevant_days to include
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from "node:fs";
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
const qaSubdir = process.env.QA_SUBDIR || "qa-500d";
const memoriesSubdir = process.env.MEMORIES_SUBDIR || "memories-500d";
const epoch = process.env.EPOCH || "2026-01-01";
const onlyId = process.env.ONLY_ID;
const resume = process.env.RESUME !== "false";
const concurrency = Number(process.env.DEEP_CONCURRENCY || 2);
const deployment = process.env.DEEP_MODEL || "gpt-5.4";
const contextBufferDays = Number(process.env.CONTEXT_BUFFER_DAYS || 3);

const qaPath = resolve(personaDir, qaSubdir, "questions.yaml");
const reportPath = resolve(personaDir, qaSubdir, "deep-verification.jsonl");
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

// --- Helpers ---------------------------------------------------------

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
    const map = new Map();
    for (const f of files) {
        const n = Number(f.match(/^day-(\d{4})\.md$/)[1]);
        const content = readFileSync(join(memoriesDir, f), "utf-8");
        map.set(n, { iso: dayNumberToIso(n), content });
    }
    return map;
}

/**
 * Build the context block for a Q&A pair:
 *   - The pair's relevant_days, in full
 *   - ±contextBufferDays around each relevant day (because cross-
 *     references and "previously mentioned" facts often sit just
 *     outside)
 *   - A "FRESHNESS SCAN": the LATEST daily in the corpus that mentions
 *     any of the reference's signature tokens, if it's beyond
 *     relevant_days. This is the asymmetry that catches "the corpus
 *     revised this fact after relevant_days" cases.
 */
function buildContext(pair, dailyMap) {
    const relevantSet = new Set();
    const rel = pair.relevant_days ?? [];
    if (rel.length === 0) {
        return { dailies: [], freshnessScan: null };
    }
    for (const d of rel) {
        for (let k = -contextBufferDays; k <= contextBufferDays; k++) {
            const day = d + k;
            if (day >= 1 && dailyMap.has(day)) relevantSet.add(day);
        }
    }
    const sortedDays = [...relevantSet].sort((a, b) => a - b);
    const dailies = sortedDays.map((d) => ({
        day: d,
        iso: dailyMap.get(d).iso,
        relevant: rel.includes(d),
        content: dailyMap.get(d).content,
    }));

    // Freshness scan: look for the latest daily beyond relevant_days
    // that mentions a signature token from the reference. Signature
    // tokens: numbers ($X, X.Yx, X%, ISO dates) + Title-Cased proper
    // names ≥2 words.
    const sigs = extractSignatures(pair.answer);
    if (sigs.length === 0) return { dailies, freshnessScan: null };
    const maxRelevant = Math.max(...rel);
    let latestHit = null;
    for (let d = dailyMap.size; d > maxRelevant + contextBufferDays; d--) {
        const entry = dailyMap.get(d);
        if (!entry) continue;
        for (const sig of sigs) {
            if (entry.content.includes(sig)) {
                latestHit = { day: d, iso: entry.iso, content: entry.content, matchedSig: sig };
                break;
            }
        }
        if (latestHit) break;
    }
    return { dailies, freshnessScan: latestHit };
}

function extractSignatures(text) {
    const signatures = new Set();
    for (const m of text.matchAll(/\$\d+(?:\.\d+)?[MB]?/g)) signatures.add(m[0]);
    for (const m of text.matchAll(/\b\d+(?:\.\d+)?x\b/g)) signatures.add(m[0]);
    for (const m of text.matchAll(/\b\d+(?:\.\d+)?%/g)) signatures.add(m[0]);
    for (const m of text.matchAll(/\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/gi)) signatures.add(m[0]);
    for (const m of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) signatures.add(m[0]);
    for (const m of text.matchAll(/\b(?:[A-Z][a-z]+\s+){1,3}[A-Z][a-z]+(?:,?\s+Inc\.?)?\b/g)) {
        signatures.add(m[0]);
    }
    return [...signatures];
}

// --- Verifier prompt -------------------------------------------------

const SYSTEM_PROMPT = `You are auditing Q&A pairs for a memory-benchmark dataset. Each pair will be tested by feeding the question to an AI agent that has access to a corpus of daily memories. The goal: identify pairs that are DEFECTIVE (the agent cannot reasonably produce the reference answer) or NEEDS_CLEANUP (the pair tests a fact that is correct only inside a specific window the question doesn't pin to).

For each pair you'll receive:
  - question
  - reference answer
  - relevant_days (the days where the question's evidence is supposed to live)
  - the daily memories for relevant_days ± 3 days
  - optionally, a "freshness scan" — the LATEST daily in the corpus that mentions a signature value from the reference, when that daily is beyond relevant_days

Classify the pair as ANSWERABLE, NEEDS_CLEANUP, or DEFECTIVE:

**ANSWERABLE** — A careful agent reading only the provided dailies can produce the reference answer. Every specific claim in the reference (numbers, dates, names, quotes) is explicitly stated or clearly implied. The question's phrasing makes it unambiguous WHICH fact in the corpus to surface.

**NEEDS_CLEANUP** — The reference is correct *for relevant_days* but the question is UNPINNED, AND the freshness scan shows the corpus contains a later daily that revises the fact (e.g., reference says "$250M term loan" supported by day 5, but freshness scan shows day 14 says "$350M term loan"). An agent asked the unpinned question at a checkpoint past the revision will correctly surface the revised value and "fail" the reference. Recommend: add irrelevant_after = revision_day - 1.

**DEFECTIVE** — The reference cannot be produced from relevant_days alone. Either:
  - The reference contains specifics (numbers, names, quotes) that the relevant_days do NOT state or clearly imply.
  - The reference contradicts what relevant_days say.
  - The question's wording allows multiple answers, only one of which matches the reference.
  - The relevant_days don't actually cover the topic being asked about.

Be conservative. The bench is only useful if its references are achievable from the memory. False positives (over-flagging) drop legitimate tests.

Respond with a single JSON object:
{
  "verdict": "ANSWERABLE" | "NEEDS_CLEANUP" | "DEFECTIVE",
  "confidence": "high" | "medium" | "low",
  "reasoning": "one sentence",
  "unsupported_claims": ["specific claim from the reference that isn't supported", ...],
  "irrelevant_after_day": <number | null>,
  "suggested_question": "<rewritten question if NEEDS_CLEANUP or DEFECTIVE could be fixed by re-phrasing; null otherwise>",
  "suggested_reference": "<rewritten reference if DEFECTIVE could be fixed by re-anchoring; null otherwise>"
}`;

function buildUserPrompt(pair, ctx) {
    const lines = [];
    lines.push(`Question: ${pair.question}`);
    lines.push(`Reference answer: ${pair.answer}`);
    lines.push(`Category: ${pair.category}`);
    lines.push(`Difficulty: ${pair.difficulty}`);
    lines.push(`Relevant days: ${pair.relevant_days.join(", ")}`);
    lines.push("");
    if (ctx.dailies.length > 0) {
        lines.push("=== Daily memories (relevant_days ± buffer) ===");
        for (const d of ctx.dailies) {
            const tag = d.relevant ? " (RELEVANT)" : " (buffer)";
            lines.push(`\n--- day ${d.day} / ${d.iso}${tag} ---`);
            lines.push(d.content.trim());
        }
    }
    if (ctx.freshnessScan) {
        lines.push("");
        lines.push(`=== Freshness scan: LATEST daily in corpus mentioning signature "${ctx.freshnessScan.matchedSig}" ===`);
        lines.push(`day ${ctx.freshnessScan.day} / ${ctx.freshnessScan.iso} (BEYOND relevant_days)`);
        lines.push(ctx.freshnessScan.content.trim());
    }
    return lines.join("\n");
}

async function verifyDeep(pair, dailyMap) {
    const ctx = buildContext(pair, dailyMap);
    if (ctx.dailies.length === 0) {
        return {
            id: pair.id,
            verdict: "DEFECTIVE",
            confidence: "high",
            reasoning: "no daily files found for relevant_days",
            unsupported_claims: ["(missing daily files)"],
            irrelevant_after_day: null,
            suggested_question: null,
            suggested_reference: null,
        };
    }
    const userPrompt = buildUserPrompt(pair, ctx);
    let attempt = 0;
    let delay = 2000;
    while (attempt < 5) {
        attempt++;
        try {
            const resp = await client.chat.completions.create({
                model: deployment,
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: userPrompt },
                ],
                temperature: 0,
                response_format: { type: "json_object" },
                max_completion_tokens: 600,
            });
            const text = resp.choices[0]?.message?.content ?? "{}";
            const parsed = JSON.parse(text);
            return {
                id: pair.id,
                category: pair.category,
                difficulty: pair.difficulty,
                relevant_days: pair.relevant_days,
                question: pair.question,
                reference: pair.answer,
                verdict: parsed.verdict ?? "DEFECTIVE",
                confidence: parsed.confidence ?? "low",
                reasoning: parsed.reasoning ?? "",
                unsupported_claims: Array.isArray(parsed.unsupported_claims) ? parsed.unsupported_claims : [],
                irrelevant_after_day: typeof parsed.irrelevant_after_day === "number" ? parsed.irrelevant_after_day : null,
                suggested_question: typeof parsed.suggested_question === "string" ? parsed.suggested_question : null,
                suggested_reference: typeof parsed.suggested_reference === "string" ? parsed.suggested_reference : null,
                had_freshness_scan: ctx.freshnessScan !== null,
            };
        } catch (err) {
            const status = err?.status ?? err?.response?.status;
            if (status === 429 && attempt < 5) {
                await new Promise((r) => setTimeout(r, Math.min(delay, 30000)));
                delay *= 2;
                continue;
            }
            return {
                id: pair.id,
                verdict: "DEFECTIVE",
                confidence: "low",
                reasoning: `verifier error: ${err?.message ?? String(err)}`,
                unsupported_claims: [],
                irrelevant_after_day: null,
                suggested_question: null,
                suggested_reference: null,
                error: true,
            };
        }
    }
    return {
        id: pair.id,
        verdict: "DEFECTIVE",
        confidence: "low",
        reasoning: "verifier exhausted retries",
        unsupported_claims: [],
        irrelevant_after_day: null,
        suggested_question: null,
        suggested_reference: null,
        error: true,
    };
}

// --- Main ------------------------------------------------------------

const dailyMap = loadDailyMap();
const allPairs = YAML.parse(readFileSync(qaPath, "utf-8"));
console.log(`Loaded ${allPairs.length} Q&A pairs, ${dailyMap.size} daily memories`);

let pairs = onlyId ? allPairs.filter((p) => p.id === onlyId) : allPairs;

// Resume support
let alreadyDone = new Set();
if (resume && !onlyId && existsSync(reportPath)) {
    const existing = readFileSync(reportPath, "utf-8").split("\n").filter((l) => l.trim());
    for (const line of existing) {
        try {
            const rec = JSON.parse(line);
            if (rec.id && !rec.error) alreadyDone.add(rec.id);
        } catch {}
    }
    if (alreadyDone.size > 0) {
        console.log(`Resume: skipping ${alreadyDone.size} already-verified pairs`);
        pairs = pairs.filter((p) => !alreadyDone.has(p.id));
    }
}

if (!resume || onlyId || alreadyDone.size === 0) {
    writeFileSync(reportPath, "", "utf-8");
}

console.log(`Deep-verifying ${pairs.length} pair(s) with azure:${deployment}, concurrency=${concurrency}`);
console.log(`Report: ${reportPath}`);
console.log();

let answerable = 0;
let needsCleanup = 0;
let defective = 0;
let errored = 0;
let done = 0;

async function worker(queue) {
    while (queue.length > 0) {
        const pair = queue.shift();
        if (!pair) break;
        const result = await verifyDeep(pair, dailyMap);
        appendFileSync(reportPath, JSON.stringify(result) + "\n");
        done++;
        if (result.error) {
            errored++;
            console.log(`[${done}/${pairs.length}] ⚠ ${result.id}: ${result.reasoning}`);
        } else if (result.verdict === "ANSWERABLE") {
            answerable++;
            // Quiet on success.
        } else if (result.verdict === "NEEDS_CLEANUP") {
            needsCleanup++;
            console.log(`[${done}/${pairs.length}] ⚙ ${result.id} (${result.category}) NEEDS_CLEANUP — ${result.reasoning?.slice(0, 100)}`);
        } else {
            defective++;
            console.log(`[${done}/${pairs.length}] ✗ ${result.id} (${result.category}) DEFECTIVE — ${result.reasoning?.slice(0, 100)}`);
            for (const c of (result.unsupported_claims ?? []).slice(0, 2)) {
                console.log(`      · ${c.slice(0, 200)}`);
            }
        }
    }
}

const queue = [...pairs];
const workers = Array.from({ length: concurrency }, () => worker(queue));
await Promise.all(workers);

console.log();
console.log(`=== Deep verification complete ===`);
console.log(`  total:          ${pairs.length}`);
console.log(`  ANSWERABLE:     ${answerable}`);
console.log(`  NEEDS_CLEANUP:  ${needsCleanup}`);
console.log(`  DEFECTIVE:      ${defective}`);
console.log(`  errored:        ${errored}`);
console.log(`  report:         ${reportPath}`);
