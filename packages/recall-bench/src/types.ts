/**
 * Recall Bench — Types
 *
 * Core type definitions for the benchmark harness, including the adapter
 * interface, Q&A pair schema, time-range slicing, and scoring types.
 */

// ---------------------------------------------------------------------------
// Time Ranges
// ---------------------------------------------------------------------------

/** Named time range cutoffs (in days) for subsetting benchmark runs. */
export const TIME_RANGES = {
    '30d': 30,
    '90d': 90,
    '6mo': 180,
    '1y': 365,
    'full': 1000,
} as const;

export type TimeRangeKey = keyof typeof TIME_RANGES;

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
] as const;

export type Category = (typeof CATEGORIES)[number];

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

export interface MemorySystemAdapter {
    /** Human-readable name of the system under test */
    name: string;

    /** Initialize the memory system to a clean state */
    setup(): Promise<void>;

    /** Ingest a single day's memory. Called in chronological order. */
    ingestDay(day: number, content: string, metadata: DayMetadata): Promise<void>;

    /** Signal that ingestion is complete. System may do final processing. */
    finalizeIngestion(): Promise<void>;

    /** Ask a question and get an answer */
    query(question: string): Promise<string>;

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

export interface JudgeModel {
    /** Score a single answer against its reference */
    score(question: string, referenceAnswer: string, systemAnswer: string): Promise<JudgeScore>;
}

// ---------------------------------------------------------------------------
// Scoring Results
// ---------------------------------------------------------------------------

export interface QuestionResult {
    /** The Q&A pair that was evaluated */
    qa: QAPair;
    /** The system's answer */
    systemAnswer: string;
    /** Judge's score */
    score: JudgeScore;
    /** Composite score (correctness + completeness + hallucination, max 6) */
    compositeScore: number;
    /** Query latency in ms */
    latencyMs: number;
}

export interface CategoryScore {
    category: Category;
    meanScore: number;
    questionCount: number;
    scores: number[];
}

export interface TimeRangeResult {
    /** Which time range this result covers */
    range: TimeRangeKey;
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
    range: TimeRangeKey;
    category: Category;
    score: number;
    questionCount: number;
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
}

export interface BenchmarkResult {
    /** Timestamp of the run */
    timestamp: string;
    /** Adapter name */
    adapterName: string;
    /** Which time ranges were evaluated */
    ranges: TimeRangeKey[];
    /** Results per persona */
    personas: PersonaResult[];
    /** Aggregate heatmap across all personas */
    heatmap: HeatmapCell[];
}

// ---------------------------------------------------------------------------
// Harness Configuration
// ---------------------------------------------------------------------------

export interface HarnessConfig {
    /** Which personas to run (IDs). Defaults to all available. */
    personas?: string[];
    /** Which time ranges to evaluate. Defaults to all. */
    ranges?: TimeRangeKey[];
    /** Shuffle seed for question ordering. 0 = no shuffle. */
    shuffleSeed?: number;
    /** Timeout per question in ms. Default 30000. */
    questionTimeoutMs?: number;
    /** Max concurrent queries. Default 1 (sequential). */
    parallelism?: number;
}
