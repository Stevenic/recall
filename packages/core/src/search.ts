import type {
    MemoryIndex,
    SearchResult,
    QueryOptions,
    ScoringWeights,
} from "./interfaces/index.js";
import { ResultType } from "./interfaces/index.js";
import type { MemoryFiles } from "./files.js";
import type { HierarchicalMemoryConfig } from "./hierarchical-config.js";
import type { SearchLogger } from "./search-logger.js";
import { parseCatalogEntry, matchCatalog, type CatalogEntry } from "./catalog.js";
import { expandQuery } from "./query-expansion.js";
import {
    extractTemporalReference,
    temporalAffinity,
    extractDateFromUri,
} from "./temporal.js";

export interface SearchOptions {
    maxResults?: number; // default: 5
    maxChunks?: number; // default: 3
    maxTokens?: number; // default: 500
    skipSync?: boolean; // default: false
    recencyDepth?: number; // default: 2 (recent weekly summaries)
    typedMemoryBoost?: number; // default: 1.2
    /** Phase 1 oversampling for parent retrieval */
    parentCandidates?: number;
    /** Phase 1 direct raw candidates */
    rawCandidates?: number;
    /** Enable BM25 */
    enableBM25?: boolean;
    /** Phase 2 scoring weights */
    scoringWeights?: ScoringWeights;
    /** Include parent summaries in results */
    includeSummaries?: boolean;
    /** Override temporal reference date */
    temporalReference?: Date;
}

export interface MultiSearchOptions extends SearchOptions {
    additionalQueries?: string[];
    catalogMatches?: SearchResult[];
}

/**
 * Two-phase hierarchical search:
 *   Phase 1 — High recall: parent vectors + raw vectors + BM25 (parallel)
 *   Phase 1b — Expand parent pointers to raw memories
 *   Phase 2 — Precision reranking with hybrid scoring + temporal affinity
 *
 * Falls back to legacy behavior when hierarchical config is disabled.
 */
export class SearchService {
    private readonly _index: MemoryIndex;
    private readonly _files: MemoryFiles;
    private readonly _config: HierarchicalMemoryConfig;
    private _searchLogger: SearchLogger | null = null;

    constructor(
        index: MemoryIndex,
        files: MemoryFiles,
        config?: HierarchicalMemoryConfig,
    ) {
        this._index = index;
        this._files = files;
        this._config = config ?? {};
    }

    /**
     * Set the search logger for dreaming signal collection.
     * When set, every search operation appends to the search log.
     */
    setSearchLogger(logger: SearchLogger): void {
        this._searchLogger = logger;
    }

    /**
     * Single-query search with two-phase hierarchical recall.
     */
    async search(
        query: string,
        options?: SearchOptions,
    ): Promise<SearchResult[]> {
        const maxResults = options?.maxResults ?? 5;
        const maxChunks = options?.maxChunks ?? 3;
        const maxTokens = options?.maxTokens ?? 500;
        const recencyDepth = options?.recencyDepth ?? 2;
        const typedMemoryBoost = options?.typedMemoryBoost ?? 1.2;
        const includeSummaries = options?.includeSummaries ?? true;

        const isHierarchical = this._config.enabled !== false;

        // Pass 1: Catalog matching (frontmatter keyword overlap)
        const catalogResults = await this._catalogSearch(query, maxResults);

        if (isHierarchical) {
            const results = await this._hierarchicalSearch(query, {
                maxResults,
                maxChunks,
                maxTokens,
                recencyDepth,
                typedMemoryBoost,
                includeSummaries,
                catalogResults,
                ...options,
            });
            await this._logSearchResults(query, results, maxResults);
            return results;
        }

        // Legacy path: catalog + semantic + recency
        const queryOpts: QueryOptions = { maxResults, maxChunks, maxTokens };
        const semanticResults = await this._index.query(query, queryOpts);

        let merged = this._mergeResults(
            catalogResults,
            semanticResults,
            typedMemoryBoost,
        );

        if (recencyDepth > 0) {
            const recentWeeklies = await this._getRecentWeeklies(recencyDepth);
            merged = this._mergeResults(merged, recentWeeklies, 1.0);
        }

        const results = merged
            .sort((a, b) => b.score - a.score)
            .slice(0, maxResults);
        await this._logSearchResults(query, results, maxResults);
        return results;
    }

    /**
     * Multi-query fusion: expand the query, run each variant, merge results.
     */
    async multiSearch(
        query: string,
        options?: MultiSearchOptions,
    ): Promise<SearchResult[]> {
        const queries = expandQuery(query);
        if (options?.additionalQueries) {
            queries.push(...options.additionalQueries);
        }

        const allResults = await Promise.all(
            queries.map((q) => this.search(q, options)),
        );

        let merged: SearchResult[] = [];
        for (const results of allResults) {
            merged = this._mergeResults(merged, results, 1.0);
        }

        const maxResults = options?.maxResults ?? 5;
        return merged
            .sort((a, b) => b.score - a.score)
            .slice(0, maxResults);
    }

    /**
     * Log search results to the dreaming search logger (if configured).
     */
    private async _logSearchResults(
        query: string,
        results: SearchResult[],
        topK: number,
    ): Promise<void> {
        if (!this._searchLogger) return;
        try {
            await this._searchLogger.logSearch(
                query,
                results.map((r) => ({ uri: r.uri, score: r.score })),
                topK,
            );
        } catch {
            // Search logging is best-effort — never fail a search due to logging
        }
    }

    // ─── Hierarchical two-phase recall ────────────────────────────

    private async _hierarchicalSearch(
        query: string,
        opts: {
            maxResults: number;
            maxChunks: number;
            maxTokens: number;
            recencyDepth: number;
            typedMemoryBoost: number;
            includeSummaries: boolean;
            catalogResults: SearchResult[];
            parentCandidates?: number;
            rawCandidates?: number;
            enableBM25?: boolean;
            scoringWeights?: ScoringWeights;
            temporalReference?: Date;
        },
    ): Promise<SearchResult[]> {
        const parentK =
            opts.parentCandidates ??
            this._config.parentCandidates ??
            10;
        const rawK =
            opts.rawCandidates ?? this._config.rawCandidates ?? 20;
        const weights: ScoringWeights =
            opts.scoringWeights ??
            this._config.scoringWeights ?? {
                embedding: 0.5,
                bm25: 0.3,
                parent: 0.2,
            };

        // ── Phase 1a: Parallel candidate retrieval ──
        const [parentResults, rawResults] = await Promise.all([
            // Parent vector search (both #agg and #summary entries)
            this._index.query(query, {
                maxResults: parentK,
                maxChunks: opts.maxChunks,
                maxTokens: opts.maxTokens,
                filter: {
                    embeddingType: { $in: ["agg", "summary"] },
                },
            }),
            // Direct raw memory search
            this._index.query(query, {
                maxResults: rawK,
                maxChunks: opts.maxChunks,
                maxTokens: opts.maxTokens,
                filter: {
                    contentType: { $in: ["daily", "typed_memory", "wisdom"] },
                },
            }),
        ]);

        // ── Phase 1b: Expand parent pointers ──
        const expandedCandidates = new Map<string, SearchResult>();

        // Add direct raw hits
        for (const r of rawResults) {
            expandedCandidates.set(r.uri, {
                ...r,
                resultType: ResultType.RAW,
            });
        }

        // Add catalog matches
        for (const r of opts.catalogResults) {
            const existing = expandedCandidates.get(r.uri);
            if (!existing || r.score * opts.typedMemoryBoost > existing.score) {
                expandedCandidates.set(r.uri, {
                    ...r,
                    score: r.score * opts.typedMemoryBoost,
                    resultType: ResultType.RAW,
                });
            }
        }

        // Expand each parent's pointers
        const parentScores = new Map<string, number>();
        for (const parent of parentResults) {
            const parentUri = parent.uri.replace(/#(agg|summary)$/, "");
            parentScores.set(
                parentUri,
                Math.max(parentScores.get(parentUri) ?? 0, parent.score),
            );

            // Load the parent file to get pointers
            const parentContent = await this._loadParentContent(parentUri);
            if (!parentContent) continue;

            const pointers = this._files.parsePointers(parentContent);

            // Add summary as a candidate if configured
            if (opts.includeSummaries) {
                const { body } = this._files.parseFrontmatter(parentContent);
                if (body.trim()) {
                    const summaryUri = `${parentUri}#summary`;
                    if (!expandedCandidates.has(summaryUri)) {
                        expandedCandidates.set(summaryUri, {
                            uri: summaryUri,
                            text: body.trim(),
                            score: parent.score,
                            metadata: parent.metadata,
                            resultType: ResultType.SUMMARY,
                            parentUri,
                        });
                    }
                }
            }

            // Recursively expand pointers to raw memories
            await this._expandPointers(
                pointers,
                parentUri,
                parent.score,
                expandedCandidates,
            );
        }

        // ── Phase 2: Reranking ──
        const candidates = Array.from(expandedCandidates.values());

        // Detect temporal reference for affinity scoring
        const temporalRef =
            opts.temporalReference ?? extractTemporalReference(query);
        const sigma = this._config.temporalSigma ?? 30;
        const enableTemporal =
            this._config.temporalAffinity !== false && temporalRef !== null;

        const wEmbed = weights.embedding ?? 0.5;
        const wBm25 = weights.bm25 ?? 0.3;
        const wParent = weights.parent ?? 0.2;

        // Score each candidate
        const scored = candidates.map((c) => {
            const embedScore = c.score; // Already from vector search
            const bm25Score = 0; // BM25 scoring handled by Vectra in query
            const pScore =
                c.parentUri ? (parentScores.get(c.parentUri) ?? 0) : 0;

            let finalScore =
                wEmbed * embedScore + wBm25 * bm25Score + wParent * pScore;

            // Apply temporal affinity if active
            if (enableTemporal && temporalRef) {
                const memDate = extractDateFromUri(c.uri);
                if (memDate) {
                    finalScore *= temporalAffinity(memDate, temporalRef, sigma);
                }
            }

            return {
                ...c,
                score: finalScore,
                scoreBreakdown: {
                    embedding: embedScore,
                    bm25: bm25Score,
                    parent: pScore,
                },
            };
        });

        // Sort and limit
        scored.sort((a, b) => b.score - a.score);

        // Inject recency if configured
        let results: SearchResult[] = scored.slice(0, opts.maxResults);
        if (opts.recencyDepth > 0) {
            const recentWeeklies = await this._getRecentWeeklies(
                opts.recencyDepth,
            );
            const merged = this._mergeResults(results, recentWeeklies, 1.0);
            results = merged
                .sort((a, b) => b.score - a.score)
                .slice(0, opts.maxResults);
        }

        return results;
    }

    /**
     * Recursively expand pointers to raw memories.
     */
    private async _expandPointers(
        pointers: string[],
        parentUri: string,
        parentScore: number,
        candidates: Map<string, SearchResult>,
    ): Promise<void> {
        for (const pointer of pointers) {
            // Check if this pointer is itself a parent (weekly pointer from monthly)
            if (pointer.includes("weekly/")) {
                const weekName = pointer
                    .replace(/^memory\/weekly\//, "")
                    .replace(/\.md$/, "");
                const weekContent = await this._files.readWeekly(weekName);
                if (weekContent) {
                    const childPointers = this._files.parsePointers(weekContent);
                    if (childPointers.length > 0) {
                        // Recurse into weekly's children (raw dailies)
                        await this._expandPointers(
                            childPointers,
                            `weekly/${weekName}`,
                            parentScore,
                            candidates,
                        );
                        continue;
                    }
                }
            }

            // This is a raw daily memory pointer
            if (candidates.has(pointer)) continue; // Already have it

            const datePart = pointer
                .replace(/^memory\//, "")
                .replace(/\.md$/, "");
            const content = await this._files.readDaily(datePart);
            if (content) {
                candidates.set(pointer, {
                    uri: pointer,
                    text: content,
                    score: parentScore * 0.8, // Inherited score, dampened
                    metadata: { contentType: "daily", period: datePart },
                    resultType: ResultType.RAW,
                    parentUri,
                });
            }
        }
    }

    /**
     * Load parent node content from the file system.
     */
    private async _loadParentContent(
        parentUri: string,
    ): Promise<string | null> {
        // parentUri looks like "weekly/2026-W15" or "monthly/2026-04"
        if (parentUri.startsWith("weekly/")) {
            const week = parentUri.replace("weekly/", "");
            return this._files.readWeekly(week);
        }
        if (parentUri.startsWith("monthly/")) {
            const month = parentUri.replace("monthly/", "");
            return this._files.readMonthly(month);
        }
        return null;
    }

    // ─── Legacy helpers (also used by hierarchical) ───────────────

    /**
     * Match typed memories by frontmatter keywords.
     */
    private async _catalogSearch(
        query: string,
        maxResults: number,
    ): Promise<SearchResult[]> {
        const typedFiles = await this._files.listTypedMemories();
        const entries: CatalogEntry[] = [];

        for (const filename of typedFiles) {
            const content = await this._files.readTypedMemory(filename);
            if (!content) continue;
            const entry = parseCatalogEntry(filename, content);
            if (entry) entries.push(entry);
        }

        const matches = matchCatalog(entries, query, maxResults);

        for (const match of matches) {
            const content = await this._files.readTypedMemory(match.uri);
            if (content) match.text = content;
        }

        return matches;
    }

    /**
     * Get the N most recent weekly summaries for recency injection.
     */
    private async _getRecentWeeklies(
        depth: number,
    ): Promise<SearchResult[]> {
        const weeklies = await this._files.listWeeklies();
        const recent = weeklies.slice(-depth);
        const results: SearchResult[] = [];

        for (const week of recent) {
            const content = await this._files.readWeekly(week);
            if (content) {
                results.push({
                    uri: `weekly/${week}.md`,
                    text: content,
                    score: 0.3,
                    metadata: { contentType: "weekly", period: week },
                    resultType: ResultType.SUMMARY,
                });
            }
        }

        return results;
    }

    /**
     * Merge two result sets, deduplicating by URI (keep highest score).
     */
    private _mergeResults(
        existing: SearchResult[],
        incoming: SearchResult[],
        boost: number,
    ): SearchResult[] {
        const byUri = new Map<string, SearchResult>();

        for (const r of existing) {
            byUri.set(r.uri, r);
        }

        for (const r of incoming) {
            const boosted = { ...r, score: r.score * boost };
            const prev = byUri.get(r.uri);
            if (!prev || boosted.score > prev.score) {
                byUri.set(r.uri, boosted);
            }
        }

        return [...byUri.values()];
    }
}
