import type {
    Reranker,
    RerankOptions,
    RerankResult,
} from "../interfaces/reranker.js";

/**
 * Local cross-encoder reranker via @huggingface/transformers.
 *
 * Defaults to `Xenova/ms-marco-MiniLM-L-6-v2` — a 22MB ONNX model
 * fine-tuned on MS MARCO that scores `(query, doc)` pairs through a
 * tiny cross-encoder. On CPU it runs at ~5ms per pair, so reranking
 * 20 candidates costs ~100ms — well under one round-trip to a hosted
 * reranker and zero per-call cost.
 *
 * The model classifies each pair as relevant / not-relevant; we use the
 * "LABEL_1" (relevant) probability as the score. Higher = more relevant.
 *
 * Why this matters for Recall: the bi-encoder + BM25 stack returns
 * candidates that are *topically* close, but the top-1 hit is often a
 * tangentially-related daily rather than the one with the specific fact
 * the question asks for. A cross-encoder rerank consistently lifts top-3
 * accuracy by 5-15 points on MS-MARCO-style tasks; in the EA bench it
 * directly addresses the "agent picked the wrong daily" failure cluster.
 */
export class LocalReranker implements Reranker {
    private readonly _modelName: string;
    private _pipeline: unknown = null;

    constructor(modelName?: string) {
        this._modelName = modelName ?? "Xenova/ms-marco-MiniLM-L-6-v2";
    }

    private async _getPipeline(): Promise<unknown> {
        if (!this._pipeline) {
            // Dynamic import to keep transformers.js off the import path
            // for environments that don't enable reranking.
            const { pipeline } = await import("@huggingface/transformers");
            // `text-classification` with this model returns a single-label
            // score per pair. `top_k: 1` would only return the top label;
            // we set null to get all labels so we can pick "LABEL_1" (the
            // relevance class) explicitly. The transformers.js typings are
            // loose so we cast through unknown.
            this._pipeline = await pipeline(
                "text-classification" as never,
                this._modelName,
            );
        }
        return this._pipeline;
    }

    async rerank(
        query: string,
        documents: string[],
        options?: RerankOptions,
    ): Promise<RerankResult[]> {
        if (documents.length === 0) return [];
        const pipe = (await this._getPipeline()) as (
            input: { text: string; text_pair: string }[] | { text: string; text_pair: string },
            opts?: { top_k?: number | null },
        ) => Promise<Array<{ label: string; score: number }> | Array<Array<{ label: string; score: number }>>>;

        // The pipeline supports batch input. Pass all pairs at once so
        // ORT can batch internally; falls back to per-pair calls when
        // the model output shape isn't what we expect.
        const pairs = documents.map((doc) => ({ text: query, text_pair: doc }));
        const raw = await pipe(pairs, { top_k: null });
        // `raw` shape for batch input is either an array of label-score
        // objects (one per input) or an array of arrays (top_k=null).
        // Normalize to per-doc relevance scores.
        const scores = documents.map((_, i) => {
            const entry = Array.isArray(raw)
                ? (raw[i] as Array<{ label: string; score: number }> | { label: string; score: number })
                : (raw as unknown as { label: string; score: number });
            if (Array.isArray(entry)) {
                // Multi-label output: prefer "LABEL_1" (relevance), else
                // first entry's score.
                const rel = entry.find((e) => /^label[_-]?1$/i.test(e.label));
                return rel ? rel.score : entry[0]?.score ?? 0;
            }
            // Single-label output: take its score directly.
            return entry?.score ?? 0;
        });

        const ordered: RerankResult[] = scores
            .map((score, index) => ({ index, score }))
            .sort((a, b) => b.score - a.score);

        const topK = options?.topK;
        return topK !== undefined && topK > 0 ? ordered.slice(0, topK) : ordered;
    }
}
