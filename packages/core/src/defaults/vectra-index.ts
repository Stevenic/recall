import { LocalDocumentIndex } from "vectra";
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

    constructor(config: VectraIndexConfig) {
        this._folderPath = config.folderPath;
        this._index = new LocalDocumentIndex({
            folderPath: config.folderPath,
            embeddings: config.embeddings,
            chunkingConfig: {
                chunkSize: config.chunkSize ?? 512,
                chunkOverlap: config.chunkOverlap ?? 0,
            },
        });
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

        const results = await this._index.queryDocuments(text, {
            maxDocuments: maxResults,
            maxChunks: maxChunks * maxResults, // Give Vectra enough chunk budget
            filter: options?.filter,
        });

        const searchResults: SearchResult[] = [];
        for (const result of results) {
            const sections = await result.renderSections(
                maxTokens,
                maxChunks,
            );
            const combinedText = sections.map((s) => s.text).join("\n\n...\n\n");

            searchResults.push({
                uri: result.uri,
                text: combinedText,
                score: result.score,
                metadata: {},
                partial: sections.length > 0,
            });
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
}
