#!/usr/bin/env node
/**
 * Patch arcs-500d.yaml so every personal-side arc forbids the work-facing
 * sessions where personal context would leak. The model's initial draft only
 * forbade the most-obvious public surfaces (executive-team, board-prep,
 * comp-committee, customer-facing, legal-deposition) and missed the
 * confidential-but-bounded work sessions (direct-reports, ea-network,
 * project-condor, legal-confidential).
 *
 * `principal` (Jamie 1:1) stays OFF the forbid list — the EA legitimately
 * handles both worlds in 1:1 with the boss.
 *
 * Uses `yaml` Document API to preserve all comments and formatting.
 *
 * Usage:  PERSONA_DIR=<dir> node scripts/patch-arcs-forbidden-sessions.mjs
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

const personaDir = process.env.PERSONA_DIR;
if (!personaDir) {
  console.error("Set PERSONA_DIR env var to the persona directory.");
  process.exit(2);
}
const arcsPath = resolve(personaDir, "arcs-500d.yaml");
if (!existsSync(arcsPath)) {
  console.error("Missing:", arcsPath);
  process.exit(1);
}

const REQUIRED_FORBIDDEN = [
  "direct-reports",
  "ea-network",
  "project-condor",
  "legal-confidential",
];

const raw = readFileSync(arcsPath, "utf-8");
const doc = YAML.parseDocument(raw);

const arcs = doc.get("arcs");
if (!arcs || !arcs.items) {
  console.error("arcs node not found or malformed");
  process.exit(1);
}

let patched = 0;
for (const arcNode of arcs.items) {
  const primary = arcNode.get("primarySession");
  if (typeof primary !== "string" || !primary.startsWith("personal-")) continue;

  // Read current forbiddenSessions (may be missing, scalar, or seq)
  let forbidden = arcNode.get("forbiddenSessions");
  if (forbidden && typeof forbidden.toJSON === "function") {
    forbidden = forbidden.toJSON();
  }
  const current = Array.isArray(forbidden) ? forbidden : [];

  // Compute the merged list, preserving existing order and adding the
  // missing required entries at the end.
  const merged = [...current];
  let added = 0;
  for (const s of REQUIRED_FORBIDDEN) {
    if (!merged.includes(s)) {
      merged.push(s);
      added++;
    }
  }
  if (added > 0) {
    arcNode.set("forbiddenSessions", merged);
    patched++;
  }
}

// Backup before writing
copyFileSync(arcsPath, arcsPath + ".bak-pre-forbidden-patch");

// Round-trip the document back to YAML (preserves comments because we used parseDocument)
writeFileSync(arcsPath, doc.toString(), "utf-8");

console.log(`Patched ${patched} personal arcs with additional forbiddenSessions.`);
console.log(`  Added entries: ${REQUIRED_FORBIDDEN.join(", ")}`);
console.log(`  Backup: ${arcsPath}.bak-pre-forbidden-patch`);
