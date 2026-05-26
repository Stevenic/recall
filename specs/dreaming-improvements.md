# Dreaming improvements: shipped + designed

This spec captures the next batch of dreaming work past the
self-improving wiki design (specs/retrieval-improvements.md §2). Two
items are tracked here:

- **§1** — Trajectory pages (SHIPPED in dream-engine.ts)
- **§2** — Entity rename detection (design only — implement after run 15)

---

## §1 — Trajectory pages (shipped)

### Purpose

Synthesis-category questions ("how did X evolve?", "what did Jordan
keep unchanged across the days?") need chronological context that a
topic-pivoted wiki page doesn't surface cleanly. The agent currently
has `memory_timeline` for this, but it has to stitch the trajectory
itself on every query. A dedicated trajectory companion page lets the
synthesis question land directly on a pre-computed chronology.

### Trigger

Purely structural — no topic-aware heuristics, no LLM call to decide
whether to fire:

```
For each successful applyWikiOp:
  if page.supersedes.length >= 2
  AND page.slug doesn't end in -trajectory:
    create / refresh `<slug>-trajectory` companion
```

Any topic that accumulates two or more supersessions becomes a
candidate. Applies equally to a SaaS engineer's "auth provider"
trajectory, a doctor's "patient X medication" trajectory, or this
bench's "Condor synergy assumptions" trajectory.

### Body shape (templated, no LLM)

```markdown
# Trajectory: {{name}}

This page tracks how {{name}} has evolved. The most current claim
lives in [[{{slug}}]]; superseded claims are preserved here in
chronological order ...

## Current state
As of {{updated}}, see [[{{slug}}]] for the full current body.
Brief excerpt:
{{first paragraph of current body}}

## Superseded claims (oldest first)
- **Until {{supersededOn}}:** {{fact}}
  - Source: {{source}}
...
```

`sources:` on the trajectory page is the union of the source page's
sources plus every URI in `supersedes` entries — so the trajectory
page's frontmatter covers every era it references.

### Cross-linking

The source page gets the trajectory slug appended to its `related:`
field. The trajectory page lists the source slug in its `related:`.
Bidirectional discovery.

### Indexing

The trajectory page is upserted into the index immediately after
writing (same pattern as merge-with-supersession), so subsequent
searches within the same dream session can find it.

### Maintenance

On every applyWikiOp that touches the source page, the trajectory is
re-generated from scratch. This keeps it in sync with the latest body
+ latest supersedes set. Cost is one extra `wiki.write` + index
upsert per source-page write — small.

### Expected score impact

Bench's synthesis category sat at ~40% across baseline runs. The few
synthesis questions we have are explicitly "how did X evolve" — exactly
what trajectory pages target. If the trajectory page ranks well in
retrieval (it should — its body matches the synthesis question shape),
we'd expect:

- Synthesis category: 4.0/6 avg → ~5.0/6 avg
- ~20 synthesis evals in a 60d run × +1.0/6 each = +20 composite
- ~+1.7 percentage points on overall score

Not huge, but real, and the synthesis category is otherwise stuck.

### Implementation cost

~100 lines in `dream-engine.ts`: `_maintainTrajectoryPage()` +
`renderTrajectoryBody()` + `collectTrajectorySources()`. Shipped.

---

## §2 — Entity rename detection (design only)

### Purpose

Real-world memory streams have entity renames. The bench's example:
"Northstar Components" (day 7) → "Northstar Gridworks" (day 14+) for
the Condor target. The merge-with-supersession step handles renames
that happen within a single page's evolution (because day-14's content
gets merged into the existing page). It does NOT handle the case where
two separate wiki pages get created for what's actually the same
entity — the dedup threshold may not catch it when the page names
diverge enough.

### Trigger

Two signals combined:

1. **Source overlap.** Two wiki pages share ≥50% of their cited
   sources. They're likely talking about the same underlying entity.
2. **Name / proper-noun divergence.** The pages' `name` fields don't
   share their dominant proper-noun token.

When both fire, the pair is a candidate for entity merge.

### Verification

One focused LLM call per candidate pair:

```
Page A: "Northstar Components" — sources [day 3, 5, 7, 11]
Page B: "Northstar Gridworks" — sources [day 14, 16, 18]
Question: "Are these the same entity, just renamed?"
```

Output: `{ same: true | false, canonicalSlug: string, oldName: string, supersededOn: string }`

Conservative bias: when unsure, say no. False positives merge two
distinct entities — bad. False negatives keep them separate — fine,
search still finds them.

### Action

When confirmed:

1. Pick the canonical page (the one with the most-recent source).
2. The other page's body is cleared, frontmatter sets `redirectTo` to
   the canonical slug, and `updated` advances.
3. Canonical page gets a `supersedes` entry recording the old name as
   a renamed entity:

```yaml
supersedes:
  - source: wiki:northstar-components  # the obsolete page's slug
    fact: 'Previously known as "Northstar Components" (entity renamed)'
    supersededOn: 2026-01-14
```

4. Trajectory companion (§1) picks up the new supersedes entry on
   the next applyWikiOp.

### Why it lands after trajectory

Two reasons:

1. **Trajectory is purely additive and pure-templated** — no risk of
   merging the wrong entities. Entity-rename can corrupt the wiki if
   the LLM verifier is wrong.
2. **The bench's failure pattern doesn't strongly demand it yet.** The
   merge-with-supersession step already catches the obvious renames
   when they happen within a single page's evolution. Entity rename
   catches the residual case where two separate pages emerge. We'll
   know from run-15 data how often that residual matters.

### Implementation cost

~150 lines: detection scan, LLM verifier, redirect+supersedes action.
Plus one analysis template for the verifier prompt.

### Sequencing post run-15

1. Measure run 15 outcome on trajectory pages.
2. If synthesis category lift is real, ship entity rename next.
3. If not, re-evaluate — maybe the trajectory page's discovery is the
   weak link (retrieval doesn't surface it), in which case fix
   retrieval before adding more dreaming features.
