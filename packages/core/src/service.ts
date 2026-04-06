import * as path from "path";
import type { FileStorage } from "./interfaces/storage.js";
import type { EmbeddingsModel } from "./interfaces/embeddings.js";
import type { MemoryIndex, IndexStats } from "./interfaces/index.js";
import type { MemoryModel } from "./interfaces/model.js";
import { MemoryFiles, type MemoryFileManifest } from "./files.js";
import { SearchService, type SearchOptions, type MultiSearchOptions } from "./search.js";
import {
    Compactor,
    type CompactionConfig,
    type CompactOptions,
    type CompactionResult,
} from "./compactor.js";
import type { SearchResult } from "./interfaces/index.js";
import { LocalFileStorage } from "./defaults/local-file-storage.js";
import { LocalEmbeddings } from "./defaults/local-embeddings.js";
import { VectraIndex } from "./defaults/vectra-index.js";

export interface WatchConfig {
    syncOnChange?: boolean; // default: true
    compactOnThreshold?: boolean; // default: false
    debounceMs?: number; // default: 2000
}

export interface MemoryServiceConfig {
    memoryRoot: string;
    storage?: FileStorage;
    embeddings?: EmbeddingsModel;
    index?: MemoryIndex;
    model?: MemoryModel;
    compaction?: Partial<CompactionConfig>;
    watch?: WatchConfig;
}

export interface MemoryStatus {
    memoryRoot: string;
    indexCreated: boolean;
    indexStats?: IndexStats;
    fileManifest: MemoryFileManifest;
}

/**
 * Top-level API composing files, search, and compaction.
 */
export class MemoryService {
    private readonly _config: MemoryServiceConfig;
    private readonly _storage: FileStorage;
    private readonly _embeddings: EmbeddingsModel;
    private readonly _index: MemoryIndex;
    private readonly _files: MemoryFiles;
    private readonly _search: SearchService;
    private _compactor: Compactor | null = null;

    constructor(config: MemoryServiceConfig) {
        this._config = config;

        // Wire up defaults
        this._storage = config.storage ?? new LocalFileStorage();
        this._embeddings = config.embeddings ?? new LocalEmbeddings();
        this._index =
            config.index ??
            new VectraIndex({
                folderPath: path.join(config.memoryRoot, ".index"),
                embeddings: this._embeddings,
            });

        this._files = new MemoryFiles(config.memoryRoot, this._storage);
        this._search = new SearchService(this._index, this._files);
    }

    // --- File operations ---

    get files(): MemoryFiles {
        return this._files;
    }

    // --- Search ---

    async search(
        query: string,
        options?: SearchOptions,
    ): Promise<SearchResult[]> {
        // Auto-sync before search unless opted out
        if (!options?.skipSync) {
            await this.sync();
        }
        return this._search.search(query, options);
    }

    async multiSearch(
        query: string,
        options?: MultiSearchOptions,
    ): Promise<SearchResult[]> {
        if (!options?.skipSync) {
            await this.sync();
        }
        return this._search.multiSearch(query, options);
    }

    // --- Index management ---

    /**
     * Full rebuild of the vector index.
     */
    async index(): Promise<IndexStats> {
        // Create/reset the index
        await this._index.createIndex({ deleteIfExists: true });

        // Index all memory files
        await this._indexAllFiles();

        return this._index.getStats();
    }

    /**
     * Incremental sync: add new/changed files, remove deleted ones.
     */
    async sync(): Promise<IndexStats> {
        const isCreated = await this._index.isCreated();
        if (!isCreated) {
            return this.index();
        }

        // Index all files (upsert handles dedup)
        await this._indexAllFiles();

        return this._index.getStats();
    }

    async status(): Promise<MemoryStatus> {
        const indexCreated = await this._index.isCreated();
        const fileManifest = await this._files.listAll();
        let indexStats: IndexStats | undefined;
        if (indexCreated) {
            indexStats = await this._index.getStats();
        }

        return {
            memoryRoot: this._config.memoryRoot,
            indexCreated,
            indexStats,
            fileManifest,
        };
    }

    // --- Compaction ---

    async compact(options?: CompactOptions): Promise<CompactionResult> {
        const compactor = this._getCompactor();
        return compactor.compact(options);
    }

    async compactDaily(week?: string): Promise<CompactionResult> {
        const compactor = this._getCompactor();
        return compactor.compactDaily(week);
    }

    async compactWeekly(month?: string): Promise<CompactionResult> {
        const compactor = this._getCompactor();
        return compactor.compactWeekly(month);
    }

    async distillWisdom(): Promise<CompactionResult> {
        const compactor = this._getCompactor();
        return compactor.distillWisdom();
    }

    // --- Lifecycle ---

    async initialize(): Promise<void> {
        await this._files.initialize();
        const isCreated = await this._index.isCreated();
        if (!isCreated) {
            await this._index.createIndex();
        }
    }

    async close(): Promise<void> {
        // No-op for now — reserved for future cleanup
    }

    // --- Internals ---

    private _getCompactor(): Compactor {
        if (!this._compactor) {
            if (!this._config.model) {
                throw new Error(
                    "A MemoryModel is required for compaction. Pass `model` in MemoryServiceConfig.",
                );
            }
            this._compactor = new Compactor(this._files, {
                model: this._config.model,
                ...this._config.compaction,
            });
        }
        return this._compactor;
    }

    private async _indexAllFiles(): Promise<void> {
        const manifest = await this._files.listAll();

        // Index dailies
        for (const date of manifest.dailies) {
            const content = await this._files.readDaily(date);
            if (content) {
                await this._index.upsertDocument(
                    `memory/${date}.md`,
                    content,
                    { contentType: "daily", period: date },
                );
            }
        }

        // Index weeklies
        for (const week of manifest.weeklies) {
            const content = await this._files.readWeekly(week);
            if (content) {
                await this._index.upsertDocument(
                    `memory/weekly/${week}.md`,
                    content,
                    { contentType: "weekly", period: week },
                );
            }
        }

        // Index monthlies
        for (const month of manifest.monthlies) {
            const content = await this._files.readMonthly(month);
            if (content) {
                await this._index.upsertDocument(
                    `memory/monthly/${month}.md`,
                    content,
                    { contentType: "monthly", period: month },
                );
            }
        }

        // Index typed memories
        for (const filename of manifest.typedMemories) {
            const content = await this._files.readTypedMemory(filename);
            if (content) {
                await this._index.upsertDocument(
                    `memory/${filename}`,
                    content,
                    { contentType: "typed_memory" },
                );
            }
        }

        // Index wisdom
        if (manifest.hasWisdom) {
            const content = await this._files.readWisdom();
            if (content) {
                await this._index.upsertDocument(
                    "WISDOM.md",
                    content,
                    { contentType: "wisdom" },
                );
            }
        }
    }
}
