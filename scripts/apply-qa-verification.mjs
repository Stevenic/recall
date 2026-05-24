#!/usr/bin/env node
/**
 * Apply Q&A reference fixes flagged by `scripts/verify-qa-corpus.mjs`.
 *
 * Reads `verification.jsonl` and `questions.yaml` from a persona's
 * `<QA_SUBDIR>/`, finds every pair flagged as unsupported with a
 * non-empty `suggested_reference`, and rewrites the pair's `answer`
 * field to the suggested value. Writes a `.bak-pre-verify-<timestamp>`
 * copy of the original alongside the updated `questions.yaml`.
 *
 * The applier never deletes pairs or changes question text — only the
 * `answer` (reference) field. This keeps the bench's category mix and
 * question count stable; only the gold standard improves.
 *
 * Usage:
 *   PERSONA_DIR=packages/recall-bench/personas/executive-assistant \
 *   node scripts/apply-qa-verification.mjs
 *
 * Optional env vars:
 *   QA_SUBDIR     — default "qa-180d"
 *   DRY_RUN=true  — print the diff but don't write
 */

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

const personaDir = process.env.PERSONA_DIR;
if (!personaDir) {
    console.error("Set PERSONA_DIR.");
    process.exit(2);
}
const qaSubdir = process.env.QA_SUBDIR || "qa-180d";
const dryRun = process.env.DRY_RUN === "true";

const qaPath = resolve(personaDir, qaSubdir, "questions.yaml");
const reportPath = resolve(personaDir, qaSubdir, "verification.jsonl");

const reportLines = readFileSync(reportPath, "utf-8").split("\n").filter((l) => l.trim());
const suggestionsById = new Map();
for (const line of reportLines) {
    const r = JSON.parse(line);
    if (
        !r.supported &&
        typeof r.suggested_reference === "string" &&
        r.suggested_reference.trim().length > 0
    ) {
        suggestionsById.set(r.id, {
            suggested: r.suggested_reference.trim(),
            unsupported_claims: r.unsupported_claims ?? [],
        });
    }
}

console.log(`Found ${suggestionsById.size} unsupported pair(s) with suggested fixes.`);

const pairs = YAML.parse(readFileSync(qaPath, "utf-8"));
let applied = 0;
let skipped = 0;
const changes = [];
for (const pair of pairs) {
    const sug = suggestionsById.get(pair.id);
    if (!sug) continue;
    if (pair.answer === sug.suggested) {
        skipped++;
        continue;
    }
    changes.push({
        id: pair.id,
        category: pair.category,
        before: pair.answer,
        after: sug.suggested,
        unsupported_claims: sug.unsupported_claims,
    });
    pair.answer = sug.suggested;
    applied++;
}

if (changes.length === 0) {
    console.log("No changes to apply.");
    process.exit(0);
}

// Show a compact diff summary.
console.log("\nProposed changes:\n");
for (const c of changes) {
    console.log(`--- ${c.id} (${c.category}) ---`);
    if (c.unsupported_claims.length > 0) {
        console.log(`  Flagged claims:`);
        for (const claim of c.unsupported_claims.slice(0, 3)) {
            console.log(`    · ${claim.slice(0, 200)}`);
        }
    }
    console.log(`  Before: ${c.before.slice(0, 240)}${c.before.length > 240 ? "…" : ""}`);
    console.log(`  After:  ${c.after.slice(0, 240)}${c.after.length > 240 ? "…" : ""}`);
    console.log();
}

console.log(`\nSummary: applying ${applied} change(s), skipping ${skipped} no-op(s).`);
if (dryRun) {
    console.log("(DRY_RUN=true — not writing.)");
    process.exit(0);
}

// Backup + write.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = `${qaPath}.bak-pre-verify-${stamp}`;
copyFileSync(qaPath, backupPath);
console.log(`Backup: ${backupPath}`);

// Preserve original YAML formatting as much as possible by using YAML.stringify
// with options that match the existing file's style (block mode, no aliases).
const out = YAML.stringify(pairs, {
    lineWidth: 0, // don't auto-wrap long strings; preserve as-is
    blockQuote: "literal", // use | for multiline strings
});
writeFileSync(qaPath, out, "utf-8");
console.log(`Wrote: ${qaPath}`);
