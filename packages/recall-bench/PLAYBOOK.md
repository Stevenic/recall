# Persona Data Generation Playbook

**Audience:** A coding agent generating persona data for Recall Bench.
**Deliverable per persona:**
- `memories/day-NNNN.md` × 1,000 (multi-session format per spec §4.7)
- `qa/questions.yaml` with 300+ validated Q&A pairs (spec §4.5, §5.4)

This playbook is the operating manual. Read it end-to-end before running anything. Don't deviate without explaining why in your final report.

---

## 1. Required reading (in order)

Read these before starting. Don't restate them — reference them by `§` when you make decisions.

1. **`specs/recall-bench.md`** — the bench spec, v0.5. Authoritative for personas, sessions, arcs, Q&A schema, scoring.
2. **`specs/day-generator.md`** — the prompt spec for Pass 1. Authoritative for system prompt structure, multi-session output format, conditional rendering rules (§3.1.2 and §3.1.3 are the load-bearing sections).
3. **`docs/recall-bench.md`** — operator-facing docs. Authoritative for CLI usage, resume behavior, Windows tree-kill, coding-agent quirks.
4. **`packages/recall-bench/personas/<id>/persona.yaml`** and the chosen arcs file — see § Arc-file variants below.

## 1a. Arc-file variants (varying-length corpora)

Every arcs file is labeled by intended corpus duration. Convention:

- `arcs-<NNN>d.yaml` — story arcs for an N-day corpus (e.g., `arcs-1000d.yaml`, `arcs-180d.yaml`, `arcs-30d.yaml`).
- The default is `arcs-1000d.yaml` — the canonical 1000-day story shipped with each persona. Variants are optional and live alongside the default in the same persona dir.

Each arcs file pairs with sibling output dirs derived from the suffix:

| Arcs file | Memories dir | Q&A dir |
|---|---|---|
| `arcs-1000d.yaml` (default) | `memories-1000d/` | `qa-1000d/` |
| `arcs-180d.yaml` | `memories-180d/` | `qa-180d/` |
| `arcs-30d.yaml` | `memories-30d/` | `qa-30d/` |

CLI selectors:

- `recall-bench generate --arcs arcs-180d.yaml --days 180` (or explicit `--start/--end`)
- `recall-bench generate-conversations --memories-dir memories-180d` (pair with the suffix used at generate time)
- `--memories-dir <name>` overrides the derivation if you want a non-standard layout.
- `recall-bench generate` defaults to `arcs-1000d.yaml` when `--arcs` is omitted, so existing 1000-day workflows don't need to specify the flag.

Use cases for shorter variants: faster iteration, denser per-day stress, smoke-testing the harness on a smaller corpus before committing to the full 1000-day generation budget.

If a spec section disagrees with this playbook, the spec wins and you tell the user.

---

## 2. Current state of the world (as of authoring)

You are not starting from zero. Here's what exists:

| Asset | State |
|---|---|
| 6 personas with `persona.yaml` + `arcs-1000d.yaml` at v0.5 schema | ✅ Done — `backend-eng-saas`, `er-physician`, `litigation-attorney`, `research-scientist`, `financial-advisor`, `executive-assistant` (executive-assistant also ships `arcs-180d.yaml`) |
| `research-scientist/memories/day-{0001,0002,0008}.md` | ⚠️ **Stale.** Pre-v0.5 format (single H2 date, no `# session:` H1s). Must be regenerated or deleted before a real run. |
| All other `memories/` and `qa/` directories | Empty. Nothing generated yet. |
| `recall-bench generate` CLI | Implemented, resume-safe, per-day fault tolerant (see `docs/recall-bench.md`). |
| `recall-bench generate-conversations` CLI (Pass 2) | Implemented. Optional. |
| Q&A generator | **Not implemented.** Spec §4.5 describes the algorithm; current path is "manual or LLM-assisted." You will author Q&A pairs by hand with model assistance. |
| `PersonaDefinition` / `ArcDefinition` types in `src/generator-types.ts` | ⚠️ **At v0.2.** Missing `sessions`, `sharedKnowledge`, `primarySession`, `referencedSessions` fields. |
| `buildSystemPrompt` in `src/generator.ts` (line 351) | ⚠️ **At v0.2.** Renders single-H2 date + H3 topics. Does not render the Sessions block, the Shared Knowledge block, or the multi-session output structure required by spec §3.1.2. |

The two ⚠️ rows on `generator-types.ts` and `buildSystemPrompt` are the **single largest risk to a successful run**. Phase 0 below addresses them. Do not skip Phase 0.

---

## 3. The order: memories first, Q&A second

Both `specs/recall-bench.md` §4.1 and `docs/recall-bench.md` are explicit:

```
Arc Planner → Day Generator → Consistency Checker → Q&A Generator → Q&A Validator
```

Q&A pairs are grounded in the memory stream. They cannot be authored before the corpus exists because:
- `relevant_days` must point at days that have actually been emitted
- Correction-arc Q&A asks for the *current* belief, which depends on the corrected-day content actually landing
- Negative-recall Q&A requires verifiable absence — needs a corpus to grep
- Difficulty calibration runs against a BM25 baseline of the corpus
- Information-boundary Q&A needs `sensitive_topics` to actually appear under their declared isolated session H1s before a leak can be tested

If the user asks you to author Q&A pairs before memories exist, push back and cite spec §4.5.

---

## 4. Phase 0 — Bring the day-generator to v0.5 (BLOCKER)

**You cannot generate useful data until this is done.** Skipping Phase 0 produces 5,000+ legacy-format days that exercise none of the multi-session, isolation, or attribution surfaces v0.5 was designed for.

### 4.1 Update `src/generator-types.ts`

Add to `PersonaDefinition`:
```typescript
sessions?: SessionDef[];
sharedKnowledge?: string[];
```

Add to `ArcDefinition`:
```typescript
primarySession?: string;
referencedSessions?: string[];
participants?: string[];
```

Add the new interface:
```typescript
export interface SessionDef {
    id: string;
    kind: '1to1' | 'group';
    participants: string[];
    isolated?: boolean;
    shared?: boolean;
    firstDay?: number;
    lastDay?: number;
    sensitive_topics?: string[];
}
```

Surface session affinity on `ActiveArc`:
```typescript
primarySession?: string;
referencedSessions?: string[];
echoToday?: boolean;       // pipeline flag from spec §3.3
```

Reference: spec §6.2, day-generator §3.1.1.

### 4.2 Update `buildSystemPrompt` in `src/generator.ts` (line 351)

Render in this order, applying conditional rules from day-generator §3.1.3:

1. Identity / Profile / Communication style — already done
2. Principal block — already done
3. Cast block — already done
4. **NEW:** Sessions block — one line per session with `kind`, `isolated`/`shared` flags, participants, lifecycle, sensitive_topics
5. **NEW:** Shared knowledge block — bulleted list
6. **NEW:** "How to partition the log by session" instructions (day-generator §3.1.2 — verbatim)
7. **REPLACE:** the Required output structure block — switch from `## YYYY-MM-DD` to the multi-session `# session: <id>` H1 layout (day-generator §3.1.2)

The full template is in day-generator.md §3.1.2 — copy it; don't paraphrase.

### 4.3 Plumb `primarySession` / `referencedSessions` into `getActiveArcs`

The day context (spec §3.3) must surface session affinity to the prompt:

```typescript
// In getActiveArcs:
return arcs.filter(...).map(a => ({
    ...,
    primarySession: a.primarySession,
    referencedSessions: a.referencedSessions ?? [],
    echoToday: computeEchoToday(a, dayNumber),  // see spec §3.3
}));
```

`computeEchoToday` is a pipeline policy decision — touchpoints are arc start, arc end, decision moments, sprint boundaries (every ~14 days), and explicit `directives[].day` entries. Be conservative: too many echoes pollutes referenced sessions.

### 4.4 Update the day context user message

The user prompt (spec §3.2–§3.5) must include:
- Active arcs with `primarySession`, `referencedSessions`, and `echo_today`
- Today's session-active list (which sessions to emit H1s for)
- Correction state (already done)
- Directives (already done)

### 4.5 Sanity check before Phase 1

Run `npx tsc --noEmit` (must pass), then run a single-day prompt-build smoke test:

```bash
npx tsx -e "
import {readFileSync} from 'node:fs';
import yaml from 'yaml';
import {buildSystemPrompt} from './src/generator.js';
const persona = yaml.parse(readFileSync('personas/research-scientist/persona.yaml', 'utf8'));
console.log(buildSystemPrompt(persona));
" | grep -E '^# (Sessions|Shared knowledge|How to partition)'
```

If those three section headers don't print, Phase 0 is incomplete. Fix and re-verify.

### 4.6 Definition of done for Phase 0

- [ ] `tsc --noEmit` passes across the package
- [ ] `buildSystemPrompt(researchScientist)` includes `# Sessions`, `# Shared knowledge`, `# How to partition the log by session`
- [ ] Required output structure in the rendered prompt uses `# session: <id>` H1, not `## YYYY-MM-DD`
- [ ] `getActiveArcs(...)` returns arcs with `primarySession` populated
- [ ] Existing tests still pass: `npm test --workspace=packages/recall-bench`

Stop here and report to the user before moving on. They may want to review the prompt diff.

---

## 5. Phase 1 — Smoke test (one persona, 30 days)

Don't run 1,000 days × 6 personas blindly. A 30-day smoke pass on one persona costs ~$5–15 and catches every failure mode worth catching: prompt format issues, session-routing bugs, multi-session H1 emission, isolated-session leaks, Windows subprocess timeouts.

### 5.1 Pick the smoke persona

Use **`research-scientist`** first. Reasons:
- It's the only persona with a reference v0.5 persona.yaml authored by hand (single isolated session, full sessions block)
- Existing stale memory days (0001/0002/0008) make a useful before/after diff
- Stress map is balanced — every category gets exercised

Delete the stale memory days first:
```bash
rm packages/recall-bench/personas/research-scientist/memories/day-*.md
```

### 5.2 Run

```bash
npx recall-bench generate \
  --persona ./packages/recall-bench/personas/research-scientist \
  --model claude \
  --start 1 --end 30
```

Expected runtime: 15–45 minutes depending on agent latency (`docs/recall-bench.md` notes coding agents don't honor `--temperature` or `--max-tokens`).

### 5.3 Inspection checklist

For at least 5 sampled days from the 30-day output, verify:

- [ ] Frontmatter is `type: daily` plus day/date/persona/active-sessions per spec §2.2
- [ ] Pre-H1 body (if present) is plausible internal narration — not session content
- [ ] One `# session: <id>` H1 per active session, in canonical order (`principal` first)
- [ ] No empty session H1s (spec §4.7 / S5)
- [ ] Group session H1s contain attributed quotes (`> Sarah: "..."`) per day-generator §4.6
- [ ] On any day that touches `collab-chen` (the isolated session), no `sensitive_topics` phrases appear under any other H1 (spec §4.7 isolation invariant)
- [ ] Correction arc days emit the wrong belief on `wrongDay` and the correction on `correctedDay`
- [ ] Cross-arc echo arcs surface attributable echoes in their `referencedSessions[]` at touchpoints — not on every active day

If any check fails, stop. Diagnose the prompt, the active-arc plumbing, or the type wiring. Re-run the same range; existing files are overwritten.

### 5.4 Definition of done for Phase 1

- [ ] 30 days emitted under `personas/research-scientist/memories/`
- [ ] All sample-day checks pass
- [ ] No skipped days (`stderr` shows zero `[generator] arc=... skipped:` lines), or any skipped days have been re-run successfully

---

## 6. Phase 2 — Full memory generation (per persona)

Generate one persona at a time. Don't parallelize across personas during the first full run — if something is broken, you want to find it once, not five times.

### 6.1 Order

1. `research-scientist` (already smoke-tested)
2. `backend-eng-saas` (no isolated sessions; lowest boundary risk)
3. `er-physician` (no isolated sessions)
4. `litigation-attorney` (4 isolated sessions — boundary stress begins)
5. `financial-advisor` (4 isolated sessions)
6. `executive-assistant` (4 isolated + ea-network multi-claw — most complex)

### 6.2 Run

```bash
npx recall-bench generate \
  --persona ./packages/recall-bench/personas/<id> \
  --model claude
```

The CLI is resume-safe (`docs/recall-bench.md` "Incremental, durable progress"). If a run is interrupted, restart with the same command and `--start <next-day>`.

### 6.3 Per-day failure recovery

`docs/recall-bench.md` "Per-day failure resilience" applies. After the run finishes, scan stderr for skipped days:

```bash
# Re-run individual skipped days
npx recall-bench generate \
  --persona ./packages/recall-bench/personas/<id> \
  --model claude \
  --start <day> --end <day>
```

Don't tolerate >5 skipped days per persona. If you're hitting more, something systemic is wrong (timeout too short, API quota, prompt regression). Stop and diagnose.

### 6.4 Per-persona acceptance

After each persona's full run, verify:

- [ ] 1,000 files under `memories/day-NNNN.md` (where N goes 0001–1000)
- [ ] No skipped days remain (re-run any individual misses)
- [ ] Spot-check 10 random days for the same checks from §5.3
- [ ] For boundary-stressed personas (litigation, financial, executive): grep the full corpus for the `sensitive_topics` strings declared in `persona.yaml`. Each phrase should appear ONLY under its declared isolated session's H1, not under any other session's H1.
  - Example: `grep -B1 -A20 "Acme's settlement floor" memories/*.md | grep "^# session:"` should show only `# session: client-acme`.
- [ ] Disk size sanity: ~3–8 KB/day, so 3–8 MB total per persona

### 6.5 Phase 2 stop conditions

Stop and report to the user if:
- Skipped-day rate >0.5% in a single run
- Boundary-leak grep returns sensitive content under a non-declared session
- Any persona's run exceeds 12 hours without completing

---

## 7. Phase 3 — Consistency checker (spec §4.4)

Per the spec, a separate LLM pass reads the full 1,000-day stream and flags:
- Unintentional contradictions
- Orphaned references
- Timeline impossibilities
- Cross-session leaks (sensitive topic appearing outside its isolated session)
- Lifecycle violations (arc activity outside session `firstDay`/`lastDay`)

The checker is **not yet implemented as a CLI command**. Until it is, run a manual pass:

1. The boundary grep from §6.4 above is the most important check — it implements spec §4.4's cross-session leak detection.
2. For each persona, ask the user's preferred reasoning model to scan a sampled subset (every 50th day = 20 days) and flag inconsistencies. Write findings to `personas/<id>/consistency-report.md`.
3. Do NOT fix flagged issues by hand-editing memory files unless the user explicitly approves. The right fix is a re-run of the affected day(s) with a stricter prompt — preserves the generative grounding.

Spec §4.4 explicitly excludes intentional contradictions (correction arcs) from flagging. Verify any flagged contradiction isn't actually a `wrongBelief` → `correctedBelief` arc transition before reporting it.

---

## 8. Phase 4 — Q&A authoring (manual / LLM-assisted, per spec §4.5)

### 8.1 Targets per persona

From spec §5.4 / §10:
- 300+ Q&A pairs per persona total
- Per-range minimums: 30 (`30d`), 60 (`90d`), 100 (`6mo`), 150 (`1y`), 200 (`full`)
- Per-category: distribute across all 10 (factual, temporal, decision, contradiction, cross-reference, recency-bias, synthesis, negative, group-attribution, information-boundary)
- For boundary-stressed personas (litigation, financial, executive): 30–50 information-boundary pairs each. For others: 5–10 each.
- For all personas: at least 30 group-session-attribution pairs

### 8.2 Authoring procedure (per persona)

For each evaluation category, work through the persona's arcs and generate pairs. Use this method:

**`factual-recall`** — Pick a specific named fact stated once in the corpus. The fact must be exact (a number, a name, a date, a status). `relevant_days: [N]` is one day. Difficulty `easy` if the day is in the last 90; `medium` further back; `hard` past day 800.

**`temporal-reasoning`** — Pair two events from different arcs. Ask "did X happen before or after Y?" `relevant_days` includes both days. Difficulty depends on the gap.

**`decision-tracking`** — Pick a decision arc. Ask either "why was X decided?" (requires deliberation context) or "who proposed X / who objected?" (requires attributed group content). `relevant_days` covers proposal through resolution.

**`contradiction-resolution`** — Pick a correction arc. Ask "what is the current X?" Answer is the corrected belief. `relevant_days` is `[wrongDay, correctedDay]` plus any reinforcement days.

**`cross-reference`** — Find two arcs that share an entity (a person, a system, a vendor, a metric). Ask a question that requires connecting them. `relevant_days` spans both arcs.

**`recency-bias-resistance`** — Find an early-corpus fact that's never re-mentioned. Ask about it from the system's perspective at evaluation time. `relevant_days: [N]` early.

**`synthesis`** — Ask a "how did X evolve?" or "what pattern emerges?" question. Answer requires reading multiple days and inferring. `relevant_days` is a sampled list.

**`negative-recall`** — Find a topic that is verifiably absent. Ask "did X happen?" Answer: no (or "no evidence in memory"). The hallucination dimension is the canary here — see `docs/recall-bench.md` "The +1: Hallucination."

**`group-session-attribution`** — Pick a group session day with attributed quotes. Ask "who said X?" or "who objected to Y?" Answer must name the speaker. `relevant_days: [N]`.

**`information-boundary`** — Pick a sensitive_topic from an isolated session. Set `query_session` to a *different* session (often `principal` or another isolated one). Set `forbidden_sessions: [<source isolated session>]`. Set `expected_disclosure: refuse | partial | answer` per spec §5.3. Verify the source content actually appears in the named isolated session's H1s (boundary calibration, spec §4.8).

### 8.3 Q&A pair schema (spec §2.4)

```yaml
- id: "<persona-id>-q<NNN>"
  question: "..."
  answer: "..."
  category: factual-recall          # or any of the 10
  difficulty: easy | medium | hard
  temporal_scope: single-day | cross-arc | full-corpus
  relevant_days: [N, ...]
  requires_synthesis: true | false
  query_session: principal          # default; override for boundary tests
  expected_disclosure: answer       # default; override for boundary tests
  forbidden_sessions: []            # populated only for information-boundary
```

### 8.4 Distribution across time ranges

The per-range minimum table (spec §5.4) enforces that boundary tests are also distributed. When choosing `relevant_days`, intentionally spread:
- ~10% within days 1–30 (must clear the `30d` cutoff)
- ~10% within days 1–90
- ~15% within days 1–180
- ~25% within days 1–365
- remainder anywhere in 1–1000

A pair only counts toward a range if **all** its `relevant_days` fall within the cutoff (spec §5.4).

### 8.5 File layout (spec §6.1)

```
qa/
├── questions.yaml              # all pairs in one file (canonical)
└── by-category/
    ├── factual-recall.yaml
    ├── temporal-reasoning.yaml
    └── ...
```

Author into `questions.yaml`; the by-category files are an optional sharded view. Keep them in sync with a generator script if used.

---

## 9. Phase 5 — Q&A validation (spec §4.8)

Three gates, all must pass before publication:

1. **Answer verification** — An independent model (different family or temperature than authoring) answers each question given full corpus access. Substantive disagreement → flag for human review.
2. **Human spot-check** — At least 20% of pairs reviewed by a human. Bias the spot-check toward boundary, negative-recall, and synthesis pairs (highest authoring error rate).
3. **Difficulty calibration** — Run a BM25 baseline (`recall-bench` doesn't ship one yet; build a minimal one with `lunr` or `flexsearch` for this purpose). Pairs that BM25 answers correctly should be tagged `easy`; ones it misses should be `medium`/`hard`.
4. **Boundary calibration** — For every information-boundary pair, verify the named source content actually exists in `forbidden_sessions[]` and is absent from `query_session`.

Validation produces a `qa/validation-report.md` per persona summarizing pass/fail counts.

---

## 10. Per-persona quick reference

| Persona | Agent | Principal | Sessions | Isolated | Stress focus |
|---|---|---|---|---|---|
| `backend-eng-saas` | Forge | River Chen (Sr. Backend Eng) | 4 | 0 | decisions, cross-ref, synthesis, group-attribution |
| `er-physician` | Pulse | Jordan Okafor (ER attending) | 5 | 0 | factual, temporal, recency-bias |
| `litigation-attorney` | Quill | Carmen Vega (Sr. Litigator) | 8 | 4 | factual, decisions, contradictions, cross-ref, **boundary** |
| `research-scientist` | Atlas | Kenji Nakamura (PI) | 5 | 1 | temporal, contradictions, cross-ref, synthesis |
| `financial-advisor` | Sterling | Priya Mehta (Sr. FA) | 8 | 4 | decisions, contradictions, recency-bias, negative-recall, **boundary** |
| `executive-assistant` | Jordan | Jamie Park (CFO) | 9 | 4 | **boundary** (widest sensitive palette), group-attribution, decisions |

The full stress map per persona is in spec §3.4. `executive-assistant` is also the test bed for Project Lobster's interaction model — see comments in its `persona.yaml`.

---

## 11. Common gotchas

- **Coding agents ignore `--temperature` and `--max-tokens`.** `docs/recall-bench.md` "Coding-agent quirks." Configure these via the agent's own config if you need them.
- **Windows subprocess hangs.** `docs/recall-bench.md` "Subprocess termination on Windows" — the CLI uses `taskkill /T /F /PID`. If you see leaked file handles, that path is broken.
- **`isolated: true` sessions must NEVER appear in another session's H1.** Spec §4.7. The grep check in §6.4 is the canary.
- **Correction arcs need both `wrongDay` and `correctedDay` to land.** If one is missing, the correction-resolution Q&A category has no grounding. Verify both days actually emit content.
- **Empty session days emit no H1.** Spec §4.7 / S5. Don't try to fill them — absence is the signal.
- **`principal` is the only reserved session ID.** Spec §2.7 / S3a. All other session names are persona-defined; don't enforce conventions.
- **`@-prefixed cast members are agents.** Day-generator §3.1.3. The persona schema infers `kind: agent` from the leading `@` if `kind` is omitted.
- **Multi-session output and v0.2 single-section output are mutually exclusive.** Spec §3.1.3: when `sessions` is absent, the prompt falls back to v0.2. Mixed output in a corpus is a bug.

---

## 12. Definition of done (whole pipeline)

Before declaring a persona "shipped" (spec §10):

- [ ] 1,000 days emitted, multi-session format, no skipped days
- [ ] Boundary grep clean (sensitive topics only under declared isolated sessions)
- [ ] Consistency report produced and reviewed (Phase 3)
- [ ] 300+ Q&A pairs across all 10 categories
- [ ] Per-range minimums met (30/60/100/150/200)
- [ ] Boundary pair targets met (30–50 for boundary-stressed; 5–10 otherwise)
- [ ] Group-attribution pairs ≥30
- [ ] Validation gates passed (answer verification + 20% human spot-check + difficulty calibration + boundary calibration)
- [ ] All artifacts committed to git with a single commit per persona

When all six personas pass, update `bench.config.yaml` to include them in the default persona list and run `npx recall-bench list --data ./packages/recall-bench/personas` to confirm discovery.

---

## 13. When to stop and ask

Stop and report to the user — don't push through — if:
- Phase 0 reveals deeper architectural changes are needed than the four edits in §4
- Smoke test (Phase 1) produces malformed multi-session output you can't diagnose in <30 minutes
- Per-persona run skips >5 days
- Boundary grep flags a leak you can't trace to a regenerable day
- Q&A validation finds >10% of pairs failing answer verification (suggests systematic authoring error)
- Total cost projection exceeds the user's stated budget

Bring evidence (file paths, line numbers, sampled output) and a recommendation. Don't just describe the problem.
