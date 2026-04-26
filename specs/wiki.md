# Wiki System — Design Spec

**Status:** Draft
**Author:** Scribe
**Date:** 2026-04-26
**Version:** 0.2
**Parent specs:** [memory-service.md](./memory-service.md) v0.3, [hierarchical-memory.md](./hierarchical-memory.md) v0.4, [dreaming.md](./dreaming.md) v0.1

---

## 1. Overview

The Wiki is a **persistent, structured knowledge graph** that sits alongside Recall's eidetic logs. Where daily/weekly/monthly logs are temporal, the wiki is **topical** — each page is everything the memory holds about a single entity, concept, or theme, with cross-references to related pages.

Wiki pages have two write modes:

- **Agent stubs** — written in real time during a conversation (single source, short body, captures one observation). Replaces the legacy `<type>_<topic>.md` typed-memory layer.
- **Synthesized pages** — written by dreaming after a topic has accumulated 3+ sources (rich body, cross-references, contradiction tracking).

A stub becomes a synthesized page naturally as more sources arrive. Same file, same slug, same `[[link]]` syntax — `len(sources)` is the only signal that distinguishes them.

Pages are searchable through the same Vectra index as every other memory, but receive a configurable **score boost** because they represent compiled, cross-referenced knowledge rather than raw history.

### Problem

Recall v0.1 had three persistence layers:

1. **Raw logs** (`memory/YYYY-MM-DD.md`) — immutable temporal record
2. **Typed memories** (`memory/<type>_<topic>.md`) — atomic durable facts in four hard-coded categories (`user`, `feedback`, `project`, `reference`)
3. **WISDOM.md** — distilled principles + drifted topical content

Two problems:

- **No compounding synthesis.** Querying for a concept that has accumulated context over many months requires the LLM to retrieve and re-synthesize fragments on every query. Nothing is *built up*. WISDOM.md has been absorbing topical content (e.g., "Architecture docs should trace the full path") that doesn't really belong there — it's a principle, but the underlying knowledge graph is missing.
- **Typed memories overlap with wiki synthesis.** A typed memory like `feedback_database-mocks.md` (rule + why + how-to-apply) and a hypothetical wiki page `database-mocking.md` (synthesis over many sources) cover the same conceptual territory. Maintaining both creates a "is this typed or wiki?" judgment call on every durable write.

Karpathy's "LLM Wiki" pattern (https://karpathy.bearblog.dev/llm-wiki/, 2026) frames this as a compounding artifact: cross-references are pre-computed, contradictions are pre-flagged, synthesis already reflects everything the agent has read. The wiki keeps getting richer with every source ingested and every question asked.

### Solution

Collapse the three durable layers into two — **raw logs** (history) and **wiki pages** (everything topical). Concretely:

1. **Page-per-topic** — One markdown file per entity, concept, project, reference, or theme (e.g., `wiki/auth-middleware.md`, `wiki/postgres-migration.md`)
2. **Cross-reference links** — Wiki-relative links (`[[entity-name]]`) connect related pages
3. **Source provenance** — Every page lists the raw memories it was derived from (`sources: [...]` frontmatter)
4. **Vectra-indexed with priority boost** — Wiki pages search alongside other memories but rank higher (configurable multiplier ~1.2–1.5×)
5. **Two write modes** — Agent writes stubs in real time (1 source); dreaming enriches into synthesized pages (3+ sources). Same file format throughout.
6. **Replaces typed memories** — The `<type>_<topic>.md` filename convention is retired. The four typed categories (`user`, `feedback`, `project`, `reference`) become wiki page categories with per-category templates that preserve the typed-memory write conventions (see §3.4).
7. **Replaces dreaming insight files** — Wiki pages are also the primary output of the dreaming pipeline.
8. **Regenerable** — Any wiki page can be rebuilt from its `sources` list, preserving the "summaries assist recall, never replace source data" wisdom

### Design Principles

- **Wiki is synthesis, not source** — Raw logs remain the permanent source of truth. Wiki pages are regenerable views over them.
- **Topical, not temporal** — Wiki pages are organized by *what they're about*, not *when they happened*.
- **One page per topic** — A topic that warrants a wiki page warrants exactly one. Splits (e.g., "auth-middleware-jwt" + "auth-middleware-cookies") are handled with sub-headings, not sibling pages.
- **Cross-references are free pointer expansion** — The pointer-expansion mechanism from hierarchical memory applies natively: a wiki page's `[[links]]` are pointers; recall fetches and reranks linked pages on demand.
- **Score boost, not hard reorder** — Wiki pages get a configurable multiplier on retrieval scores. Temporal queries can still surface raw logs at the top when they genuinely score higher.
- **Stubs are first-class** — A single-source observation written by the agent in real time is a valid wiki page. It will accumulate sources over time. The wiki is never gated on "synthesis quality" alone — agent observations seed the graph.
- **Per-category discipline** — Each category carries a template that codifies the write conventions (see §3.4). Concept stubs lead with a rule + **Why:** + **How to apply:**, project stubs with fact + **Why:** + **How to apply:**, etc. This preserves the discipline that made typed memories useful.
- **No silent edits** — Every wiki update produces a diary entry in DREAMS.md (when written by dreaming) or a daily-log line (when written by the agent). Pages are versioned through git, not in-file revision history.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Search Layer                             │
│  (raw logs · weekly · monthly · typed · wisdom · WIKI)      │
│                          ▲                                  │
│                          │ score boost (wiki)               │
│                          │                                  │
│  ┌─────────────────────────────────────────────────────────┐│
│  │             Wiki Layer (memory/wiki/)                   ││
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   ││
│  │  │ entity/  │ │ concept/ │ │ project/ │ │ index.md │   ││
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘   ││
│  └────────────────────────▲────────────────────────────────┘│
│                           │ creates/updates                 │
│  ┌────────────────────────┴────────────────────────────────┐│
│  │              DreamEngine (Synthesis)                    ││
│  └────────────────────────▲────────────────────────────────┘│
│                           │ reads                           │
│  ┌────────────────────────┴────────────────────────────────┐│
│  │  Raw logs · Typed memories · WISDOM.md · Search log     ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

| Component | Responsibility |
|-----------|---------------|
| **WikiEngine** | Read/write wiki pages (stubs and synthesized), maintain index, validate links, provide regeneration commands |
| **Agent (in conversation)** | Writes single-source stubs in real time, replacing the old typed-memory write path |
| **DreamEngine (extended)** | Enriches stubs into multi-source synthesized pages; merges, contradicts, refactors |
| **SearchService (extended)** | Apply wiki score boost during ranking; treat wiki pages as first-class memories |
| **MemoryFiles (extended)** | Add wiki-aware file operations (read/write/list wiki pages) |

---

## 3. Wiki Page Format

### 3.1 Frontmatter

Every wiki page has YAML frontmatter:

```yaml
---
name: Auth Middleware
description: Three-phase migration from cookies to JWT, compliance-driven
type: wiki
category: project              # entity | concept | project | reference | theme
slug: auth-middleware
created: 2026-02-15
updated: 2026-04-26
sources:
  - memory/2026-01-15.md
  - memory/2026-03-22.md
  - memory/2026-04-08.md
  - memory/weekly/2026-W14.md
related:
  - postgres-migration
  - compliance-review
confidence: high               # high | medium | low
contradicts: []                # list of wiki slugs this page contradicts
---
```

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | yes | Display name; used in index and search results |
| `description` | yes | One-line summary; used in index and as embedding hint |
| `type` | yes | Always `wiki` (distinguishes from typed memories) |
| `category` | yes | Page category (see §4) |
| `slug` | yes | URL-safe filename stem; matches the file basename |
| `created` | yes | Date the page was first generated |
| `updated` | yes | Date the page was last updated by dreaming |
| `sources` | yes | List of raw memory URIs the page was synthesized from |
| `related` | no | Other wiki slugs explicitly linked (denormalized for index speed) |
| `confidence` | no | Synthesis confidence (set by dreaming based on source agreement) |
| `contradicts` | no | Wiki slugs whose claims this page disagrees with |

### 3.2 Body Structure

Wiki pages follow a loose template — the dreaming engine adapts structure to content type, but every page must have:

1. **Lede paragraph** — One paragraph answering "what is this?" written for someone with zero context
2. **Body sections** — Markdown headings with content; structure varies by category and stub-vs-synthesized state (see §3.3 and §3.4)
3. **Cross-references** — Inline `[[slug]]` links wherever another wiki page is mentioned
4. **Provenance footer** (optional) — Inline citations using `[ref:N]` matching `sources[N]`

**Example — synthesized page** (`memory/wiki/auth-middleware.md`):

```markdown
---
name: Auth Middleware
description: Three-phase migration from cookies to JWT, compliance-driven
type: wiki
category: project
slug: auth-middleware
created: 2026-02-15
updated: 2026-04-26
sources:
  - memory/2026-01-15.md
  - memory/2026-03-22.md
  - memory/2026-04-08.md
related:
  - compliance-review
  - jwt-rotation
confidence: high
---

The auth middleware is the request-authentication layer for all API traffic.
It went through three distinct phases between Jan and Apr 2026, driven by
[[compliance-review]] requirements rather than performance concerns.

## Timeline

### Phase 1 — Cookie-based sessions (Jan 2026)
Initial implementation stored session tokens in cookies. Worked, but legal
flagged the storage scheme during the [[compliance-review]] in March [ref:1].

### Phase 2 — Transition window (Mar 2026)
Both schemes ran in parallel for two weeks while clients migrated. See
[[jwt-rotation]] for the rotation strategy [ref:2].

### Phase 3 — JWT-only (Apr 2026)
Cookie path removed. JWT signing now uses the rotation schedule from
[[jwt-rotation]] [ref:3].

## Key Decisions

- Compliance over ergonomics — verbose JWT claims were accepted to satisfy audit
- httpOnly required for all token cookies (carry-over)
- See [[compliance-review]] for the legal constraints that drove this migration

## Related

- [[compliance-review]] — driving requirements
- [[jwt-rotation]] — operational details
- [[postgres-migration]] — separate but contemporaneous work

---
**Sources:**
1. memory/2026-01-15.md — initial implementation decision
2. memory/2026-03-22.md — compliance flag and migration plan
3. memory/2026-04-08.md — cutover completed
```

### 3.3 Stub vs Synthesized Pages

A wiki page exists in one of two states based on `len(sources)`:

| State | Sources | Author | Body |
|-------|---------|--------|------|
| **Stub** | 1 | Agent (real time) | Short — captures one observation following the category template (§3.4) |
| **Synthesized** | 3+ | Dreaming | Full body with timeline, sub-sections, cross-references, contradictions |

There is no formal "transition" — a stub becomes a synthesized page when dreaming enriches it. A page with 2 sources is a stub-in-transition.

**Confidence convention:**

- Stubs default to `confidence: low` (single observation)
- Synthesized pages set `confidence` based on source agreement (`high` / `medium` / `low`)
- Confidence is regenerated on every synthesis pass

**`confidence: low` is not pejorative.** It signals "this is one agent observation, not yet cross-referenced." It still ranks at the wiki score boost. Confidence becomes informative when conflicts arise (a stub claim and a synthesized page disagreement).

### 3.4 Per-Category Templates

Each category carries a write template. The agent uses the template when writing a stub; dreaming uses the same template (extended) when synthesizing. Templates preserve the typed-memory write conventions that the wiki layer is replacing.

#### `entity` (formerly `user` typed memories, plus systems / tools / vendors)

```markdown
<Lede paragraph: who/what is this?>

## Role
<What they do, what it does>

## Background / History
<Relevant context>

## Preferences / Conventions  (for people)
<How they like to work, communication style>

## How to work with  (for people)
<Tactical guidance>
```

For agent stubs about people, two short paragraphs (lede + one section) is sufficient.

#### `concept` (formerly `feedback` typed memories, plus patterns / ideas)

Concept stubs (agent-written) follow the typed-memory feedback convention:

```markdown
<Lede paragraph: the rule, in one or two sentences>

**Why:** <The reason — usually a past incident or strong preference>

**How to apply:** <When/where this guidance kicks in>
```

Synthesized concept pages add: definition, examples across sources, contrast with alternatives, cross-references.

#### `project` (formerly `project` typed memories, plus bounded efforts)

Project stubs (agent-written) follow the typed-memory project convention:

```markdown
<Lede paragraph: the fact or decision>

**Why:** <The motivation — usually a constraint, deadline, or stakeholder ask>

**How to apply:** <How this should shape your suggestions>
```

Synthesized project pages add: timeline, key decisions, owners, status, related projects.

#### `reference` (unchanged — pointers to external authoritative info)

```markdown
<Lede paragraph: what it is>

## Where to find it
<URL / location / access path>

## When to use it
<Conditions / triggers>
```

Reference pages rarely need synthesis — they're mostly stub-shaped by nature.

#### `theme` (synthesis-only — no agent stub form)

```markdown
<Lede paragraph: the recurring topic, why it keeps coming up>

## What gets discussed
<Common questions, recurring debates>

## Common positions
<Identified positions, with citations>

## Contradictions
<Open disagreements, with `contradicts` frontmatter populated>
```

Theme pages are written exclusively by dreaming. Agents do not stub themes — by definition a theme requires multiple sources to recognize.

---

## 4. Page Categories

Categories drive page templates (§3.4) and (eventually) UI grouping. The agent picks a category when stubbing; dreaming may recategorize during synthesis.

| Category | When to use | Replaces typed memory | Stubbable by agent? |
|----------|------------|-----------------------|---------------------|
| **entity** | A named thing — person, system, tool, library, vendor | `user` typed memories | Yes |
| **concept** | An idea, pattern, or rule — "two-pass search", "don't mock the database" | `feedback` typed memories | Yes |
| **project** | A bounded effort with a goal — "auth middleware migration" | `project` typed memories | Yes |
| **reference** | Pointer to authoritative external info — Linear project, dashboard | `reference` typed memories | Yes |
| **theme** | Recurring topic without a single owner — "test reliability", "API ergonomics" | (none) | No — synthesis only |

A page may evolve between categories (a `theme` becomes a `project` once it has an owner; a `concept` stub becomes part of a larger `theme` synthesis). Recategorization is a normal dreaming output.

---

## 5. Naming and File Layout

### 5.1 File Layout

```
<memory-root>/
├── WISDOM.md
├── DREAMS.md
├── memory/
│   ├── 2026-04-01.md                # Daily logs (unchanged)
│   ├── weekly/                      # Weekly summaries (unchanged)
│   ├── monthly/                     # Monthly summaries (unchanged)
│   ├── type_topic.md                # (DEPRECATED — see §10.4 migration)
│   ├── dreams/                      # (DEPRECATED — see §10.1)
│   └── wiki/                        # Wiki pages (stubs + synthesized)
│       ├── index.md                 # Auto-generated catalog
│       ├── auth-middleware.md       # Page (slug = filename)
│       ├── compliance-review.md
│       ├── postgres-migration.md
│       └── ...
└── .index/                          # Vector index (now includes wiki/)
```

The `<type>_<topic>.md` filename convention is retired. Existing typed memories migrate to `memory/wiki/<topic>.md` with category preserved in frontmatter (see §10.4).

### 5.2 Slug Rules

- Slugs are URL-safe: lowercase, ASCII, hyphens between words
- Slugs are unique within a memory root (the wiki is flat — no subdirectories)
- File basename matches slug exactly: `slug: auth-middleware` → `auth-middleware.md`
- Slug stability is a hard constraint: once a page is created, the slug never changes (rename creates a new page + redirect, see §7.4)
- Reserved slugs: `index` (catalog file)

### 5.3 No Subdirectories

The wiki is intentionally flat. Subdirectories tempt category-based hierarchies that fight cross-references. Categories live in frontmatter, not the filesystem. This matches Karpathy's pattern and Obsidian conventions.

---

## 6. Cross-References

### 6.1 Link Syntax

Wiki pages use `[[slug]]` for cross-references between wiki pages:

```markdown
The migration was driven by [[compliance-review]] requirements.
```

Optional display text:

```markdown
See the [[compliance-review|legal review]] for details.
```

Links to non-wiki memories use standard Markdown links with relative paths:

```markdown
The decision was logged in [memory/2026-03-22.md](../2026-03-22.md).
```

### 6.2 Link Resolution

The WikiEngine resolves `[[slug]]` to `memory/wiki/<slug>.md` at render time. Broken links (slug doesn't exist) are surfaced by `recall wiki lint` (see §11).

### 6.3 Pointer Expansion (Recall)

When a wiki page is retrieved during search, its `[[links]]` and `related` frontmatter list are treated as **pointer candidates**. The two-phase recall pipeline can expand them in Phase 2 if relevance warrants — this reuses the existing pointer expansion mechanism from hierarchical memory (no new code path).

---

## 7. Lifecycle Operations

### 7.1 Create

Wiki pages are created in one of two modes:

**Stub creation (agent, real time)**

When the agent observes something durable during a conversation — a feedback rule, a project decision, a user preference, a reference link — it creates a stub page directly in `memory/wiki/`. Trigger conditions:

- The observation maps to one of the four stubbable categories (`entity`, `concept`, `project`, `reference`)
- Slug doesn't already exist (otherwise: append source to existing page, see §7.2)
- Single source: the daily log file the observation originated in

Stub creation produces:

- A new page file in `memory/wiki/<slug>.md` with `confidence: low`, `sources: [<today's daily log>]`, body following the per-category template (§3.4)
- A line in today's daily log noting the stub creation (for auditability)
- A Vectra index entry

The agent does **not** update `index.md` on stub creation — index regeneration is debounced and runs on the next dreaming session or `recall wiki rebuild-index` invocation.

**Synthesis creation (dreaming)**

The dreaming engine creates synthesized pages (or promotes stubs to synthesis) when a topic:

1. Has 3+ source memories *and* has been queried via search at least once, OR
2. Was explicitly nominated (e.g., wisdom drift or theme detection)

Synthesis creation produces:

- A new (or rewritten) page file with `confidence: high|medium|low` based on source agreement
- An `index.md` update
- A DREAMS.md diary entry
- A Vectra index re-embedding

### 7.2 Update

Updates happen in two modes:

**Agent appends (real time)**

When the agent observes a new fact about an existing wiki topic, it appends:

- New source URI added to `sources` frontmatter
- New paragraph or sub-section appended to the body (under an appropriate heading, or as a new dated note)
- `updated` frontmatter advanced

The agent does not rewrite existing body content during a stub append — that's dreaming's job. Stub appends accumulate observations; dreaming distills them.

**Dreaming rewrites (synthesis)**

Updates happen during dreaming when:

- New source memories arrive that materially change the topic (added to `sources`, body fully rewritten)
- A contradiction is detected with another wiki page (`contradicts` updated, body annotated)
- A linked page is renamed or merged (links updated)
- A stub has accumulated 3+ sources and is ready for synthesis

Dreaming rewrites are full-body — the LLM produces the new body from the full source list. Git provides the version history.

### 7.3 Merge

Two pages may need to merge (e.g., `auth-middleware-cookies` and `auth-middleware-jwt` are both about `auth-middleware`). Merge:

1. Combine `sources`, `related`, body content under sub-headings
2. Write merged content to the surviving slug
3. Replace the deprecated slug's file with a redirect stub (frontmatter `redirect_to: <new-slug>`, no body)
4. Update all `[[old-slug]]` references in other pages

### 7.4 Rename

Slug changes follow the merge pattern: original file becomes a redirect stub, body moves to the new slug.

### 7.5 Lint

`recall wiki lint` scans the wiki for:

- **Broken links** — `[[slug]]` references to non-existent pages
- **Orphan pages** — Pages with no inbound links and not in `index.md`
- **Stale sources** — Pages whose `updated` is significantly older than their newest source's date
- **Missing categories** — Pages without a `category` field
- **Slug/filename drift** — `slug: foo` in a file named `bar.md`
- **Contradiction loops** — Pages mutually listing each other in `contradicts`

Lint output is consumed by the dreaming engine on the next session — broken links and stale pages become high-priority candidates.

### 7.6 Regenerate

`recall wiki rebuild <slug>` regenerates a single page from its declared `sources`. `recall wiki rebuild --all` rebuilds the entire wiki. This is the **regeneration story** that satisfies the "summaries assist recall, never replace source data" wisdom — at any point, the wiki can be reconstructed from raw logs, so it's never load-bearing in a way that would compromise auditability.

Rebuild uses the same prompt templates as initial generation. It does not preserve human edits — wiki pages are owned by dreaming.

---

## 8. The Index (`index.md`)

`memory/wiki/index.md` is auto-generated. It contains:

```markdown
---
type: wiki-index
generated: 2026-04-26
total: 47
---

# Wiki Index

## Entities (12)
- [[postgres]] — Primary application database; managed via Cloud SQL
- [[stripe]] — Payments processor; webhook integration in `services/billing`
- ...

## Concepts (8)
- [[two-phase-search]] — Recall's parent-routed retrieval pipeline
- [[salience-extraction]] — Per-memory weight derivation from frequency + position
- ...

## Projects (15)
- [[auth-middleware]] — JWT migration completed Apr 2026
- [[compliance-review]] — Q1 2026 legal audit driving multiple migrations
- ...

## Themes (7)
- [[test-reliability]] — Recurring tension between mock speed and integration accuracy
- ...

## Recent Updates
- 2026-04-26: [[auth-middleware]] (sources +1)
- 2026-04-25: [[postgres-migration]] (created)
- 2026-04-22: [[two-phase-search]] (updated)
```

The index is regenerated on every wiki write. It is *not* indexed in Vectra (it's an entry point for humans, not the search system).

---

## 9. Search Integration

### 9.1 Indexing

Wiki pages are indexed in Vectra alongside all other memory types. The chunking strategy follows the existing chunker (configurable, default ~512 tokens). Frontmatter `name`, `description`, and `category` are included in the embedded text to give topical signal.

`contentType: "wiki"` is added to chunk metadata.

### 9.2 Score Boost

Wiki retrieval scores are multiplied by a configurable factor:

```typescript
export interface WikiConfig {
  /** Multiplier applied to wiki retrieval scores (default: 1.3) */
  scoreBoost?: number;
}
```

Defaults:

| Multiplier | Behavior |
|------------|----------|
| 1.0 | No boost (wiki ranks equally with raw logs) |
| 1.3 | Default — wiki pages typically out-rank loosely matching raw logs |
| 1.5 | Aggressive — wiki effectively dominates unless query is strongly temporal |
| 2.0+ | Wiki-first; raw logs only surface when wiki has nothing |

**Rationale for soft boost vs hard reorder:** A query like "what did I do on April 8?" should still surface `memory/2026-04-08.md` at the top, even if a wiki page mentions April 8 weakly. The multiplier makes wiki pages preferred *all else being equal*, not unconditionally.

### 9.3 Filtering

Search consumers can opt out of the boost or filter by content type:

```typescript
service.search("compliance", {
  wikiBoost: 1.0,           // disable boost for this query
  filter: {
    contentType: ["wiki"],  // only wiki pages
  },
});
```

### 9.4 Pointer Expansion

When a wiki page surfaces in Phase 1 retrieval, Phase 2 may expand its `related` and inline `[[links]]` if those pages would have been candidates anyway (this is the existing hierarchical-memory mechanism — no new code).

---

## 10. Dreaming Integration

The dreaming spec (`specs/dreaming.md` v0.1) defined three output types: insight files, contradiction files, and typed memory promotions. **The wiki replaces all three.** Typed memory promotion now means promoting a stub to a synthesized wiki page.

### 10.1 What changes in dreaming

| Before (v0.1) | After (with wiki) |
|---------------|-------------------|
| Cross-reference analysis → `memory/dreams/insights/<date>-<slug>.md` | Cross-reference analysis → wiki page create or update |
| Contradiction detection → `memory/dreams/contradictions/<date>.md` | Contradiction detection → `contradicts` frontmatter on affected wiki pages, plus DREAMS.md entry |
| Theme synthesis → insight file | Theme synthesis → `category: theme` wiki page |
| Typed memory promotion → `memory/<type>_<topic>.md` | Stub-to-synthesis promotion → wiki page rewrite (1 source → 3+ sources) |
| Gap analysis → DREAMS.md only | Unchanged |

The `memory/dreams/insights/` and `memory/dreams/contradictions/` directories are deprecated. Existing files (if any) become read-only legacy; new dreaming sessions stop writing to them. A migration command (`recall wiki migrate-insights`) converts existing insight files into wiki pages.

### 10.2 Dreaming output prompts gain a wiki target

Each analysis template (cross-reference, theme synthesis, contradiction) now produces structured output indicating:

- Target slug (existing or new)
- Operation (create | update | merge | redirect)
- Full page body
- Source list

The DreamEngine then dispatches to the WikiEngine to apply.

### 10.3 What dreaming still owns

Dreaming continues to own:

- Signal collection (search log, entity scan, staleness, drift)
- Candidate scoring and selection
- LLM-driven synthesis
- DREAMS.md diary entries
- **Stub enrichment** — finding pages with `len(sources) == 1`, gathering related raw memories, and promoting to synthesized form

The wiki is the **canvas dreaming writes onto**, not a separate system.

### 10.4 Typed Memory Migration

Existing typed memories (`memory/<type>_<topic>.md`) migrate to wiki pages. The mapping is mechanical:

| Typed memory | Wiki page |
|--------------|-----------|
| `user_*.md` | `wiki/<topic>.md` with `category: entity` |
| `feedback_*.md` | `wiki/<topic>.md` with `category: concept` |
| `project_*.md` | `wiki/<topic>.md` with `category: project` |
| `reference_*.md` | `wiki/<topic>.md` with `category: reference` |

Migration rules:

- **Filename:** `<type>_<topic>.md` → `<topic>.md` (the `<type>_` prefix is dropped; category lives in frontmatter)
- **Frontmatter:** Existing `name`, `description` carry over. New fields added: `type: wiki`, `category` (mapped from old `type`), `slug` (kebab-cased topic), `created` (file mtime or daily log date if discoverable), `updated` (today), `sources` (best-effort: scan body for `<daily-log>` references; fall back to a single synthetic source `migration:<date>`)
- **Body:** Preserved verbatim. Body already follows the per-category template (rule + Why + How to apply for `feedback`, etc.) so re-templating is unnecessary.
- **Slug collisions:** If two typed memories would map to the same slug (e.g., `feedback_testing.md` and `project_testing.md`), the migration tool renames the later one to `<topic>-<category>.md` and emits a warning. Manual resolution recommended.

Migration is invoked via `recall wiki migrate-typed-memories`. It is **idempotent** (re-running skips already-migrated files) and **non-destructive** (original typed memory files are moved to `memory/.archive/typed-memories/` rather than deleted).

After migration, the WISDOM compaction logic (which historically read from typed memories) shifts source to wiki pages — see §11.

---

## 11. WISDOM.md Refactor

The wiki absorbs topical content that has been creeping into WISDOM.md. WISDOM.md becomes principles-only plus a curated knowledge map.

### 11.1 What stays in WISDOM.md

- **Principles** — General rules that apply across topics ("Plans, docs, and summaries should reduce ambiguity")
- **Anti-patterns** — Things to avoid that span topics ("Practice drifts from templates")
- **Knowledge Map** — A new section listing high-traffic wiki pages by category, providing entry points

### 11.2 What moves to the wiki

Anything topical: project state, system descriptions, references to specific tools or vendors. Today, WISDOM.md has 30 entries — most are principles and stay; a handful that drift toward topical (e.g., specific compaction strategies tied to Recall's design) become wiki pages with WISDOM.md retaining the *principle*.

### 11.3 Knowledge Map section

Appended to the bottom of WISDOM.md, regenerated by dreaming:

```markdown
## Knowledge Map

Entry points into the wiki (`memory/wiki/`).

### Active Projects
- [[auth-middleware]] — JWT migration; current status
- [[postgres-migration]] — Schema revision, in progress

### Core Concepts
- [[two-phase-search]] — How recall ranks
- [[salience-extraction]] — Per-memory weighting

### See also
- `memory/wiki/index.md` for the full catalog
```

### 11.4 Wisdom drift detection (extended)

The dreaming engine's wisdom drift signal (from `dreaming.md` §4.4) is updated to also propose **wiki pages for entries that drift toward topical**. Drift now has three outcomes:

1. Update WISDOM.md entry (existing)
2. Flag contradiction (existing)
3. **Promote to wiki** (new) — entry is more topical than principled; better expressed as a wiki page

---

## 12. Surface Area Rules

The wiki **collapses what was three durable layers into two**. The separation rule:

| Layer | Owns | Lifecycle |
|-------|------|-----------|
| **Raw logs** (`memory/YYYY-MM-DD.md`, weekly, monthly) | Immutable history — what happened, what was decided, what was discussed on a specific day | Append-only; never modified after the day ends |
| **Wiki pages** (`memory/wiki/<slug>.md`) | Topical knowledge — everything the agent knows about a single subject, in stub or synthesized form | Stubs written by agent (real time); synthesized by dreaming; regenerable from raw logs |

WISDOM.md is **not** a third durable layer — it is a derived view (principles + Knowledge Map) regenerated from the wiki and raw logs (see §11).

### 12.1 Decision rule

**When a fact appears, ask:**

1. *Is it a record of what happened on a specific day?* → raw log (today's daily file)
2. *Does it describe a durable subject — a person, rule, project, reference, or recurring theme?* → wiki page (stub if new, append if existing)

That's it. Two questions. The "is this a typed memory or a wiki page?" judgment call is gone.

### 12.2 Anti-duplication

- **Raw logs cite wiki pages, not the reverse for ephemeral observations.** A daily log entry that says "discussed compliance review with team" should reference `[[compliance-review]]` rather than restating the project context.
- **Wiki stubs cite raw logs.** Every stub's `sources` frontmatter points to the daily log it originated from. Body content paraphrases the observation rather than copying the daily-log line verbatim.
- **Synthesized pages cite stubs and raw logs.** When dreaming promotes a stub to a synthesized page, the prior stub body is the seed; new sources expand it rather than replacing it.
- **Raw logs never get edited to align with wiki content.** The wiki adapts to the raw logs, not the other way around.

### 12.3 What replaces the typed-memory mental model

Agents trained on the typed-memory pattern (`feedback_*`, `project_*`, etc.) should adopt the equivalent wiki workflow:

| Old workflow | New workflow |
|--------------|--------------|
| Write `memory/feedback_database-mocks.md` | Write `memory/wiki/database-mocks.md` with `category: concept` |
| Write `memory/project_auth-rewrite.md` | Write `memory/wiki/auth-rewrite.md` with `category: project` |
| Write `memory/user_steve.md` | Write `memory/wiki/steve.md` with `category: entity` |
| Write `memory/reference_grafana-board.md` | Write `memory/wiki/grafana-board.md` with `category: reference` |

The per-category templates (§3.4) preserve the `**Why:** / **How to apply:**` discipline that made typed memories useful.

---

## 13. WikiEngine API

```typescript
export interface WikiConfig {
  /** Enable wiki layer (default: false) */
  enabled?: boolean;

  /** Score multiplier applied to wiki page retrieval (default: 1.3) */
  scoreBoost?: number;

  /** Minimum sources before the agent can stub a page (default: 1) */
  minSourcesForStub?: number;

  /** Minimum sources before dreaming promotes a stub to synthesis (default: 3) */
  minSourcesForSynthesis?: number;

  /** Days a page can go un-updated before being flagged stale (default: 90) */
  stalenessThresholdDays?: number;
}

export interface WikiPage {
  slug: string;
  name: string;
  description: string;
  category: WikiCategory;
  created: string;
  updated: string;
  sources: string[];
  related: string[];
  confidence?: "high" | "medium" | "low";
  contradicts?: string[];
  body: string;
}

/** Convenience accessor: a page is a stub when it has a single source. */
export function isStub(page: WikiPage): boolean {
  return page.sources.length <= 1;
}

export type WikiCategory =
  | "entity" | "concept" | "project" | "reference" | "theme";

export class WikiEngine {
  constructor(service: MemoryService, config?: WikiConfig);

  /** Read a wiki page by slug */
  read(slug: string): Promise<WikiPage | null>;

  /** Write or overwrite a wiki page */
  write(page: WikiPage): Promise<void>;

  /** Append a source + body fragment to an existing stub (agent-friendly path) */
  append(slug: string, source: string, bodyFragment: string): Promise<WikiPage>;

  /** Create a stub page from a category template (agent-friendly path) */
  stub(input: {
    slug: string;
    name: string;
    description: string;
    category: WikiCategory;
    source: string;
    body: string;
  }): Promise<WikiPage>;

  /** List all wiki page slugs */
  list(): Promise<string[]>;

  /** Regenerate index.md from current pages */
  rebuildIndex(): Promise<void>;

  /** Validate the wiki — broken links, orphans, stale, etc. */
  lint(): Promise<WikiLintReport>;

  /** Rebuild a single page from its declared sources */
  rebuild(slug: string): Promise<WikiPage>;

  /** Rebuild all pages */
  rebuildAll(): Promise<WikiRebuildReport>;

  /** Apply a merge: combine src into dst, leave src as redirect */
  merge(src: string, dst: string): Promise<void>;

  /** Apply a rename: src becomes redirect to new slug */
  rename(oldSlug: string, newSlug: string): Promise<void>;

  /** Migrate legacy insight files into wiki pages */
  migrateInsights(): Promise<WikiMigrationReport>;

  /** Migrate legacy typed memories into wiki pages */
  migrateTypedMemories(): Promise<WikiTypedMigrationReport>;
}

export interface WikiLintReport {
  brokenLinks: { from: string; toSlug: string }[];
  orphans: string[];
  stalePages: { slug: string; updated: string; newestSource: string }[];
  missingCategory: string[];
  slugDrift: { file: string; declaredSlug: string }[];
  contradictionLoops: [string, string][];
}

export interface WikiRebuildReport {
  rebuilt: string[];
  skipped: string[];
  failed: { slug: string; reason: string }[];
}

export interface WikiMigrationReport {
  pagesCreated: string[];
  insightsConverted: number;
  contradictionsFolded: number;
  unconverted: string[];
}

export interface WikiTypedMigrationReport {
  /** Typed memory paths successfully migrated, keyed by source path -> new slug */
  migrated: Record<string, string>;
  /** Slug collisions resolved by appending the category to the slug */
  renamedOnCollision: Record<string, string>;
  /** Files skipped because they were already migrated (idempotent) */
  alreadyMigrated: string[];
  /** Files that could not be migrated (parse errors, missing frontmatter) */
  failed: { path: string; reason: string }[];
  /** Archive directory where original typed memories were moved */
  archivePath: string;
}
```

### 13.1 MemoryService integration

```typescript
export interface MemoryServiceConfig {
  // ... existing fields ...

  /** Wiki configuration */
  wiki?: WikiConfig;
}

// New accessor on MemoryService:
service.wiki: WikiEngine
```

### 13.2 SearchService integration

The search ranking step gains a per-document multiplier hook:

```typescript
function applyContentTypeBoosts(
  hits: SearchResult[],
  boosts: Record<string, number>
): SearchResult[];
```

`boosts` is sourced from config (e.g., `{ wiki: 1.3 }`). Per-query overrides via `QueryOptions.contentBoosts`.

---

## 14. CLI

### 14.1 New Commands

```
recall wiki list                          # List wiki pages
recall wiki list --category project       # Filter by category
recall wiki list --stubs                  # List only stubs (len(sources) == 1)
recall wiki show <slug>                   # Print a wiki page
recall wiki stub <slug> --category <c>    # Create a stub page (agent-friendly)
recall wiki append <slug> --source <s>    # Append a source + body to a stub
recall wiki lint                          # Validate the wiki
recall wiki lint --fix                    # Auto-fix where safe (rebuild index, etc.)
recall wiki rebuild <slug>                # Regenerate a page from sources
recall wiki rebuild --all                 # Regenerate everything
recall wiki merge <src> <dst>             # Merge two pages
recall wiki rename <old> <new>            # Rename a page
recall wiki migrate-insights              # Convert legacy dreaming insights to wiki
recall wiki migrate-typed-memories        # Convert legacy typed memories to wiki
recall wiki status                        # Page count (stub vs synthesized), lint summary, last update
```

### 14.2 Updated Commands

```
recall search <query> --no-wiki-boost              # Disable boost for this query
recall search <query> --wiki-only                  # Only wiki pages
recall dream                                       # Now writes to wiki by default
recall dream --no-wiki                             # Fall back to insight files (compat)
```

### 14.3 Output formats

All `recall wiki *` commands support `--json`. Default output is human-readable.

---

## 15. Configuration

```yaml
# .recall.yaml
wiki:
  enabled: true
  scoreBoost: 1.3
  minSourcesForStub: 1         # Agent can stub on a single observation
  minSourcesForSynthesis: 3    # Dreaming promotes to synthesis at 3+ sources
  stalenessThresholdDays: 90
```

Wiki is **opt-in**. When disabled:

- DreamEngine reverts to v0.1 behavior (insight files + contradiction files)
- WikiEngine APIs return `null` / empty
- Search ignores wiki content type
- CLI `recall wiki *` commands print "wiki disabled" and exit non-zero

---

## 16. Storage Budget

| Component | Size estimate (1 year) |
|-----------|----------------------|
| Wiki pages (~50 pages, 2–3 KB each) | ~150 KB |
| `index.md` | <20 KB |
| Vectra index growth (wiki chunks) | ~1 MB |

**Total additional storage:** <2 MB/year. Negligible compared to the existing baseline. Note that wiki pages partially *replace* insight files from dreaming v0.1, so net storage may be roughly flat.

---

## 17. Comparison: Recall Wiki vs Karpathy LLM Wiki

| Aspect | Recall Wiki | Karpathy LLM Wiki |
|--------|-------------|------------------|
| **Generation trigger** | Dreaming pipeline (scheduled, signal-driven) | Manual ingest (user drops in source, agent updates wiki) |
| **Source corpus** | Internal: raw logs, typed memories | External: articles, papers, podcasts, books |
| **Maintenance loop** | Automatic (dreaming) + `recall wiki lint` | Conversational (user + agent in Obsidian) |
| **Search** | Vectra index + score boost | Index file + optional CLI search tool |
| **Cross-references** | `[[slug]]` resolved by WikiEngine | `[[slug]]` resolved by Obsidian |
| **Schema** | Frontmatter-typed pages, fixed categories | User/agent-defined, conventions in CLAUDE.md |
| **Provenance** | `sources: [...]` mandatory | `[ref:N]` citations encouraged |
| **Regeneration** | `recall wiki rebuild` from declared sources | Manual / re-ingest |
| **Audience** | Single agent (within a memory root) | Single user (with agent assist) |
| **Visualization** | Index file; future graph view | Obsidian graph view |

The patterns are deeply compatible. Recall's wiki could be browsed in Obsidian if a user wanted — pages are plain markdown with `[[slug]]` links and frontmatter, and Obsidian handles those natively.

---

## 18. Open Questions

### Resolved in v0.2

- ~~**Q5: What's the minimum `sources` count to create a page?**~~ — **Resolved.** Split into two thresholds: `minSourcesForStub: 1` (agent stubs in real time) and `minSourcesForSynthesis: 3` (dreaming promotes to full synthesis). See §13 and §15.
- ~~**Do we need typed memories if we have the wiki?**~~ — **Resolved (new in v0.2).** No. Typed memories are subsumed by wiki pages with the four typed categories (`user`, `feedback`, `project`, `reference`) mapping onto wiki categories (`entity`, `concept`, `project`, `reference`). The `<type>_<topic>.md` filename convention is retired. Migration via `recall wiki migrate-typed-memories` (§10.4).

### Open

| # | Question | Options | Notes |
|---|----------|---------|-------|
| 1 | Default `scoreBoost` value | (a) 1.3 — gentle preference (b) 1.5 — strong preference (c) 1.0 + filter-only — opt-in via query | Affects ranking behavior dramatically; needs benchmarking |
| 2 | Should wiki pages be chunked or embedded as single documents? | (a) Chunked (consistent with raw logs) (b) Single embedding per page (loses internal structure but preserves whole-page topicality) (c) Hybrid — page-level + chunk-level | Affects how partial matches behave. Stubs (1 paragraph) likely fit a single embedding; synthesized pages may want chunking. Hybrid is the natural answer but adds complexity. |
| 3 | Where does the Knowledge Map live? | (a) Bottom of WISDOM.md (b) Separate `KNOWLEDGE.md` file (c) `memory/wiki/index.md` only | (a) leverages WISDOM's "always-loaded" property; (c) consolidates |
| 4 | Should the wiki support page-level access control (private vs sharable)? | (a) No — all pages are equally local (b) `private: true` frontmatter to exclude from any future sharing | Premature for v1 but easy to add now if YES |
| 6 | Should `[[slug]]` links be resolved at write time (denormalized) or read time? | (a) Write-time — fast read, brittle on rename (b) Read-time — slower read, robust on rename | (b) preferred; performance impact likely negligible |
| 7 | Should the wiki support multimedia (images, attachments)? | (a) Text only for v1 (b) Image references via standard markdown allowed but not curated | (a) keeps scope tight for v1 |
| 8 | Migration of existing WISDOM.md entries | (a) Manual review pass — user approves each promotion (b) Automatic with confidence threshold (c) Status quo — only future dreaming touches WISDOM | (a) safest for the existing corpus |
| 9 | Slug collisions during typed-memory migration | (a) Append category to slug (`testing-feedback`, `testing-project`) and warn (b) Fail loudly and require manual resolution (c) Merge body content under sub-headings | Default proposal: (a). Only triggers if two typed categories cover the same topic, which is rare in practice. |
| 10 | Should agent-written stubs trigger immediate Vectra re-indexing? | (a) Yes — stub appears in search same turn (b) Debounced — re-index on next dreaming pass | (a) is the high-value path but adds latency to writes; (b) keeps writes cheap but creates a search lag |

---

## 19. Acceptance Criteria

### Wiki Page Format

- [ ] Pages are markdown with required frontmatter fields (`name`, `description`, `type`, `category`, `slug`, `created`, `updated`, `sources`)
- [ ] Slug matches filename basename
- [ ] Slugs are flat (no subdirectories under `memory/wiki/`)
- [ ] `[[slug]]` links resolve to `memory/wiki/<slug>.md`
- [ ] Reserved slug `index` is rejected for user-facing pages
- [ ] Per-category templates (§3.4) are documented and used by `stub()` for `entity`, `concept`, `project`, `reference`
- [ ] Concept and project stubs include `**Why:**` and `**How to apply:**` sections (preserving typed-memory discipline)

### WikiEngine

- [ ] `read(slug)` returns parsed `WikiPage` or `null`
- [ ] `write(page)` validates frontmatter and writes file
- [ ] `stub(input)` creates a single-source page from the per-category template
- [ ] `append(slug, source, fragment)` adds source + fragment to an existing page; advances `updated`
- [ ] `isStub(page)` returns true iff `len(sources) <= 1`
- [ ] `list()` enumerates all wiki page slugs; supports `--stubs` filter
- [ ] `rebuildIndex()` regenerates `index.md` deterministically
- [ ] `lint()` reports broken links, orphans, stale pages, slug drift, contradiction loops
- [ ] `rebuild(slug)` regenerates a page from declared sources via `MemoryModel`
- [ ] `merge(src, dst)` combines pages and writes redirect stub for `src`
- [ ] `rename(old, new)` writes redirect stub for `old`, body at `new`
- [ ] `migrateInsights()` converts legacy `memory/dreams/insights/` files
- [ ] `migrateTypedMemories()` converts legacy `memory/<type>_<topic>.md` files to `memory/wiki/<topic>.md` with category preserved; resolves collisions; archives originals; idempotent

### Search Integration

- [ ] Wiki pages are indexed in Vectra with `contentType: "wiki"`
- [ ] Frontmatter `name` and `description` are included in embedded text
- [ ] Configurable score boost is applied at retrieval time
- [ ] `--no-wiki-boost` and `--wiki-only` CLI flags work
- [ ] `QueryOptions.contentBoosts` overrides config defaults per query

### Dreaming Integration

- [ ] DreamEngine writes to wiki by default when wiki is enabled
- [ ] Cross-reference analysis produces wiki create/update operations
- [ ] Theme synthesis produces `category: theme` pages
- [ ] Contradiction detection updates `contradicts` frontmatter and DREAMS.md
- [ ] Wisdom drift can promote a WISDOM entry to a wiki page
- [ ] `--no-wiki` flag falls back to v0.1 insight-file output

### WISDOM Integration

- [ ] Knowledge Map section is regenerated by dreaming on wiki updates
- [ ] WISDOM.md compaction prompt is updated to push topical content toward wiki

### CLI

- [ ] `recall wiki list / show / lint / rebuild / merge / rename / migrate-insights / status` all implemented
- [ ] `--json` output supported on all wiki commands
- [ ] `recall search` flags (`--no-wiki-boost`, `--wiki-only`) implemented

### Configuration

- [ ] Wiki is opt-in (disabled by default)
- [ ] `scoreBoost`, `minSourcesForStub`, `minSourcesForSynthesis`, `stalenessThresholdDays` configurable
- [ ] Disabled state is graceful (no errors; wiki commands exit non-zero with clear message)

### Typed-Memory Migration

- [ ] `recall wiki migrate-typed-memories` discovers all `memory/<type>_<topic>.md` files
- [ ] Each migrates to `memory/wiki/<topic>.md` with category mapped (`user`→`entity`, `feedback`→`concept`, `project`→`project`, `reference`→`reference`)
- [ ] Body is preserved verbatim; frontmatter is augmented (not replaced)
- [ ] Slug collisions are resolved by appending category to the second slug; warning emitted
- [ ] Original typed memory files are moved to `memory/.archive/typed-memories/` (not deleted)
- [ ] Migration is idempotent — re-running skips already-migrated files
- [ ] WISDOM compaction logic is updated to read from wiki pages (not typed memories) post-migration

### Regeneration

- [ ] `recall wiki rebuild --all` reconstructs every page from declared sources without referencing existing bodies
- [ ] Rebuild output is deterministic given the same model + sources (modulo LLM nondeterminism — pages should be semantically equivalent)

---

## 20. Implementation Sequencing

### Phase A — Wiki File Layer

1. Define page format, frontmatter schema, slug rules
2. Implement `WikiEngine.read / write / list`
3. Implement `WikiEngine.stub / append` with per-category templates (§3.4)
4. Implement `[[slug]]` link parser and resolver
5. Implement `index.md` generator
6. Add `WikiConfig` to `MemoryServiceConfig`
7. CLI: `recall wiki list / show / stub / append / status`

**Can ship independently. Agents can stub real-time wiki pages for testing before dreaming integration.**

### Phase B — Search Integration

1. Index wiki pages in Vectra
2. Add `contentType: "wiki"` and frontmatter fields to embedded text
3. Implement score boost in ranking
4. CLI: `recall search --no-wiki-boost / --wiki-only`

**Depends on A. Can be tested with hand-written pages.**

### Phase C — Lint and Maintenance

1. Implement `lint()` (broken links, orphans, stale, drift)
2. Implement `rebuildIndex()`
3. Implement `merge / rename` with redirect stubs
4. CLI: `recall wiki lint / rebuild`

**Depends on A. Parallel with B.**

### Phase D — Dreaming Integration

1. Update DreamEngine analysis templates to produce wiki create/update operations
2. Implement `WikiEngine.rebuild()` (LLM-driven regeneration)
3. Update DREAMS.md format to reference wiki updates
4. Implement `migrateInsights()`
5. CLI: `recall dream --no-wiki` compatibility flag

**Depends on B and C, plus dreaming v0.2 (which absorbs this spec's requirements).**

### Phase E — Typed-Memory Migration & WISDOM.md Refactor

1. Implement `WikiEngine.migrateTypedMemories()` (collision handling, archive, idempotence)
2. CLI: `recall wiki migrate-typed-memories`
3. Run migration pass across teammates (~30 typed memories total)
4. Update WISDOM compaction prompt to read from wiki pages instead of typed memories
5. Update WISDOM compaction prompt to push topical content to wiki
6. Implement Knowledge Map regeneration
7. Run a one-time migration pass on existing WISDOM entries (manual review per question 8)

**Depends on A and D. The typed-memory migration (steps 1–3) can run as soon as Phase A lands; the WISDOM refactor (steps 4–7) depends on D.**

**Phases A, B, C can run in parallel after A's surface API lands. The typed-memory migration sub-phase of E can run in parallel with B/C/D once A lands. The WISDOM refactor sub-phase of E depends on D.**

---

## 21. Changelog

| Version | Date | Changes |
|---|---|---|
| 0.1 | 2026-04-26 | Initial draft — wiki page format, categories, naming, cross-references, lifecycle, search/dreaming/WISDOM integration, surface area separation rule, WikiEngine API, CLI, open questions, acceptance criteria, sequencing |
| 0.2 | 2026-04-26 | **Collapse typed memories into wiki.** Added stub-vs-synthesized model (§3.3) and per-category templates (§3.4) preserving the typed-memory `**Why:** / **How to apply:**` discipline. Mapped `user`/`feedback`/`project`/`reference` typed categories onto wiki categories. Updated §1, §4, §5 (file layout drops `<type>_<topic>.md`), §7 (added stub creation + agent appends), §10 (added §10.4 typed-memory migration), §12 (surface area rule simplified to two layers — raw + wiki), §13 (split `minSourcesForCreate` into `minSourcesForStub` + `minSourcesForSynthesis`; added `stub()`, `append()`, `migrateTypedMemories()`), §14 (CLI: `wiki stub`, `wiki append`, `wiki migrate-typed-memories`, `wiki list --stubs`), §15 (config), §18 (resolved Q5; added Q9 collision handling, Q10 stub re-indexing latency), §19 (acceptance criteria for typed-memory migration), §20 (Phase E gains migration sub-phase, parallelizable with B/C/D). |
