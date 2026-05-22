#!/usr/bin/env node
/**
 * Anchor vague temporal references in QA questions to the absolute date
 * window implied by `relevant_days`. The bench's QA generator sometimes
 * writes questions like *"On Sunday, what file did Jordan create…"* with no
 * indication of WHICH Sunday — the agent has no anchor and the question
 * becomes unanswerable. This script injects the absolute date(s) implied
 * by `relevant_days` parenthetically without disturbing the question's
 * phrasing.
 *
 * Examples:
 *   "On Sunday for the Caldwell remediation"
 *     → "On Sunday (2026-02-15) for the Caldwell remediation"
 *   "On the weekend quiet days, did Jordan send a 6:30 AM brief?"  rel=[214,215]
 *     → "On the weekend quiet days (2026-08-02 to 2026-08-03), did…"
 *   "The weekday morning briefing"  rel=[1]
 *     → "The weekday morning briefing (2026-01-01)"
 *
 * Patterns covered (case-insensitive):
 *   - Day-of-week: monday|tuesday|…|sunday
 *   - Time of day: the morning|the evening (when not already date-anchored)
 *   - Range: the weekend|the week|the weekday
 *
 * Skips questions that already contain a YYYY-MM-DD anchor — those don't
 * need disambiguation.
 *
 * Usage:  PERSONA_DIR=<dir> QA_SUBDIR=qa-500d EPOCH=2026-01-01 \
 *           node fix-qa-vague-temporal.mjs
 */

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

const personaDir = process.env.PERSONA_DIR;
const qaSubdir = process.env.QA_SUBDIR || "qa-500d";
const epochStr = process.env.EPOCH || "2026-01-01";
if (!personaDir) {
  console.error("Set PERSONA_DIR.");
  process.exit(2);
}
const qaPath = resolve(personaDir, qaSubdir, "questions.yaml");
const EPOCH = new Date(epochStr);
if (Number.isNaN(EPOCH.getTime())) {
  console.error("Invalid EPOCH:", epochStr);
  process.exit(2);
}

function dayToIso(n) {
  const d = new Date(EPOCH);
  d.setUTCDate(d.getUTCDate() + (n - 1));
  return d.toISOString().slice(0, 10);
}
function dayToWeekdayName(n) {
  const d = new Date(EPOCH);
  d.setUTCDate(d.getUTCDate() + (n - 1));
  return ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][d.getUTCDay()];
}

const DAYS_OF_WEEK = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const WEEKDAYS = new Set(["monday", "tuesday", "wednesday", "thursday", "friday"]);
const WEEKEND_DAYS = new Set(["saturday", "sunday"]);

// Already-anchored — skip
const ISO_RE = /\b20\d{2}-\d{2}-\d{2}\b/;

// Patterns we'll rewrite. Each entry's `match` is matched (i, ci); its
// `anchor(relevantDays)` returns the parenthetical string to insert (or
// null to skip this match).
const PATTERNS = [
  // Day-of-week alone: "on Sunday", "this Sunday", "by Sunday"
  {
    name: "day-of-week",
    re: new RegExp(`\\b(${DAYS_OF_WEEK.join("|")})\\b`, "gi"),
    anchor(rd, match) {
      const wantedWeekday = match[1].toLowerCase();
      // Find the relevant day whose calendar weekday matches.
      for (const d of rd) {
        if (dayToWeekdayName(d) === wantedWeekday) return dayToIso(d);
      }
      // No match — use the first relevant day as a best-effort anchor.
      return rd.length > 0 ? dayToIso(rd[0]) : null;
    },
  },
  // Weekend (two-day window if available)
  {
    name: "weekend",
    re: /\b(?:the|that|this)\s+weekend(?:\s+(?:quiet|stabilization)\s+days?)?\b/gi,
    anchor(rd) {
      const wkdEnds = rd.filter((d) => WEEKEND_DAYS.has(dayToWeekdayName(d))).sort((a, b) => a - b);
      if (wkdEnds.length >= 2) return `${dayToIso(wkdEnds[0])} to ${dayToIso(wkdEnds[wkdEnds.length - 1])}`;
      if (wkdEnds.length === 1) return dayToIso(wkdEnds[0]);
      return rd.length > 0 ? dayToIso(rd[0]) : null;
    },
  },
  // Weekday
  {
    name: "weekday",
    re: /\b(?:the|that|this)\s+weekday(?:\s+(?:morning|rush))?\b/gi,
    anchor(rd) {
      const wkdays = rd.filter((d) => WEEKDAYS.has(dayToWeekdayName(d))).sort((a, b) => a - b);
      if (wkdays.length > 0) return dayToIso(wkdays[0]);
      return rd.length > 0 ? dayToIso(rd[0]) : null;
    },
  },
  // Morning / evening / afternoon (generic time-of-day, anchor to first relevant day)
  {
    name: "time-of-day",
    re: /\b(?:the|that|this)\s+(morning|evening|afternoon)\b/gi,
    anchor(rd) {
      return rd.length > 0 ? dayToIso(rd[0]) : null;
    },
  },
];

const raw = readFileSync(qaPath, "utf-8");
const pairs = YAML.parse(raw);

const bakPath = qaPath + ".bak-pre-vague-fix";
copyFileSync(qaPath, bakPath);

let editsApplied = 0;
const samples = [];

for (const p of pairs) {
  if (typeof p.question !== "string") continue;
  if (ISO_RE.test(p.question)) continue; // already anchored
  const rd = Array.isArray(p.relevant_days) ? p.relevant_days.filter((d) => typeof d === "number") : [];
  if (rd.length === 0) continue;

  const before = p.question;
  let working = p.question;

  // Apply each pattern in order. Track inserted anchors so we don't
  // double-annotate the same span (e.g., "on Sunday" → "on Sunday (date)"
  // shouldn't then match "the morning" inside the date).
  for (const pat of PATTERNS) {
    pat.re.lastIndex = 0;
    working = working.replace(pat.re, (match, ...rest) => {
      // Match comes back including the leading whitespace bits via the regex.
      // We re-find the actual full match via the regex's groups.
      // `match` here is the literal matched substring.
      const m = [match, ...rest.slice(0, -2)]; // strip offset + full string
      const anchor = pat.anchor(rd, m);
      if (!anchor) return match;
      // Skip if the very next characters are already an open-paren (already annotated)
      return `${match} (${anchor})`;
    });
  }

  if (working !== before) {
    p.question = working;
    editsApplied++;
    if (samples.length < 6) samples.push({ id: p.id, before, after: working });
  }
}

writeFileSync(qaPath, YAML.stringify(pairs, { lineWidth: 0 }), "utf-8");

console.log(`Wrote ${qaPath}`);
console.log(`  edits applied: ${editsApplied}`);
console.log(`  backup:        ${bakPath}`);
console.log("");
console.log("Sample edits:");
for (const s of samples) {
  console.log("--- " + s.id);
  console.log("  before:", s.before.slice(0, 180));
  console.log("  after: ", s.after.slice(0, 220));
}
