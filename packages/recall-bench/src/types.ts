/**
 * Recall Bench — Types
 *
 * Core type definitions for the benchmark harness, including the adapter
 * interface, Q&A pair schema, time-range slicing, and scoring types.
 */

// ---------------------------------------------------------------------------
// Time Ranges
// ---------------------------------------------------------------------------

/**
 * A single benchmark checkpoint: the corpus is truncated to the first `days`
 * days, then Q&A pairs whose answers fall within that window are evaluated.
 * `label` is the display name on heatmap headers and reports.
 */
export interface TimeRange {
    label: string;
    days: number;
}

/**
 * Conventional named cutoffs. Accepted as input wherever a TimeRange is taken
 * (CLI flags, profile YAML); produced by parseTimeRange for backward compat.
 */
const NAMED_RANGE_DAYS: Record<string, number> = {
    '30d': 30,
    '90d': 90,
    '6mo': 180,
    '1y': 365,
    'full': Number.MAX_SAFE_INTEGER,
};

/**
 * The default set of ranges when neither CLI nor profile specifies any.
 * Mirrors the pre-refactor "all named keys" behavior.
 */
export const DEFAULT_RANGES: readonly TimeRange[] = Object.entries(NAMED_RANGE_DAYS).map(
    ([label, days]) => ({ label, days }),
);

/**
 * Parse a single range input. Accepts:
 *   - a number (days): 30 → { label: "30d", days: 30 }
 *   - a numeric string: "30" → same
 *   - a "Nd" string: "30d" → same
 *   - a named alias: "30d", "90d", "6mo", "1y", "full"
 *   - a "Nm" / "Nmo" string: "6mo" → 180 days
 *   - a "Ny" string: "1y" → 365 days
 * Throws on unrecognized input.
 */
export function parseTimeRange(input: string | number | TimeRange): TimeRange {
    if (typeof input === 'object' && input !== null && 'days' in input) {
        return { label: input.label, days: input.days };
    }
    if (typeof input === 'number') {
        if (!Number.isFinite(input) || input <= 0) {
            throw new Error(`Invalid time range: ${input} (must be a positive number of days)`);
        }
        return { label: `${input}d`, days: input };
    }
    const raw = String(input).trim();
    if (raw in NAMED_RANGE_DAYS) {
        return { label: raw, days: NAMED_RANGE_DAYS[raw] };
    }
    const dayMatch = /^(\d+)d$/.exec(raw);
    if (dayMatch) {
        const n = parseInt(dayMatch[1], 10);
        return { label: `${n}d`, days: n };
    }
    const moMatch = /^(\d+)mo?$/.exec(raw);
    if (moMatch) {
        const n = parseInt(moMatch[1], 10);
        return { label: `${n}mo`, days: n * 30 };
    }
    const yMatch = /^(\d+)y$/.exec(raw);
    if (yMatch) {
        const n = parseInt(yMatch[1], 10);
        return { label: `${n}y`, days: n * 365 };
    }
    if (/^\d+$/.test(raw)) {
        const n = parseInt(raw, 10);
        return { label: `${n}d`, days: n };
    }
    throw new Error(
        `Invalid time range: "${raw}". Expected a number (e.g. 30), "Nd", "Nmo", "Ny", or one of: ${Object.keys(NAMED_RANGE_DAYS).join(', ')}.`,
    );
}

/**
 * Expand a {start, end, step} arithmetic progression into a list of ranges.
 * Useful in profiles to avoid spelling out 30+ entries by hand. Inclusive of
 * end when (end - start) is divisible by step.
 */
export function expandRangeSeries(opts: { start: number; end: number; step: number }): TimeRange[] {
    const { start, end, step } = opts;
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step)) {
        throw new Error('expandRangeSeries: start, end, and step must be finite numbers');
    }
    if (step <= 0) {
        throw new Error('expandRangeSeries: step must be positive');
    }
    if (end < start) {
        throw new Error('expandRangeSeries: end must be >= start');
    }
    const out: TimeRange[] = [];
    for (let d = start; d <= end; d += step) {
        out.push({ label: `${d}d`, days: d });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Evaluation Categories (topics)
// ---------------------------------------------------------------------------

export const CATEGORIES = [
    'factual-recall',
    'temporal-reasoning',
    'decision-tracking',
    'contradiction-resolution',
    'cross-reference',
    'recency-bias-resistance',
    'synthesis',
    'negative-recall',
    'group-session-attribution',
    'information-boundary',
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * For information-boundary tests, what the memory system is expected to do
 * when asked the question from `query_session`:
 *   - `refuse`:  decline to answer; sensitive content stays hidden
 *   - `partial`: a sanitized / cover-language answer (e.g., "scheduling conflict"
 *                instead of the underlying deposition reason)
 *   - `answer`:  full disclosure is allowed in this session
 */
export type ExpectedDisclosure = 'refuse' | 'partial' | 'answer';

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------

export type Difficulty = 'easy' | 'medium' | 'hard';

// ---------------------------------------------------------------------------
// Q&A Pairs
// ---------------------------------------------------------------------------

export interface QAPair {
    /** Unique identifier (e.g., "backend-eng-saas-q042") */
    id: string;
    /** The question to pose to the memory system */
    question: string;
    /** Reference answer used for scoring */
    answer: string;
    /** Evaluation category / topic */
    category: Category;
    /** Difficulty rating */
    difficulty: Difficulty;
    /** Day numbers that contain relevant information (1-based) */
    relevantDays: number[];
    /** Whether the answer requires synthesizing across multiple memories */
    requiresSynthesis: boolean;

    // Boundary-test fields (populated for category 'information-boundary',
    // optional otherwise). See specs/recall-bench.md §2.4 / §5.3 and
    // PLAYBOOK.md §8.3.

    /**
     * The session the question is asked from. For boundary tests, this is a
     * session that should NOT have access to the source content (e.g.,
     * `principal` querying about content sourced from an isolated session).
     * Defaults to `principal` when omitted.
     */
    querySession?: string;
    /**
     * Sessions whose content the answer would require leaking. The memory
     * system MUST NOT echo content from these sessions when asked the question
     * from `querySession`. Populated for `information-boundary` pairs.
     */
    forbiddenSessions?: string[];
    /** What a correctly-behaving memory system should do for this question. */
    expectedDisclosure?: ExpectedDisclosure;
    /**
     * Day-number cutoff after which this Q&A becomes obsolete because the
     * corpus has superseded the fact the reference encodes. Lets a Q&A
     * author retire pairs whose unpinned phrasing would yield the latest
     * value rather than the day-N-window value the reference holds.
     * Omit for pairs whose reference stays correct for the lifetime of
     * the corpus.
     */
    irrelevantAfter?: number;
}

// ---------------------------------------------------------------------------
// Day Metadata
// ---------------------------------------------------------------------------

export interface DayMetadata {
    /** Day number within the persona's memory stream (1-1000) */
    dayNumber: number;
    /** Synthetic calendar date (ISO 8601) */
    date: string;
    /** Persona ID this day belongs to */
    personaId: string;
    /** IDs of narrative arcs active on this day */
    activeArcs: string[];
}

// ---------------------------------------------------------------------------
// Memory System Adapter
// ---------------------------------------------------------------------------

/**
 * One retrieved memory chunk surfaced by the system before synthesis. Used
 * for failure-log diagnostics — lets analysts inspect what the system pulled
 * from memory when the answer was scored as a failure.
 */
export interface RetrievalEntry {
    /** Source path/identifier (e.g., a markdown filename or chunk id). */
    path: string;
    /** Relevance score from the memory backend. */
    score: number;
    /** The chunk text itself. */
    snippet: string;
}

export interface QueryDetail {
    answer: string;
    /** Memory chunks the system retrieved before synthesizing the answer. */
    retrieval?: RetrievalEntry[];
    /**
     * Tool-call trace (agent-loop systems only). One entry per tool call
     * the agent made while answering, in order. Surfaced via the
     * per-question log (questions.jsonl) so auditors can see whether the
     * agent used memory_get vs memory_search vs memory_timeline as the
     * system prompt instructs. Optional — systems that don't use a
     * tool-loop pipeline (e.g. single-shot synthesis adapters) omit it.
     */
    toolCalls?: ToolCallTraceEntry[];
}

export interface ToolCallTraceEntry {
    /** Tool name (e.g. "memory_search", "memory_get", "memory_timeline"). */
    tool: string;
    /** Arguments passed to the tool. */
    args: Record<string, unknown>;
    /** Short preview of the tool's response (first ~200 chars). */
    resultPreview: string;
}

export interface MemorySystemAdapter {
    /** Human-readable name of the system under test */
    name: string;

    /** Initialize the memory system to a clean state */
    setup(): Promise<void>;

    /** Ingest a single day's memory. Called in chronological order. */
    ingestDay(day: number, content: string, metadata: DayMetadata): Promise<void>;

    /**
     * Signal that ingested data should become queryable. The harness may call
     * this multiple times between successive ingest batches (incremental
     * checkpoint mode). Implementations MUST be idempotent: a second call
     * should extend the live index with any new days, not reset it.
     */
    finalizeIngestion(): Promise<void>;

    /** Ask a question and get an answer */
    query(question: string): Promise<string>;

    /**
     * Optional: ask a question and also surface the retrieval results the
     * adapter used to build the answer. Lets the harness log retrieval state
     * for failure analysis. When omitted, the harness uses `query()` and
     * skips retrieval logging.
     */
    queryDetail?(question: string): Promise<QueryDetail>;

    /** Clean up resources */
    teardown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Judge Interface
// ---------------------------------------------------------------------------

export interface JudgeScore {
    /** 0-3: Does the answer contain the right information? */
    correctness: number;
    /** 0-2: Does the answer include all relevant details? */
    completeness: number;
    /** 0-1: Is the answer free of hallucinated content? (1 = grounded) */
    hallucination: number;
    /** Optional reasoning from the judge */
    reasoning?: string;
}

/**
 * Optional context the harness can pass to a judge so it can score
 * grounding against the actual source memories rather than only against
 * the (often-terse) reference answer. When `memoryExcerpts` is provided,
 * implementations are expected to evaluate `hallucination` relative to
 * the excerpts; without it, judges fall back to comparing system answer
 * to reference.
 *
 * For `information-boundary` Q&A pairs the harness also surfaces the
 * access-control fields (`expectedDisclosure`, `querySession`,
 * `forbiddenSessions`). When those are present, judges should evaluate
 * the system answer against the *expected behavior* (refuse / partial /
 * answer) rather than against the reference's literal content — a system
 * that correctly refuses to leak protected content should score high
 * even when the reference would have answered.
 */
export interface JudgeContext {
    memoryExcerpts?: string;
    expectedDisclosure?: ExpectedDisclosure;
    querySession?: string;
    forbiddenSessions?: string[];
}

export interface JudgeModel {
    /** Score a single answer against its reference (and optional memory context). */
    score(
        question: string,
        referenceAnswer: string,
        systemAnswer: string,
        context?: JudgeContext,
    ): Promise<JudgeScore>;
}

// ---------------------------------------------------------------------------
// Scoring Results
// ---------------------------------------------------------------------------

export interface QuestionResult {
    /** The Q&A pair that was evaluated */
    qa: QAPair;
    /** The system's answer */
    systemAnswer: string;
    /**
     * Judge's score. When the appellate judge re-scored a primary failure,
     * this is the appellate score (the appellate verdict is final); the
     * primary score is preserved in `primaryScore` for diagnostics.
     */
    score: JudgeScore;
    /** Composite score (correctness + completeness + hallucination, max 6) */
    compositeScore: number;
    /** Query latency in ms */
    latencyMs: number;
    /**
     * The primary judge's score, when an appellate review took place. Absent
     * when no appellate judge is configured or when the primary's score
     * didn't qualify as a failure.
     */
    primaryScore?: JudgeScore;
}

export interface CategoryScore {
    category: Category;
    meanScore: number;
    questionCount: number;
    /**
     * Count of QA pairs in this category whose `max(relevantDays) ≤ cutoff`
     * at the time this range was evaluated — i.e., questions the dataset
     * makes available at this checkpoint, regardless of whether sampling
     * selected them. Lets visualizers distinguish "no eligible data yet"
     * (render as not-yet-possible) from "data exists but was filtered out."
     */
    eligibleCount?: number;
    scores: number[];
}

export interface TimeRangeResult {
    /** Which time range this result covers */
    range: TimeRange;
    /** How many days were ingested */
    daysIngested: number;
    /** How many Q&A pairs were eligible for this range */
    questionsEvaluated: number;
    /** Mean composite score across all questions in this range */
    overallScore: number;
    /** Per-category breakdown */
    categoryScores: CategoryScore[];
    /** Per-difficulty breakdown */
    difficultyScores: Record<Difficulty, { mean: number; count: number }>;
    /** Hallucination rate (% of questions where hallucination = 0) */
    hallucinationRate: number;
    /** Individual question results */
    questionResults: QuestionResult[];
}

export interface HeatmapCell {
    /** Range label (the column header). */
    range: string;
    category: Category;
    score: number;
    questionCount: number;
    /** See CategoryScore.eligibleCount. */
    eligibleCount?: number;
}

export interface PersonaResult {
    personaId: string;
    adapterName: string;
    /** Results per time range */
    rangeResults: TimeRangeResult[];
    /** Heatmap data: category × time range → score */
    heatmap: HeatmapCell[];
    /** Total ingestion time in ms */
    totalIngestionMs: number;
    /** Total query time in ms */
    totalQueryMs: number;
    /** Base Q&A pair count for this persona (the dataset size). */
    uniqueQAPairCount: number;
    /** Sum of `questionsEvaluated` across all ranges for this persona. */
    totalEvalsRun: number;
    /**
     * Information-disclosure breakdown for `information-boundary` Q&A pairs:
     * per-expectedDisclosure ('refuse' | 'partial' | 'answer') stats aggregated
     * across all ranges. Omitted (or empty) when no boundary pairs exist.
     */
    disclosureBreakdown?: DisclosureBreakdown;
}

/**
 * Aggregate stats per expectedDisclosure category for information-boundary
 * questions. Counts and scores are summed across all ranges and only
 * information-boundary pairs contribute.
 */
export interface DisclosureBreakdown {
    refuse?: DisclosureStats;
    partial?: DisclosureStats;
    answer?: DisclosureStats;
}

export interface DisclosureStats {
    /** Number of (question × range) evaluations contributing here. */
    evaluations: number;
    /** Number of unique Q&A pairs with this expectedDisclosure value. */
    uniquePairs: number;
    /** Mean composite score (0-6) across the evaluations. */
    meanScore: number;
    /** Hallucination rate (% of evals where hallucination=0). */
    hallucinationRate: number;
}

export interface RunMetadata {
    /** Wall-clock duration of the run in ms (set when `run()` finishes). */
    durationMs: number;
    /** Model used by the adapter to synthesize prose answers (display string). */
    synthesisModel?: string;
    /** Embedding provider used by the adapter ('openai', 'auto', 'fts-only', etc.). */
    embeddingProvider?: string;
    /** Embedding model id (display string). */
    embeddingModel?: string;
    /** Judge model spec (display string). */
    judgeModel?: string;
    /** Appellate-judge model spec (display string), when one was configured. */
    appellateJudgeModel?: string;
    /** Count of evaluations the appellate judge re-scored. */
    appellateInvocations?: number;
    /**
     * Sum of `questionsEvaluated` across all (persona × range) combinations.
     * For 30 checkpoints × 316 questions where every question is eligible at
     * every checkpoint, this number can be much larger than `uniqueQAPairCount`.
     */
    totalEvalsRun: number;
    /** Sum of base Q&A pair counts across personas (the dataset size). */
    uniqueQAPairCount: number;
    /**
     * The historical-sample cap used by the run (`HarnessConfig.sample`). When
     * present and finite, indicates the per-checkpoint count of historical
     * questions; otherwise omitted (full evaluation).
     */
    sample?: number;
    /**
     * Days-around-relevant-day window the judge received as grounding context
     * for each Q&A pair. 0 (or omitted) means the judge ran reference-only.
     */
    judgeMemoryWindow?: number;
    /**
     * Whether group-aware categories (`group-session-attribution`,
     * `information-boundary`) were enabled for this run. `false` means those
     * categories were skipped at the harness level — heatmap rows for them
     * will be all-gray. `true` means they ran and boundary-aware judging
     * was applied to `information-boundary` pairs.
     */
    groupsEnabled?: boolean;
}

export interface BenchmarkResult {
    /** Timestamp of the run (start) */
    timestamp: string;
    /** Adapter name */
    adapterName: string;
    /** Which time ranges were evaluated */
    ranges: TimeRange[];
    /** Results per persona */
    personas: PersonaResult[];
    /** Aggregate heatmap across all personas */
    heatmap: HeatmapCell[];
    /** Run-level metadata for reporting (models, duration, totals). */
    metadata: RunMetadata;
    /**
     * Aggregate information-disclosure breakdown across all personas.
     * Omitted when no information-boundary pairs exist.
     */
    disclosureBreakdown?: DisclosureBreakdown;
}

// ---------------------------------------------------------------------------
// Harness Configuration
// ---------------------------------------------------------------------------

export interface HarnessConfig {
    /** Which personas to run (IDs). Defaults to all available. */
    personas?: string[];
    /** Which time ranges to evaluate. Defaults to all. */
    ranges?: TimeRange[];
    /** Shuffle seed for question ordering. 0 = no shuffle. */
    shuffleSeed?: number;
    /** Timeout per question in ms. Default 30000. */
    questionTimeoutMs?: number;
    /** Max concurrent queries. Default 1 (sequential). */
    parallelism?: number;
    /**
     * Arcs file inside each persona dir, used to select the dataset variant.
     * Memory and Q&A directory names are derived from this filename's suffix
     * (e.g., `arcs-180d.yaml` → `memories-180d/`, `qa-180d/`). Default:
     * `arcs-1000d.yaml`.
     */
    arcsFile?: string;
    /**
     * Window (in days) the harness uses when assembling memory excerpts for
     * the judge. For each Q&A pair the harness takes `qa.relevantDays` and
     * extends ±N days, then concatenates those days' content into a
     * `JudgeContext.memoryExcerpts` field passed to `judge.score(...)`.
     * Set to 0 to disable (judge sees reference-only). Default: 0.
     */
    judgeMemoryWindow?: number;
    /**
     * Whether the memory system under test claims to support per-group
     * (per-session) memories with access controls. When `false` (the default),
     * the harness skips every Q&A pair in the `group-session-attribution`
     * and `information-boundary` categories — those rows render gray on the
     * heatmap because no known memory system supports them today. When
     * `true`, those categories are evaluated AND the judge receives
     * `expectedDisclosure` / `querySession` / `forbiddenSessions` so it can
     * score refusal/partial/answer behavior appropriately.
     */
    groupsEnabled?: boolean;
    /**
     * Random-sample budget for "historical" questions at each checkpoint:
     * questions that first became eligible at an earlier checkpoint are
     * shuffled (seeded by `shuffleSeed`) and capped at this count. **New**
     * questions — those whose max relevant_day falls into the delta between
     * the previous checkpoint and this one — are always evaluated.
     *
     * Default: undefined (no sampling; every eligible question is evaluated
     * at every checkpoint, matching the prior behavior).
     */
    sample?: number;
    /**
     * Optional appellate judge: a second JudgeModel invoked only when the
     * primary judge's score qualifies as a failure (composite < 4.0/6.0 OR
     * hallucination=0). The appellate's score becomes canonical; the
     * primary's is preserved on the QuestionResult for analysis.
     */
    appellateJudge?: JudgeModel;
    /**
     * If set, the harness writes one JSONL record per failed evaluation
     * (one that was sent to the appellate judge) to this path. Records
     * include the question, reference, system answer, both judge scores,
     * the retrieval results (when the adapter implements `queryDetail`),
     * and the memory context the judge saw.
     */
    failureLogPath?: string;
    /**
     * Streaming progress sink. When set, the harness writes JSON lines to
     * this path:
     *   - First record (`type: "header"`): run-level metadata that's known
     *     before the first checkpoint (models, sample, ranges, groups, etc.).
     *   - Per checkpoint (`type: "checkpoint"`): persona id, range, scores,
     *     category breakdown, hallucination rate, timing. Emitted as soon as
     *     the checkpoint finishes — enables in-flight heatmap rendering.
     *   - Last record (`type: "summary"`): final-only metadata (durationMs,
     *     appellate invocations, totalEvalsRun).
     */
    progressJsonlPath?: string;
    /**
     * Per-question streaming sink. When set, the harness writes ONE JSON
     * line per question evaluated — regardless of score — containing the
     * full QA pair, system answer, final judge score, retrieval, and
     * latency. Lets operators inspect any non-perfect answer mid-run
     * without lowering the appellate threshold (which would multiply
     * judge cost). Distinct from `failureLogPath` (which is appellate-
     * gated and adds both primary and appellate scores). When both are
     * configured, the failure log is the richer record for the subset
     * that hit appellate, and the question log is the complete record
     * for every question. Default: <dir-of-json-out>/questions.jsonl.
     */
    questionLogPath?: string;
    /**
     * If set, the harness reads checkpoint records from this JSONL file at
     * the start of the run and treats any range whose label matches a
     * previously-completed `checkpoint` record as already done. The cached
     * result is included in the final aggregate; only its eval phase is
     * skipped. The adapter still ingests the day-range underneath the
     * cached cutoffs (in one bulk pass) so subsequent uncached checkpoints
     * see the right corpus state.
     *
     * Caveat: per-question results are not restorable from JSONL (the file
     * doesn't capture them). Cached ranges contribute their pre-aggregated
     * scores to the final result; their failure-log entries live in the
     * prior run's failure log. New checkpoints append to the progress JSONL
     * (and failure log) as normal.
     */
    resumeFromJsonlPath?: string;
    /**
     * When true, skip the catch-up ingest phase on resume. Use this when
     * the adapter preserves its memory state across runs (e.g., the Loki
     * adapter with `Recall:WipeOnSetup=false`) so the partition already
     * holds the cached checkpoints' ingest. Without this flag the harness
     * re-ingests every day up to the resume cutoff, doubling data on
     * adapters that don't wipe.
     */
    skipCatchupIngest?: boolean;
    /**
     * When true, stop after the first checkpoint of the first persona —
     * a dry-run mode for catching startup / wiring errors without paying
     * for the full sweep. Useful as a quick sanity check after harness or
     * profile changes. The partial result is still written normally
     * (one checkpoint of data instead of N), and downstream artifacts
     * (heatmap, summary) reflect just that one slice.
     */
    dryRun?: boolean;
    /**
     * Display labels for the models used in this run. Surfaced in the text
     * report and the JSON output's `metadata` block so visualizations can
     * annotate which models produced the data.
     */
    modelLabels?: {
        synthesisModel?: string;
        embeddingProvider?: string;
        embeddingModel?: string;
        judgeModel?: string;
        appellateJudgeModel?: string;
    };
}
