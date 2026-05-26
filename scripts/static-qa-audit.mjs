#!/usr/bin/env node
/**
 * Fast, LLM-free static audit of Q&A pairs.
 *
 * Catches the obvious defects so the LLM verifiers don't burn cycles on
 * them. Reports — doesn't fix — and the user/agent decides what to do.
 *
 * Defect classes (any one fires):
 *
 *   E_EMPTY_RELEVANT_DAYS  relevant_days is missing or empty.
 *   E_MISSING_DAILY        a relevant_day doesn't exist on disk.
 *   E_REF_VALUE_MISSING    the reference contains a "signature" value
 *                          ($X, X.Yx, X%, ISO date, proper noun) that
 *                          appears in NO relevant_day. Strongest signal
 *                          for a hallucinated reference.
 *   E_QUESTION_ENTITY_MISS the question names a Title-Cased entity
 *                          that appears in NO relevant_day. The pair
 *                          may be asking about a topic the relevant_days
 *                          don't actually cover.
 *   W_REF_NO_TOKEN_OVERLAP weaker — the reference shares no non-stopword
 *                          token with any relevant_day. Sometimes
 *                          legitimate (refs are short paraphrases) so
 *                          this is a warning not an error.
 *
 * Usage:
 *   PERSONA_DIR=packages/recall-bench/personas/executive-assistant \
 *   QA_SUBDIR=qa-500d \
 *   MEMORIES_SUBDIR=memories-500d \
 *   node scripts/static-qa-audit.mjs
 *
 * Output: <PERSONA_DIR>/<QA_SUBDIR>/static-audit.jsonl + console summary.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import YAML from "yaml";

const personaDir = process.env.PERSONA_DIR;
if (!personaDir) {
    console.error("Set PERSONA_DIR");
    process.exit(2);
}
const qaSubdir = process.env.QA_SUBDIR || "qa-500d";
const memoriesSubdir = process.env.MEMORIES_SUBDIR || "memories-500d";
const epoch = process.env.EPOCH || "2026-01-01";

function dayNumberToIso(n) {
    const d = new Date(epoch + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n - 1);
    return d.toISOString().slice(0, 10);
}

const qaPath = resolve(personaDir, qaSubdir, "questions.yaml");
const memoriesDir = resolve(personaDir, memoriesSubdir);
const reportPath = resolve(personaDir, qaSubdir, "static-audit.jsonl");

// --- Helpers ---------------------------------------------------------

const STOP = new Set("a an the is are was were be been being have has had do does did will would could should may might can about across after again all also and any are around as at back be because been before but by came can come could day did do does each even every for from get got had has have he her here him his how i if in into is it its just like make many may me more most much my no not now of off on once one only or other our out over own people same see should so some such take than that the their them then there these they this those time to too two up upon us use very was way we were what when where which while who whom whose why will with would you your".split(/\s+/));

function tokenize(text) {
    return (text.toLowerCase().match(/[a-z][a-z'-]+/g) ?? [])
        .filter((w) => w.length > 2 && !STOP.has(w));
}

function extractSignatures(text) {
    const sigs = new Set();
    for (const m of text.matchAll(/\$\d+(?:\.\d+)?[MB]?/g)) sigs.add(m[0]);
    for (const m of text.matchAll(/\b\d+(?:\.\d+)?x\b/g)) sigs.add(m[0]);
    for (const m of text.matchAll(/\b\d+(?:\.\d+)?%/g)) sigs.add(m[0]);
    for (const m of text.matchAll(/\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/gi)) sigs.add(m[0]);
    for (const m of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) sigs.add(m[0]);
    return [...sigs];
}

function extractProperNouns(text) {
    // Title-cased ≥2-word phrases. The naive regex catches sentence-
    // starters like "Did Jordan", "From Thursday", "What March" — the
    // first word is capitalized by punctuation, not because it's a
    // proper noun. Strip the first capital word before matching when
    // it looks like an interrogative / preposition / conjunction.
    const STARTER_VERBS_AND_PREPS = new Set([
        "Did", "Does", "Do", "Has", "Have", "Had", "Was", "Were", "Is",
        "Are", "Will", "Would", "Could", "Should", "Can", "Should",
        "What", "Which", "Who", "Whom", "Whose", "When", "Where", "Why",
        "How", "From", "After", "Before", "Across", "During", "By", "In",
        "On", "Through", "Across", "Between", "Among", "Around", "Over",
        "Under", "About", "With", "Without", "Within", "Throughout",
        "By", "At", "Until", "Since", "Toward", "Towards", "Upon",
    ]);
    // If the first token is in the starter set, drop it from the
    // matching window so its trailing word doesn't form a spurious pair.
    const firstSpace = text.indexOf(" ");
    let scanText = text;
    if (firstSpace > 0) {
        const firstWord = text.slice(0, firstSpace);
        if (STARTER_VERBS_AND_PREPS.has(firstWord)) {
            // Replace first word with spaces so positions stay aligned
            // but the regex won't anchor on the capital.
            scanText = " ".repeat(firstWord.length) + text.slice(firstSpace);
        }
    }
    const out = new Set();
    for (const m of scanText.matchAll(/\b(?:[A-Z][a-z]+\s+){1,3}[A-Z][a-z]+(?:,?\s+Inc\.?)?\b/g)) {
        out.add(m[0]);
    }
    return [...out];
}

function loadDailies() {
    if (!existsSync(memoriesDir)) {
        console.error(`Missing memories dir: ${memoriesDir}`);
        process.exit(2);
    }
    const map = new Map();
    for (const f of readdirSync(memoriesDir).sort()) {
        const m = f.match(/^day-(\d{4})\.md$/);
        if (!m) continue;
        const day = Number(m[1]);
        map.set(day, readFileSync(join(memoriesDir, f), "utf-8"));
    }
    return map;
}

// --- Audit ----------------------------------------------------------

const dailies = loadDailies();
const pairs = YAML.parse(readFileSync(qaPath, "utf-8"));
console.log(`Loaded ${pairs.length} Q&A pairs, ${dailies.size} dailies`);
console.log();

writeFileSync(reportPath, "", "utf-8");
const fs = await import("node:fs");

const counts = {
    E_EMPTY_RELEVANT_DAYS: 0,
    E_MISSING_DAILY: 0,
    E_REF_VALUE_MISSING: 0,
    E_QUESTION_ENTITY_MISS: 0,
    W_REF_NO_TOKEN_OVERLAP: 0,
};

const flagged = []; // { id, codes: [...], details: {...} }

for (const pair of pairs) {
    const codes = [];
    const details = {};

    const rel = pair.relevant_days ?? [];
    if (rel.length === 0) {
        codes.push("E_EMPTY_RELEVANT_DAYS");
    }

    // Collect relevant-day content as one string for substring searches.
    // Also include the ISO date of each relevant day — dailies don't always
    // restate their own date in body text, but the date is implicit
    // (the filename anchors it). Without this, refs like "on 2026-05-07"
    // get spuriously flagged when day 127 IS the May 7 daily.
    let relevantBlob = "";
    const missingDays = [];
    for (const d of rel) {
        if (!dailies.has(d)) {
            missingDays.push(d);
            continue;
        }
        relevantBlob += "\n" + dayNumberToIso(d) + "\n" + dailies.get(d);
    }
    if (missingDays.length > 0) {
        codes.push("E_MISSING_DAILY");
        details.missingDays = missingDays;
    }
    if (relevantBlob.length === 0) {
        // Nothing more to check.
        if (codes.length > 0) {
            flagged.push({ id: pair.id, category: pair.category, codes, details });
            for (const c of codes) counts[c]++;
            fs.appendFileSync(reportPath, JSON.stringify({ id: pair.id, codes, details }) + "\n");
        }
        continue;
    }

    // E_REF_VALUE_MISSING — signatures in the ref must appear in some
    // relevant day verbatim.
    const refSigs = extractSignatures(pair.answer);
    const missingSigs = refSigs.filter((s) => !relevantBlob.includes(s));
    if (missingSigs.length > 0) {
        codes.push("E_REF_VALUE_MISSING");
        details.missingSignatures = missingSigs;
    }

    // E_QUESTION_ENTITY_MISS — proper nouns named in the question that
    // appear in NO relevant day. Skip if the question itself doesn't
    // have a proper noun (most don't).
    const qNouns = extractProperNouns(pair.question);
    const missingNouns = qNouns.filter((n) => !relevantBlob.includes(n));
    if (missingNouns.length > 0) {
        codes.push("E_QUESTION_ENTITY_MISS");
        details.missingEntities = missingNouns;
    }

    // W_REF_NO_TOKEN_OVERLAP — weak signal; refs that share zero
    // meaningful tokens with any relevant day are usually defective.
    const refTokens = new Set(tokenize(pair.answer));
    if (refTokens.size > 0) {
        const blobTokens = new Set(tokenize(relevantBlob));
        const overlap = [...refTokens].filter((t) => blobTokens.has(t));
        if (overlap.length === 0) {
            codes.push("W_REF_NO_TOKEN_OVERLAP");
        }
    }

    if (codes.length > 0) {
        for (const c of codes) counts[c]++;
        const record = {
            id: pair.id,
            category: pair.category,
            difficulty: pair.difficulty,
            relevant_days: rel,
            question: pair.question,
            reference: pair.answer,
            codes,
            details,
        };
        flagged.push(record);
        fs.appendFileSync(reportPath, JSON.stringify(record) + "\n");
    }
}

// --- Console summary ------------------------------------------------

console.log("=== Static audit results ===");
console.log(`  total pairs:                 ${pairs.length}`);
console.log(`  clean (no flags):            ${pairs.length - flagged.length}`);
console.log(`  flagged:                     ${flagged.length}`);
console.log();
console.log(`  E_EMPTY_RELEVANT_DAYS:       ${counts.E_EMPTY_RELEVANT_DAYS}`);
console.log(`  E_MISSING_DAILY:             ${counts.E_MISSING_DAILY}`);
console.log(`  E_REF_VALUE_MISSING:         ${counts.E_REF_VALUE_MISSING}`);
console.log(`  E_QUESTION_ENTITY_MISS:      ${counts.E_QUESTION_ENTITY_MISS}`);
console.log(`  W_REF_NO_TOKEN_OVERLAP:      ${counts.W_REF_NO_TOKEN_OVERLAP}`);
console.log();
console.log(`Report: ${reportPath}`);

// Surface the most damaging class (E_REF_VALUE_MISSING) first
const sigMisses = flagged.filter((f) => f.codes.includes("E_REF_VALUE_MISSING"));
if (sigMisses.length > 0) {
    console.log();
    console.log(`=== E_REF_VALUE_MISSING (${sigMisses.length}) — sample ===`);
    for (const f of sigMisses.slice(0, 15)) {
        console.log(`  ${f.id} (${f.category}, days ${f.relevant_days.join(",")})`);
        console.log(`    Q:   ${f.question.slice(0, 120)}`);
        console.log(`    REF: ${f.reference.slice(0, 160)}`);
        console.log(`    missing: ${f.details.missingSignatures.join(", ")}`);
    }
}
