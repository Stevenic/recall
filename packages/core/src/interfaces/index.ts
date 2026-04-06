import type { MetadataFilter, MetadataTypes } from "vectra";

export type { MetadataFilter, MetadataTypes };

export interface DocumentMetadata {
    contentType?: string; // "daily" | "weekly" | "monthly" | "wisdom" | "typed_memory"
    teammate?: string;
    period?: string; // ISO date, week, or month
    [key: string]: MetadataTypes | undefined;
}

export interface QueryOptions {
    maxResults?: number; // default: 10
    maxChunks?: number; // default: 3
    maxTokens?: number; // default: 500
    filter?: MetadataFilter;
}

export interface SearchResult {
    uri: string;
    text: string;
    score: number;
    metadata: DocumentMetadata;
    partial?: boolean;
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
}
