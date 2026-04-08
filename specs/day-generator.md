# Day Generator — Prompt Spec

**Status:** Draft  
**Author:** Scribe  
**Date:** 2026-04-06  
**Version:** 0.1  
**Parent:** [recall-bench.md](recall-bench.md) §4.3

---

## 1. Purpose

This spec defines the prompt structure, input/output format, and behavioral rules for the **Day Generator** — Pass 1 of the two-pass generation pipeline. The day generator produces one daily memory log per call, sequentially across 1,000 days per persona.

---

## 2. Pipeline Position

```
Arc Planner (done — arcs.yaml files exist)
       │
       ▼
 ┌─────────────────────────────────────────┐
 │  DAY GENERATOR  ◄── this spec           │
 │  Sequential per persona (day 1→1000)    │
 │  Parallel across 5 personas             │
 └─────────────────────────────────────────┘
       │
       ▼
Consistency Checker → Q&A Generator → ...
```

**Call volume:** ~5,000 LLM calls total (1,000 days × 5 personas).  
**Parallelism:** 5 independent streams. Within a stream, each call depends on the previous day's output.

---

## 3. Input Schema

Each call to the day generator receives a structured prompt assembled from these components:

### 3.1 System Prompt (static per persona)

```
You are a daily memory log generator for a synthetic benchmark persona.
Your job is to produce a single day's memory log that reads like a real
agent's daily record — not a story, not fiction, but a working
professional's actual log of what happened today.

Persona: {{persona.name}}
Role: {{persona.role}}
Domain: {{persona.domain}}
Company/Institution: {{persona.company}}
Team size: {{persona.team_size}}

Profile:
{{persona.profile}}

Communication style:
{{persona.communication_style}}

IMPORTANT: Write in the voice and style described above. The log should
sound like {{persona.name}} wrote it, not like an AI describing what
{{persona.name}} did.
```

### 3.2 Day Context (changes every call)

```yaml
day_number: 247
calendar_date: "2024-09-04"  # epoch + day_number - 1
day_of_week: Wednesday
```

### 3.3 Active Arcs (changes every call)

A list of arcs that overlap this day number, annotated with phase:

```yaml
active_arcs:
  - id: payments-v2
    type: project
    title: "Payment processing v2"
    phase: mid          # early | mid | late | concluding
    day_in_arc: 68      # how many days into this arc
    arc_length: 200     # total arc duration
    description: |
      Rebuild the payment pipeline from a single-currency Stripe integration
      to multi-currency support with subscription billing...
    
  - id: graphql-layer
    type: project
    title: "GraphQL API gateway"
    phase: early
    day_in_arc: 5
    arc_length: 200
    description: |
      Introduce an Apollo-based GraphQL gateway...
    
  - id: decision-api-versioning
    type: decision
    title: "API versioning strategy"
    phase: mid
    day_in_arc: 30
    arc_length: 60
    description: |
      Choose between URL-path, header-based, and query-param versioning...
```

**Phase calculation:**
- `early`: day_in_arc < 15% of arc_length
- `mid`: 15%–75%
- `late`: 75%–90%
- `concluding`: >90%

### 3.4 Day Directives (optional, changes every call)

Specific events the generator MUST include on this day. These come from the arc definitions and ensure key plot points land on the right days.

```yaml
directives:
  - arc: payments-v2
    event: "Stripe webhook reliability testing reveals 2.3% drop rate under load"
  - arc: graphql-layer
    event: "Kick-off meeting for GraphQL gateway project"
```

**When directives are absent**, the generator produces a natural continuation of active arcs — routine progress, minor blockers, incremental work.

### 3.5 Correction State (for correction arcs only)

When a correction arc is active and the current day falls in a specific window:

```yaml
correction_state:
  - arc: correction-rate-limit
    phase: wrong_belief   # wrong_belief | correction_day | post_correction
    belief: "API rate limit is 100 requests per second"
    # on correction_day, flip to:
    # corrected_belief: "API rate limit is 1000 requests per second"
```

- **`wrong_belief` phase:** The persona states or relies on the wrong belief as if it were true. It should appear naturally, not forced.
- **`correction_day` phase:** The persona discovers the error. Log should show surprise/context for the correction.
- **`post_correction` phase:** The persona uses the corrected belief. The old belief should never reappear.

### 3.6 Recent History (sliding window)

The previous 3 days of generated logs, provided verbatim. This is the primary continuity mechanism.

```
## Recent days (for continuity — do NOT repeat this content)

### Day 244 (2024-09-01, Sunday)
[full text of day-0244.md]

### Day 245 (2024-09-02, Monday)
[full text of day-0245.md]

### Day 246 (2024-09-03, Tuesday)
[full text of day-0246.md]
```

**Why 3 days, not 5:** Cost control. Each day's log averages ~300–500 tokens. 3 days adds ~1,200 tokens to context; 5 would add ~2,000. The arc descriptions carry the long-range context. If the consistency checker flags too many continuity breaks, bump to 5.

### 3.7 Arc State Summary (optional, for long arcs)

For any arc older than 30 days, include a brief running summary of where that arc stands. This bridges the gap between the 3-day window and the arc description.

```yaml
arc_summaries:
  - id: payments-v2
    summary: |
      Multi-currency support is feature-complete. Currently in QA with
      3 blocking bugs remaining. Webhook reliability fix deployed last
      week, monitoring shows drop rate down to 0.1%. Subscription
      billing module still in design — waiting on product spec.
```

**Who generates these summaries?** The pipeline, not the LLM. After each day is generated, the pipeline updates the arc summary by appending a one-line delta. Every 10 days, the pipeline asks the LLM to compress the summary back to ~100 words. This keeps context manageable without losing coherence.

---

## 4. Output Format

The generator produces a single markdown file with this structure:

```markdown
---
type: daily
day: {{day_number}}
date: "{{calendar_date}}"
persona: {{persona.id}}
arcs: [{{comma-separated active arc IDs}}]
---

# Day {{day_number}} — {{calendar_date}} ({{day_of_week}})

{{body — free-form markdown}}
```

### 4.1 Body Rules

The body is free-form markdown written in the persona's voice. It must follow these rules:

1. **First person.** The persona is writing about their own day.
2. **Past tense.** This is an end-of-day log, not a live stream.
3. **Grounded in arcs.** Every paragraph should relate to at least one active arc or be a natural "life" detail (meetings, breaks, routine tasks).
4. **No meta-references.** Never mention "arcs", "the benchmark", "day number", or any generation infrastructure.
5. **Realistic density variation.** See §5.
6. **Specific details.** Names, numbers, versions, error messages, file paths, dosages, case numbers — whatever is domain-appropriate. Vague logs are useless for benchmarking recall.
7. **Natural cross-references.** When arcs share dependencies (e.g., auth and caching both touch Redis), mention the connection naturally.

### 4.2 Typed Memory Sections (embedded)

On days where a significant decision, learning, or reference emerges, the log MAY include a typed memory block. These are not required every day — perhaps 1 in 5 days includes one.

```markdown
---
name: Webhook retry strategy
description: Chose exponential backoff with jitter, 5 max retries
type: decision
---

Settled on exponential backoff with jitter for webhook retries. Max 5
attempts, base delay 1s, max delay 30s. Considered fixed intervals but
the thundering-herd risk during recovery was too high.
```

These blocks appear inline within the day's log, separated by `---` fences. They mirror the recall service's typed memory format so the benchmark can also test extraction.

---

## 5. Density & Variation

Daily logs must vary realistically. The generator receives a **density hint** computed by the pipeline:

| Hint | Meaning | Target length | When assigned |
|---|---|---|---|
| `quiet` | Low-activity day | 50–150 words | Weekends, holidays, quiet periods in arcs, no directives |
| `normal` | Routine workday | 150–400 words | Most weekdays with 1–2 active arcs |
| `busy` | Heavy day | 400–800 words | Directive-heavy days, arc starts/ends, incidents |
| `dense` | Critical day | 800–1200 words | Major incidents, multi-arc convergences, correction days |

**Distribution target across 1,000 days:**
- `quiet`: ~20% (200 days — weekends + holidays + slow stretches)
- `normal`: ~50% (500 days)
- `busy`: ~25% (250 days)
- `dense`: ~5% (50 days)

The pipeline assigns density hints based on:
- Day of week (Sat/Sun → `quiet` unless an incident is active)
- Number of active arcs
- Presence and importance of directives
- Arc phase (starts and conclusions → bump density)
- Explicit quiet periods from arc definitions

---

## 6. Special Day Types

### 6.1 Arc Start Days

When an arc's `startDay` matches the current day:
- Introduce the arc's topic naturally (first mention, context, why it's starting now)
- Don't dump the full arc description — reveal details incrementally
- The persona should express their initial reaction/assessment

### 6.2 Arc End Days

When an arc's `endDay` matches the current day:
- Wrap up with outcomes, lessons learned, or final status
- Reference back to how things started if relevant
- Provide specific results (metrics, decisions finalized, cases closed)

### 6.3 Incident Days

Incident arcs compress a lot of information into few days:
- Day 1: Discovery, initial triage, escalation
- Middle: Investigation, hypothesis testing, partial fixes
- Final: Resolution, root cause confirmed, post-mortem scheduled
- Post-mortem: Lessons learned, action items (may be 1–2 days after resolution)

Each incident day should be `busy` or `dense`.

### 6.4 Quiet Days

On explicitly quiet days (vacations, holidays, weekends):
- Short or empty log is fine ("Light day. Caught up on email, reviewed one PR.")
- Do NOT advance arcs significantly
- Can include personal context if persona-appropriate

### 6.5 Cross-Reference Days

When multiple active arcs share a dependency or concern:
- Mention the connection explicitly ("The Redis changes for auth are going to affect the caching layer too — need to sync with the payments team on this")
- These are high-value moments for the benchmark's cross-reference category

---

## 7. Prompt Assembly

The pipeline assembles the full prompt in this order:

```
┌─────────────────────────────┐
│  SYSTEM PROMPT (§3.1)       │  ~200 tokens, static per persona
├─────────────────────────────┤
│  USER MESSAGE               │
│  ┌────────────────────────┐ │
│  │ Day Context (§3.2)     │ │  ~30 tokens
│  │ Active Arcs (§3.3)     │ │  ~200–400 tokens (2–4 arcs)
│  │ Directives (§3.4)      │ │  ~0–100 tokens
│  │ Correction State (§3.5)│ │  ~0–50 tokens
│  │ Arc Summaries (§3.7)   │ │  ~0–200 tokens (for arcs > 30 days)
│  │ Density Hint (§5)      │ │  ~10 tokens
│  │ Recent History (§3.6)  │ │  ~1,200 tokens (3 days)
│  └────────────────────────┘ │
└─────────────────────────────┘

Total input: ~1,800–2,200 tokens per call
Total output: ~50–1,200 tokens (varies by density)
```

### 7.1 User Message Template

```
Generate the daily memory log for day {{day_number}}.

Date: {{calendar_date}} ({{day_of_week}})
Density: {{density_hint}}

Active arcs:
{{formatted active_arcs as YAML}}

{{#if directives}}
Today's events (MUST appear in the log):
{{formatted directives}}
{{/if}}

{{#if correction_state}}
Correction state:
{{formatted correction_state}}
{{/if}}

{{#if arc_summaries}}
Arc progress summaries:
{{formatted arc_summaries}}
{{/if}}

Recent days (for continuity — do NOT repeat content from these):
{{recent_history}}

Produce ONLY the markdown content for this day's log, including the
YAML frontmatter. Do not include any explanation or commentary outside
the log.
```

---

## 8. Arc Summary Maintenance

Arc summaries (§3.7) are a lightweight state tracker to bridge the gap between the 3-day history window and the static arc description. They are maintained by the pipeline, not by the LLM during generation.

### 8.1 Update Cycle

After each day is generated:
1. **Extract:** Scan the generated log for sentences referencing each active arc
2. **Append:** Add a one-line delta to the arc's running summary (e.g., "Day 247: webhook drop rate fix deployed")
3. **Compress (every 10 days):** Ask the LLM to compress the running summary back to ~100 words, preserving key facts and current status

### 8.2 Summary Prompt (for compression)

```
Compress this arc progress log into a ~100-word status summary.
Keep: current status, key metrics, blocking issues, recent decisions.
Drop: routine progress, repeated information, resolved issues.

Arc: {{arc.title}}
Running log:
{{running_log}}
```

### 8.3 Storage

Arc summaries are ephemeral — stored in the pipeline's working state, not in the output dataset. They exist only to feed context into subsequent day-generation calls.

---

## 9. Edge Cases

### 9.1 Day 1

No recent history exists. The system prompt carries extra weight. The first day should:
- Establish the persona's baseline situation
- Introduce 1–2 starting arcs naturally
- Set the communication tone for the full stream

### 9.2 Days with No Active Arcs

Rare by design, but possible during quiet periods. Generate a minimal log about routine work, admin tasks, or personal notes. Still write in persona voice.

### 9.3 Arc Overlap Transitions

When one arc is concluding and another is starting on the same day, both should appear in the log but the concluding arc takes priority for detail (wrap-up is harder to reconstruct than a kick-off).

### 9.4 Correction Arc Timing

The wrong belief should appear naturally across multiple days before the correction — not just once. The pipeline should include `wrong_belief` correction state for at least 3–5 days before the correction day, spread across the arc's early phase.

### 9.5 Weekend / Holiday Detection

The pipeline derives weekends from `calendar_date` and should auto-assign `quiet` density for Saturday/Sunday unless an incident arc is active. Holiday dates should be defined per-persona (US holidays for US personas, etc.).

---

## 10. Quality Signals

The consistency checker (§4.4 in recall-bench.md) validates the output, but the generator should aim for these during generation:

1. **No orphaned names.** Don't introduce a person, system, or concept that never appears again (unless it's a one-off interaction that's realistic).
2. **Stable facts.** If a fact is stated (port number, version, dosage, deadline), it should remain consistent across days unless a correction arc changes it.
3. **Progressive detail.** Arcs should reveal information incrementally — early days are high-level, later days have specific metrics and outcomes.
4. **Natural forgetting.** Not every day references every active arc. Some arcs go quiet for a few days, which is realistic and creates recency-bias test opportunities.
5. **Domain-authentic language.** An ER physician writes "POCUS showed free fluid in Morison's pouch" not "the ultrasound showed fluid". A backend engineer writes "bumped the connection pool to 50" not "increased database connections".

---

## 11. Cost Estimate

| Component | Tokens | Notes |
|---|---|---|
| Input per call | ~2,000 | System + context + history |
| Output per call | ~300 avg | Weighted by density distribution |
| Calls per persona | 1,000 | Sequential |
| **Total per persona** | ~2.3M | Input + output |
| **Total (5 personas)** | ~11.5M | Parallelizable |
| Arc summary compression | ~500K | 100 calls × 5 personas × ~1K tokens |
| **Grand total** | ~12M tokens | |

At typical API pricing, this is a manageable single-digit dollar cost per full dataset generation.

---

## 12. Example — Full Input/Output

### Input (abbreviated)

**System prompt:** (River Chen / Backend Eng / Nexus — per §3.1)

**User message:**

```
Generate the daily memory log for day 247.

Date: 2024-09-04 (Wednesday)
Density: busy

Active arcs:
  - id: payments-v2
    type: project
    title: "Payment processing v2"
    phase: mid
    day_in_arc: 68
    arc_length: 200
    description: "Rebuild payment pipeline..."
    
  - id: graphql-layer
    type: project
    title: "GraphQL API gateway"
    phase: early
    day_in_arc: 5
    arc_length: 200
    description: "Introduce Apollo-based GraphQL gateway..."
    
  - id: decision-api-versioning
    type: decision
    title: "API versioning strategy"
    phase: mid
    day_in_arc: 30
    arc_length: 60
    description: "Choose between URL-path, header, query-param..."

Today's events (MUST appear in the log):
  - arc: graphql-layer
    event: "First schema stitching prototype passes integration tests"

Arc progress summaries:
  - id: payments-v2
    summary: "Multi-currency support feature-complete. In QA, 3 blocking bugs.
              Webhook drop rate fix deployed, monitoring at 0.1%. Subscription
              billing in design — waiting on product spec."

Recent days:
[day 244-246 content here]

Produce ONLY the markdown content...
```

### Expected Output

```markdown
---
type: daily
day: 247
date: "2024-09-04"
persona: backend-eng-saas
arcs: [payments-v2, graphql-layer, decision-api-versioning]
---

# Day 247 — 2024-09-04 (Wednesday)

Good progress day. The GraphQL schema stitching prototype passed integration
tests this morning — first time we've had the federated queries resolving
across both the orders and inventory services without manual type wiring.
Apollo Federation v2's `@shareable` directive handled the overlapping `Product`
type cleanly. Took about 90 minutes to get the CI pipeline green because the
test fixtures assumed REST-only responses; had to add GraphQL response
snapshots.

This raises the API versioning question again. If we expose GraphQL alongside
REST, do we version the GraphQL schema independently? Talked to Dana about it
at standup — she's leaning toward treating GraphQL as unversioned (schema
evolution with `@deprecated` fields) while REST keeps URL-path versioning
(`/v2/`, `/v3/`). I'm not sold. If a breaking change hits a federated type
that both REST and GraphQL serve, we'd need coordinated rollouts anyway. Going
to write up the trade-offs in the ADR tomorrow.

On the payments side: QA found a fourth blocking bug — currency conversion
rounding on JPY amounts (zero-decimal currency). The `toSmallestUnit()` helper
was dividing by 100 unconditionally. Fix is one line but the test coverage gap
is embarrassing. Pushed the fix to `payments-v2/fix-jpy-rounding` and tagged
Amir for review.

Still waiting on product for the subscription billing spec. Pinged Marcus
again — he says end of week. Starting to doubt that timeline given the sales
demo prep eating everyone's bandwidth.
```

This example shows:
- **~350 words** (appropriate for `busy` density)
- **3 arcs touched** (graphql-layer, decision-api-versioning, payments-v2)
- **Directive fulfilled** (schema stitching prototype passing tests)
- **Specific details** (Apollo Federation v2, `@shareable`, `toSmallestUnit()`, JPY, branch name)
- **Cross-reference** (API versioning decision connects to GraphQL arc)
- **Named people** (Dana, Amir, Marcus — recurring from earlier days)
- **No typed memory block** (not every day needs one)
- **Natural voice** (River's direct, technical style)

---

## Changelog

| Version | Date | Changes |
|---|---|---|
| 0.1 | 2026-04-06 | Initial draft |
