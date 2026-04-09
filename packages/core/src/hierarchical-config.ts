import type { ScoringWeights } from "./interfaces/index.js";

/**
 * Configuration for the hierarchical memory system.
 */
export interface HierarchicalMemoryConfig {
    /** Enable hierarchical memory (default: true) */
    enabled?: boolean;

    /** Phase 1 hybrid scoring weight for embeddings vs BM25 (default: 0.7) */
    parentAlpha?: number;

    /** Phase 2 scoring weights */
    scoringWeights?: ScoringWeights;

    /** Parent oversampling factor (default: 10) */
    parentCandidates?: number;

    /** Direct raw memory candidates in Phase 1 (default: 20) */
    rawCandidates?: number;

    /** Embedding aggregation strategy (default: "salience") */
    aggregationStrategy?: "uniform" | "recency" | "salience";

    /** Enable BM25 in Phase 1 parent retrieval (default: true) */
    bm25Parents?: boolean;

    /** Enable BM25 in Phase 2 reranking (default: true) */
    bm25Rerank?: boolean;

    /** Temporal affinity falloff width in days (default: 30) */
    temporalSigma?: number;

    /** Enable temporal affinity scoring (default: true) */
    temporalAffinity?: boolean;
}
