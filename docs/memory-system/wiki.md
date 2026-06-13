---
title: The LLM Wiki
layout: default
parent: Recall Memory System
nav_order: 2
---

# The LLM Wiki

Recall keeps two kinds of memory side by side. **Temporal logs** record *what happened, when* — an immutable, append-only stream of daily entries that compaction rolls up into weekly and monthly summaries. The **wiki** records *what is true about a topic* — a curated set of cross-linked markdown pages, one per subject, that accumulate and refine knowledge as it arrives.

The temporal stream answers "what did I do on day 247?" The wiki answers "what do I currently know about the auth middleware?" — without re-deriving the answer from a thousand scattered log entries every time it's asked.

> **Origin.** The wiki layer is inspired by Andrej Karpathy's "LLM Wiki" gist — the idea that an agent should maintain its long-term knowledge as a set of interlinked wiki pages it curates over time and follows on demand, rather than re-reading raw history on every query. Recall implements that idea with two operational additions: pages are written in two modes (cheap real-time *stubs* by the agent, richer *synthesized* pages by [dreaming](architecture.html#dreaming-system)), and every page is **regenerable** from the sources it cites, so the wiki never becomes a lossy fork of the logs it summarizes.

---

## Why a wiki?

Before the wiki, durable knowledge lived in three places: raw daily logs, a flat set of *typed memories* (`user` / `feedback` / `project` / `reference` files), and `WISDOM.md`. That layout had two problems:

1. **No compounding synthesis.** A topic that accumulated context over months — a project, a person, a recurring decision — was never *built up* anywhere. Every query had to re-gather and re-synthesize the same fragments from scratch.
2. **A recurring "where does this go?" judgment call.** Every durable observation forced a choice between four typed-memory buckets, and insight files from dreaming added a fifth surface. The boundaries blurred constantly.

The wiki collapses durable knowledge to **two layers**: raw logs (history, immutable) and wiki pages (everything topical). The four typed-memory categories became wiki **categories**; dreaming's insight files became wiki **pages**. One topic, one page, with cross-references — instead of the same subject scattered across several system writes.

The underlying primitive is more general than "wikis": **memories that cite other memories, resolved by following pointers on demand.** Wiki `[[links]]`, a parent summary's `pointers` to its child dailies, and a page's `sources` list are all the same mechanism — a reference you chase only when you need the detail behind it.

---

## Anatomy of a page

A wiki page is a markdown file at `memory/wiki/<slug>.md` with YAML frontmatter and a freeform body. Links to other pages use `[[slug]]` (or `[[name:slug]]` to point into a [shared wiki](#private-and-shared-wikis)).

```markdown
---
name: Auth Middleware
description: Three-phase migration from cookie sessions to JWT, compliance-driven
slug: auth-middleware
category: project
created: 2026-02-15
updated: 2026-04-26
sources:
  - uri: memory/2026-01-15.md
    summary: Initial implementation decision
  - uri: memory/2026-03-22.md
    summary: Compliance flag forced the migration plan
  - uri: memory/2026-04-08.md
    summary: Cutover completed
related:
  - compliance-review
  - jwt-rotation
confidence: high
supersedes: []
---

The auth middleware is the request-authentication layer for all API traffic.
It moved from cookie sessions to JWT between Jan and Apr 2026, driven by
[[compliance-review]] requirements rather than performance concerns.

## Timeline
### Phase 1 — Cookie sessions (Jan 2026)
...
```

| Field | Purpose |
|-------|---------|
| `category` | One of `entity`, `concept`, `project`, `reference`, `theme`. Drives the stub template and UI grouping. |
| `sources` | The memory URIs the page was synthesized from. Each may carry an optional line `range` (so the agent can read just the relevant span) and a one-line `summary`. **This is what makes a page regenerable.** |
| `related` | Other wiki slugs explicitly linked from this page. |
| `confidence` | `high` / `medium` / `low` synthesis confidence; defaults to `low` for stubs. |
| `contradicts` | Slugs whose claims this page disagrees with (surfaced by dreaming's contradiction detection). |
| `supersedes` | Prior claims this page now overrides — see [Supersession](#supersession). |
| `grounding` | Verification report from the post-write grounding check: counts of grounded vs. `unverified` vs. `stale` claims. Retrieval can demote pages with unverified claims. |
| `redirectTo` | Set on the leftover stub after a `merge` / `rename` / `promote`, so old links still resolve. |

### Categories

| Category | Replaces (legacy typed memory) | Holds |
|----------|-------------------------------|-------|
| `entity` | — | People, teams, systems, organizations |
| `concept` | `feedback` | Rules, principles, guidance (preserves the `**Why:** / **How to apply:**` discipline via its stub template) |
| `project` | `project` | Ongoing work, its decisions and timeline |
| `reference` | `reference` | Pointers to external systems, dashboards, tickets |
| `theme` | dreaming insight files | Cross-cutting patterns synthesized across many days |

(The legacy `user` typed memory — role and preferences — maps onto `entity`/`concept` pages about the principal.)

---

## How pages get built: two write modes

A page is a **stub** when it has a single source and a **synthesized page** once it has accumulated several. There's no formal state transition — `sources.length` *is* the signal (`isStub()` returns true at ≤ 1 source). The same file format is used throughout; pages just get richer.

### 1. Stubs — written by the agent, in real time

When the agent observes something durable mid-conversation (a decision, a rule, a fact about a person), it writes a stub immediately: a new `memory/wiki/<slug>.md` with `confidence: low`, one source (today's daily log), and a short templated body. The write is also logged to the daily log for auditability, and the page is indexed so it's findable straight away. Stubs are first-class — a single observation is a valid page.

### 2. Synthesized pages — written by dreaming, asynchronously

Once a topic has **3+ sources** (`minSourcesForSynthesis`) and has actually been queried, [dreaming](architecture.html#dreaming-system) calls `rebuild(slug)`: it hands the LLM the page's full source list and asks for a fresh body that reflects the current state of the topic, sets `confidence` from how well the sources agree, and records the work in `DREAMS.md`. Dreaming also creates pages from scratch when its cross-temporal analysis surfaces a `theme` or a contradiction worth a page.

### Regenerability

Because every page declares its `sources`, **any page can be rebuilt from the logs at any time** (`recall wiki rebuild <slug>` for one, `--all` for the whole wiki). This is the wiki's load-bearing invariant and it encodes a core Recall principle: *summaries assist recall, they never replace source data.* The wiki is a derived, disposable view over the immutable logs — never a second source of truth that can silently drift away from them.

Every wiki write also produces a trail: a `DREAMS.md` diary entry (synthesis) or a daily-log line (stub). There are no silent edits, and pages are versioned through git.

---

## Retrieval and the score boost

Wiki pages are embedded and indexed alongside raw logs and surface through the same [two-phase search](architecture.html#search-architecture). Their `name` and `description` are folded into the embedded text so a topical query lands on the page. Search can also filter to wiki-only or exclude the wiki entirely (`--wiki-only` / `--no-wiki`).

The one knob specific to the wiki is `scoreBoost`, a multiplier applied to a wiki page's retrieval score. Its default — **`0.9`, a deliberate *de-boost*** — is one of the clearest examples of [Recall Bench](../bench/recall-bench.html) feeding back into the core, and the tuning history is worth keeping:

| Boost | Result |
|-------|--------|
| `1.5` | Too aggressive — wiki pages routinely outranked the daily log that actually contained the asked-about fact. |
| `1.1` | A softer tiebreaker, but a 500-day bench run still showed the right daily at position #1 in **0 of 22** appellate-reviewed misses, and a wiki page at #1 in **13 of 22**. Even a 10% nudge was enough to displace the daily that carried the answer. |
| `0.9` | **Current.** A wiki page must beat the daily on its own retrieval score by ~10% before it takes the top spot. Pages stay fully findable and citable; they just don't get a tiebreaker that costs specific-fact recall. This matches the neutral-source stance the bench's other systems use by default. |

The lesson: a synthesized topical page is a *convenience*, not a *priority*. When a specific fact is asked for, the immutable daily that recorded it should win.

---

## Supersession

> *In conversation this is sometimes called "suppression." The mechanism in the code is **supersession**.*

### What it tackles

Agent memory accumulates corrections. A decision is made, then reversed; a number is set, then revised; an entity is renamed. If the wiki simply *appends* each new fact to the relevant page, the page becomes a chronological pile of old-and-new claims, and an LLM reading it grabs whichever paragraph it happens to read first — usually the older one. The page stops being a reliable "current state of record."

Supersession is the mechanism that keeps a page **current** while preserving its **history**. When a new daily contradicts a page's existing claim, the body is rewritten to the new truth and the old claim is recorded — not deleted — in the page's `supersedes` frontmatter. This is the wiki's answer to the [`contradiction-resolution`](../bench/recall-bench.html#the-recall-categories) failure mode: returning a value that was already corrected, or losing the record of *what changed and when*.

```yaml
# memory/wiki/ledger-database.md
supersedes:
  - source: memory/2026-01-10.md
    fact: "Initial choice was Postgres"
    supersededOn: 2026-01-30
```
```markdown
MySQL. Chosen over Postgres on 2026-01-30 for write throughput.
```

The page body asserts the **current** answer (MySQL); the `supersedes` entry preserves the audit trail (it used to be Postgres, and here's the daily that said so). Retrieval surfaces both: when the page is returned, its context header lists any superseded claims so the agent knows "this page used to say X; it now says Y."

### How it works

Supersession is driven by dreaming, not the agent, and runs in four steps:

1. **Signal detection.** The [signal collector](architecture.html#signal-collection) scans recent dailies for decision-marker language — *decided to / on / against*, *switched from … to*, *changed our mind*, *corrected*, *reversed*, *replaced X with*. Each match becomes a supersession candidate, scored by marker density and recency.
2. **Contradiction analysis.** Candidates route to dreaming's contradiction-detection prompt, which sees the decision-marker daily plus the top semantically-matching wiki pages and decides whether the daily actually overrides existing wiki state.
3. **Dedup + merge.** Before writing, dreaming checks whether a topically-overlapping page already exists (cosine similarity ≥ 0.8). If so, a proposed *create* is transparently converted to an *update*, and the bodies are merged by the LLM in one of three modes — `replace` (new contradicts old), `merge` (partial overlap), or `append` (purely additive). The merge step is what prevents the page from becoming a chronological accretion; without it, every duplicate would degrade into an append.
4. **Record.** `recordSupersession()` appends each replaced claim to the page's `supersedes` array (deduped by source URI), stamps `supersededOn`, and advances the page's `updated` date.

### Trajectory pages and rename detection

Two features build on supersession:

- **Trajectory pages.** Once a page accumulates **two or more** supersessions, dreaming auto-maintains a companion `<slug>-trajectory` page — a pre-computed, chronological list of every superseded claim with its source. This gives [`synthesis`](../bench/recall-bench.html#the-recall-categories) questions ("how did our database choice evolve?") a single page to land on instead of forcing a scan across many dailies.
- **Entity rename detection.** When two pages describe the same entity under different names ("Northstar Components" → "Northstar Gridworks"), the older page is converted to a redirect and the rename is recorded as a supersession on the canonical page.

### Grounding check

After a synthesis write, the grounding verifier compares each claim in the body against its cited sources and records counts of `grounded`, `unverified`, and `stale` claims on the page. A **stale** claim — one whose supporting source is older than the page's newest source — is a signal that the merge-with-supersession step may have missed a correction. Strict-mode retrieval demotes pages carrying unverified or stale claims, so a page that drifts out of sync with its sources loses rank until dreaming reconciles it.

---

## Private and shared wikis

Every agent has a **private** wiki (`target: "private"`). Agents may also opt into one or more **shared** wikis for team knowledge that compounds across a group:

| Role | Capability |
|------|-----------|
| `member` | Read and write the shared wiki |
| `reader` | Read only |

Shared wikis are configured by `name` and `path`, get their own index, and are referenced with qualified links (`[[name:slug]]`). Search federates across the private wiki and any configured shared wikis; each shared wiki can override the default `scoreBoost`.

---

## CLI

The wiki is exposed through a `recall wiki` subcommand tree:

| Command | Description |
|---------|-------------|
| `wiki list` | List page slugs (filter by `--category`, `--stubs`, `--shared <name>`, `--all`) |
| `wiki show <slug>` | Print a page, hydrated with frontmatter, sources, and confidence |
| `wiki stub <slug>` | Create a stub from the per-category template |
| `wiki append <slug>` | Append a source + body fragment to an existing page |
| `wiki rebuild [slug]` | Re-synthesize a page (or `--all`) from its sources via the LLM |
| `wiki merge <src> <dst>` | Merge two pages, leaving a redirect at `src` |
| `wiki rename <old> <new>` | Rename a page, leaving a redirect at the old slug |
| `wiki lint` | Validate broken links, orphans, stale pages, slug drift, and contradiction loops |
| `wiki migrate-typed-memories` | Convert legacy `memory/<type>_<topic>.md` files to wiki pages |
| `wiki migrate-insights` | Convert legacy dreaming insight files to `theme` pages |
| `wiki knowledge-map` | Regenerate the Knowledge Map section of `WISDOM.md` from the wiki |
| `wiki targets` / `wiki status` | List configured wikis / show per-target page and category counts |

---

## Configuration

| Option | Default | Notes |
|--------|---------|-------|
| `enabled` | `false` (library) / **on (CLI)** | The programmatic config defaults off so embedders opt in; the `recall` CLI turns the wiki on by default — opt out with `--no-wiki`. |
| `scoreBoost` | `0.9` | Retrieval multiplier for wiki pages (see [above](#retrieval-and-the-score-boost)). |
| `minSourcesForStub` | `1` | A single observation is a valid stub. |
| `minSourcesForSynthesis` | `3` | Sources required before dreaming promotes a stub to a synthesized page. |
| `stalenessThresholdDays` | `90` | Days a page can go un-updated before `lint` flags it stale. |
| `shared` | `[]` | Shared wikis the agent participates in. |

---

For the full design — page format, lifecycle, search integration, shared-wiki federation, and the open tuning questions — see [`specs/wiki.md`](https://github.com/Stevenic/recall/blob/main/specs/wiki.md).
