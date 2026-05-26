import { LocalDocumentIndex, LocalIndex } from "vectra";
import type { EmbeddingsModel } from "vectra";
import type {
    MemoryIndex,
    CreateIndexOptions,
    DocumentMetadata,
    QueryOptions,
    SearchResult,
    IndexStats,
} from "../interfaces/index.js";

export interface VectraIndexConfig {
    folderPath: string;
    embeddings: EmbeddingsModel;
    chunkSize?: number;
    chunkOverlap?: number;
}

/**
 * Default MemoryIndex implementation backed by Vectra's LocalDocumentIndex.
 */
export class VectraIndex implements MemoryIndex {
    private readonly _index: LocalDocumentIndex;
    private readonly _folderPath: string;
    private readonly _embeddings: EmbeddingsModel;
    private _vectorIndex: LocalIndex | null = null;

    constructor(config: VectraIndexConfig) {
        this._folderPath = config.folderPath;
        this._embeddings = config.embeddings;
        // Default chunk overlap of 64 tokens (~12.5% of the 512-token chunk).
        // Vectra's TextSplitter is token-aware so this is meaningful overlap,
        // not character-count guessing. Overlap preserves context at chunk
        // boundaries and meaningfully lifts cross-paragraph synthesis and
        // temporal-reasoning recall — the embedding for "decided X on
        // Tuesday" no longer disappears when "decided X" lands at the tail
        // of one chunk and "on Tuesday" at the head of the next.
        this._index = new LocalDocumentIndex({
            folderPath: config.folderPath,
            embeddings: config.embeddings,
            chunkingConfig: {
                chunkSize: config.chunkSize ?? 512,
                chunkOverlap: config.chunkOverlap ?? 64,
            },
        });
    }

    /**
     * Access the underlying LocalIndex for raw vector operations.
     */
    private _getVectorIndex(): LocalIndex {
        if (!this._vectorIndex) {
            this._vectorIndex = new LocalIndex(this._folderPath);
        }
        return this._vectorIndex;
    }

    get folderPath(): string {
        return this._folderPath;
    }

    async createIndex(options?: CreateIndexOptions): Promise<void> {
        if (options?.deleteIfExists) {
            // Vectra's createIndex supports overwrite config
            await this._index.createIndex({
                version: 1,
                deleteIfExists: true,
            });
        } else {
            await this._index.createIndex({ version: 1 });
        }
    }

    async isCreated(): Promise<boolean> {
        return this._index.isCatalogCreated();
    }

    async upsertDocument(
        uri: string,
        text: string,
        metadata?: DocumentMetadata,
    ): Promise<void> {
        // Convert DocumentMetadata to Vectra's flat Record<string, MetadataTypes>
        const flatMeta: Record<string, string | number | boolean> = {};
        if (metadata) {
            for (const [key, value] of Object.entries(metadata)) {
                if (
                    value !== undefined &&
                    (typeof value === "string" ||
                        typeof value === "number" ||
                        typeof value === "boolean")
                ) {
                    flatMeta[key] = value;
                }
            }
        }

        await this._index.upsertDocument(
            uri,
            text,
            undefined, // docType — let Vectra infer from extension
            Object.keys(flatMeta).length > 0 ? flatMeta : undefined,
        );
    }

    async deleteDocument(uri: string): Promise<void> {
        await this._index.deleteDocument(uri);
    }

    async hasDocument(uri: string): Promise<boolean> {
        const id = await this._index.getDocumentId(uri);
        return id !== undefined;
    }

    async query(
        text: string,
        options?: QueryOptions,
    ): Promise<SearchResult[]> {
        const maxResults = options?.maxResults ?? 10;
        const maxChunks = options?.maxChunks ?? 3;
        const maxTokens = options?.maxTokens ?? 500;
        // Default to hybrid (semantic + BM25). Vectra appends BM25-only hits
        // to the semantic results and tags each chunk with `isBm25`, so the
        // returned `score` is already a hybrid signal — callers should treat
        // it as such rather than blending another BM25 weight on top.
        // Pass `enableBM25: false` to opt out for pure-vector experiments.
        const isBm25 = options?.enableBM25 !== false;

        let results;
        try {
            results = await this._index.queryDocuments(text, {
                maxDocuments: maxResults,
                maxChunks: maxChunks * maxResults, // Give Vectra enough chunk budget
                filter: options?.filter,
                isBm25,
            });
        } catch (err) {
            // wink-bm25 refuses to consolidate when the document collection
            // is too small (typically <3 docs), throwing
            // "document collection is too small for consolidation". Tiny
            // corpora are common at the start of a session and in tests;
            // gracefully fall back to pure-vector for the query. Other
            // errors propagate normally.
            const msg = err instanceof Error ? err.message : String(err);
            if (isBm25 && /too small for consolidation/i.test(msg)) {
                results = await this._index.queryDocuments(text, {
                    maxDocuments: maxResults,
                    maxChunks: maxChunks * maxResults,
                    filter: options?.filter,
                    isBm25: false,
                });
            } else {
                throw err;
            }
        }

        const searchResults: SearchResult[] = [];
        for (const result of results) {
            const sections = await result.renderSections(
                maxTokens,
                maxChunks,
            );
            const combinedText = sections.map((s) => s.text).join("\n\n...\n\n");

            // Compute a 1-based line-range hint from the matched chunks'
            // character positions so the agent can do targeted ranged
            // memory_get calls (matches OpenClaw production's
            // `MemorySearchResult.startLine` / `endLine` affordance).
            // Best-effort: skip silently if anything goes wrong.
            let startLine: number | undefined;
            let endLine: number | undefined;
            try {
                if (result.chunks.length > 0) {
                    let minStart = Infinity;
                    let maxEnd = -Infinity;
                    for (const c of result.chunks) {
                        const sp = c.item.metadata.startPos;
                        const ep = c.item.metadata.endPos;
                        if (typeof sp === "number" && sp < minStart) minStart = sp;
                        if (typeof ep === "number" && ep > maxEnd) maxEnd = ep;
                    }
                    if (Number.isFinite(minStart) && Number.isFinite(maxEnd)) {
                        const docText = await result.loadText();
                        startLine = charPosToLine(docText, minStart);
                        endLine = charPosToLine(docText, maxEnd);
                    }
                }
            } catch {
                // Position info unavailable — return without line range.
            }

            const sr: SearchResult = {
                uri: result.uri,
                text: combinedText,
                score: result.score,
                metadata: {},
                partial: sections.length > 0,
            };
            if (startLine != null) sr.startLine = startLine;
            if (endLine != null) sr.endLine = endLine;
            searchResults.push(sr);
        }

        return searchResults;
    }

    async getStats(): Promise<IndexStats> {
        const isCreated = await this.isCreated();
        if (!isCreated) {
            return { documentCount: 0, chunkCount: 0 };
        }
        const stats = await this._index.getCatalogStats();
        return {
            documentCount: stats.documents,
            chunkCount: stats.chunks,
        };
    }

    async getEmbedding(uri: string): Promise<number[] | null> {
        const vecIdx = this._getVectorIndex();
        const isCreated = await vecIdx.isIndexCreated();
        if (!isCreated) return null;

        const items = await vecIdx.listItems();
        // Document chunks use URI-based IDs; find the first chunk for this URI
        const item = items.find(
            (i: any) => i.metadata?.uri === uri || i.id === uri,
        );
        if (!item) return null;
        return item.vector ? Array.from(item.vector) : null;
    }

    async upsertEmbedding(
        uri: string,
        embedding: number[],
        metadata?: DocumentMetadata,
    ): Promise<void> {
        const vecIdx = this._getVectorIndex();
        const isCreated = await vecIdx.isIndexCreated();
        if (!isCreated) {
            await vecIdx.createIndex({ version: 1 });
        }

        const flatMeta: Record<string, string | number | boolean> = { uri };
        if (metadata) {
            for (const [key, value] of Object.entries(metadata)) {
                if (
                    value !== undefined &&
                    (typeof value === "string" ||
                        typeof value === "number" ||
                        typeof value === "boolean")
                ) {
                    flatMeta[key] = value;
                }
            }
        }

        await vecIdx.upsertItem({
            id: uri,
            vector: embedding,
            metadata: flatMeta,
        });
    }
}

/**
 * Convert a 0-based character offset into a 1-based line number for the
 * given text. Walks the prefix counting newlines — O(charPos) but
 * usually small relative to chunk sizes. Used to translate Vectra's
 * char-offset chunk metadata into the line-range affordance the agent
 * needs for ranged memory_get calls.
 */
function charPosToLine(text: string, charPos: number): number {
    const limit = Math.min(Math.max(0, charPos), text.length);
    let line = 1;
    for (let i = 0; i < limit; i++) {
        if (text.charCodeAt(i) === 10 /* '\n' */) line++;
    }
    return line;
}
