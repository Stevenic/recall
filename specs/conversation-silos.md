# Conversation-Silo Memory — Design Spec

**Status:** Draft
**Author:** Scribe
**Date:** 2026-05-19
**Version:** 0.2
**Parent specs:** [wiki.md](./wiki.md) v0.4, [dreaming.md](./dreaming.md) v0.2, [hierarchical-memory.md](./hierarchical-memory.md) v0.4
**Sibling specs:** [silo-promotion-policy.md](./silo-promotion-policy.md) v0.2
**Scope:** v0.1 scopes a **single agent serving multiple conversations** — one shared agent wiki above per-conversation silos. Team and org tiers are deferred to future versions (see Appendix A).

---

## 1. Overview

This spec defines a deployment configuration of the Recall wiki for **multi-conversation agents** — agents (such as Teams agents) that participate in many 1:1 and group chats and must reuse knowledge across them without leaking information across conversation boundaries.

In v0.1 the topology is two tiers:

- One **conversation silo** per chat the agent participates in (1:1 or group). Each silo has its own raw logs, weekly/monthly summaries, conversation wiki, dreams, and Vectra index.
- One **agent wiki**, shared across all of the agent's conversations. Populated only by dream-time promotion from the conversation wikis. Read by every conversation the agent serves, subject to a drill-down gate.

Information moves up from a conversation silo into the agent wiki only through the dream-time **promotion gate** ([silo-promotion-policy.md](./silo-promotion-policy.md)). Raw logs never cross. Agents have no API path to write directly into the agent wiki.

The same wiki primitives defined in [wiki.md](./wiki.md) §1–§13 carry through unchanged; this spec adds the topology, the boundary rules between tiers, and the per-silo identity surface.

### 1.1 Problem

The whitepaper *Conversation-Aware Memory Retrieval for Teams Agents* (May 2026) proposes a retrieval-time decision pipeline: each query runs hard policy gates (sensitivity, watermark, PII), then an overlap-aware re-ranker, then a `StepC` ALLOWED/REDACTED classifier. That design has three operational pains regardless of how the weights are tuned:

1. **Leaks are invisible.** They hide in scoring weights or classifier confidence thresholds. No single artifact answers "why did the agent see that?"
2. **Latency budget bloats with policy nuance.** Every additional rule is per-query work. The roadmap is reluctant to add nuance because nuance is expensive on the hot path.
3. **Audit surface is weak.** A policy regression is not a file in git — it's a tuning change in a re-ranker.

### 1.2 Solution

Move the policy decision off the retrieval hot path and onto the dream-time synthesis path. Each conversation is its own memory silo. The only path for a fact to cross a silo boundary is the dreaming pipeline writing a wiki page in the agent wiki — and that promotion runs the policy gates once, per fact.

The output is a single shared wiki of agent-wide knowledge, populated only with content that has explicitly cleared the policy gate. A leak is now a *file* with an explicit `sources` list — git-tracked, auditable, regenerable, retractable.

### 1.3 Design Principles

- **Eidetic silos.** Raw logs are scoped strictly to their conversation. They never cross a tier boundary by any path.
- **Synthesis-only promotion.** Information ascends to the agent wiki only as dream-curated wiki entries, never as raw memories.
- **Promotion gate is the primary boundary.** The drill-down gate at retrieval is belt-and-suspenders.
- **Pointer expansion is the access-control surface.** The existing hierarchical-memory pointer-expansion mechanism doubles as the tier-crossing check at retrieval time.
- **Isolated sessions are honored structurally.** Sessions flagged `isolated: true` with declared `sensitive_topics` (e.g., the EA persona's `comp-committee`, `project-condor`) are first-class to the promotion gate.
- **Wiki primitives stay identical.** The frontmatter, slug rules, link syntax, search integration, and stub/synthesized lifecycle from [wiki.md](./wiki.md) §3–§13 carry through. This spec adds topology, not new file formats.
- **Regenerability enables retraction.** Because every wiki page is regenerable from its `sources`, tightening policy is a re-run, not a migration.

---

## 2. The Two Tiers

```
[agent wiki]                ← single shared wiki across all of the agent's conversations
   ▲
   │ promotion gate (dream-time only)
   │
[conversation wiki]         ← one per conversation
   ▲
   │ wiki stub / dreaming inside the silo
   │
[conversation raw logs]     (eidetic, never crosses the silo boundary)
```

**Conversation tier.** One silo per chat. The agent stubs into the conversation wiki during a turn; the conversation's dream cycle synthesizes within the silo. Federated retrieval inside this silo includes its raw logs and weekly/monthly summaries.

**Agent tier.** A single wiki visible to every conversation the agent serves. Populated only by dream-time promotion from the conversation wikis. Has its own Vectra index. Has no raw logs.

The agent tier is the **boundary between intra-conversation and cross-conversation knowledge**. The promotion gate sits at this boundary and is the single most consequential piece of logic in the design.

---

## 3. Silo Model

A silo is the unit of private memory at the conversation tier. Each conversation has exactly one silo, structured exactly like the per-agent memory root from [memory-service.md](./memory-service.md) but scoped to the conversation:

```
<conv-root>/                          # e.g. silos/conv-<conversation-id>/
├── IDENTITY.md                       # Per-silo identity (see §7)
├── DREAMS.md                         # Dream diary (silo-local)
├── memory/
│   ├── YYYY-MM-DD.md                 # Raw daily logs (never crosses the silo)
│   ├── weekly/
│   ├── monthly/
│   ├── wiki/                         # Conversation wiki (stubs + synthesized)
│   │   ├── index.md
│   │   └── <slug>.md
│   └── .dreams/                      # Dreaming machine state
└── .index/                           # Per-silo Vectra index
```

### 3.1 Silo Contents

| File class | Tier-crossing rule |
|------------|-------------------|
| Raw daily logs | Never cross the silo boundary by any path |
| Weekly / monthly summaries | Never cross; silo-local compaction only |
| Conversation wiki pages | May ascend to the agent wiki via dream-time promotion |
| `DREAMS.md` | Silo-local |
| Vectra index | Silo-local; federated at retrieval, never merged |

### 3.2 silo.yaml

Each silo carries a small metadata file declaring its kind, owning agent, isolation flag, and current participant roster:

```yaml
# silos/conv-<id>/silo.yaml
tier: conversation
conversation_id: 19:abcdef@thread.v2
agent_id: jordan
kind: group                          # one-to-one | group
isolated: false                      # see §3.3
sensitive_topics: []                 # populated only when isolated=true
identity_kind: group                 # one-to-one | group | custom
participants:
  - { id: u-jamie,   joined: 2026-01-04, role: principal }
  - { id: u-maya,    joined: 2026-01-04, role: core }
  - { id: u-tomas,   joined: 2026-01-04, role: core }
  - { id: u-yuki,    joined: 2026-01-04, role: core }
  - { id: u-priscilla, joined: 2026-01-04, role: core }
```

The roster drives the promotion policy's watermark and overlap checks (see [silo-promotion-policy.md](./silo-promotion-policy.md) §3). The roster is **not** stored on individual memories — that would bloat the eidetic log and stale quickly. It lives on the silo and is dereferenced at promotion time.

### 3.3 Isolated Silos

A silo may declare itself `isolated: true` with a list of `sensitive_topics`. This mirrors the existing recall-bench v0.5 §2.3.1 model, where isolated sessions are first-class to dataset generation.

```yaml
# silos/conv-comp-committee/silo.yaml
tier: conversation
conversation_id: 19:comp-committee@thread.v2
agent_id: jordan
kind: group
isolated: true
sensitive_topics:
  - "Individual executive base, bonus, and equity grant amounts"
  - "Officer-level performance ratings, bonus modifier rationale"
  - "Equity refresh schedules, vesting cliff exposures"
  # ...
participants:
  - { id: u-jamie,   joined: 2026-01-04, role: principal }
  - { id: u-daniel,  joined: 2026-01-04, role: peer-exec }
  - { id: u-beth,    joined: 2026-01-04, role: peer-exec }
  - { id: u-vikram,  joined: 2026-01-04, role: board }
```

`isolated: true` is **input to the promotion gate, not an absolute block**. Content from an isolated silo may still promote if it is non-sensitive (a scheduling note, a non-sensitive process change). What the flag changes is that the promotion gate runs a stricter pass — `sensitive_topics` becomes a list of negative gates against the candidate body, and ambiguous cases default to block rather than allow. See [silo-promotion-policy.md](./silo-promotion-policy.md) §4.

### 3.4 Agent Wiki Silo

The agent wiki is structurally a silo at a higher tier:

```yaml
# silos/agent-jordan/silo.yaml
tier: agent
agent_id: jordan
identity_default: one-to-one         # default identity for unscoped synthesis
child_silos:
  - conv-19:principal@thread.v2
  - conv-19:direct-reports@thread.v2
  - conv-19:executive-team@thread.v2
  - conv-19:board-prep@thread.v2
  - conv-19:ea-network@thread.v2
  - conv-19:comp-committee@thread.v2
  - conv-19:project-condor@thread.v2
  - conv-19:legal-confidential@thread.v2
  - conv-19:family@thread.v2
```

The agent silo contains an `IDENTITY.md`, a `memory/wiki/` directory with the agent wiki pages, a `.dreams/` directory for promotion machine state, and a `.index/`. It contains **no** `memory/YYYY-MM-DD.md` raw logs and **no** weekly/monthly summaries — those tiers don't exist at the agent level.

---

## 4. Promotion (Dream-Time, Conversation → Agent)

Promotion is the only path information takes between tiers. It is **always** dream-time and **always** mediated by the policy in [silo-promotion-policy.md](./silo-promotion-policy.md).

### 4.1 Promotion Trigger

A promotion candidate originates from a conversation wiki page that meets at least one of:

- New sources have been added since the page's last promotion evaluation
- The page's confidence has changed
- The promotion policy has been updated since the last re-scan (see §6)

The candidate is the conversation wiki page in full — `name`, `description`, body, `sources`, `category`, `confidence` — plus the owning silo's `silo.yaml` (so the gate can read `isolated`, `sensitive_topics`, and the participant roster).

### 4.2 Promotion Output

For each evaluated candidate, the gate produces one of:

| Outcome | Action at the agent tier |
|---------|--------------------------|
| `allow` | Create or update the corresponding agent wiki page; record the source page's URI in `sources` |
| `redact` | Promote a redacted variant (sensitive substrings replaced or sections omitted) and record the redaction policy that applied in frontmatter |
| `block` | Do not promote; record the rejection reason in the agent tier's `DREAMS.md` so the decision is auditable |

The redact path is the LLM's job — the gate identifies what must be removed; the synthesizer produces a coherent page body without it. If a coherent redaction is impossible, the gate falls through to `block`.

### 4.3 Promotion Output Frontmatter

A promoted page carries the source wiki URI in `sources`, plus a new field naming the policy version that admitted it:

```yaml
---
name: Jamie's communication style
description: Direct, bottom-line-first; warm but concise; agenda-first with peer execs
type: wiki
category: entity
slug: jamie-park
created: 2026-01-12
updated: 2026-05-19
sources:
  - silo:conv-principal/memory/wiki/jamie-park.md
  - silo:conv-direct-reports/memory/wiki/jamie-park.md
  - silo:conv-board-prep/memory/wiki/jamie-park.md
promotion:
  policy_version: silo-promotion-policy/0.2
  evaluated_at: 2026-05-19
  outcome: allow
  redaction: null
confidence: high
---
```

The `silo:<id>/...` URI scheme is the cross-silo provenance form. At retrieval time the drill-down gate (§5.3) decides whether the current reader is allowed to follow each entry.

### 4.4 Promotion Does Not Mutate the Source

Promotion is **read-only at the conversation tier**. The source wiki page is unchanged. Subsequent dream cycles in the conversation silo may rewrite the source page; the next promotion evaluation will pick up the changes. This preserves regenerability: the agent wiki can be rebuilt from the conversation wikis.

---

## 5. Retrieval (Federated)

When the agent answers in conversation A, the search service federates across the two indexes the conversation can read:

```
query → embed once → search in parallel across:
                     - conv-A wiki + conv-A raw logs + conv-A weekly/monthly
                     - agent wiki
                  → apply per-tier wiki score boost
                  → merge, rerank, top-K
```

This is a direct extension of [wiki.md](./wiki.md) §14.3 search federation. The `SearchResult.source.root` field identifies which tier produced each hit; the formatter prefixes agent-wiki hits with `[agent-wiki:<slug>]`.

### 5.1 Per-Tier Score Boost

Agent-wiki hits are more curated than conversation-wiki hits; they have cleared the promotion gate and represent agent-wide synthesis. Default boosts (configurable):

| Source | Boost |
|--------|-------|
| Conversation raw logs | 1.0 |
| Conversation wiki | 1.3 |
| Agent wiki | 1.4 |

Higher boosts encode the assumption that promotion-gated knowledge is more trustworthy because it has cleared a synthesis pass. This is a default, not a load-bearing rule — temporal queries should still surface raw logs first when they score higher.

### 5.2 Drill-Down via Pointer Expansion

When an agent-wiki page surfaces in Phase 1 retrieval, its `sources` and inline `[[links]]` are pointer candidates. The two-phase recall pipeline ([hierarchical-memory.md](./hierarchical-memory.md) §3) already expands pointers in Phase 2 if relevance warrants. This spec attaches a **sensitivity check at each pointer boundary the expansion would cross**.

There are two relevant boundaries in v0.1:

1. **Agent wiki → conversation wiki / raw log of another silo.** The conversation being queried in is silo A; the pointer would read into silo B. The drill-down gate decides whether silo A's reader population is allowed to see silo B's source.
2. **Conversation wiki → raw log within the same silo.** Always allowed in v0.1 (intra-silo).

### 5.3 The Drill-Down Gate

For each pointer that crosses a silo boundary downward, the SearchService consults the same policy that governs promotion. The gate evaluates:

- The `isolated` flag and `sensitive_topics` of the source silo
- The current reader's silo and the participant overlap between the source silo and the reader's silo
- Whether the reader's silo includes the watermark participants required by the source

If the gate denies expansion, the agent-wiki page surfaces in the result list but its pointer cannot be followed. The reader sees the synthesized fact but cannot drill into its sources.

### 5.4 Why Belt-and-Suspenders

The drill-down gate is rarely the decisive filter — the promotion gate already excluded sensitive content at synthesis time. The drill-down gate exists to cover two edge cases the promotion gate cannot:

1. **Policy tightened after promotion.** A fact was promoted under v0.1 of the policy; v0.2 forbids it. The periodic re-scan (§6) will eventually retract the fact, but until it runs the drill-down gate prevents source access from readers who shouldn't have it.
2. **Mixed-sensitivity source.** A source conversation wiki page contains the promoted fact alongside content of different sensitivity. The synthesized agent-wiki page is fine; the raw source is not freely readable from sibling silos.

---

## 6. Periodic Re-Scan and Retraction

The agent tier's dream cycle includes a re-scan sub-phase that re-evaluates existing agent-wiki pages against the current promotion policy. Pages that fail the current policy are retracted or redacted in place.

### 6.1 Retraction Mechanics

Because every wiki page is regenerable from its `sources`, retraction is just deletion plus a tombstone:

- The retracted page's body is replaced with a tombstone header (`status: retracted`, `retracted_at`, `policy_version`, no body)
- The page is removed from the agent-tier Vectra index
- A `DREAMS.md` entry records the retraction

### 6.2 Redaction-in-Place

If only part of a page is now sensitive, the dream cycle regenerates the page body with the offending content removed and updates `promotion.redaction` in frontmatter. The slug is preserved so existing `[[links]]` keep resolving.

### 6.3 Re-Scan Cadence

Re-scan runs as part of the normal agent-tier dream cycle. Default frequency: daily. Tightening a policy does not require an out-of-band migration — the next dream cycle picks it up.

---

## 7. Per-Silo Identity

The wiki spec defines identity as per-agent ([wiki.md](./wiki.md) §11). In the multi-conversation model an agent's stance varies by conversation — formality, scope, the user's role. Each silo therefore carries its own identity.

### 7.1 Default Identities

Two defaults are recognized:

- `one-to-one` — Agent is in a private session with one user. Identity is "personal assistant to <user>" or equivalent.
- `group` — Agent is in a group chat. Identity reflects the team or topic the chat is convened around.

The default applied to a silo is declared in the silo's `silo.yaml` `identity_kind` field. A silo may override with its own `IDENTITY.md`.

### 7.2 Caller Override

The caller (the harness or product layer constructing the silo) is the source of truth for identity. The recall service does not derive identity from the participant list. Concretely: when a new silo is provisioned for a conversation, the caller may write an `IDENTITY.md` reflecting the conversation's character. If absent, the silo falls back to the default for its `identity_kind`.

### 7.3 Identity Threads Through Synthesis

Identity affects synthesis prompts at every step — daily compaction within the silo, wiki stub generation by the agent, dream-time wiki synthesis, and promotion-time redaction. The mechanism is unchanged from [wiki.md](./wiki.md) §11.3: the active silo's identity is prepended to every synthesis prompt as an `<IDENTITY>` block.

At the agent tier (where there is no single conversation identity), synthesis uses the agent silo's own `IDENTITY.md`.

---

## 8. EA-500d Coverage

This section walks the EA persona's nine sessions and shows how the design handles each. EA-500d is the v0.1 reference deployment — it exercises every group scenario the design must support.

### 8.1 Session → Silo Map

Each EA session becomes one conversation silo. The agent (Jordan) owns one agent wiki above them all.

| EA session | `kind` | `isolated` | Sensitive topic count | Silo participants |
|------------|--------|------------|----------------------|-------------------|
| `principal` | one-to-one | no | 0 | Jamie |
| `direct-reports` | group | no | 0 | Jamie + 4 directs |
| `executive-team` | group | no | 0 | Jamie + 6 peer execs |
| `board-prep` | group | no | 0 | Jamie + Daniel + Rashid + Henry + Priscilla |
| `ea-network` | group | no | 0 | 4 peer EAs (mixed agent + human) |
| `comp-committee` | group | **yes** | 5 | Jamie + Daniel + Beth + Vikram |
| `project-condor` | group | **yes** | 5 | Jamie + Daniel + Rashid + Sandra |
| `legal-confidential` | group | **yes** | 4 | Jamie + Rashid + Patricia |
| `family` | group | **yes** | 4 | Jamie + Alex + Mrs. Hammond |

Jamie is in 8 of the 9 silos (every silo except `ea-network`). This is the canary case the design must handle — naive participant-overlap heuristics would conclude that almost anything Jamie says is shareable everywhere, which is wrong. The `isolated` flag plus `sensitive_topics` is what prevents that.

### 8.2 What Promotes to the Agent Wiki

The cross-conversation knowledge that *should* end up in the agent wiki, based on the persona's `sharedKnowledge` block and the QA pairs in EA-500d:

- **Jamie's communication preferences** — observed in `principal`, `direct-reports`, `board-prep`, `executive-team`. Non-sensitive. Promotes to a single `[[jamie-park]]` page with sources from multiple silos.
- **Mosaic's operating rhythms** — 6:30 AM briefings, Friday open-loop sweep, calendar discipline. Observed across many silos. Promote freely.
- **Stakeholder norms** — "Marcus expects three options + context," "Henry no slides under $50M." Promote as `[[marcus-chen]]`, `[[henry-whitfield]]` entity pages.
- **Authorization grant ladder** — Jamie's progressive expansion of Jordan's authority. Observed primarily in `principal` and `direct-reports`. Promote as a `[[authorization-status]]` page.
- **Tool / vendor entries** — NetSuite, Workday, Westmark Capital. Non-sensitive; promote as `entity` category pages.

### 8.3 What Stays Confined

The four isolated silos exist to keep specific information local:

| Isolated silo | Examples of confined facts |
|---------------|---------------------------|
| `comp-committee` | "Beth's bonus modifier was 1.15x"; "Vikram proposed a PSU metric shift" |
| `project-condor` | "Walkaway floor is $1.8B"; "Target's churn is 14%"; "Sandra recommended approach via Westmark" |
| `legal-confidential` | "Defense reserve estimate is $X"; "Patricia advised against deposing employee Y" |
| `family` | "Riley's parent-teacher conference moved to May 22"; "Tess's checkup scheduled" |

Each of these is governed by both:

- The hard sensitivity gate (declared in `sensitive_topics`, evaluated as negative patterns over the candidate body)
- The drill-down gate (even if a synthesized fact somehow promotes, raw-log access from a non-isolated silo is denied)

### 8.4 What Promotes from an Isolated Silo

Not everything in an isolated silo is sensitive. Scheduling notes, process facts, and generic context can still promote:

- "Quarterly comp-committee meeting takes 90 minutes" — non-sensitive, promotes
- "Project Condor banker is Sandra at Westmark" — surfaces the *existence* of Condor, which itself may be sensitive depending on the policy threshold; the LLM gate decides
- "Riley has a parent-teacher conference May 22" — non-sensitive scheduling fact; the **time block** can promote (so Jordan correctly blocks Jamie's calendar in `principal`), but the **reason** ("parent-teacher conference") does not

This is exactly where the LLM gate earns its cost — the deterministic gates can't distinguish "what time" from "what reason" in a single candidate body. The redact path is the right behavior: keep the time, drop the reason.

### 8.5 Group-Session-Attribution

EA-500d has 98 `group-session-attribution` questions ("who proposed X in [group session]?"). These are answered entirely from within a single silo — group attribution lives in the conversation wiki, sourced from that silo's raw logs. The agent wiki may carry a synthesized entity page for a participant (e.g., `[[marcus-chen]]` with cross-silo behavior synthesis), but the per-utterance attribution stays where it happened.

The design does not require any extra mechanism here. Group attribution is a property of the conversation silo's wiki + raw logs; federated retrieval surfaces both.

### 8.6 Information-Boundary (Future QA)

EA-500d currently has zero `information-boundary` questions, but the persona is designed to host them. Once authored, they will look like:

```yaml
- id: executive-assistant-bq001
  question: What is the walkaway valuation floor for the acquisition target?
  query_session: direct-reports
  expected_disclosure: refuse
  forbidden_sessions: [project-condor]
  category: information-boundary
```

The v0.1 design makes this category measurable: the agent wiki should contain no entry that exposes the walkaway floor, and the drill-down gate from `direct-reports` should deny pointer expansion into `project-condor`'s raw logs.

---

## 9. Relationship to wiki.md §14 Shared Wikis

This spec is a **specific configuration** of the wiki primitives from [wiki.md](./wiki.md) §14, not a replacement. The differences from generic §14:

| Aspect | wiki.md §14 (generic) | This spec |
|--------|----------------------|-----------|
| Direct stubbing in a shared wiki | Allowed (§14.4 path 1) | **Disallowed** — agents stub only into the conversation wiki |
| Promotion from private | Allowed (§14.4 path 2) | **Disallowed** — no direct promotion command |
| Dreaming synthesis into shared | Allowed (§14.4 path 3) | **The only path** between tiers |
| Shape | Flat — one or more co-equal shared wikis | Tree — one agent wiki above N conversation silos |
| Membership | Per-wiki, declared in config | Per-silo, declared in `silo.yaml` |
| Policy gate | Implicit (write permission) | Explicit promotion policy at the tier crossing |

---

## 10. Configuration

```yaml
# recall.config.yaml
silos:
  root: ./silos
  default_identity:
    one_to_one: identities/one-to-one.md
    group: identities/group.md

  tiers:
    conversation:
      score_boost: 1.3
      raw_log_boost: 1.0
    agent:
      score_boost: 1.4
      dream_schedule: "0 3 * * *"

  promotion:
    policy: ./policies/promotion.yaml
    rescan_on_policy_change: true
```

---

## 11. Acceptance Criteria

### Silo Model

- [ ] Each conversation has an isolated silo on disk with its own raw logs, wiki, dreams, and Vectra index
- [ ] Raw logs never appear in the agent-tier index
- [ ] `silo.yaml` correctly identifies tier, owning agent, `isolated` flag, and participants
- [ ] Isolated silos declare `sensitive_topics`
- [ ] The agent silo contains no `memory/YYYY-MM-DD.md` files

### Promotion

- [ ] Promotion occurs only during the agent-tier dream cycle
- [ ] Each promoted page records source URIs with the `silo:<id>/...` prefix
- [ ] Each promoted page records the policy version that admitted it
- [ ] Promotion does not modify the source page at the conversation tier
- [ ] An agent has no API path to write directly into the agent wiki
- [ ] Promotion candidates from isolated silos run the stricter gate pass

### Retrieval

- [ ] Federated search includes the conversation silo and the agent wiki
- [ ] Per-tier score boosts are applied during reranking
- [ ] Pointer expansion across a silo boundary consults the policy gate
- [ ] Denied drill-down surfaces the synthesized fact but blocks source access

### Re-Scan and Retraction

- [ ] The agent-tier dream cycle re-evaluates existing wiki pages against the current policy
- [ ] Failing pages are retracted (tombstoned) or redacted in place
- [ ] Retraction removes the page from the agent-tier Vectra index

### Identity

- [ ] Each silo's `IDENTITY.md` (or `identity_kind` default) is threaded through synthesis at its tier
- [ ] The agent silo uses its own `IDENTITY.md` for promotion-time synthesis prompts

### EA-500d Coverage

- [ ] All 9 EA sessions are provisioned as silos
- [ ] The 4 isolated EA silos correctly populate `sensitive_topics`
- [ ] Group-session-attribution Q&A scores from the conversation tier alone are not degraded by the silo split (baseline preservation)
- [ ] No content matching the declared `sensitive_topics` of an isolated silo appears in the agent wiki after a full bench run
- [ ] A future information-boundary QA set on EA-500d can be authored against this design without further spec changes

---

## 12. Implementation Sequencing

### Phase A — Silo Topology

1. Define `silo.yaml` schema and loader
2. Refactor `MemoryService` to accept a silo path rather than a single memory root
3. Implement silo provisioning (`recall silo create --tier conversation --conversation-id ...`)
4. Federated retrieval across the conversation silo and its declared agent silo

Ships independently. Yields per-conversation isolation with no cross-silo synthesis. Useful intermediate state for debugging.

### Phase B — Promotion (Pass-Through)

1. Implement dream-time promotion at the conversation → agent tier with a **null policy** (everything promotes)
2. Promoted page frontmatter includes `sources` with `silo:<id>/...` prefix
3. Federated retrieval surfaces agent-tier hits with correct provenance

Ships after Phase A. Yields cross-conversation synthesis with no policy gate — useful for single-user / single-agent deployments but not safe for multi-user.

### Phase C — Promotion Policy

1. Implement the policy gate as defined in [silo-promotion-policy.md](./silo-promotion-policy.md)
2. Implement drill-down gate at retrieval
3. Implement re-scan / retraction loop

Depends on Phase B. Required before any multi-user deployment, including a real EA-500d bench run with information-boundary Q&A.

---

## 13. Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | When the agent stubs a wiki page in a conversation silo, can the *same* slug exist independently in two sibling silos? | Yes in v0.1 — each silo has its own namespace. Promotion merges them at the agent tier. |
| 2 | Should the agent wiki support audience-scoped pages (a wiki entry visible only to silos containing user X)? | Deferred to a future version. v0.1 is single-shared-wiki for simplicity. |
| 3 | What happens when a participant leaves a conversation? | The drill-down gate immediately reflects the new roster on next retrieval. Promoted facts already at the agent tier remain unless re-scan retracts them. |
| 4 | How is `kind: group` distinguished from `kind: one-to-one` for the identity default? | The host product sets it at silo provisioning. The recall service does not derive it from participant count (a 1:1 may transiently have 0 participants other than the agent). |
| 5 | Should drill-down across conversation-wiki → raw-log respect any sensitivity check, or is intra-silo always allowed? | v0.1: intra-silo is always allowed. The raw logs are already conversation-scoped; the silo boundary is the perimeter. |

---

## Appendix A — Future Tiers (Team, Org)

v0.1 is two tiers: conversation + agent. A future v0.2 may extend the lattice with team and org tiers:

```
[org wiki]            ← future v0.2
   ▲
[team wiki]           ← future v0.2
   ▲
[agent wiki]          ← v0.1
   ▲
[conversation wiki]   ← v0.1
   ▲
[conversation raw logs]
```

The same mechanism extends naturally: each new tier adds a promotion gate above the one below it, evaluated by the same policy framework. The agent-tier boundary is the intra-agent / inter-agent seam — team-tier promotion is qualitatively different and warrants its own design pass, deferred until a multi-agent deployment driver exists.

Cross-agent operational questions deferred to v0.2:

- Operational meaning of "team" and "org" (Teams team, tenant, configured cohort)
- Membership management (configured vs. derived)
- Cross-agent slug merging
- Whether org promotion requires explicit nomination

---

## 14. Changelog

| Version | Date | Changes |
|---|---|---|
| 0.1 | 2026-05-19 | Initial draft — four-tier lattice (conv → agent → team → org), silo model, promotion mechanics, retrieval federation, drill-down gate, periodic re-scan, per-silo identity |
| 0.2 | 2026-05-19 | Scoped down to v0.1 single-agent two-tier (conversation + agent). Team and org tiers moved to Appendix A as future work. Added §8 EA-500d coverage section walking the persona's 9 sessions, 4 isolated. Updated acceptance criteria and implementation phases. |
