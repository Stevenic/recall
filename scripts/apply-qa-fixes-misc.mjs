#!/usr/bin/env node
/**
 * One-shot: apply irrelevant_after fields (from detect-irrelevant-after)
 * and the q843 question-text typo fix. Idempotent.
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

const personaDir = process.env.PERSONA_DIR ?? "packages/recall-bench/personas/executive-assistant";
const qaSubdir = process.env.QA_SUBDIR ?? "qa-500d";
const qaPath = resolve(personaDir, qaSubdir, "questions.yaml");

const IRRELEVANT_AFTER = [
    { id: "executive-assistant-q452", day: 260 },
    { id: "executive-assistant-q546", day: 347 },
    { id: "executive-assistant-q560", day: 347 },
    { id: "executive-assistant-q596", day: 348 },
    { id: "executive-assistant-q597", day: 348 },
    { id: "executive-assistant-q757", day: 441 },
    { id: "executive-assistant-q769", day: 452 },
];

const Q843_FIX = {
    id: "executive-assistant-q843",
    question: "On which day were two July rehearsal placeholders first held for Investor Day 2027?",
    answer: "Two July rehearsal placeholders for Investor Day 2027 were first held on day 488 (2027-05-02).",
};

// q054: original Q asked "what did Jordan say…" but ref admits Jordan never
// appears in those dailies. Reroute the Q to its actual subjects (Jamie's
// posture + the broader routing rule).
const Q054_FIX = {
    id: "executive-assistant-q054",
    question:
        "What was Jamie's posture on whether the ERP migration belonged on the executive-team agenda on 2026-01-29, and what was the broader routing rule restated on 2026-02-04?",
    answer:
        "On 2026-01-29, Jamie still preferred lightweight executive-team updates unless there was a concrete decision, control issue, or timeline risk. On 2026-02-04, the routing rule was to keep early-stage items on the narrowest useful path and widen to executive-team only when there was a concrete decision, control issue, or timing risk.",
};

// q027: tighten "for Jamie" → "for Jamie's own working calendar" so the
// question can't be read as "rules in service of Jamie's family" (which
// would pull in Riley/Tess scheduling rules from the same window).
const Q027_FIX = {
    id: "executive-assistant-q027",
    question:
        "What three standing calendar rules did Jordan keep preserving for Jamie's own working calendar during this window?",
    answer:
        "No internal meetings before 8:30 unless Europe-related, protect Friday afternoons where possible, and avoid stacking emotionally heavy conversations before board or earnings moments.",
};

const Q_TEXT_FIXES = [Q843_FIX, Q054_FIX, Q027_FIX];

const doc = YAML.parseDocument(readFileSync(qaPath, "utf-8"));
const items = doc.contents.items;

let changed = 0;
for (const node of items) {
    const idNode = node.get("id");
    const id = typeof idNode === "string" ? idNode : idNode?.value;
    const m = IRRELEVANT_AFTER.find((x) => x.id === id);
    if (m) {
        const existing = node.get("irrelevant_after");
        if (existing !== m.day) {
            node.set("irrelevant_after", m.day);
            changed++;
            console.log(`set irrelevant_after=${m.day} on ${id}`);
        }
    }
    const tf = Q_TEXT_FIXES.find((x) => x.id === id);
    if (tf) {
        const q = node.get("question");
        const a = node.get("answer");
        if (q !== tf.question) {
            node.set("question", tf.question);
            changed++;
            console.log(`fixed question text on ${id}`);
        }
        if (a !== tf.answer) {
            node.set("answer", tf.answer);
            changed++;
            console.log(`fixed answer on ${id}`);
        }
    }
}

if (changed === 0) {
    console.log("Nothing to change.");
    process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
copyFileSync(qaPath, `${qaPath}.bak-pre-misc-${stamp}`);
writeFileSync(qaPath, doc.toString({ lineWidth: 0, blockQuote: "literal" }), "utf-8");
console.log(`Wrote ${qaPath} with ${changed} edits.`);
