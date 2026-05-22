# Silo Promotion Policy — Design Spec

**Status:** Draft (skeleton — most gate rules are TBD)
**Author:** Scribe
**Date:** 2026-05-19
**Version:** 0.2
**Parent specs:** [conversation-silos.md](./conversation-silos.md) v0.2, [wiki.md](./wiki.md) v0.4, [dreaming.md](./dreaming.md) v0.2
**Scope:** v0.1 covers the **conversation → agent** promotion gate only. Team and org tier policies are deferred to future versions (see Appendix A).

---

## 1. Overview

This spec defines the **policy gate** that decides whether a fact may promote from a conversation silo into the shared agent wiki (see [conversation-silos.md](./conversation-silos.md) §4). It is the single piece of logic that controls what synthesized knowledge becomes visible across all of the agent's conversations.

This document is a skeleton. The structure of the policy — inputs, outcomes, ordering of gates, integration with dreaming and retrieval — is settled and described below. The specific gate rules (sensitivity label sets, watermark validity windows, LLM classifier prompts) are TBD and will be filled in by follow-up work (§9).

### 1.1 Why a Separate Spec

The promotion policy is the highest-churn surface in the design. Product, security, and compliance will all want to iterate on the rules. Keeping the policy out of the structural spec ([conversation-silos.md](./conversation-silos.md)) lets the topology stabilize while the rules evolve.

### 1.2 Design Principles

- **Decisions are per-fact, made once.** The gate runs at dream time on each promotion candidate. Retrieval-time work is limited to provenance-aware drill-down checks against decisions the gate already made.
- **Outputs are explicit.** Every evaluation produces `allow`, `redact`, or `block`, plus a recorded reason. No silent rejections.
- **Versioned.** Every gate evaluation records the policy version that produced it. Tightening the policy triggers a re-scan; loosening does not.
- **Hard gates before soft gates before LLM gates.** Cheap deterministic checks fail fast. The LLM is consulted only on candidates that have already cleared the structural checks.
- **`isolated: true` is a first-class signal.** Candidates originating from an isolated silo run a stricter pass.

---

## 2. Inputs

Each promotion evaluation receives:

```typescript
interface PromotionCandidate {
  /** The wiki page being considered for promotion */
  source: {
    silo_id: string;              // conversation silo ID
    slug: string;
    frontmatter: WikiFrontmatter; // name, category, sources, confidence, etc.
    body: string;
  };

  /** Source silo metadata from its silo.yaml */
  source_silo: {
    isolated: boolean;
    sensitive_topics: string[];   // populated only when isolated=true
    kind: "one-to-one" | "group";
    participants: Participant[];
  };

  /** Target: the agent wiki and the reader population it serves */
  target: {
    agent_id: string;
    /** All conversation silos that read the agent wiki */
    reader_silos: Array<{ silo_id: string; participants: Participant[] }>;
  };

  /** Active policy version */
  policy_version: string;
}

interface Participant {
  id: string;
  joined: string;                 // ISO date
  role: string;                   // principal | core | guest | board | etc.
}
```

The candidate is the **full wiki page**, not a sentence or a fact. The synthesizer treats the page as the atomic unit. If the page mixes sensitive and non-sensitive content, the redaction path (§3.3) regenerates it without the sensitive portions.

---

## 3. Gate Categories

The policy is a sequence of gate categories evaluated in order. Each gate may return `allow`, `redact`, `block`, or `defer` (pass to the next gate).

### 3.1 Hard Gates (Deterministic)

Fail-fast structural checks. Cheap, no LLM. If any returns `block` or `redact`, evaluation stops there.

| Gate | Input | Decision |
|------|-------|----------|
| **Isolated-silo sensitivity match** | If `source_silo.isolated == true`, scan `source.body` against `source_silo.sensitive_topics` | If any sensitive topic is matched in the body, default `block`; refer to LLM gate for a possible `redact` |
| **Sensitivity label** | `source.frontmatter.sensitivity` (if set) | TBD — set of labels admitted at the agent tier |
| **Watermark validity** | Source participants present at the candidate's creation date, vs. current reader-silo participants | TBD — fraction of source watermark participants who must still be readers of *at least one* sibling silo |
| **PII / secret screen** | Body content, regex + entity scan | TBD — block if any unredacted PII/secrets detected; some classes (proper names) may auto-redact |
| **Source-tier minimum confidence** | `source.frontmatter.confidence` | TBD — usually `medium` or `high` required |
| **Source-tier minimum age** | `source.frontmatter.created` vs now | TBD — facts may need to "settle" before promotion |

### 3.2 Soft Gates (Deterministic, Scoring)

Computed scores combined with thresholds. May return `allow`, `defer`, or `block` depending on threshold position. None of these alone is sufficient to `allow` — they gate access to the LLM phase.

| Gate | Input | Score |
|------|-------|-------|
| **Cross-silo frequency** | Count of sibling conversation silos with a wiki page on the same slug | TBD threshold; higher frequency increases confidence the fact is shared knowledge, not silo-private |
| **Topic salience** | Embedding distance from any existing agent-wiki entry on the slug | TBD; used to detect drift / contradiction candidates |
| **Participant continuity** | Fraction of source silo's `principal` and `core` participants still active in any reader silo | TBD |

The soft gates' output is a vector of scores attached to the candidate. The LLM gate sees it. The hard-coded promotion rule is: if any soft score is below its `block` threshold, block; if all are above their `allow` thresholds, advance to LLM gate; if mixed, advance to LLM gate with the scores in the prompt.

### 3.3 LLM Gate (`StepC`)

The `StepC` ALLOWED / REDACTED / BLOCKED classifier from the Teams whitepaper, run at dream time per candidate (not per query). Inputs:

- Source page body
- The agent wiki's identity (for framing)
- The source silo's `isolated` flag and `sensitive_topics` list
- Soft-gate scores
- The active sensitivity label set

Outputs:

- `allow` — emit the page as-is at the agent tier
- `redact` with a list of substrings or sections to remove — synthesizer regenerates the page body without them
- `block` with a reason — page is not promoted; reason is recorded in `DREAMS.md`

The LLM gate is the most expensive step. It is **only** reached by candidates that have cleared the hard and soft gates. Cost is paid per fact, once, at dream time — not per query.

### 3.4 Order of Evaluation

```
hard gates ──block──► reject (record in DREAMS.md)
   │ allow/defer
   ▼
soft gates ──block──► reject
   │ allow/defer
   ▼
LLM gate  ──block──► reject
   │ allow / redact
   ▼
synthesize agent-wiki page
   │
   ▼
write + index
```

---

## 4. Handling Isolated Silos

The EA persona's four isolated silos (`comp-committee`, `project-condor`, `legal-confidential`, `family`) are the v0.1 reference case. The policy must:

1. **Detect sensitivity-topic matches in candidate bodies.** Each `sensitive_topic` in `source_silo.sensitive_topics` is a natural-language description, not a regex. The hard gate runs an embedding-based or substring-based scan to detect matches; the LLM gate makes the call on ambiguous matches.
2. **Allow non-sensitive promotions from isolated silos.** A scheduling note from `family` (e.g., "block 2:30–3:30 PM Thursday for personal") may promote without the *reason* (e.g., "parent-teacher conference"). This is the canonical `redact` path: keep the time, drop the reason.
3. **Default to block on ambiguity.** Isolated-silo candidates that the LLM gate cannot cleanly categorize fall through to `block`, not `allow`. The asymmetry is deliberate — promotion errors leak information; non-promotion errors do not.

### 4.1 Worked Example — comp-committee

Source body in `silos/conv-comp-committee/memory/wiki/q2-comp-cycle.md`:

> The Q2 comp committee meeting reviewed officer-level performance ratings and approved Beth Rivera's bonus modifier of 1.15x. The committee also discussed the PSU metric shift proposed by Vikram Mehta, deferring decision to Q3. Meetings take 90 minutes; next session scheduled for August 12.

Hard gate scan against `sensitive_topics`:

- "Individual executive base, bonus, and equity grant amounts" → **matches** "Beth Rivera's bonus modifier of 1.15x"
- "Plan-design changes pending committee approval (e.g., PSU metric shifts)" → **matches** "PSU metric shift proposed by Vikram Mehta"

LLM gate decision: `redact` — the non-sensitive substrings ("Meetings take 90 minutes", "next session scheduled for August 12") survive; the rest is removed. Resulting agent-wiki entry:

> Comp committee meetings take 90 minutes. Next scheduled session is August 12.

Recorded in frontmatter:

```yaml
promotion:
  policy_version: silo-promotion-policy/0.2
  evaluated_at: 2026-05-19
  outcome: redact
  redaction: "Removed 2 sensitive-topic matches (officer comp, PSU plan-design)"
```

### 4.2 Worked Example — family

Source body in `silos/conv-family/memory/wiki/may-22-conference.md`:

> Riley's parent-teacher conference is scheduled for May 22, 2:30–3:30 PM. Mrs. Hammond confirmed. Jamie blocked the time.

Hard gate match: "Riley and Tess Park's school information, conference dates, and academic concerns" → **matches** the entire body.

LLM gate decision: `redact` — surface the time block without the reason. Resulting agent-wiki entry:

> Jamie has a personal commitment on May 22, 2:30–3:30 PM. Time blocked.

This is the right behavior for the principal silo to know about (so Jordan doesn't schedule over it) without exposing the family content to silos like `direct-reports`.

### 4.3 What Does Not Get Cleverly Redacted

Some isolated-silo content cannot be safely abstracted. For example, the *existence* of Project Condor is itself sensitive in many policy regimes. A body like "Sandra recommended approaching the target via Westmark" cannot be redacted into something useful — removing the names destroys the meaning. These cases fall through to `block`. The agent wiki simply does not learn about Condor; Jordan only knows about Condor inside the `project-condor` silo.

---

## 5. Outputs and Provenance

Each evaluation records a decision artifact:

```yaml
# Embedded in the promoted page's frontmatter (see conversation-silos.md §4.3)
promotion:
  policy_version: silo-promotion-policy/0.2
  evaluated_at: 2026-05-19T03:14:00Z
  outcome: allow                       # allow | redact | block
  gates_passed: [isolated-check, sensitivity, watermark, pii, confidence, age, frequency, salience, llm]
  redaction: null                      # or a description of what was removed
```

Block decisions do not produce a page at the agent tier; they produce a `DREAMS.md` entry recording:

```markdown
## 2026-05-19 — promotion blocked: q2-comp-cycle
- source: silo:conv-comp-committee/memory/wiki/q2-comp-cycle.md
- failing gate: isolated-check + llm
- reason: source matches 2 sensitive topics; LLM gate found no coherent non-sensitive subset
- policy version: silo-promotion-policy/0.2
```

---

## 6. Retraction on Policy Change

When the policy file is updated, the next agent-tier dream cycle re-evaluates every existing promoted page against the new policy. Pages that no longer pass are retracted or redacted in place (see [conversation-silos.md](./conversation-silos.md) §6).

Policy changes are versioned. The dream cycle compares each page's recorded `policy_version` against the active version; only pages with stale versions are re-evaluated. This bounds the cost of a policy bump.

Loosening the policy does **not** trigger re-promotion of previously-blocked candidates. Re-promotion happens naturally on the next normal dream cycle when the source page is touched. Explicit re-evaluation of blocked candidates is a separate command (`recall dream re-evaluate-blocks`, TBD).

---

## 7. Configuration

```yaml
# policies/promotion.yaml
version: silo-promotion-policy/0.2

conversation_to_agent:
  hard:
    isolated_check: enabled            # honors source_silo.sensitive_topics
    sensitivity_max: internal          # TBD label taxonomy
    watermark_validity_pct: 0.5        # TBD
    pii_screen: enabled
    min_source_confidence: medium
    min_source_age_days: 0
  soft:
    frequency_min: 1                   # 1 = even a single-silo fact may promote
    salience_threshold: TBD
    continuity_min: 0.5
  llm:
    model: openai:gpt-4o               # TBD
    temperature: 0
    prompt: prompts/promotion-stepc.md
```

All threshold values above are placeholders. They exist to show the shape of the configuration; real values come from the follow-up policy work (§9).

---

## 8. Acceptance Criteria

### Framework

- [ ] Every promotion candidate produces a recorded decision with policy version
- [ ] Hard gates evaluate before soft gates before LLM gates
- [ ] Decisions are one of `allow`, `redact`, `block` (no silent outcomes)
- [ ] Block decisions are recorded in the agent silo's `DREAMS.md`
- [ ] Redact outcomes regenerate the page body without offending content

### Isolated-Silo Handling

- [ ] Candidates from `isolated: true` silos run the isolated-sensitivity hard gate
- [ ] Sensitive-topic matches in the candidate body default to `block` or `redact`, never `allow`
- [ ] Non-sensitive substrings from an isolated silo can survive via the `redact` path
- [ ] The `*existence*` of certain isolated subjects (e.g., a codenamed project) can be policy-configured to block as a category, not just per-topic

### Integration

- [ ] Policy file is loaded at the agent-tier dream-cycle start
- [ ] Each promoted page records the policy version that admitted it
- [ ] Stale policy versions trigger re-evaluation on the next dream cycle
- [ ] Drill-down gate at retrieval consults the same policy

### EA-500d Coverage

- [ ] A full bench run produces **zero** agent-wiki entries containing the declared `sensitive_topics` of any isolated EA silo
- [ ] Non-sensitive scheduling and process facts from isolated silos surface in the agent wiki via the `redact` path where appropriate
- [ ] Group-session-attribution Q&A from EA-500d scores at parity with a no-silo baseline (the conversation tier alone is sufficient for attribution)

---

## 9. TBD — Specific Rules

The following are not yet decided. Each is its own follow-up:

| # | Topic | Owner | Notes |
|---|-------|-------|-------|
| 1 | Sensitivity label taxonomy and admitted set at the agent tier | Security / compliance | Align with the labels already used in Teams agent memory |
| 2 | Watermark validity percentage threshold | Product + security | Whitepaper §5.2 / §5.4 provide a starting point |
| 3 | PII / secret regex + entity scan implementation | Engineering | Reuse the salience NER pipeline + a secrets scanner |
| 4 | Cross-silo frequency threshold | Product | How many sibling silos must hold the same slug before promotion |
| 5 | StepC prompt and parsing | Engineering + product | Adapt the whitepaper's StepC ALLOWED/REDACTED prompt for per-candidate dream-time evaluation |
| 6 | Slug merging at the agent tier | Engineering | Two sibling silos may have the same slug with different bodies; the synthesizer must merge before evaluating |
| 7 | Calibration of the isolated-sensitivity matcher | Engineering | Embedding-based vs substring-based; thresholds; false-positive rate on EA-500d |
| 8 | Whether "subject existence" can be policy-blocked as a category (e.g., entire Condor codename) | Product | Topic-level vs body-substring level |

---

## Appendix A — Future Tier Specializations (Team, Org)

v0.1 covers only `conversation → agent`. Future versions add:

- **`agent → team`**: cross-agent synthesis where overlap matters; reader population expands to include other agents' conversations
- **`team → org`**: cross-team synthesis; strictest gates; possibly human-in-the-loop nomination

The same framework (hard → soft → LLM, recorded decisions, retraction on policy change) extends to those tiers. Per-tier rules are declared as additional blocks in the same policy YAML when those tiers exist.

---

## 10. Changelog

| Version | Date | Changes |
|---|---|---|
| 0.1 | 2026-05-19 | Initial skeleton — inputs, gate categories (hard / soft / LLM), per-tier specialization sketch for all four tiers, output and provenance schema, retraction-on-policy-change |
| 0.2 | 2026-05-19 | Scoped down to v0.1 single tier (conversation → agent). Team and org tier policies moved to Appendix A. Added §4 worked examples grounded in the EA persona's isolated silos (comp-committee, family). Updated configuration to single-tier shape. |
