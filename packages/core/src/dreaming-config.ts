/**
 * Dreaming system types and configuration.
 *
 * Dreaming is an asynchronous knowledge synthesis system that runs alongside
 * compaction. While compaction is structural (temporal boundaries), dreaming
 * is analytical — discovering patterns, surfacing forgotten connections,
 * extracting insights, and promoting durable knowledge.
 */

// ─── Configuration ───────────────────────────────────────

export interface DreamingConfig {
    /** Enable dreaming (default: false) */
    enabled?: boolean;

    /** Maximum candidates per dreaming session (default: 20) */
    maxCandidates?: number;

    /** Days of search log to analyze (default: 30) */
    signalWindowDays?: number;

    /** Days before typed memories are flagged as stale (default: 90) */
    stalenessThresholdDays?: number;

    /** Enable search signal logging (default: true when dreaming is enabled) */
    logSearches?: boolean;

    /** Candidate scoring weights */
    scoringWeights?: DreamScoringWeights;

    /** Analysis templates (override defaults) */
    analysisTemplates?: Partial<AnalysisTemplates>;

    /**
     * Write analysis output to wiki pages instead of (or in addition to)
     * the legacy `memory/dreams/insights/` + `memory/dreams/contradictions/`
     * files. Requires a WikiEngine wired into the DreamEngine. Default: true
     * when the wiki layer is enabled at the service level.
     */
    writeToWiki?: boolean;

    /**
     * Cosine-similarity threshold above which a `create` wiki op is converted
     * to an `update` against an existing topically-overlapping page. Without
     * this dedup, dreaming proliferates near-duplicate pages on the same
     * topic (e.g. `condor-working-deal-frame` and `condor-valuation-and-
     * synergy-frame`) and the wiki accumulates stale claims that crowd out
     * dailies at search time. The check uses pure-semantic retrieval against
     * `name + description + body` and only fires when a single non-self
     * wiki page exceeds this threshold. Default: 0.8.
     */
    wikiDedupThreshold?: number;

    /**
     * WISDOM.md distillation step that runs at the end of `dream()`. The
     * LLM reads the current WISDOM.md, a summary of the dream's new
     * insights / wiki updates / contradictions, and proposes a JSON list
     * of patches (`add` / `update` / `remove` / `keep_all`). The result
     * is an always-loadable pointer table the agent's host can pre-stuff
     * into context on every turn.
     */
    wisdom?: WisdomDistillationConfig;

    /**
     * How many candidate analyses can run concurrently inside a single
     * dream session.
     *
     * Default is 4. The wiki apply path serializes per-slug via an
     * internal lock, so concurrent workers touching the same wiki page
     * naturally serialize while ops on different pages parallelize
     * freely. Raising this further bumps Azure TPM use but otherwise
     * has no correctness impact.
     */
    analyzeConcurrency?: number;
}

/**
 * A wiki page operation emitted by the dreaming analyzer. The DreamEngine
 * applies each op to its bound WikiEngine in writeResults().
 */
export type DreamWikiOp =
    | {
          op: "create";
          slug: string;
          category: "entity" | "concept" | "project" | "reference" | "theme";
          name: string;
          description: string;
          body: string;
          sources: string[];
          related?: string[];
          confidence?: "high" | "medium" | "low";
          /**
           * Optional supersession record. Present when the new page overrides
           * a prior claim that lived in a daily log or another memory.
           */
          supersedes?: { source: string; fact?: string };
      }
    | {
          op: "update";
          slug: string;
          /** Body fragment to append. Existing body is preserved. */
          appendBody: string;
          /** Source URI to add (deduped against existing sources). */
          source: string;
          /**
           * Optional supersession record. Present when the appended fact
           * overrides an older claim. The page's `supersedes` frontmatter
           * gets this entry appended (deduped by source URI).
           */
          supersedes?: { source: string; fact?: string };
      }
    | {
          op: "contradict";
          /** The page that holds the new claim. */
          slug: string;
          /** Slugs of pages this page's claim contradicts. */
          contradicts: string[];
          /** Optional description of the contradiction for the DREAMS.md diary. */
          note?: string;
      };

export interface DreamWikiUpdate {
    op: DreamWikiOp["op"];
    slug: string;
    /** Whether the op succeeded; failures are surfaced in the report rather than thrown. */
    ok: boolean;
    /** Human-readable detail for the diary or CLI output. */
    detail: string;
}

export interface DreamScoringWeights {
    hitFrequency?: number; // default: 0.25
    queryDiversity?: number; // default: 0.25
    gapSignal?: number; // default: 0.20
    staleness?: number; // default: 0.15
    entityFrequency?: number; // default: 0.15
}

export interface AnalysisTemplates {
    crossReference: string;
    gapAnalysis: string;
    contradictionDetection: string;
    typedMemoryExtraction: string;
    themeSynthesis: string;
    /**
     * Verifier prompt for the entity-rename detector. Given two wiki pages
     * that share a majority of cited sources but whose names don't share
     * a dominant proper noun, the verifier decides whether they describe
     * the same underlying entity and which name is canonical.
     */
    entityRename: string;
    /**
     * Prompt for the wisdom-distillation step that maintains WISDOM.md
     * during dreaming. Reads the current wisdom file, recent dream
     * activity, and a wiki-index summary; returns a JSON patch list.
     */
    wisdomDistillation: string;
}

/**
 * Configuration for the dreaming-time WISDOM.md distillation step. Each
 * dream() call ends with a single LLM round-trip that proposes
 * patches against the current WISDOM.md.
 */
export interface WisdomDistillationConfig {
    /**
     * Run the wisdom step at the end of `dream()`. Default: true when a
     * WikiEngine is wired into the DreamEngine. Set to false to disable
     * during single-source experiments.
     */
    enabled?: boolean;
    /**
     * Hard cap on entries in WISDOM.md. The LLM is told to keep_all
     * within this budget; the post-LLM applier enforces it by trimming
     * lowest-priority entries when exceeded.
     */
    maxEntries?: number;
    /**
     * Soft cap on WISDOM.md char count. The agent's context window
     * always loads WISDOM.md, so the file's size is part of every
     * answer's budget. Default ~4000 chars (≈ 1K tokens).
     */
    maxChars?: number;
}

// ─── Search Log ──────────────────────────────────────────

export interface SearchLogEntry {
    ts: string;
    query: string;
    results: string[];
    scores: number[];
    topK: number;
    returned: number;
}

// ─── Candidates ──────────────────────────────────────────

export type DreamCandidateType =
    | "entity_cluster"
    | "temporal_gap"
    | "stale_memory"
    | "wisdom_drift"
    | "high_frequency"
    | "null_query"
    /**
     * A recent daily contains decision markers ("decided to", "switched to",
     * "chose X over Y", "changed our mind", "corrected", "updated") that
     * suggest a fact may have changed. Dreaming reviews the daily against
     * existing wiki state and proposes a wiki op with `supersedes` when a
     * supersession is confirmed. See §12.4 + the wiki refactor design.
     */
    | "supersession_signal";

export interface DreamCandidate {
    type: DreamCandidateType;
    score: number;
    uris: string[];
    description: string;
}

// ─── Dream Options & Results ─────────────────────────────

export interface DreamOptions {
    /** Override max candidates for this session */
    maxCandidates?: number;
    /** Dry run — report what would be examined without running LLM */
    dryRun?: boolean;
    /** Only run specific phases */
    phases?: ("gather" | "analyze" | "write")[];
    /**
     * Force-disable wiki writes for this session even when `writeToWiki` is
     * true in config. Useful for `recall dream --no-wiki`.
     */
    skipWiki?: boolean;
}

export interface DreamResult {
    /** Insights generated */
    insights: InsightRecord[];
    /** Typed memories promoted */
    promotions: string[];
    /** Contradictions detected */
    contradictions: ContradictionRecord[];
    /** Gaps identified (queries with no good results) */
    gaps: GapRecord[];
    /** Wiki page operations applied (Phase D — empty when wiki disabled) */
    wikiUpdates: DreamWikiUpdate[];
    /** Candidates examined vs total */
    candidatesExamined: number;
    candidatesTotal: number;
    /** LLM usage */
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
}

export interface InsightRecord {
    file: string;
    theme: string;
    sources: string[];
    confidence: "high" | "medium" | "low";
}

export interface ContradictionRecord {
    wisdomEntry: string;
    evidence: string[];
    recommendation: string;
}

export interface GapRecord {
    query: string;
    frequency: number;
    lastQueried: string;
}

// ─── Analysis Results (internal) ─────────────────────────

export interface AnalysisResult {
    candidate: DreamCandidate;
    insights: InsightRecord[];
    promotions: Array<{ filename: string; content: string }>;
    contradictions: ContradictionRecord[];
    gaps: GapRecord[];
    /** Wiki operations the model emitted — applied during writeResults */
    wikiOps: DreamWikiOp[];
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
}

// ─── Dream Status ────────────────────────────────────────

export interface DreamStatus {
    lastRun?: string;
    pendingCandidates: number;
    searchLogEntries: number;
    searchLogOldest?: string;
}

// ─── Dream State (persisted to .dreams/dream-state.json) ─

export interface DreamState {
    lastRun?: string;
    lastCandidatesExamined?: number;
    lastInsightsGenerated?: number;
}

// ─── Default values ──────────────────────────────────────

export const DEFAULT_SCORING_WEIGHTS: Required<DreamScoringWeights> = {
    hitFrequency: 0.25,
    queryDiversity: 0.25,
    gapSignal: 0.20,
    staleness: 0.15,
    entityFrequency: 0.15,
};

export const DEFAULT_MAX_CANDIDATES = 20;
export const DEFAULT_SIGNAL_WINDOW_DAYS = 30;
export const DEFAULT_STALENESS_THRESHOLD_DAYS = 90;
/**
 * Default threshold for create→update conversion. Tuned so genuinely
 * distinct topics (e.g. "API rate limits" vs "API authentication") stay
 * separate while near-duplicates of the same topic ("condor valuation
 * frame" vs "condor working deal frame") merge. Pure-semantic cosine
 * similarity from Vectra runs in [0, 1]; 0.8 is a strict "same topic"
 * bar that won't false-positive on tangentially related pages.
 */
export const DEFAULT_WIKI_DEDUP_THRESHOLD = 0.8;
/**
 * Default concurrency for dream candidate analysis. The wiki apply
 * path is race-safe via per-slug locking (`_withSlugLock`) so workers
 * touching the same page serialize while different-page work
 * parallelizes. 4 is a reasonable starting point — well inside Azure
 * TPM windows for gpt-5.4 / gpt-5.4-mini and gives a ~3-4x speedup
 * over sequential.
 */
export const DEFAULT_DREAM_ANALYZE_CONCURRENCY = 4;
/**
 * Per-dream-session cap on entity-rename verifier calls. The detector
 * runs after every successful wiki write that has ≥3 sources, but the
 * LLM verifier is gated by this cap to bound cost. False positives are
 * the dangerous failure mode (merging two distinct entities), so the
 * cap keeps the blast radius small while we tune the prompt.
 */
export const DEFAULT_MAX_ENTITY_RENAMES_PER_SESSION = 3;
/**
 * Default hard cap on WISDOM.md entries. Twenty pointers fit comfortably
 * in a glanceable list and stay under the byte budget even at long
 * descriptions; more than that turns the file into prose and defeats
 * its purpose as a pre-stuffed pointer index.
 */
export const DEFAULT_WISDOM_MAX_ENTRIES = 20;
/**
 * Default soft cap on WISDOM.md char count. The file is always loaded
 * into the agent's context window, so its size is part of every turn's
 * budget. ~4000 chars ≈ 1K tokens — about 5% of a typical 20K-token
 * working context.
 */
export const DEFAULT_WISDOM_MAX_CHARS = 4000;
/**
 * Minimum source overlap (Jaccard) between two wiki pages for the
 * entity-rename detector to escalate to the LLM verifier. 0.5 means
 * "the pages share at least half of their combined sources" — strong
 * enough that they're likely about the same thing, but not so strict
 * that a slow rename (where only the most-recent dailies overlap) gets
 * missed.
 */
export const DEFAULT_ENTITY_RENAME_OVERLAP = 0.5;
