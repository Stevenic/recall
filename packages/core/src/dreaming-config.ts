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
      }
    | {
          op: "update";
          slug: string;
          /** Body fragment to append. Existing body is preserved. */
          appendBody: string;
          /** Source URI to add (deduped against existing sources). */
          source: string;
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
    | "null_query";

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
