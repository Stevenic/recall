#!/usr/bin/env node
/**
 * Replace bench-internal "day N" relative references in QA pairs with
 * absolute ISO dates derived from the persona's epoch. The memory corpus
 * itself never uses "day N" notation — that's bench bookkeeping — so any
 * Q&A pair that quotes "day N" is asking the memory system to know a
 * mapping it has no way of knowing.
 *
 * Usage:  PERSONA_DIR=<dir> EPOCH=2026-01-01 node fix-qa-relative-dates.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

const personaDir = process.env.PERSONA_DIR;
const epochStr = process.env.EPOCH || "2026-01-01";
if (!personaDir) {
  console.error("Set PERSONA_DIR env var to the persona dir (containing qa-180d/questions.yaml).");
  process.exit(2);
}

const qaSubdir = process.env.QA_SUBDIR || "qa-180d";
const qaPath = resolve(personaDir, qaSubdir, "questions.yaml");
const EPOCH = new Date(epochStr);
if (Number.isNaN(EPOCH.getTime())) {
  console.error("Invalid EPOCH:", epochStr);
  process.exit(2);
}

function dayToIso(dayNum) {
  const d = new Date(EPOCH);
  d.setUTCDate(d.getUTCDate() + (dayNum - 1));
  return d.toISOString().slice(0, 10);
}

const raw = readFileSync(qaPath, "utf-8");
const pairs = YAML.parse(raw);

// Match "day N" with an optional leading preposition (preserved verbatim).
// We replace the whole match: "on day 14" → "on 2026-01-14", "by day 7" → "by 2026-01-07".
const RE = /\b(on|by|at|since|from|until|through|before|after|during|as of)\s+day\s+(\d+)\b/gi;
// Also handle bare "day N" where it's used as a noun phrase ("day 14's status").
const BARE_RE = /\bday\s+(\d+)\b/gi;

let edits = 0;
const sampleEdits = [];

function rewrite(text) {
  if (typeof text !== "string") return text;
  let out = text;
  let changed = false;
  // Pass 1: prepositional phrases
  out = out.replace(RE, (_m, prep, n) => {
    changed = true;
    return `${prep} ${dayToIso(parseInt(n, 10))}`;
  });
  // Pass 2: bare day N (remaining instances)
  out = out.replace(BARE_RE, (_m, n) => {
    changed = true;
    return dayToIso(parseInt(n, 10));
  });
  return { text: out, changed };
}

for (const p of pairs) {
  const before = { q: p.question, a: p.answer };
  const q = rewrite(p.question);
  const a = rewrite(p.answer);
  if (q.changed) { p.question = q.text; edits++; }
  if (a.changed) { p.answer = a.text; edits++; }
  if ((q.changed || a.changed) && sampleEdits.length < 5) {
    sampleEdits.push({ id: p.id, before, after: { q: p.question, a: p.answer } });
  }
}

writeFileSync(qaPath, YAML.stringify(pairs, { lineWidth: 0 }), "utf-8");
console.log(`Wrote ${qaPath}`);
console.log(`  edits applied: ${edits}`);
console.log("");
console.log("Sample edits:");
for (const e of sampleEdits) {
  console.log("--- " + e.id);
  if (e.before.q !== e.after.q) {
    console.log("  Q before:", e.before.q);
    console.log("  Q after: ", e.after.q);
  }
  if (e.before.a !== e.after.a) {
    console.log("  A before:", e.before.a);
    console.log("  A after: ", e.after.a);
  }
}
