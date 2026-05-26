/**
 * Interface for second-stage reranking of retrieval candidates.
 *
 * First-stage retrieval (bi-encoder embedding similarity + BM25) is fast
 * but coarse — it ranks each document against the query in isolation. A
 * cross-encoder reranker takes `[query, doc]` as a single input and runs
 * full attention across both, producing a much more accurate relevance
 * score at the cost of one model call per candidate. The trade-off lands
 * in our favor when the candidate set is small (top-20) and the query
 * matters (factual recall, specific values).
 *
 * Used by {@link SearchService} as an optional post-processing step on
 * top-K hits. When unset, search returns first-stage results unchanged.
 */
export interface Reranker {
    /**
     * Score `(query, doc)` pairs and return them ordered by relevance,
     * highest first. The implementation may truncate to `topK` when
     * provided; otherwise it returns all input pairs reordered.
     *
     * Implementations should be best-effort: a model load failure or
     * timeout should throw, but a partial-batch failure should still
     * return what scored. Callers fall back to first-stage order on
     * any thrown error.
     */
    rerank(
        query: string,
        documents: string[],
        options?: RerankOptions,
    ): Promise<RerankResult[]>;
}

export interface RerankOptions {
    /** Truncate the output to the highest-scoring `topK` results. */
    topK?: number;
}

export interface RerankResult {
    /** Index of the document in the original input array. */
    index: number;
    /** Cross-encoder relevance score; higher is more relevant. */
    score: number;
}
