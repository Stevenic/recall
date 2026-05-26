#!/usr/bin/env node
/**
 * Apply patches suggested by `scripts/deep-verify-qa.mjs`.
 *
 * Reads `deep-verification.jsonl` and `questions.yaml` from a persona's
 * `<QA_SUBDIR>/`, walks each verdict, and applies one of three actions:
 *
 *   ANSWERABLE        → no-op (already fine).
 *   NEEDS_CLEANUP     → add `irrelevant_after: <day>` to the pair. (We
 *                       prefer this over time-pinning the question since
 *                       it preserves the original wording and matches
 *                       how the bench's eligibility filter already
 *                       handles 7 other pairs.)
 *   DEFECTIVE         → if both `suggested_question` AND
 *                       `suggested_reference` exist, rewrite the pair.
 *                       If only one exists, apply that and log a
 *                       review-needed line. If neither, log a review-
 *                       needed line — caller must decide whether to
 *                       drop or hand-patch the pair.
 *
 * The applier never deletes pairs. It writes a `.bak-pre-deepverify-
 * <timestamp>` copy before writing.
 *
 * Hard-skip set: pairs that were JUST patched manually (q027, q054,
 * q843) — deep-verify ran against pre-patch versions of these, so any
 * suggestion would clobber a good hand-rewrite. Configurable via
 * SKIP_IDS env (comma-separated).
 *
 * Usage:
 *   PERSONA_DIR=packages/recall-bench/personas/executive-assistant \
 *   QA_SUBDIR=qa-500d \
 *   node scripts/apply-deep-verify.mjs
 *
 * Optional env:
 *   DRY_RUN=true    show diff, don't write
 *   SKIP_IDS=...    comma-separated ids to leave untouched
 */

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

const personaDir = process.env.PERSONA_DIR;
if (!personaDir) {
    console.error("Set PERSONA_DIR.");
    process.exit(2);
}
const qaSubdir = process.env.QA_SUBDIR || "qa-500d";
const dryRun = process.env.DRY_RUN === "true";
const SKIP = new Set(
    (process.env.SKIP_IDS ??
        "executive-assistant-q027,executive-assistant-q054,executive-assistant-q843")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
);

const qaPath = resolve(personaDir, qaSubdir, "questions.yaml");
const reportPath = resolve(personaDir, qaSubdir, "deep-verification.jsonl");

const verdicts = readFileSync(reportPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

console.log(`Loaded ${verdicts.length} verdict(s) from deep-verification.jsonl`);

const doc = YAML.parseDocument(readFileSync(qaPath, "utf-8"));
const items = doc.contents.items;
const byId = new Map();
for (const node of items) {
    const idNode = node.get("id");
    const id = typeof idNode === "string" ? idNode : idNode?.value;
    if (id) byId.set(id, node);
}

const actions = {
    cleanupApplied: [],
    cleanupAlreadyHad: [],
    defectiveRewritten: [],
    defectivePartial: [],
    defectiveNoSuggestion: [],
    notFound: [],
    skipped: [],
};

for (const v of verdicts) {
    const id = v.id;
    if (SKIP.has(id)) {
        actions.skipped.push(id);
        continue;
    }
    const node = byId.get(id);
    if (!node) {
        actions.notFound.push(id);
        continue;
    }

    if (v.verdict === "NEEDS_CLEANUP") {
        if (typeof v.irrelevant_after_day !== "number") continue;
        const existing = node.get("irrelevant_after");
        if (existing === v.irrelevant_after_day) {
            actions.cleanupAlreadyHad.push(id);
            continue;
        }
        node.set("irrelevant_after", v.irrelevant_after_day);
        actions.cleanupApplied.push({ id, day: v.irrelevant_after_day });
        continue;
    }

    if (v.verdict === "DEFECTIVE") {
        const sq = typeof v.suggested_question === "string" && v.suggested_question.trim().length > 0
            ? v.suggested_question.trim()
            : null;
        const sr = typeof v.suggested_reference === "string" && v.suggested_reference.trim().length > 0
            ? v.suggested_reference.trim()
            : null;
        if (!sq && !sr) {
            actions.defectiveNoSuggestion.push({
                id,
                reasoning: v.reasoning,
                category: v.category,
            });
            continue;
        }
        const before = {
            question: node.get("question"),
            answer: node.get("answer"),
        };
        if (sq) node.set("question", sq);
        if (sr) node.set("answer", sr);
        const record = {
            id,
            category: v.category,
            before,
            after: {
                question: sq ?? before.question,
                answer: sr ?? before.answer,
            },
            reasoning: v.reasoning,
        };
        if (sq && sr) actions.defectiveRewritten.push(record);
        else actions.defectivePartial.push(record);
        continue;
    }

    // ANSWERABLE — no-op
}

// ── Console summary ──────────────────────────────────────────────────

console.log();
console.log("=== Deep-verify apply summary ===");
console.log(`  NEEDS_CLEANUP applied:           ${actions.cleanupApplied.length}`);
console.log(`  NEEDS_CLEANUP already had:       ${actions.cleanupAlreadyHad.length}`);
console.log(`  DEFECTIVE rewritten (Q+A):       ${actions.defectiveRewritten.length}`);
console.log(`  DEFECTIVE partial (Q or A only): ${actions.defectivePartial.length}`);
console.log(`  DEFECTIVE no suggestion (review): ${actions.defectiveNoSuggestion.length}`);
console.log(`  hard-skipped:                    ${actions.skipped.length}`);
console.log(`  id not found in qaml:            ${actions.notFound.length}`);
console.log();

if (actions.defectiveNoSuggestion.length > 0) {
    console.log("DEFECTIVE pairs with no usable suggestion (need manual review):");
    for (const r of actions.defectiveNoSuggestion) {
        console.log(`  ${r.id} (${r.category}): ${r.reasoning?.slice(0, 200)}`);
    }
    console.log();
}

if (actions.defectivePartial.length > 0) {
    console.log("DEFECTIVE pairs rewritten with only Q OR only A (review desirable):");
    for (const r of actions.defectivePartial.slice(0, 10)) {
        console.log(`  ${r.id}: ${r.reasoning?.slice(0, 160)}`);
    }
    console.log();
}

const totalChanges =
    actions.cleanupApplied.length +
    actions.defectiveRewritten.length +
    actions.defectivePartial.length;

if (totalChanges === 0) {
    console.log("No changes to apply.");
    process.exit(0);
}

if (dryRun) {
    console.log(`(DRY_RUN=true — would write ${totalChanges} change(s) — not writing.)`);
    process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
copyFileSync(qaPath, `${qaPath}.bak-pre-deepverify-${stamp}`);
const out = doc.toString({ lineWidth: 0, blockQuote: "literal" });
writeFileSync(qaPath, out, "utf-8");
console.log(`Wrote ${qaPath} with ${totalChanges} change(s). Backup: ${qaPath}.bak-pre-deepverify-${stamp}`);
