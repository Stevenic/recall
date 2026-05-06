# Day Generator — Prompt Spec

**Status:** Draft  
**Author:** Scribe  
**Date:** 2026-04-28  
**Version:** 0.3  
**Parent:** [recall-bench.md](recall-bench.md) §4.3, §4.6, §4.7, §2.6, §2.7

---

## 1. Purpose

This spec defines the prompt structure, input/output format, and behavioral rules for the **Day Generator** — Pass 1 of the two-pass generation pipeline. The day generator produces one daily memory log per call, sequentially across 1,000 days per persona.

---

## 2. Pipeline Position

```
Arc Planner (done — arcs-1000d.yaml files exist)
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

**The persona IS the AI agent — a computer program.** The system prompt frames
the LLM as that agent and instructs it to write its own working memory log:
who interacted with it today, what they asked, what it produced, what it
decided, and what it handed off. The log is **not** a first-person human
professional's diary.

#### 3.1.1 Persona Schema

The persona is loaded from `persona.yaml` and passed verbatim into the prompt.
Schema:

```typescript
interface PersonaDefinition {
    id: string;
    name: string;                // the AGENT's name (e.g., "Atlas"), not the human's
    epoch: string;               // ISO date — day 1 of the timeline
    role: string;                // e.g., "AI lab co-pilot for a synthetic biology PI"
    domain: string;
    company?: string;            // either company OR institution may be set
    institution?: string;
    team_size: number;
    profile: string;             // multi-line — describes the agent
    communication_style: string; // multi-line — describes the agent's voice
    projects?: ProjectRef[];
    principal?: PrincipalRef;    // the human the agent primarily serves
    cast?: CastMember[];         // other humans + agents the agent works with
    sessions?: SessionDef[];     // conversation contexts the agent participates in
    sharedKnowledge?: string[];  // facts available to every session at generation time
}

interface PrincipalRef {
    name: string;
    role: string;
    profile?: string;
}

interface CastMember {
    name: string;                // humans by name; agents prefixed with "@"
    role: string;
    kind?: 'human' | 'agent';    // defaults to 'agent' if name starts with '@', else 'human'
}

interface SessionDef {
    id: string;                  // stable slug — e.g., "principal", "lab-meeting", "client-acme"
    kind: '1to1' | 'group';      // authoritative; not derived from participant count
    participants: string[];      // names referencing principal + cast entries
    isolated?: boolean;          // default false; when true, contents must not leak to other sessions
    shared?: boolean;            // default false; when true, contents are visible to other sessions
    firstDay?: number;           // optional lower bound on session activity (1-indexed)
    lastDay?: number;            // optional upper bound; undefined = open-ended
    sensitive_topics?: string[]; // grounding facts that must stay inside this session
}
```

`principal` and `cast` are optional but strongly recommended — without them
the prompt falls back to a generic team frame. `company` is optional;
`institution` is also accepted (academic / hospital / lab personas typically
use `institution`).

#### 3.1.2 Prompt Template

Rendered sections, in order:

```
You are an AI agent named "{{persona.name}}" — a computer program. Your job is to
produce a single day's entry of YOUR OWN memory log, written from your perspective
as the agent. The log records who interacted with you today (humans and other
agents), what they asked, what you did, what you decided, what files or outputs
you produced, and what you handed off.

# Identity
- Name: {{persona.name}}
- Role: {{persona.role}}
- Domain: {{persona.domain}}
- Affiliation: {{persona.institution || persona.company}}     # only if either is set
- Team supported: {{persona.team_size}} people

# Profile
{{persona.profile}}

# Communication style
{{persona.communication_style}}

# Principal — the human you primarily serve     # only if persona.principal is set
- Name: {{persona.principal.name}}
- Role: {{persona.principal.role}}
- Profile:                                       # only if persona.principal.profile is set
    {{persona.principal.profile}}

# Cast — humans and other agents you interact with     # only if persona.cast is non-empty
- {{cast[i].name}} ({{cast[i].kind}}) — {{cast[i].role}}
- ...

# Sessions — conversation contexts you participate in     # only if persona.sessions is non-empty
- {{sessions[i].id}} ({{sessions[i].kind}}{{", isolated" if sessions[i].isolated}}{{", shared" if sessions[i].shared}}) — participants: {{sessions[i].participants}}
  {{#if sessions[i].sensitive_topics}}sensitive topics (must stay in this session): {{sessions[i].sensitive_topics}}{{/if}}
  {{#if sessions[i].firstDay or sessions[i].lastDay}}lifecycle: day {{sessions[i].firstDay || 1}}–{{sessions[i].lastDay || "end"}}{{/if}}
- ...

# Shared knowledge — facts available to every session     # only if persona.sharedKnowledge is non-empty
- {{sharedKnowledge[i]}}
- ...

# How to write the log
- Write in third-person from the agent's perspective. Refer to yourself implicitly
  ("Drafted Aim 2…", "Sent the sgRNA list to Sarah") or by name when needed.
  DO NOT write a first-person human diary ("I came in early…", "Kicking off…").
- Reference humans by name (e.g., "Kenji asked…"). Reference other AI agents with
  @-handles (e.g., "Handed off PubMed query to @lit-search-agent").
- Each section should describe an interaction or unit of work: who initiated it,
  what was asked, what the agent produced or decided, and what files or handoffs
  resulted. Quote the principal's ask verbatim when material.
- Organize by TOPIC, not by clock time. Section titles should name the topic and
  the person involved (e.g., "### Kenji — pKN001 colony screen review").
- List files produced/changed and decisions explicitly. End with an "Outstanding"
  or "Tomorrow" section when follow-up work exists.

# How to partition the log by session
- The day's log is partitioned into **sessions**. Each session is a separate
  conversation context (1:1 with the principal, a group meeting, an isolated
  client room, etc.). Today's active sessions are listed in the user message.
- Render one `# session: <id>` H1 per session that had activity today, in
  canonical order: `principal` first if present, then group sessions in the
  order they were declared in the persona definition. **Skip sessions with no
  activity** — do not emit an empty H1.
- Inside each session H1, organize by topic with H3 sub-sections as described
  above. Topics belong under the session where the interaction actually occurred.
- **Internal narration** (the agent's own scratchpad — reflections, planning,
  cross-session summaries the agent makes for itself) is rendered as
  un-prefixed body content **above** the first `# session:` H1. It is not a
  session and is never quoted as such.
- **Group session attribution.** Inside a group session H1, attribute speakers
  verbatim when their words are load-bearing — e.g.,
  `> Sarah: "We should hold off on the v2 transfection until LNP-7 is ready."`
  Decisions, action items, and dissent must be attributed; never collapse into
  "the team decided." If three participants agreed and one objected, record both.
- **Isolated session no-leak invariant.** When a session is marked `isolated`,
  its `sensitive_topics` are grounded as load-bearing facts under that session's
  H1 only. Never echo a sensitive topic from an isolated session into a different
  session's H1, except into `# session: principal` and only when the principal
  explicitly authorizes the disclosure (the day must record that authorization).
- **Cross-session arc echoes.** When today's user message marks an arc with
  `referencedSessions`, render the arc's content under `primarySession` in detail
  AND emit a brief, attributable echo under each referenced session — a status
  update, briefing, or dissent moment, not a recap. The echo must be consistent
  with the primary content; contradictions are bugs.
- **Shared knowledge** (listed above) may be voiced in any session without
  triggering a leak.

# Required output structure
\```
---
type: daily
---

<optional internal narration — un-prefixed body, before any session H1>

# session: <session-id>

### <topic / interaction title>

<body — narrate the interaction, decision, or output>

### <next topic>
...

# session: <next-session-id>

### <topic / interaction title>
...
\```

Frontmatter is minimal. Use one `# session: <id>` H1 per active session.
Each topic inside a session is an H3. The agent does not perform physical
actions itself (no pipetting, no surgery, no courtroom appearances) — it
drafts, analyzes, searches, summarizes, schedules, and coordinates. Physical
actions are taken by humans, who report results back to the agent.
```

#### 3.1.3 Conditional Rendering Rules

- The `Affiliation` line is omitted when both `institution` and `company` are absent.
- `# Principal` block is omitted entirely when `persona.principal` is absent.
- The nested `Profile:` line under Principal is omitted when `persona.principal.profile` is absent.
- `# Cast` block is omitted when `persona.cast` is empty or absent.
- `kind` defaults to `'agent'` when `name` starts with `@`, else `'human'`.
- `# Sessions` block is omitted when `persona.sessions` is empty or absent. When omitted, the `# How to partition the log by session` instructions and the multi-session output structure are also omitted; the day-generator falls back to a single-section log under one H2 (the v0.2 format). Personas without a declared `sessions:` block are treated as legacy single-session.
- `# Shared knowledge` block is omitted when `persona.sharedKnowledge` is empty or absent.
- Inside each `Sessions` line, the `isolated` and `shared` annotations only render when their respective fields are true.
- The `sensitive topics` line is omitted when `sensitive_topics` is absent.
- The `lifecycle` line is omitted when both `firstDay` and `lastDay` are absent.

**Reference implementation:** `packages/recall-bench/src/generator.ts` →
`buildSystemPrompt`.

### 3.2 Day Context (changes every call)

```yaml
day_number: 247
calendar_date: "2024-09-04"  # epoch + day_number - 1
day_of_week: Wednesday
```

### 3.3 Active Arcs (changes every call)

A list of arcs that overlap this day number, annotated with phase and session affinity:

```yaml
active_arcs:
  - id: payments-v2
    type: project
    title: "Payment processing v2"
    phase: mid          # early | mid | late | concluding
    day_in_arc: 68      # how many days into this arc
    arc_length: 200     # total arc duration
    primarySession: principal           # where deep work happens
    referencedSessions: [standup]       # natural-touchpoint echoes
    echo_today: false                    # pipeline flag — should this arc echo today?
    description: |
      Rebuild the payment pipeline from a single-currency Stripe integration
      to multi-currency support with subscription billing...
    
  - id: graphql-layer
    type: project
    title: "GraphQL API gateway"
    phase: early
    day_in_arc: 5
    arc_length: 200
    primarySession: design-review
    referencedSessions: [principal, standup]
    echo_today: true                     # sprint boundary — surface in standup
    description: |
      Introduce an Apollo-based GraphQL gateway...
    
  - id: decision-api-versioning
    type: decision
    title: "API versioning strategy"
    phase: mid
    day_in_arc: 30
    arc_length: 60
    primarySession: principal
    referencedSessions: []
    description: |
      Choose between URL-path, header-based, and query-param versioning...
```

**Session affinity fields:**

- `primarySession` — the session this arc primarily unfolds in. The day-generator emits the arc's deep content under this session's H1.
- `referencedSessions` — sessions that get attributable echoes at natural touchpoints. The pipeline sets `echo_today: true` when today is a touchpoint (sprint boundary, decision moment, status point); the generator must emit a brief echo in each referenced session on those days. On other days the generator should not echo the arc to its referenced sessions.
- For arcs whose `primarySession` is itself an isolated session, the deep content belongs only in that session's H1; cross-references into `principal` are allowed but only if the persona explicitly authorizes the disclosure (the day must record that authorization).

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

### 3.8 What Kind of Work the Agent Does

The persona is a software agent, not a person with hands. This shapes what
events end up in the daily log.

**The agent does NOT perform physical actions.** No pipetting, no surgery, no
suturing, no courtroom appearances, no IV starts, no client lunches, no
handshakes. Humans on the team perform those, then **report results back** to
the agent — typically as the body of an interaction the agent records.

**The agent's actual work is informational:**

- **Drafts** — experimental plans, grant text, ADRs, briefs, treatment notes, IEPs, model memos
- **Analyzes** — sequencing reads, lab values, contract clauses, financials, telemetry, code diffs
- **Searches and summarizes** — literature, case law, prior art, internal docs, ticket history
- **Schedules** — meetings, follow-ups, reagent orders, court filings, deadlines
- **Coordinates and hands off** — to specialist agents (e.g., `@stats-agent`,
  `@lit-search-agent`) and to humans on the team

A typical log entry therefore reads as: *"Sarah came back with the colony
screen results — 11/24 positive. Atlas re-ran the analysis with the corrected
primer set, drafted the figure caption, and queued the next round of cloning
with @order-agent."* The physical work (the colony screen) is reported to the
agent; the agent's own work (re-analysis, drafting, ordering handoff) is what
gets recorded as agent activity.

**Why this matters for benchmarking:** the recall test set is built from the
agent's logs, so what the agent records determines what's recallable.
Clamping the agent to informational work keeps the dataset aligned with
realistic agentic-memory use cases (assistant-style AI), not with
human-professional first-person journaling.

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
sessions: [{{comma-separated session IDs that have content today}}]
---

{{optional internal narration — un-prefixed body, before any session H1}}

# session: {{session_id}}

{{H3-organized topics for this session}}

# session: {{next_session_id}}

{{H3-organized topics for this session}}
```

The `sessions` frontmatter list is **derived** by the harness from the `# session:` H1s actually present in the body — the generator does not author it. Pre-H1 internal narration is never listed there.

For personas without a `sessions:` block, fall back to the legacy v0.2 single-section format: a single `## YYYY-MM-DD` H2, no `# session:` H1s, body is unpartitioned. The harness exposes the entire body as one synthetic session called `principal` with `kind: 1to1` for adapter compatibility.

### 4.1 Body Rules

The body is free-form markdown written as the AI agent's working memory log. It must follow these rules:

1. **Third person, agent narrator.** The agent is recording its own day — interactions, decisions, files produced, handoffs. Refer to the agent implicitly ("Drafted Aim 2…") or by name when needed. **DO NOT write a first-person human diary** ("I came in early…", "Kicking off…"). Humans are referenced by name (`Kenji asked…`); other agents by `@-handle` (`Handed off to @lit-search-agent`).
2. **Past tense.** This is an end-of-day log, not a live stream.
3. **Grounded in arcs.** Every topic should relate to at least one active arc or be a natural agent-routine detail (handoffs, scheduled summaries, queue status).
4. **Organize by topic, not clock time.** Each H3 names the topic and the person involved (e.g., `### Sarah — colony screen review`), not `### 9:00 AM`.
5. **Partition by session.** Each topic belongs under the `# session: <id>` H1 where the interaction actually happened. Skip session H1s that have no activity today (do not emit empty H1s). See §4.3 for full session-rendering rules.
6. **No meta-references.** Never mention "arcs", "the benchmark", "day number", or any generation infrastructure.
7. **Realistic density variation.** See §5.
8. **Specific details.** Names, numbers, versions, error messages, file paths, dosages, case numbers — whatever is domain-appropriate. Vague logs are useless for benchmarking recall. Quote the principal's ask verbatim when material.
9. **Natural cross-references.** When arcs share dependencies (e.g., a sgRNA reused across two experiments), mention the connection naturally — but only inside sessions where both arcs are visible. Cross-references from isolated sessions are bounded by the no-leak invariant (§4.3).
10. **End each session's content with `Outstanding` or `Tomorrow`** when follow-up work exists in that session. The principal session, being the trusted aggregator, may carry consolidated outstanding items spanning multiple sessions.

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

These blocks appear inline within the day's log, separated by `---` fences. They mirror the recall service's typed memory format so the benchmark can also test extraction. A typed memory block lives **inside** the session H1 where the underlying interaction occurred — it does not float above the first session H1, and it does not span sessions.

### 4.3 Session-Aware Rendering

This subsection codifies the rules for partitioning a day across sessions. They reinforce the broader rules in `recall-bench.md` §2.6, §2.7, §4.6, and §4.7.

#### Section ordering

`# session: principal` (if the day has activity there) appears first. Group sessions follow in the order they were declared in `persona.yaml`. The harness does not depend on order, but stable order keeps day files diff-friendly.

#### Internal narration (pre-H1 body)

Optional. Use it for the agent's own reflections, planning notes, or cross-session summaries the agent maintains for itself. Keep it brief (1–3 short paragraphs); deep work belongs inside a session. Never quote it as if it came from a session.

#### Group session attribution rules (mirrors recall-bench §4.6)

1. **Quote load-bearing statements verbatim** with explicit speaker attribution:
   `> Sarah: "We should hold off on the v2 transfection until LNP-7 is ready."`
2. **Attribute decisions, action items, and dissent** to specific participants. Never collapse into "the team decided." If three agreed and one objected, record both.
3. **Attribute background context** when prior shared knowledge is referenced: `Sarah had previously raised this in lab-meeting on day 142.`

#### Isolated session no-leak invariant (mirrors recall-bench §4.7)

1. `sensitive_topics` declared on an isolated session are grounded as load-bearing facts under that session's H1 only.
2. The same sensitive topic must **not** appear under any other session's H1 — including `principal` — unless the day records the principal explicitly authorizing the disclosure.
3. Authorization itself is recorded as an attributable interaction inside `# session: principal`: `Kenji authorized the agent to brief the case-strategy team on the procedural posture of Acme, with no privileged content.`
4. The consistency checker flags any sensitive-topic phrase appearing outside its declared home as a generation-time leak (recall-bench §4.4).

#### Cross-session arc echoes

When the user message marks `echo_today: true` for an arc with non-empty `referencedSessions`:

1. Render the arc's deep content under the `primarySession` H1 (full detail).
2. Emit a brief, attributable echo under each referenced session — typically a status update, briefing, decision moment, or dissent capture. An echo is 1–3 sentences, not a recap.
3. The echo must be consistent with the primary content. Stating "v2 is on track" in `principal` and "v2 is blocked" in `standup` on the same day is a generation bug.
4. When `echo_today: false`, do not emit the arc into its referenced sessions — keep the test surface clean.

#### Shared knowledge

Items in `persona.sharedKnowledge` may be voiced inside any session at any time without triggering a leak. Use them sparingly — they're meant for genuinely-cross-cutting facts ("the lab uses Nextflow for RNA-seq"), not as a backdoor for sensitive content.

#### Empty days and quiet sessions

If the day has only internal narration and no session activity, emit only the pre-H1 body and no `# session:` H1s. If today is a quiet day for a particular session, simply omit its H1 — absence is the signal.

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
│  SYSTEM PROMPT (§3.1)       │  ~250–350 tokens, static per persona
│                             │  (sessions + shared knowledge add ~50–150)
├─────────────────────────────┤
│  USER MESSAGE               │
│  ┌────────────────────────┐ │
│  │ Day Context (§3.2)     │ │  ~30 tokens
│  │ Active Sessions (§7.1) │ │  ~30–100 tokens
│  │ Active Arcs (§3.3)     │ │  ~200–400 tokens (2–4 arcs)
│  │ Directives (§3.4)      │ │  ~0–100 tokens
│  │ Correction State (§3.5)│ │  ~0–50 tokens
│  │ Arc Summaries (§3.7)   │ │  ~0–200 tokens (for arcs > 30 days)
│  │ Density Hint (§5)      │ │  ~10 tokens
│  │ Recent History (§3.6)  │ │  ~1,200–1,500 tokens (3 days, multi-session)
│  └────────────────────────┘ │
└─────────────────────────────┘

Total input: ~1,900–2,500 tokens per call
Total output: ~50–1,500 tokens (varies by density and number of active sessions)
```

### 7.1 User Message Template

```
Generate the daily memory log for day {{day_number}}.

Date: {{calendar_date}} ({{day_of_week}})
Density: {{density_hint}}

{{#if active_sessions}}
Active sessions today (emit a `# session: <id>` H1 only for sessions with real
activity; skip the rest):
{{formatted active_sessions}}
{{/if}}

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
the log. Write as the AI agent in third person — record interactions,
decisions, files produced, and handoffs. Do NOT write a first-person
human diary. Partition the body by session using `# session: <id>` H1s
as specified in the system prompt; honor the isolated-session no-leak
invariant.
```

#### Active sessions block (per call)

The pipeline assembles the `active_sessions` list each day from the persona's `sessions:` block plus today's arc activity:

```yaml
active_sessions:
  - id: principal
    kind: 1to1
    expected_activity: yes              # principal-1:1 is "on" any day there's content
  - id: lab-meeting
    kind: group
    expected_activity: yes              # weekly cadence places it on this day
    cadence_note: "Weekly Monday lab meeting"
  - id: collab-chen
    kind: group
    isolated: true
    expected_activity: maybe
    cadence_note: "Within active window day 350–650; activate when arc has content"
    sensitive_topics:
      - "Chen Lab's proprietary LNP formulations"
      - "IP and authorship negotiations"
```

The generator should emit a `# session:` H1 only for sessions with real activity; the `expected_activity` and `cadence_note` fields are hints, not requirements. Sessions outside their `firstDay`/`lastDay` lifecycle window are excluded by the pipeline.

### 7.2 User Message Variants

The reference implementation has three user-message builders, all sharing the
trailing reinforcement above:

| Builder | Used by | Purpose |
|---|---|---|
| `buildUserMessage` | One-shot day generation | Full context: all active arcs, directives, correction state, arc summaries, recent history |
| `buildArcUserMessage` | Pass 1 (arc-by-arc) | Focused on one **PRIMARY arc**; other active arcs listed only as background; supports merging into `EXISTING LOG` when an earlier arc already produced content for the day |
| `buildGapUserMessage` | Pass 2 (gap-fill) | Routine/light day — active arcs may be mentioned in passing, no major events; density forced to `quiet` |

**All three variants end with the same reinforcing instruction:** *"Write as
the AI agent in third person — record interactions, decisions, files
produced, and handoffs. Do NOT write a first-person human diary."* This is
deliberate redundancy — the system prompt establishes the framing once, and
each user message reinforces it, because a single instance is not enough to
prevent the LLM from defaulting to a first-person human voice (especially
mid-stream after several days of generation).

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

This example uses the `research-scientist` persona (`Atlas` — an AI lab
co-pilot serving Kenji Nakamura) and demonstrates the **multi-session day
file format** introduced in v0.3. The day shows internal narration, a
`# session: principal` H1 with deep deliberation, a `# session: lab-meeting`
H1 with verbatim group attribution, and a `# session: collab-chen` H1 with
isolated-session content carrying a `sensitive_topic`.

### Input (abbreviated)

**System prompt:** rendered from `packages/recall-bench/personas/research-scientist/persona.yaml` per §3.1.2 — includes Identity (Atlas / AI lab co-pilot / Pacific State University), Profile, Communication style, Principal (Kenji Nakamura), Cast (Sarah, Marcus, Lin, Patel, Dr. Wei Chen, Lab manager, Dept. chair, `@lit-search-agent`, `@seq-design-agent`, `@stats-agent`, `@order-agent`), Sessions (`principal`, `lab-meeting`, `course-staff`, `tenure-review`, `collab-chen` — isolated, day 300–700, sensitive: Chen Lab proprietary LNP formulations and IP/authorship), and Shared knowledge (lab uses Nextflow/nf-core after pipeline rebuild; biosafety paperwork through lab manager).

**User message:**

```
Generate the daily memory log for day 415.

Date: 2025-02-19 (Wednesday)
Density: busy

Active sessions today:
  - id: principal
    kind: 1to1
    expected_activity: yes
  - id: lab-meeting
    kind: group
    expected_activity: yes
    cadence_note: "Weekly Wednesday lab meeting"
  - id: collab-chen
    kind: group
    isolated: true
    expected_activity: yes
    cadence_note: "Active arc — LNP-4 cytotoxicity discrepancy under investigation"
    sensitive_topics:
      - "Chen Lab's proprietary LNP-4 formulation chemistry"
      - "IP and authorship negotiations between Nakamura Lab and Chen Lab"

Active arcs:
  - id: crispr-circuit
    type: project
    title: "CRISPR toggle switch circuit engineering"
    phase: mid
    day_in_arc: 415
    arc_length: 800
    primarySession: principal
    referencedSessions: [lab-meeting]
    echo_today: true
    description: "Core research project — bistable dCas9 toggle switch..."

  - id: collab-drug-delivery
    type: project
    title: "LNP collaboration with Chen Lab"
    phase: mid
    day_in_arc: 65
    arc_length: 300
    primarySession: collab-chen
    referencedSessions: [principal]
    echo_today: true
    description: "Cross-lab collaboration on lipid nanoparticle delivery..."

  - id: correction-lnp-toxicity
    type: correction
    title: "LNP-4 cytotoxicity"
    phase: early
    day_in_arc: 35
    arc_length: 220
    primarySession: collab-chen
    referencedSessions: [principal]
    echo_today: false
    description: "Wrong belief: LNP-4 has <5% cytotoxicity (correction not yet known)..."

Correction state:
  - arc: correction-lnp-toxicity
    phase: wrong_belief
    belief: "LNP-4 formulation has <5% cytotoxicity at therapeutic doses"

Today's events (MUST appear in the log):
  - arc: crispr-circuit
    event: "v3 EF1α-driven cardiomyocyte data review — 11.2-fold dynamic range achieved"

Recent days: [day 412–414 content here]

Produce ONLY the markdown content...
```

### Expected Output

```markdown
---
type: daily
day: 415
date: "2025-02-19"
persona: research-scientist
arcs: [crispr-circuit, collab-drug-delivery, correction-lnp-toxicity]
sessions: [principal, lab-meeting, collab-chen]
---

Wednesdays carry both lab meeting and the standing Chen Lab call this quarter,
so Atlas pre-staged the v3 cardiomyocyte data summary and the LNP-4 cytotoxicity
panel before either meeting opened. Cross-checked that the v3 dynamic-range
result and the LNP-4 cytotoxicity number live in different rooms; Kenji's
standing rule on the Chen collaboration applies.

# session: principal

### Kenji — v3 cardiomyocyte data review

Kenji opened the morning with the overnight flow data: "Atlas, pull the v3
mCherry/GFP ratios from last night's run and tell me whether we cleared the
10-fold bar." Atlas parsed `KN_toggle_v3/data/flow_2025-02-18/` against the
v3 reference panel and logged
`KN_toggle_v3/data/flow_2025-02-18/v3_dynamic_range_summary.md`:

- ON/OFF ratio (mean of n=3): **11.2-fold** (95% CI 9.8–12.6)
- Hysteresis demonstrated across two induction cycles (dox→withdrawal→dox)
- Cell viability post-induction: 92% (LDH-based assay).

Kenji's call: v3 clears the R01 Aim 2 quantitative bar (≥10-fold ON/OFF for
≥72h, hysteresis required). Atlas updated `grants/R01_aim2_evidence.md` with
the figure and the day-415 raw data pointer. Kenji asked Atlas to surface
the headline number in lab-meeting today but to hold the cell-line-switch
backstory for the team — "we'll do the cardiomyocyte rationale separately
next week."

### Kenji — LNP collaboration status (briefing for principal)

Atlas summarized the open Chen-Lab thread for Kenji: LNP-4 efficiency
numbers are tracking with prior runs, but Marcus's parallel cytotoxicity
read in the Nakamura lab is showing higher numbers than the Chen Lab
report. Atlas flagged the discrepancy as a question to raise on the Chen
call, without quoting the Chen-side formulation details. Kenji: "Don't
press them on chemistry today — get their assay protocol first, we'll
benchmark our own assay against theirs."

### Outstanding

- v3 figure caption for R01 Aim 2 evidence file (Atlas, by Friday).
- Cardiomyocyte rationale write-up for next week's lab-meeting.
- Pre-read for the Chen call (assay protocol request only).

# session: lab-meeting

Weekly Wednesday lab meeting — Kenji, Sarah, Marcus, Lin, Patel, lab manager.

### v3 toggle switch — milestone announcement

Kenji opened with the v3 result. Atlas projected the
`v3_dynamic_range_summary.md` headline.

> Sarah: "11.2-fold is the highest we've seen across any version. Did the
> hysteresis hold past 72 hours?"

Atlas confirmed: hysteresis verified at 72h and 96h timepoints; degradation
begins around 120h.

> Marcus: "Are we sure the high baseline isn't an EF1α artifact? CMV gave
> us a cleaner OFF state."

Kenji: EF1α was the right call given the cardiomyocyte silencing on CMV;
baseline noise is the price. Decision: lock in EF1α for the v3 line. Marcus
flagged dissent for the record but accepted the decision.

### RNA-seq pipeline — Marcus rollout update

Marcus reported the Nextflow/nf-core pipeline is now the lab default —
legacy Perl scripts retired Friday. All new analyses go through nf-core;
historical re-runs handled case-by-case. Atlas filed `pipeline_rollout_2025-02-19.md`
with Marcus's rollout checklist.

### Outstanding

- Lin to write the v3 result up for the next lab meeting (Marcus second-author).
- Marcus to publish the nf-core onboarding doc to the lab wiki.

# session: collab-chen

Standing Wednesday call — Kenji, Atlas, Dr. Wei Chen.

### LNP-4 cytotoxicity discrepancy — assay protocol exchange

Atlas opened with Kenji's authorized framing: surface the discrepancy,
request the Chen Lab assay protocol, hold off on chemistry questions.

> Dr. Chen: "Our LNP-4 panels show under 5% cytotoxicity at therapeutic
> doses — we've run it three times. What assay are you using?"

Marcus's data (relayed through Atlas): MTT-based readout, dose 4 µg/mL,
3% cytotoxicity in our hands too. Discrepancy is not in the MTT result.
Dr. Chen agreed to send the full LNP-4 cytotoxicity protocol document
this week (Chen Lab internal naming `cytotox_LNP4_v2.md`).

> Kenji: "Once we have the protocol, Marcus will benchmark our LDH assay
> against MTT side-by-side. If LDH gives a different number, we'll know
> the discrepancy is assay sensitivity, not formulation."

Working hypothesis carried forward: LNP-4 cytotoxicity is <5% at
therapeutic doses (per Chen Lab MTT data). Atlas filed
`collab_chen/lnp4_cytotox_2025-02-19.md` under the collaboration folder
only — not cross-linked into the principal-1:1 brief per Kenji's standing
rule on Chen formulation details.

### Authorship — Q2 manuscript draft

Dr. Chen raised authorship for the upcoming joint manuscript.

> Dr. Chen: "I'd like Liu first-author on the LNP side, your group second
> bloc — does that work?"

Kenji: agreed in principle, deferred final order until figure assignments
land. Atlas logged the conversation in
`collab_chen/authorship_negotiation_log.md` (collaboration-only).

### Outstanding

- Wait on Chen Lab cytotoxicity protocol document.
- Marcus to schedule LDH-vs-MTT side-by-side once the protocol arrives.
- Authorship: revisit after figure assignments (target end of Q2).
```

This example shows:
- **Multi-session H1 grammar** — three `# session:` H1s in canonical order (`principal` first, then group sessions in declaration order: `lab-meeting`, `collab-chen`)
- **Pre-H1 internal narration** — Atlas's own reflection on cross-session staging, before the first H1
- **Frontmatter `sessions:` list** — derived by the harness, lists the three active session IDs
- **Cross-session arc echo** — the `crispr-circuit` v3 result has deep content under `# session: principal` and a brief, attributable echo under `# session: lab-meeting` (consistent: 11.2-fold in both)
- **Group session attribution** — verbatim quotes (`> Sarah:`, `> Marcus:`, `> Dr. Chen:`); Marcus's dissent on EF1α explicitly recorded, not collapsed
- **Isolated session no-leak invariant** — Chen Lab's LNP-4 chemistry stays inside `# session: collab-chen`; the principal-side briefing references "the discrepancy" without naming Chen Lab formulation details, per Kenji's standing rule. Authorization is recorded in `# session: principal` ("get their assay protocol first")
- **Sensitive topic grounded in its session** — LNP-4 cytotoxicity numbers, authorship negotiation, and Chen Lab protocol documents all live under `collab-chen` only
- **Per-session Outstanding sections** — each session ends with its own follow-ups; principal's outstanding spans the day's themes
- **Files filed under their session's folder** — `collab_chen/...` for collaboration-only, no cross-linking
- **No physical actions by Atlas** — humans run experiments and report; Atlas drafts, parses, logs, files (per §3.8)

---

## Changelog

| Version | Date | Changes |
|---|---|---|
| 0.1 | 2026-04-06 | Initial draft |
| 0.2 | 2026-04-28 | **Reframed: persona IS the AI agent, not the human it serves.** §3.1 system prompt rewritten as the agent-narrator template (Identity / Profile / Communication style / Principal / Cast / How to write the log / Required output structure) implemented in `generator.ts → buildSystemPrompt`. §3.1.1 added persona schema with new `principal?` and `cast?` fields; `company` made optional, `institution?` added. §3.1.3 added conditional rendering rules. §3.8 added "What kind of work the agent does" — agent does informational work only (no physical actions). §4.1 body rules: rule 1 changed from "First person" to "Third person, agent narrator"; added topic-organized rule (4) and `Outstanding`/`Tomorrow` rule (9). §7.1 user-message template gains a trailing reinforcement: "Write as the AI agent in third person… Do NOT write a first-person human diary." §7.2 added — documents the three user-message variants (`buildUserMessage`, `buildArcUserMessage`, `buildGapUserMessage`) and notes all three end with the same reinforcement. §12 example replaced with research-scientist (Atlas) third-person agent-narrator log. |
| 0.3 | 2026-04-28 | **Multi-session day file format.** Aligns with `recall-bench.md` v0.5 (§2.6, §2.7, §4.6, §4.7). §3.1.1 persona schema gains `sessions?: SessionDef[]` and `sharedKnowledge?: string[]`. §3.1.2 prompt template adds `# Sessions` and `# Shared knowledge` blocks, plus a new `# How to partition the log by session` section covering canonical ordering, internal narration as pre-H1 body, group session attribution rules, isolated session no-leak invariant, cross-session arc echoes. §3.1.3 conditional rendering rules expanded (sessions/sharedKnowledge optional; legacy single-session fallback when `sessions:` is absent). §3.3 active arcs gain `primarySession`, `referencedSessions`, and `echo_today` fields. §4 output format restructured: frontmatter gains derived `sessions:` list; pre-H1 body = optional internal narration; `# session: <id>` H1 per active session; empty sessions skipped. §4.1 body rules updated: new rule 5 (partition by session) and rule 9 (cross-references bounded by no-leak invariant); per-session Outstanding sections (rule 10). §4.2 typed memory blocks scoped to a single session. §4.3 NEW — Session-Aware Rendering, codifying section ordering, internal narration, group attribution (mirrors recall-bench §4.6), isolated-session no-leak invariant (mirrors recall-bench §4.7), cross-session arc echo rules, shared knowledge, and quiet-session handling. §7.1 user message template adds an `Active sessions today` block and a closing reinforcement to honor the no-leak invariant. §12 example replaced with a multi-session research-scientist day (day 415: principal + lab-meeting + collab-chen, with verbatim group attribution, dissent capture, isolated-session sensitive_topic enforcement, cross-session arc echo for `crispr-circuit`, and authorization recorded in principal). |
