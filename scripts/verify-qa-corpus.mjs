#!/usr/bin/env node
/**
 * Verify a persona's Q&A corpus against its memory corpus.
 *
 * For each Q&A pair, loads the union of `relevant_days` daily files and
 * asks an LLM judge: "is every factual claim in the reference answer
 * grounded in this memory?" Writes one JSONL record per pair to the
 * output report:
 *
 *   {
 *     "id": "executive-assistant-q002",
 *     "supported": true | false,
 *     "category": "contradiction-resolution",
 *     "question": "...",
 *     "reference": "...",
 *     "unsupported_claims": ["..."],
 *     "suggested_reference": "..."  // only when supported=false
 *   }
 *
 * Cost: ~1 LLM call per pair × azure:gpt-5.4. For 316 pairs that's
 * roughly $0.50–1.00. We use the strong (non-mini) judge because we
 * want to catch subtle hallucinations in references — the bench
 * results are only as good as the dataset.
 *
 * Usage:
 *   PERSONA_DIR=packages/recall-bench/personas/executive-assistant \
 *   QA_SUBDIR=qa-180d \
 *   MEMORIES_SUBDIR=memories-180d \
 *   node scripts/verify-qa-corpus.mjs
 *
 * Output: <PERSONA_DIR>/<QA_SUBDIR>/verification.jsonl
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
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

const qaPath = resolve(personaDir, qaSubdir, "questions.yaml");
const reportPath = resolve(personaDir, qaSubdir, "verification.jsonl");
const memoriesDir = resolve(personaDir, memoriesSubdir);

const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureApiKey = process.env.AZURE_OPENAI_API_KEY;
const azureApiVersion = process.env.AZURE_OPENAI_API_VERSION;
const deployment = process.env.VERIFIER_MODEL || "gpt-5.4";
if (!azureEndpoint || !azureApiKey || !azureApiVersion) {
    console.error("Missing AZURE_OPENAI_* env vars.");
    process.exit(2);
}

const concurrency = Number(process.env.VERIFIER_CONCURRENCY || 6);
const onlyId = process.env.ONLY_ID; // optional: verify just one Q&A pair

// --- Helpers ---------------------------------------------------------

const client = new AzureOpenAI({
    apiKey: azureApiKey,
    endpoint: azureEndpoint,
    apiVersion: azureApiVersion,
    deployment,
    maxRetries: 5,
});

function loadDailyContent(day) {
    const filename = `day-${String(day).padStart(4, "0")}.md`;
    const path = join(memoriesDir, filename);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
}

const SYSTEM_PROMPT = `You verify Q&A pairs against their source memory corpus.

For each pair you receive:
  - A question
  - A reference answer (the "gold standard")
  - A set of "memory" daily logs (the only source of truth)

Your job: decide whether EVERY factual claim in the reference answer is
supported by the provided memory. A claim is supported when the memory
contains an explicit statement or unambiguous implication that matches
the claim. A claim is unsupported when the memory does NOT contain it,
contradicts it, or only weakly implies it.

Important rules:
- The reference may invent details the LLM that generated it imagined,
  even when the question/topic is otherwise valid. Flag those.
- Be strict: "the agent didn't push back" is NOT support for a claim
  that says "the agent pushed back firmly." Wording matters.
- Don't penalize natural summarization. If memory says "around 6:30 AM"
  and the reference says "6:30 AM," that's supported.
- Don't penalize date format differences. "January 5" and "2026-01-05"
  are the same fact when memory has either.
- If the question itself can't be answered from the corpus (e.g. asks
  about something never mentioned), the reference is unsupportable by
  definition — flag it as a defective question.

Respond with a single JSON object:
{
  "supported": true | false,
  "unsupported_claims": ["specific phrase or fact from the reference that lacks support", ...],
  "question_answerable_from_corpus": true | false,
  "suggested_reference": "if supported=false, propose a corrected reference that includes ONLY claims grounded in the provided memory; otherwise omit this field"
}

The suggested_reference should be a complete, free-standing answer to
the question that uses only what's in the memory. It should be in the
same style and length as the original reference where possible.`;

function buildUserPrompt(qa, dailies) {
    const lines = [];
    lines.push(`Question:\n${qa.question}\n`);
    lines.push(`Reference answer:\n${qa.answer}\n`);
    lines.push(`Memory (relevant daily logs, days ${qa.relevant_days.join(", ")}):`);
    for (const { day, content } of dailies) {
        lines.push(`\n--- day ${day} ---\n${content.trim()}`);
    }
    return lines.join("\n");
}

async function verifyOne(qa) {
    const dailies = qa.relevant_days
        .map((day) => ({ day, content: loadDailyContent(day) }))
        .filter((d) => d.content);
    if (dailies.length === 0) {
        return {
            id: qa.id,
            supported: false,
            category: qa.category,
            question: qa.question,
            reference: qa.answer,
            unsupported_claims: ["(no daily files found for relevant_days)"],
            question_answerable_from_corpus: false,
            suggested_reference: null,
            error: "missing daily files",
        };
    }

    const user = buildUserPrompt(qa, dailies);
    let parsed;
    try {
        const resp = await client.chat.completions.create({
            model: deployment,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: user },
            ],
            temperature: 0,
            response_format: { type: "json_object" },
            max_completion_tokens: 600,
        });
        const text = resp.choices[0]?.message?.content ?? "{}";
        parsed = JSON.parse(text);
    } catch (err) {
        return {
            id: qa.id,
            supported: false,
            category: qa.category,
            question: qa.question,
            reference: qa.answer,
            unsupported_claims: [],
            question_answerable_from_corpus: null,
            suggested_reference: null,
            error: err instanceof Error ? err.message : String(err),
        };
    }

    return {
        id: qa.id,
        supported: parsed.supported === true,
        category: qa.category,
        difficulty: qa.difficulty,
        question: qa.question,
        reference: qa.answer,
        relevant_days: qa.relevant_days,
        unsupported_claims: Array.isArray(parsed.unsupported_claims)
            ? parsed.unsupported_claims
            : [],
        question_answerable_from_corpus:
            parsed.question_answerable_from_corpus !== false,
        suggested_reference:
            typeof parsed.suggested_reference === "string"
                ? parsed.suggested_reference
                : null,
    };
}

// --- Main ------------------------------------------------------------

const allPairs = YAML.parse(readFileSync(qaPath, "utf-8"));
let pairs = allPairs;
if (onlyId) {
    pairs = allPairs.filter((p) => p.id === onlyId);
    if (pairs.length === 0) {
        console.error(`No Q&A pair with id="${onlyId}"`);
        process.exit(2);
    }
}

console.log(`Verifying ${pairs.length} Q&A pair(s) using azure:${deployment}`);
console.log(`Memories dir: ${memoriesDir}`);
console.log(`Report:       ${reportPath}`);
console.log(`Concurrency:  ${concurrency}\n`);

// Truncate report
writeFileSync(reportPath, "", "utf-8");

let supported = 0;
let unsupported = 0;
let errored = 0;
let done = 0;

// Simple worker-pool concurrency.
async function worker(queue) {
    while (queue.length > 0) {
        const qa = queue.shift();
        if (!qa) break;
        const result = await verifyOne(qa);
        appendFileSync(reportPath, JSON.stringify(result) + "\n");
        if (result.error) {
            errored++;
            console.log(`[${++done}/${pairs.length}] ⚠ ${result.id}: ERROR ${result.error}`);
        } else if (result.supported) {
            supported++;
            done++;
            // Quiet unless verbose: skip per-supported log to keep output focused.
        } else {
            unsupported++;
            done++;
            const claims = result.unsupported_claims.slice(0, 3);
            console.log(`[${done}/${pairs.length}] ✗ ${result.id} (${result.category}) — unsupported:`);
            for (const c of claims) console.log(`     · ${c}`);
        }
    }
}

const queue = [...pairs];
const workers = Array.from({ length: concurrency }, () => worker(queue));
await Promise.all(workers);

console.log(`\n=== Verification complete ===`);
console.log(`Total:       ${pairs.length}`);
console.log(`Supported:   ${supported}`);
console.log(`Unsupported: ${unsupported}`);
console.log(`Errored:     ${errored}`);
console.log(`Report:      ${reportPath}`);
