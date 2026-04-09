import type { MetadataFilter, MetadataTypes } from "vectra";

export type { MetadataFilter, MetadataTypes };

export interface DocumentMetadata {
    contentType?: string; // "daily" | "weekly" | "monthly" | "wisdom" | "typed_memory"
    teammate?: string;
    period?: string; // ISO date, week, or month
    /** For parent nodes: "agg" or "summary" */
    embeddingType?: "agg" | "summary";
    [key: string]: MetadataTypes | undefined;
}

export enum ResultType {
    /** Raw daily memory entry — authoritative detail */
    RAW = "raw",
    /** Generated summary from a parent node — gap coverage, not authoritative */
    SUMMARY = "summary",
}

export interface ScoringWeights {
    embedding?: number; // default: 0.5
    bm25?: number; // default: 0.3
    parent?: number; // default: 0.2
}

export interface QueryOptions {
    maxResults?: number; // default: 10
    maxChunks?: number; // default: 3
    maxTokens?: number; // default: 500
    filter?: MetadataFilter;
    /** Phase 1 oversampling factor for parent retrieval (default: 10) */
    parentCandidates?: number;
    /** Phase 1 direct raw memory candidates (default: 20) */
    rawCandidates?: number;
    /** Enable BM25 hybrid scoring (default: true) */
    enableBM25?: boolean;
    /** Phase 2 scoring weights (must sum to 1.0) */
    scoringWeights?: ScoringWeights;
    /** Include parent summaries in results (default: true) */
    includeSummaries?: boolean;
    /** Override temporal reference date for affinity scoring */
    temporalReference?: Date;
}

export interface SearchResult {
    uri: string;
    text: string;
    score: number;
    metadata: DocumentMetadata;
    partial?: boolean;
    /** Distinguishes raw memory entries from generated parent summaries */
    resultType?: ResultType;
    /** URI of the parent node that contributed this result, if via expansion */
    parentUri?: string;
    /** Breakdown of scoring components */
    scoreBreakdown?: {
        embedding: number;
        bm25: number;
        parent: number;
    };
}

export interface IndexStats {
    documentCount: number;
    chunkCount: number;
    lastUpdated?: Date;
}

export interface CreateIndexOptions {
    deleteIfExists?: boolean;
}

/**
 * Abstraction over the vector index. Wraps the vector database
 * so Vectra can be swapped for another backend.
 */
export interface MemoryIndex {
    createIndex(options?: CreateIndexOptions): Promise<void>;
    isCreated(): Promise<boolean>;
    upsertDocument(
        uri: string,
        text: string,
        metadata?: DocumentMetadata,
    ): Promise<void>;
    deleteDocument(uri: string): Promise<void>;
    hasDocument(uri: string): Promise<boolean>;
    query(text: string, options?: QueryOptions): Promise<SearchResult[]>;
    getStats(): Promise<IndexStats>;

    /**
     * Retrieve the raw embedding vector for a document URI.
     * Returns null if the document is not in the index.
     * Required for computing aggregated embeddings.
     */
    getEmbedding(uri: string): Promise<number[] | null>;

    /**
     * Upsert a pre-computed embedding vector (no text chunking).
     * Used for storing aggregated embeddings.
     */
    upsertEmbedding(
        uri: string,
        embedding: number[],
        metadata?: DocumentMetadata,
    ): Promise<void>;
}
