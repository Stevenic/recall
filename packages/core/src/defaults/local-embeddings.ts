import type {
    EmbeddingsModel,
    EmbeddingsResponse,
} from "../interfaces/embeddings.js";

/**
 * Local embeddings using @huggingface/transformers (transformers.js).
 * Uses Xenova/all-MiniLM-L6-v2 by default — works fully offline.
 */
export class LocalEmbeddings implements EmbeddingsModel {
    readonly maxTokens: number = 256;

    private readonly _modelName: string;
    private _pipeline: any = null;

    constructor(modelName?: string) {
        this._modelName = modelName ?? "Xenova/all-MiniLM-L6-v2";
    }

    private async _getPipeline(): Promise<any> {
        if (!this._pipeline) {
            // Dynamic import to avoid loading transformers.js at module level
            const { pipeline } = await import("@huggingface/transformers");
            this._pipeline = await pipeline(
                "feature-extraction",
                this._modelName,
            );
        }
        return this._pipeline;
    }

    async createEmbeddings(
        inputs: string | string[],
    ): Promise<EmbeddingsResponse> {
        try {
            const pipe = await this._getPipeline();
            const inputArray = Array.isArray(inputs) ? inputs : [inputs];
            const output: number[][] = [];

            for (const input of inputArray) {
                const result = await pipe(input, {
                    pooling: "mean",
                    normalize: true,
                });
                // result is a Tensor — extract the data as a flat array
                output.push(Array.from(result.data as Float32Array));
            }

            return {
                status: "success",
                output,
            };
        } catch (err: unknown) {
            return {
                status: "error",
                message: err instanceof Error ? err.message : String(err),
            };
        }
    }
}
