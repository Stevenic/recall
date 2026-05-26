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
import type { HierarchicalMemoryConfig } from "./hierarchical-config.js";
import type { SearchResult } from "./interfaces/index.js";
import { LocalFileStorage } from "./defaults/local-file-storage.js";
import { LocalEmbeddings } from "./defaults/local-embeddings.js";
import { LocalReranker } from "./defaults/local-reranker.js";
import { VectraIndex } from "./defaults/vectra-index.js";
import type { Reranker } from "./interfaces/reranker.js";
import { computeSalienceWeights } from "./salience.js";
import { SearchLogger } from "./search-logger.js";
import { DreamEngine } from "./dream-engine.js";
import type {
    DreamingConfig,
    DreamOptions,
    DreamResult,
    DreamStatus,
} from "./dreaming-config.js";
import { IdentityLoader, type IdentityConfig } from "./identity.js";
import { WikiEngine } from "./wiki-engine.js";
import type { WikiConfig } from "./wiki-types.js";
import { withTemporalTag } from "./temporal-tag.js";
export { withTemporalTag } from "./temporal-tag.js";

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
    /**
     * Optional model override for dreaming. When unset, dreaming uses
     * `model`. Useful when dreaming benefits from a stronger reasoning
     * model than compaction or query-time synthesis — dreaming's
     * cross-cutting analysis + wiki-op decisions reward extra capability
     * more than per-turn synthesis does.
     */
    dreamingModel?: MemoryModel;
    /**
     * Optional cross-encoder reranker for second-stage retrieval. When
     * set, search pulls a larger first-stage candidate set and reranks
     * it before returning. When unset, defaults to a local `LocalReranker`
     * (Xenova/ms-marco-MiniLM-L-6-v2, ~22MB, no API key). Pass `null` to
     * disable reranking entirely (e.g. for tests that don't want to load
     * the cross-encoder model).
     */
    reranker?: Reranker | null;
    compaction?: Partial<CompactionConfig>;
    watch?: WatchConfig;
    hierarchical?: HierarchicalMemoryConfig;
    /** Dreaming configuration */
    dreaming?: DreamingConfig;
    /** Wiki configuration (Phase A — read/write/list/stub; Phases B+ extend) */
    wiki?: WikiConfig;
    /** Identity file (used by future synthesis prompt threading) */
    identity?: IdentityConfig;
}

export interface MigrationReport {
    parentsUpgraded: number;
    pointersBackfilled: number;
    brokenPointers: string[];
    aggregatedEmbeddingsGenerated: number;
    dryRun: boolean;
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
    private readonly _searchLogger: SearchLogger | null;
    private _compactor: Compactor | null = null;
    private _dreamEngine: DreamEngine | null = null;
    private readonly _identity: IdentityLoader;
    private readonly _wiki: WikiEngine;

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
        this._identity = new IdentityLoader(
            config.memoryRoot,
            this._storage,
            config.identity,
        );
        this._wiki = new WikiEngine(
            config.memoryRoot,
            this._storage,
            config.wiki,
            { model: config.model },
        );
        // Resolve reranker. Default-on with `LocalReranker` (Xenova/ms-
        // marco-MiniLM-L-6-v2, ~22MB lazy ONNX). `null` opts out; an
        // explicit instance overrides the default.
        //
        // SearchService skips the rerank pass when the query has an
        // explicit date pin — the cross-encoder rates token-similar
        // dailies above date-anchored ones and on those questions the
        // agent's prompt already knows to memory_get the pinned date
        // directly. For everything else the rerank materially improves
        // top-3 precision.
        const reranker: Reranker | undefined =
            config.reranker === null
                ? undefined
                : (config.reranker ?? new LocalReranker());
        this._search = new SearchService(
            this._index,
            this._files,
            config.hierarchical,
            this._wiki.enabled
                ? { scoreBoost: this._wiki.config.scoreBoost }
                : undefined,
            this._wiki.enabled ? this._wiki : undefined,
            reranker,
        );

        // Wire up search logging if dreaming is enabled
        const dreamConfig = config.dreaming;
        const logSearches = dreamConfig?.logSearches ?? (dreamConfig?.enabled ?? false);
        if (logSearches) {
            this._searchLogger = new SearchLogger(config.memoryRoot, this._storage);
            this._search.setSearchLogger(this._searchLogger);
        } else {
            this._searchLogger = null;
        }
    }

    // --- File operations ---

    get files(): MemoryFiles {
        return this._files;
    }

    // --- Wiki ---

    get wiki(): WikiEngine {
        return this._wiki;
    }

    // --- Identity ---

    get identity(): IdentityLoader {
        return this._identity;
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

    // --- Dreaming ---

    async dream(options?: DreamOptions): Promise<DreamResult> {
        const engine = this._getDreamEngine();
        return engine.dream(options);
    }

    async dreamStatus(): Promise<DreamStatus> {
        const engine = this._getDreamEngine();
        return engine.status();
    }

    // --- Lifecycle ---

    async initialize(): Promise<void> {
        await this._files.initialize();
        if (this._wiki.enabled) {
            await this._wiki.initialize();
        }
        const isCreated = await this._index.isCreated();
        if (!isCreated) {
            await this._index.createIndex();
        }
    }

    async close(): Promise<void> {
        // No-op for now — reserved for future cleanup
    }

    // --- Internals ---

    private _getDreamEngine(): DreamEngine {
        if (!this._dreamEngine) {
            const dreamingModel =
                this._config.dreamingModel ?? this._config.model;
            if (!dreamingModel) {
                throw new Error(
                    "A MemoryModel is required for dreaming. Pass `model` or `dreamingModel` in MemoryServiceConfig.",
                );
            }
            const logger = this._searchLogger ?? new SearchLogger(this._config.memoryRoot, this._storage);
            this._dreamEngine = new DreamEngine(
                this._files,
                this._index,
                dreamingModel,
                this._storage,
                logger,
                this._config.dreaming,
                { wiki: this._wiki.enabled ? this._wiki : undefined },
            );
        }
        return this._dreamEngine;
    }

    private _getCompactor(): Compactor {
        if (!this._compactor) {
            if (!this._config.model) {
                throw new Error(
                    "A MemoryModel is required for compaction. Pass `model` in MemoryServiceConfig.",
                );
            }
            this._compactor = new Compactor(this._files, {
                model: this._config.model,
                index: this._index,
                aggregationStrategy:
                    this._config.hierarchical?.aggregationStrategy ?? "salience",
                wiki: this._wiki.enabled ? this._wiki : undefined,
                ...this._config.compaction,
            });
        }
        return this._compactor;
    }

    /**
     * Migrate existing parent nodes to hierarchical architecture.
     * Backfills pointers, generates aggregated embeddings.
     */
    async migrateToHierarchical(
        dryRun: boolean = false,
    ): Promise<MigrationReport> {
        const report: MigrationReport = {
            parentsUpgraded: 0,
            pointersBackfilled: 0,
            brokenPointers: [],
            aggregatedEmbeddingsGenerated: 0,
            dryRun,
        };

        const manifest = await this._files.listAll();

        // Backfill weekly nodes
        for (const week of manifest.weeklies) {
            const content = await this._files.readWeekly(week);
            if (!content) continue;

            const existingPointers = this._files.parsePointers(content);
            if (existingPointers.length > 0) continue; // Already migrated

            // Infer pointers from date range
            const dailyPointers = this._inferWeeklyPointers(
                week,
                manifest.dailies,
            );
            const broken = dailyPointers.filter(
                (p) =>
                    !manifest.dailies.includes(
                        p.replace(/^memory\//, "").replace(/\.md$/, ""),
                    ),
            );
            report.brokenPointers.push(...broken);

            const validPointers = dailyPointers.filter(
                (p) => !broken.includes(p),
            );
            report.pointersBackfilled += validPointers.length;
            report.parentsUpgraded++;

            if (!dryRun && validPointers.length > 0) {
                // Compute salience
                const entries: { uri: string; text: string }[] = [];
                for (const ptr of validPointers) {
                    const date = ptr
                        .replace(/^memory\//, "")
                        .replace(/\.md$/, "");
                    const c = await this._files.readDaily(date);
                    if (c) entries.push({ uri: ptr, text: c });
                }
                const salienceMap =
                    entries.length > 0
                        ? await computeSalienceWeights(entries)
                        : {};

                // Rewrite frontmatter
                const { body } = this._files.parseFrontmatter(content);
                const pointerYaml = validPointers
                    .map((p) => `  - ${p}`)
                    .join("\n");
                const salienceYaml = Object.entries(salienceMap)
                    .map(([k, v]) => `  ${k}: ${v.toFixed(2)}`)
                    .join("\n");
                const newContent = `---\ntype: weekly\nperiod: ${week}\npointers:\n${pointerYaml}\nsalience:\n${salienceYaml}\n---\n\n${body.trim()}\n`;
                await this._files.writeWeekly(week, newContent);

                // Generate dual embeddings
                if (this._index) {
                    report.aggregatedEmbeddingsGenerated++;
                }
            }
        }

        // Backfill monthly nodes
        for (const month of manifest.monthlies) {
            const content = await this._files.readMonthly(month);
            if (!content) continue;

            const existingPointers = this._files.parsePointers(content);
            if (existingPointers.length > 0) continue;

            const weeklyPointers = this._inferMonthlyPointers(
                month,
                manifest.weeklies,
            );
            report.pointersBackfilled += weeklyPointers.length;
            report.parentsUpgraded++;

            if (!dryRun && weeklyPointers.length > 0) {
                const entries: { uri: string; text: string }[] = [];
                for (const ptr of weeklyPointers) {
                    const wk = ptr
                        .replace(/^memory\/weekly\//, "")
                        .replace(/\.md$/, "");
                    const c = await this._files.readWeekly(wk);
                    if (c) entries.push({ uri: ptr, text: c });
                }
                const salienceMap =
                    entries.length > 0
                        ? await computeSalienceWeights(entries)
                        : {};

                const { body } = this._files.parseFrontmatter(content);
                const pointerYaml = weeklyPointers
                    .map((p) => `  - ${p}`)
                    .join("\n");
                const salienceYaml = Object.entries(salienceMap)
                    .map(([k, v]) => `  ${k}: ${v.toFixed(2)}`)
                    .join("\n");
                const newContent = `---\ntype: monthly\nperiod: ${month}\npointers:\n${pointerYaml}\nsalience:\n${salienceYaml}\n---\n\n${body.trim()}\n`;
                await this._files.writeMonthly(month, newContent);

                if (this._index) {
                    report.aggregatedEmbeddingsGenerated++;
                }
            }
        }

        return report;
    }

    /**
     * Infer which daily files belong to a given ISO week.
     */
    private _inferWeeklyPointers(
        isoWeek: string,
        _allDailies: string[],
    ): string[] {
        const match = isoWeek.match(/^(\d{4})-W(\d{2})$/);
        if (!match) return [];
        const year = parseInt(match[1]);
        const weekNum = parseInt(match[2]);

        // Compute Monday of this ISO week
        const jan4 = new Date(Date.UTC(year, 0, 4));
        const dayOfWeek = jan4.getUTCDay() || 7;
        const monday = new Date(jan4);
        monday.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1 + (weekNum - 1) * 7);

        const pointers: string[] = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(monday);
            d.setUTCDate(monday.getUTCDate() + i);
            const dateStr = d.toISOString().split("T")[0];
            pointers.push(`memory/${dateStr}.md`);
        }
        return pointers;
    }

    /**
     * Infer which weekly files belong to a given month.
     */
    private _inferMonthlyPointers(
        yearMonth: string,
        allWeeklies: string[],
    ): string[] {
        const match = yearMonth.match(/^(\d{4})-(\d{2})$/);
        if (!match) return [];
        const year = parseInt(match[1]);
        const month = parseInt(match[2]) - 1;

        return allWeeklies
            .filter((w) => {
                const wMatch = w.match(/^(\d{4})-W(\d{2})$/);
                if (!wMatch) return false;
                const wYear = parseInt(wMatch[1]);
                const wNum = parseInt(wMatch[2]);
                // Approximate: get Thursday of the ISO week
                const jan4 = new Date(Date.UTC(wYear, 0, 4));
                const dow = jan4.getUTCDay() || 7;
                const mon = new Date(jan4);
                mon.setUTCDate(jan4.getUTCDate() - dow + 1 + (wNum - 1) * 7);
                const thu = new Date(mon);
                thu.setUTCDate(mon.getUTCDate() + 3);
                return (
                    thu.getUTCFullYear() === year &&
                    thu.getUTCMonth() === month
                );
            })
            .map((w) => `memory/weekly/${w}.md`);
    }

    private async _indexAllFiles(): Promise<void> {
        const manifest = await this._files.listAll();

        // Index dailies
        for (const date of manifest.dailies) {
            const content = await this._files.readDaily(date);
            if (content) {
                await this._index.upsertDocument(
                    `memory/${date}.md`,
                    withTemporalTag(content, date),
                    { contentType: "daily", period: date },
                );
            }
        }

        // Index weeklies
        for (const week of manifest.weeklies) {
            const content = await this._files.readWeekly(week);
            if (content) {
                const thursday = isoWeekToThursday(week);
                await this._index.upsertDocument(
                    `memory/weekly/${week}.md`,
                    withTemporalTag(content, thursday),
                    { contentType: "weekly", period: week },
                );
            }
        }

        // Index monthlies
        for (const month of manifest.monthlies) {
            const content = await this._files.readMonthly(month);
            if (content) {
                const midMonth = monthToMidpoint(month);
                await this._index.upsertDocument(
                    `memory/monthly/${month}.md`,
                    withTemporalTag(content, midMonth),
                    { contentType: "monthly", period: month },
                );
            }
        }

        // Index typed memories. Legacy format has no canonical date; skip
        // the temporal tag — they'll embed as-is. After Phase E migration
        // these end up as wiki pages with proper `updated` dates.
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

        // Index wisdom. WISDOM.md is continuously edited; no canonical
        // "as of" date. Skip the tag — embed as-is.
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

        // Index dream insights — filename carries the YYYY-MM-DD prefix.
        const insights = await this._files.listInsights();
        for (const filename of insights) {
            const content = await this._files.readDreamFile(
                `memory/dreams/insights/${filename}`,
            );
            if (content) {
                const date = extractDateFromFilename(filename);
                const tagged = date ? withTemporalTag(content, date) : content;
                await this._index.upsertDocument(
                    `memory/dreams/insights/${filename}`,
                    tagged,
                    { contentType: "insight" },
                );
            }
        }

        // Index dream contradictions — filename is YYYY-MM-DD.md
        const contradictions = await this._files.listContradictions();
        for (const filename of contradictions) {
            const content = await this._files.readDreamFile(
                `memory/dreams/contradictions/${filename}`,
            );
            if (content) {
                const date = extractDateFromFilename(filename);
                const tagged = date ? withTemporalTag(content, date) : content;
                await this._index.upsertDocument(
                    `memory/dreams/contradictions/${filename}`,
                    tagged,
                    { contentType: "contradiction" },
                );
            }
        }

        // Index wiki pages (when the wiki layer is enabled). Only the private
        // wiki for now — shared wiki indexing lands in Phase F. The page body
        // is indexed alongside its frontmatter name/description so the topical
        // signal is visible to the embedder.
        if (this._wiki.enabled) {
            await this._indexWikiPages();
        }
    }

    private async _indexWikiPages(): Promise<void> {
        const slugs = await this._wiki.list("private");
        for (const slug of slugs) {
            const page = await this._wiki.read(slug, "private");
            if (!page) continue;
            // Compose embedded text so the page's "what is this?" signal is
            // captured alongside the body. Frontmatter doesn't get embedded
            // when we pass just `page.body`, so prepend the name/description.
            // The temporal tag uses `updated`, since the wiki page represents
            // current state of record as of that date.
            const embeddedText = withTemporalTag(
                [
                    `# ${page.name}`,
                    page.description,
                    "",
                    page.body.trim(),
                ]
                    .filter((line) => line.length > 0 || line === "")
                    .join("\n"),
                page.updated,
            );
            await this._index.upsertDocument(
                `memory/wiki/${slug}.md`,
                embeddedText,
                {
                    contentType: "wiki",
                    period: page.updated,
                    wikiCategory: page.category,
                    wikiSlug: page.slug,
                    wikiTarget: "private",
                    wikiSources: page.sources.length,
                    // Grounding flags so the search-time scorer can demote
                    // pages with unverified or stale claims without an
                    // extra read. Absent when verification hasn't run.
                    wikiUnverified: page.grounding?.unverified.length ?? 0,
                    wikiStale: page.grounding?.stale.length ?? 0,
                },
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Temporal embedding helpers
// ---------------------------------------------------------------------------

/** Pull YYYY-MM-DD from filenames like `2026-04-15.md` or `2026-04-15-slug.md`. */
function extractDateFromFilename(filename: string): string | null {
    const m = filename.match(/(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}

/**
 * Convert an ISO week (e.g. "2026-W15") to the Thursday of that week.
 * Thursday is the conventional "representative day" for an ISO week — it's
 * always in the same calendar month as the week itself.
 */
function isoWeekToThursday(isoWeek: string): string {
    const m = isoWeek.match(/^(\d{4})-W(\d{2})$/);
    if (!m) return isoWeek;
    const year = parseInt(m[1], 10);
    const weekNum = parseInt(m[2], 10);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const dayOfWeek = jan4.getUTCDay() || 7;
    const monday = new Date(jan4);
    monday.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1 + (weekNum - 1) * 7);
    const thursday = new Date(monday);
    thursday.setUTCDate(monday.getUTCDate() + 3);
    return thursday.toISOString().slice(0, 10);
}

/** Convert "YYYY-MM" to the 15th of that month. */
function monthToMidpoint(yearMonth: string): string {
    const m = yearMonth.match(/^(\d{4})-(\d{2})$/);
    if (!m) return yearMonth;
    return `${m[1]}-${m[2]}-15`;
}
