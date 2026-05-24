/**
 * Local mirrors of the recall-bench adapter contract.
 *
 * Duplicated here (rather than imported from `@recall/bench`) so this harness
 * stays self-contained and small. If recall-bench's shapes evolve, mirror
 * the changes here.
 */

export interface DayMetadata {
    /** Day number within the persona's memory stream (1-1000) */
    dayNumber: number;
    /** Synthetic calendar date (ISO 8601 YYYY-MM-DD) */
    date: string;
    /** Persona ID this day belongs to */
    personaId: string;
    /** IDs of narrative arcs active on this day */
    activeArcs: string[];
}

export interface RetrievalEntry {
    path: string;
    score: number;
    snippet: string;
}

export interface QueryDetail {
    answer: string;
    retrieval?: RetrievalEntry[];
}

export interface MemorySystemAdapter {
    name: string;
    setup(): Promise<void>;
    ingestDay(day: number, content: string, metadata: DayMetadata): Promise<void>;
    finalizeIngestion(): Promise<void>;
    query(question: string): Promise<string>;
    queryDetail?(question: string): Promise<QueryDetail>;
    teardown(): Promise<void>;
}

/**
 * Subset of the MemPalace MCP search-tool response we care about. Mempalace's
 * `mempalace_search` returns a richer envelope; we only consume `results[]`
 * and the optional sanitizer metadata.
 */
export interface MempalaceSearchResult {
    text: string;
    wing: string;
    room: string;
    source_file?: string;
    created_at?: string;
    similarity: number;
    distance?: number;
}

export interface MempalaceSearchResponse {
    results: MempalaceSearchResult[];
    vector_disabled?: boolean;
    error?: string;
}
