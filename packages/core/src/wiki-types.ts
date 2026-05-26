/**
 * Wiki page categories. Drive per-category templates (§3.4) and UI grouping.
 */
export type WikiCategory =
    | "entity"
    | "concept"
    | "project"
    | "reference"
    | "theme";

/**
 * A wiki target: `"private"` for the agent's own wiki, or the configured
 * `name` of a shared wiki (Phase F).
 */
export type WikiTarget = "private" | (string & {});

export interface SharedWikiConfig {
    /** Logical name; used in CLI flags and qualified `[[name:slug]]` links */
    name: string;
    /** Filesystem path to the shared memory root (relative to agent root, or absolute) */
    path: string;
    /** Access role for this agent */
    role: "member" | "reader";
    /** Optional per-shared-wiki score boost; overrides top-level `wiki.scoreBoost` */
    scoreBoost?: number;
}

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
    /** Shared wikis the agent participates in (default: []) */
    shared?: SharedWikiConfig[];
}

export const DEFAULT_WIKI_CONFIG: Required<
    Omit<WikiConfig, "shared" | "enabled">
> & { enabled: boolean; shared: SharedWikiConfig[] } = {
    enabled: false,
    // Score-boost tuning history (failure-driven):
    //   1.5 — too aggressive; wiki routinely outranked dailies even when
    //         the daily contained the asked-about specific fact.
    //   1.1 — softer tiebreaker for synthesized pages, but run 18's
    //         500d failures (22 appellate-reviewed misses) showed the
    //         right daily at pos #1 in 0/22 cases, and a wiki page at
    //         pos #1 in 13/22 cases. Even 10% was enough for wiki to
    //         consistently displace dailies that carried the answer.
    //   0.9 — current. De-boost: a wiki page must beat the daily on its
    //         own retrieval score by ~10% before it wins position #1.
    //         Wiki pages are still findable (they index normally) and
    //         the agent can still cite them; they just don't get a
    //         tiebreaker that costs specific-fact recall. Matches the
    //         "neutral treatment of all sources" stance OpenClaw uses
    //         by default.
    scoreBoost: 0.9,
    minSourcesForStub: 1,
    minSourcesForSynthesis: 3,
    stalenessThresholdDays: 90,
    shared: [],
};

/**
 * A reference into a contributing memory source. The `uri` is mandatory;
 * `range` and `summary` are optional enrichments emitted by dreaming
 * when it can. Daily logs are immutable, so `range` captured at write
 * time stays valid forever — the agent can use it to issue targeted
 * `memory_get` calls. Pages on disk that predate the enrichment store
 * just the URI; the parser upgrades them to this shape with `summary`
 * / `range` undefined.
 */
export interface SourceContribution {
    /** Memory URI of the contributing source (e.g. `memory/2026-01-14.md`). */
    uri: string;
    /**
     * Optional 1-based line window of the source that supports this
     * contribution. When set, the agent can issue
     * `memory_get(uri, from, lines)` to read just the relevant span.
     */
    range?: { from: number; lines: number };
    /**
     * Optional one-sentence description of what this source contributed
     * to the page's current claim. Transition-form ("Revised X from $18M
     * to $28M") is preferred over current-state ("Added the $28M case")
     * since it tells the agent both the new value and the prior one.
     */
    summary?: string;
}

export interface WikiPage {
    slug: string;
    name: string;
    description: string;
    category: WikiCategory;
    /** ISO date the page was first created */
    created: string;
    /** ISO date the page was last updated */
    updated: string;
    /**
     * Contributors that shaped the page's current claim. Older pages on
     * disk may store just URIs (`string[]`); the parser upgrades them
     * to {@link SourceContribution} with `summary` / `range` undefined.
     * The serializer emits the compact URI-only form for pages whose
     * every contribution lacks both fields so legacy pages stay
     * bit-identical until dreaming next touches them.
     */
    sources: SourceContribution[];
    /** Other wiki slugs explicitly linked from this page */
    related: string[];
    /** Synthesis confidence; defaults to "low" for stubs */
    confidence?: "high" | "medium" | "low";
    /** Wiki slugs whose claims this page disagrees with */
    contradicts?: string[];
    /**
     * Records that this page's current claim overrides an earlier one. Each
     * entry points at the older source (typically a daily log) plus an
     * optional summary of the prior claim. Maintained by dreaming when it
     * detects that a new daily contradicts existing wiki state — the wiki
     * page evolves to the new truth, and the old claim is recorded here
     * for traceability. Lets retrieval and synthesis know "this page used
     * to say X; it now says Y."
     */
    supersedes?: SupersedesEntry[];
    /** Optional redirect to another slug (for merge / rename / promote stubs) */
    redirectTo?: string;
    /**
     * Quality flags from the post-write grounding verifier. Searchable
     * by retrieval so pages with unverified or stale claims get demoted
     * relative to fully-grounded pages on the same topic. Absent when
     * verification didn't run.
     */
    grounding?: GroundingReport;
    /** Page body (markdown, no frontmatter) */
    body: string;
}

/**
 * Verification summary attached to a wiki page after dreaming writes it.
 * Produced by `WikiEngine.verifyGrounding` (or the dream-engine post-
 * write hook). Treat the fields as advisory: zero counts mean the
 * verifier didn't find issues, but it may also have skipped checks it
 * couldn't make (no LLM available, no sources to compare against).
 */
export interface GroundingReport {
    /** ISO date the verification ran. */
    verifiedOn: string;
    /** Count of claims in the body the verifier found supporting evidence for. */
    grounded: number;
    /**
     * Claims in the body that no cited source mentions. These are
     * either hallucinations the synthesis model invented, or values
     * the verifier failed to match (e.g. paraphrased differently).
     * Strict-mode retrieval should demote pages with any unverified
     * claims.
     */
    unverified: string[];
    /**
     * Claims whose supporting source is older than the page's most-
     * recent cited source. Indicates the body may be carrying a stale
     * value that a later daily already revised — the merge-with-
     * supersession step should have caught it but didn't.
     */
    stale: string[];
}

/**
 * A record of a prior claim that this wiki page now overrides. Frontmatter
 * representation in `supersedes:` on the page.
 */
export interface SupersedesEntry {
    /** URI of the older source whose claim is now superseded (e.g. memory/2026-01-10.md). */
    source: string;
    /**
     * Optional one-line summary of the prior claim, useful for the diary
     * and for downstream LLM context. Omit when summary isn't available.
     */
    fact?: string;
    /** ISO date the supersession was recorded. Auto-set when omitted. */
    supersededOn: string;
}

/** Convenience: a page is a stub when it has a single source. */
export function isStub(page: WikiPage): boolean {
    return page.sources.length <= 1;
}

export interface WikiPageStubInput {
    slug: string;
    name: string;
    description: string;
    category: WikiCategory;
    /**
     * Source URI for the stub (typically today's daily log path). Either
     * a bare URI or the structured form with optional range + summary.
     */
    source: string | SourceContribution;
    /** Body content. May be a pre-rendered template or freeform markdown */
    body: string;
    /** Optional related slugs */
    related?: string[];
    /** Optional explicit creation date (defaults to today) */
    created?: string;
    /** Target wiki (defaults to "private") */
    target?: WikiTarget;
}

export interface WikiPageRef {
    target: WikiTarget;
    slug: string;
}

export interface WikiLintReport {
    brokenLinks: { from: string; toSlug: string; target: WikiTarget }[];
    orphans: string[];
    stalePages: { slug: string; updated: string; newestSource: string }[];
    missingCategory: string[];
    slugDrift: { file: string; declaredSlug: string }[];
    contradictionLoops: [string, string][];
    /** Qualified `[[name:slug]]` references whose target wiki is unconfigured or missing */
    unknownTargets: { from: string; targetName: string }[];
    /** Per-target counts of pages scanned */
    scanned: Record<string, number>;
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

/**
 * A parsed `[[slug]]` or `[[name:slug]]` link reference.
 */
export interface WikiLinkRef {
    /** Wiki target name; null for bare `[[slug]]` (resolves within the same wiki) */
    target: string | null;
    /** Page slug */
    slug: string;
    /** Optional pipe-separated display text (`[[slug|display]]`) */
    display: string | null;
    /** Position of the link in the source text (start/end offsets, inclusive/exclusive) */
    start: number;
    end: number;
}

/**
 * A wiki target's resolved location on disk.
 */
export interface ResolvedWikiTarget {
    /** Logical target name (`"private"` or a shared wiki name) */
    name: WikiTarget;
    /** Absolute path to the memory root */
    root: string;
    /** Absolute path to the wiki directory (`<root>/memory/wiki`) */
    wikiDir: string;
    /** Access role; `"member"` for private and member-role shared wikis */
    role: "member" | "reader";
}
