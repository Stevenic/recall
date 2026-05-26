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
import type { WikiEngine } from "./wiki-engine.js";
import type { WikiPage } from "./wiki-types.js";
import type { Reranker } from "./interfaces/reranker.js";
import { parseCatalogEntry, matchCatalog, type CatalogEntry } from "./catalog.js";
import { expandQuery } from "./query-expansion.js";
import {
    extractTemporalReference,
    temporalAffinity,
    extractDateFromUri,
    extractRecencyCue,
    recencyBoost,
    type RecencyCue,
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
    /**
     * Multiplier applied to wiki page scores. Defaults to the
     * service-configured `wiki.scoreBoost` (1.3 when unset). Set to 1.0 to
     * disable boost for this query without disabling wiki indexing.
     */
    wikiBoost?: number;
    /**
     * When true, restrict results to wiki pages only. Useful for "show me
     * the synthesized view" queries — bypasses the raw/parent retrieval
     * branches entirely.
     */
    wikiOnly?: boolean;
    /**
     * When false, skip wiki pages entirely (raw + parents only). Default true.
     */
    includeWiki?: boolean;
    /**
     * Enable cross-encoder reranking of first-stage results. When a
     * Reranker is wired into the SearchService, the service pulls a
     * larger candidate set (see {@link rerankPool}), reranks via the
     * cross-encoder, and returns the top `maxResults`. Set to `false`
     * to bypass for a single query. Default: true when a reranker is
     * available.
     */
    rerank?: boolean;
    /**
     * Number of first-stage candidates to feed the reranker. The
     * cross-encoder lifts top-K precision but you don't want to score
     * the entire candidate set — a small head (top-20) captures the
     * relevant hits and finishes in ~100ms. Default: 20.
     */
    rerankPool?: number;
    /**
     * Cap on the number of WHOLE wiki entries the wiki-side path emits.
     * Each entry returned by `_wikiSearch` is a hydrated page composed
     * with its frontmatter pointer header — not a raw chunk. The cap is
     * a ceiling, not a target: byte budget can also short-circuit it.
     * Default: 3.
     */
    maxWikiEntries?: number;
    /**
     * Soft cap on total chars of wiki content returned. Once filled, no
     * additional entries are added — except the always-1-whole-entry
     * invariant: the highest-scoring entry is returned even if it alone
     * exceeds the budget. Default: 12000 (~3K tokens).
     */
    wikiByteBudget?: number;
}

export interface MultiSearchOptions extends SearchOptions {
    additionalQueries?: string[];
    catalogMatches?: SearchResult[];
}

/** Search-time view of wiki config. */
export interface SearchWikiConfig {
    /** Default multiplier applied to wiki page scores during ranking. */
    scoreBoost?: number;
    /** Default cap on whole wiki entries returned per query. */
    maxWikiEntries?: number;
    /** Default soft byte budget for wiki entries returned per query. */
    wikiByteBudget?: number;
}

// Search-time fallback when neither call options nor service-level wiki
// config supplies a boost. Matches the DEFAULT_WIKI_CONFIG default —
// keep these two in sync so tests + integration paths agree.
const DEFAULT_WIKI_SCORE_BOOST = 1.1;
/** Cap on whole wiki entries returned per query when nothing overrides. */
const DEFAULT_MAX_WIKI_ENTRIES = 3;
/** Soft byte budget for wiki entries (chars, not tokens). ~3K tokens. */
const DEFAULT_WIKI_BYTE_BUDGET = 12_000;

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
    private readonly _wikiConfig: SearchWikiConfig;
    private readonly _wiki: WikiEngine | undefined;
    private readonly _reranker: Reranker | undefined;
    private _searchLogger: SearchLogger | null = null;

    constructor(
        index: MemoryIndex,
        files: MemoryFiles,
        config?: HierarchicalMemoryConfig,
        wikiConfig?: SearchWikiConfig,
        wiki?: WikiEngine,
        reranker?: Reranker,
    ) {
        this._index = index;
        this._files = files;
        this._config = config ?? {};
        this._wikiConfig = wikiConfig ?? {};
        this._wiki = wiki;
        this._reranker = reranker;
    }

    /**
     * Two-stage reranking: take the first-stage merged result list (already
     * scored by embedding + BM25 + boosts) and reorder by cross-encoder
     * relevance. Best-effort: any failure falls back to first-stage order so
     * search stays available even when the reranker model can't load.
     *
     * The cross-encoder is invoked on the top {@link rerankPool} candidates
     * (default 20). Reranking a larger pool wastes inference; reranking a
     * smaller one wastes the cross-encoder's accuracy lift. Returns the same
     * SearchResult shape; only the `score` field changes (replaced by the
     * cross-encoder relevance) and the array order is updated.
     */
    private async _rerank(
        query: string,
        results: SearchResult[],
        rerankPool: number,
        topK: number,
    ): Promise<SearchResult[]> {
        if (!this._reranker || results.length <= 1) return results;
        const pool = results.slice(0, rerankPool);
        const tail = results.slice(rerankPool);
        try {
            const ordered = await this._reranker.rerank(
                query,
                pool.map((r) => `${r.uri}\n${(r.text ?? "").slice(0, 1500)}`),
                { topK: Math.min(topK, pool.length) },
            );
            const reranked = ordered.map((o) => ({
                ...pool[o.index],
                score: o.score,
            }));
            // Anything below the rerank pool keeps its first-stage score
            // and lands after the reranked head. Useful when the caller
            // asked for topK > pool size (rare).
            return [...reranked, ...tail];
        } catch {
            // Reranker fault — return first-stage results unchanged.
            return results;
        }
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
        const wikiBoost =
            options?.wikiBoost ??
            this._wikiConfig.scoreBoost ??
            DEFAULT_WIKI_SCORE_BOOST;
        const includeWiki = options?.includeWiki !== false;
        const wikiOnly = options?.wikiOnly === true;

        // Reranker on/off + pool size — pool=20 by default, lifts top-3
        // precision via cross-encoder attention without re-scoring the
        // whole index. Off when no Reranker is wired.
        //
        // Skip rerank when the query has an explicit date pin
        // (`on YYYY-MM-DD`, `recorded on 2026-01-07`, `as of …`). The
        // cross-encoder ranks token-similar dailies above date-anchored
        // ones and the agent prompt already routes pinned questions
        // directly to that date's daily. Rerank stays on for the much
        // larger non-pinned set where it consistently lifts top-3
        // precision.
        const queryHasDatePin =
            options?.temporalReference != null ||
            extractTemporalReference(query) != null;
        const rerankEnabled =
            options?.rerank !== false &&
            this._reranker != null &&
            !queryHasDatePin;
        const rerankPool = options?.rerankPool ?? 20;

        // Wiki-only mode short-circuits — no catalog, no parent, no recency.
        if (wikiOnly) {
            const wikiResults = await this._wikiSearch(query, {
                maxResults: rerankEnabled ? Math.max(maxResults, rerankPool) : maxResults,
                maxChunks,
                maxTokens,
                wikiBoost,
                maxWikiEntries:
                    options?.maxWikiEntries ?? this._wikiConfig.maxWikiEntries,
                wikiByteBudget:
                    options?.wikiByteBudget ?? this._wikiConfig.wikiByteBudget,
            });
            let sliced = wikiResults.sort((a, b) => b.score - a.score);
            if (rerankEnabled) {
                sliced = await this._rerank(query, sliced, rerankPool, maxResults);
            }
            sliced = sliced.slice(0, maxResults);
            await this._logSearchResults(query, sliced, maxResults);
            return sliced;
        }

        // Pass 1: Catalog matching (frontmatter keyword overlap)
        const catalogResults = await this._catalogSearch(query, maxResults);

        if (isHierarchical) {
            const results = await this._hierarchicalSearch(query, {
                maxResults: rerankEnabled ? Math.max(maxResults, rerankPool) : maxResults,
                maxChunks,
                maxTokens,
                recencyDepth,
                typedMemoryBoost,
                includeSummaries,
                catalogResults,
                wikiBoost,
                includeWiki,
                ...options,
            });
            const reranked = rerankEnabled
                ? await this._rerank(query, results, rerankPool, maxResults)
                : results;
            const sliced = reranked.slice(0, maxResults);
            await this._logSearchResults(query, sliced, maxResults);
            return sliced;
        }

        // Legacy path: catalog + semantic + recency
        const queryOpts: QueryOptions = { maxResults, maxChunks, maxTokens };
        const semanticResults = await this._index.query(query, queryOpts);

        let merged = this._mergeResults(
            catalogResults,
            semanticResults,
            typedMemoryBoost,
        );

        if (includeWiki) {
            const wikiResults = await this._wikiSearch(query, {
                maxResults,
                maxChunks,
                maxTokens,
                wikiBoost,
                maxWikiEntries:
                    options?.maxWikiEntries ?? this._wikiConfig.maxWikiEntries,
                wikiByteBudget:
                    options?.wikiByteBudget ?? this._wikiConfig.wikiByteBudget,
            });
            merged = this._mergeResults(merged, wikiResults, 1.0);
        }

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
            wikiBoost: number;
            includeWiki: boolean;
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
        const [parentResults, rawResults, wikiResults] = await Promise.all([
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
            // Wiki page search (parallel; boost is applied during the rerank)
            opts.includeWiki
                ? this._wikiSearch(query, {
                      maxResults: rawK,
                      maxChunks: opts.maxChunks,
                      maxTokens: opts.maxTokens,
                      wikiBoost: 1.0,
                      maxWikiEntries: this._wikiConfig.maxWikiEntries,
                      wikiByteBudget: this._wikiConfig.wikiByteBudget,
                  })
                : Promise.resolve<SearchResult[]>([]),
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

        // Add wiki hits (unboosted; the rerank applies opts.wikiBoost).
        for (const r of wikiResults) {
            const existing = expandedCandidates.get(r.uri);
            if (!existing || r.score > existing.score) {
                expandedCandidates.set(r.uri, {
                    ...r,
                    resultType: ResultType.RAW,
                });
            }
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

        // Recency cue ("latest" / "earliest" / null). When the query
        // explicitly asks for current state or original state, we apply
        // a recency boost to candidates based on their position in the
        // corpus's date span. Without a cue, the multiplier is 1.0 so
        // ranking is unchanged.
        const recencyCue: RecencyCue = extractRecencyCue(query);
        let cueSpan: { start: Date; end: Date } | null = null;
        if (recencyCue !== null) {
            // Compute the date span from the candidate set itself so the
            // boost is meaningful within whatever the index currently
            // holds (the corpus may not start at 1970 or end at today).
            let minMs = Infinity;
            let maxMs = -Infinity;
            for (const c of candidates) {
                const d = extractDateFromUri(c.uri);
                if (!d) continue;
                const t = d.getTime();
                if (t < minMs) minMs = t;
                if (t > maxMs) maxMs = t;
            }
            if (Number.isFinite(minMs) && Number.isFinite(maxMs) && maxMs > minMs) {
                cueSpan = { start: new Date(minMs), end: new Date(maxMs) };
            }
        }

        // `embedding` and `parent` weights are what actually drive ranking.
        // `bm25` stays in the type for backward compatibility and is folded
        // into the embedding signal at search time: `_index.query` runs in
        // Vectra's hybrid mode by default (semantic + BM25 merged) so the
        // returned score already encodes both signals. We add `wBm25` into
        // the embedding weight rather than zeroing it out, so existing
        // `ScoringWeights` overrides keep behaving roughly as before.
        const wEmbed = (weights.embedding ?? 0.5) + (weights.bm25 ?? 0.3);
        const wParent = weights.parent ?? 0.2;

        // Score each candidate
        const scored = candidates.map((c) => {
            // Hybrid score from Vectra (semantic + BM25 already merged).
            const hybridScore = c.score;
            const pScore =
                c.parentUri ? (parentScores.get(c.parentUri) ?? 0) : 0;

            let finalScore = wEmbed * hybridScore + wParent * pScore;

            // Wiki boost is applied as a soft multiplier on the final score —
            // wiki pages out-rank loosely matching raw logs but a strong raw
            // hit (e.g., a date-specific daily) can still win on temporal
            // affinity.
            if (c.metadata?.contentType === "wiki" && opts.wikiBoost !== 1.0) {
                finalScore *= opts.wikiBoost;
            }

            // Apply temporal affinity if active
            if (enableTemporal && temporalRef) {
                const memDate = extractDateFromUri(c.uri);
                if (memDate) {
                    finalScore *= temporalAffinity(memDate, temporalRef, sigma);
                }
            }

            // Apply recency-cue boost when the query explicitly asks
            // about latest/earliest state and the candidate has a date.
            // This catches cases the temporalAffinity branch misses —
            // queries like "what is the current X?" have no explicit
            // date pin but do want the latest matching memory.
            if (cueSpan) {
                const memDate = extractDateFromUri(c.uri);
                if (memDate) {
                    finalScore *= recencyBoost(memDate, recencyCue, cueSpan.start, cueSpan.end);
                }
            }

            // Grounding-penalty path: temporarily DISABLED while we
            // collect data on what the verifier flags. The verifier
            // still runs (its output lands in the page frontmatter +
            // index metadata) but search ignores the flags here. Run
            // 16 showed the penalty was downranking wiki pages that
            // the agent was previously following into the right
            // dailies — the cure was worse than the disease until we
            // know which flag-counts correlate with actual wrongness.
            //
            // Re-enable once we have data from `wikiUnverified` /
            // `wikiStale` correlated against question outcomes, with
            // calibrated multipliers.
            //
            // const wUnverified = Number(c.metadata?.wikiUnverified ?? 0);
            // const wStale = Number(c.metadata?.wikiStale ?? 0);
            // if (wUnverified > 0 || wStale > 0) { ... }

            return {
                ...c,
                score: finalScore,
                scoreBreakdown: {
                    embedding: hybridScore,
                    bm25: 0, // Reserved — Vectra returns one merged score
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
     * Retrieve wiki pages matching `query`. Returns raw vector-similarity
     * scores from the index; the caller decides whether to apply a boost.
     * Pass `wikiBoost` to pre-multiply (legacy-path callers do this; the
     * hierarchical reranker applies the boost itself).
     */
    private async _wikiSearch(
        query: string,
        opts: {
            maxResults: number;
            maxChunks: number;
            maxTokens: number;
            wikiBoost: number;
            maxWikiEntries?: number;
            wikiByteBudget?: number;
        },
    ): Promise<SearchResult[]> {
        // Oversample at the chunk level — Vectra returns chunk-by-chunk
        // hits, and a single wiki page may contribute several chunks.
        // Groups-by-URI later pick the best chunk per page; we need
        // enough headroom that the top-K pages are all represented.
        const chunkHits = await this._index.query(query, {
            maxResults: Math.max(opts.maxResults * 4, 12),
            maxChunks: opts.maxChunks,
            maxTokens: opts.maxTokens,
            filter: { contentType: "wiki" },
        });
        if (chunkHits.length === 0) return [];

        // Group by URI; keep the best-scoring chunk per page.
        const bestByUri = new Map<string, SearchResult>();
        for (const hit of chunkHits) {
            const prev = bestByUri.get(hit.uri);
            if (!prev || prev.score < hit.score) bestByUri.set(hit.uri, hit);
        }
        const ranked = [...bestByUri.values()]
            .map((r) =>
                opts.wikiBoost === 1.0 ? r : { ...r, score: r.score * opts.wikiBoost },
            )
            .sort((a, b) => b.score - a.score);

        // Hydrate full pages + render pointer-header views. When no wiki
        // engine is wired, fall back to the chunk-level hits unchanged.
        if (!this._wiki) return ranked.slice(0, opts.maxResults);

        const maxEntries = opts.maxWikiEntries ?? DEFAULT_MAX_WIKI_ENTRIES;
        const budget = opts.wikiByteBudget ?? DEFAULT_WIKI_BYTE_BUDGET;
        const out: SearchResult[] = [];
        let used = 0;
        for (const cand of ranked) {
            if (out.length >= maxEntries) break;
            const slug = extractWikiSlugFromUri(cand.uri);
            const composed = slug
                ? await this._composeWikiPageView(slug, cand)
                : null;
            const entry = composed ?? cand;
            const size = entry.text.length;
            // Always-1-whole-entry: the highest-scoring entry comes back
            // even if it alone exceeds the budget. Subsequent entries
            // respect both the budget and the maxEntries cap.
            if (out.length === 0) {
                out.push(entry);
                used += size;
                continue;
            }
            if (used + size > budget) break;
            out.push(entry);
            used += size;
        }
        return out;
    }

    /**
     * Hydrate a wiki slug into a `SearchResult` whose `text` is the page's
     * pointer-header (cited dailies + supersedes + related links) followed
     * by the full body. Returns null when the page can't be read so the
     * caller can fall back to the chunk-level hit.
     */
    private async _composeWikiPageView(
        slug: string,
        chunkHit: SearchResult,
    ): Promise<SearchResult | null> {
        if (!this._wiki) return null;
        try {
            const page = await this._wiki.read(slug, "private");
            if (!page) return null;
            const text = renderWikiPointerHeader(page) + page.body.trimEnd() + "\n";
            return {
                uri: chunkHit.uri,
                text,
                score: chunkHit.score,
                metadata: { ...chunkHit.metadata, contentType: "wiki" },
            };
        } catch {
            return null;
        }
    }

    /**
     * Match the agent's "catalog" — typed memories and (Phase B+) wiki pages
     * — by frontmatter keyword overlap. Catalog matching uses the
     * `name` / `description` / `type` fields and is exact-match-flavored,
     * which makes it a reliable first hop for factual-recall queries that
     * mention the page name verbatim. After Phase E migration, typed
     * memories are migrated to wiki pages, so the wiki branch keeps the
     * signal alive.
     */
    private async _catalogSearch(
        query: string,
        maxResults: number,
    ): Promise<SearchResult[]> {
        const entries: CatalogEntry[] = [];

        // Typed memories (legacy; still present in unmigrated repos).
        const typedFiles = await this._files.listTypedMemories();
        for (const filename of typedFiles) {
            const content = await this._files.readTypedMemory(filename);
            if (!content) continue;
            const entry = parseCatalogEntry(filename, content);
            if (entry) entries.push(entry);
        }

        // Wiki pages. Wiki frontmatter ships `type: wiki` + `category: …`;
        // the same parser pulls them in with `metadata.contentType =
        // "typed_memory"` by default, so we patch the entry's metadata to
        // reflect the wiki contentType + slug. That makes the downstream
        // wiki score boost in the reranker fire when the catalog finds the
        // page first.
        if (this._wiki?.enabled) {
            const wikiSlugs = await this._wiki.list("private");
            for (const slug of wikiSlugs) {
                const page = await this._wiki.read(slug, "private");
                if (!page || page.redirectTo) continue;
                const uri = `memory/wiki/${slug}.md`;
                entries.push({
                    uri,
                    name: page.name,
                    description: page.description,
                    type: page.category,
                    metadata: {
                        contentType: "wiki",
                        wikiCategory: page.category,
                        wikiSlug: page.slug,
                        wikiTarget: "private",
                        wikiSources: page.sources.length,
                        period: page.updated,
                    },
                });
            }
        }

        const matches = matchCatalog(entries, query, maxResults);

        // Fill in result text from the underlying source. For wiki entries
        // we re-read the page through the engine; for typed memories we use
        // the existing file API. URIs that don't match either pattern fall
        // through with empty text.
        for (const match of matches) {
            if (match.uri.startsWith("memory/wiki/") && this._wiki?.enabled) {
                const slug = match.uri
                    .replace(/^memory\/wiki\//, "")
                    .replace(/\.md$/, "");
                const page = await this._wiki.read(slug, "private");
                if (page) {
                    match.text =
                        `# ${page.name}\n${page.description}\n\n${page.body.trim()}`;
                }
                continue;
            }
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

/**
 * Extract a wiki slug from a `memory/wiki/<slug>.md` URI. Returns null
 * when the URI doesn't match the wiki path shape.
 */
function extractWikiSlugFromUri(uri: string): string | null {
    const m = /(?:^|\/)memory\/wiki\/([^/]+)\.md$/.exec(uri);
    return m ? m[1] : null;
}

/**
 * Format a {@link SourceContribution.range} as `[from..to]` with `to`
 * end-inclusive. Empty when the range is unset or malformed.
 */
function formatSourceRange(range?: { from: number; lines: number }): string {
    if (!range || range.from < 1 || range.lines < 1) return "";
    const to = range.from + range.lines - 1;
    return `[${range.from}..${to}]`;
}

/**
 * Render the per-page pointer header that prefixes every whole wiki
 * entry returned by `_wikiSearch`. The agent sees the page's
 * contributors (with optional range + summary annotations), prior
 * claims via `supersedes`, and sibling pages via `related` — turning
 * the wiki page into an explicit walk target for `memory_get` rather
 * than opaque prose.
 *
 * Format mirrors the wiki preamble that the bench harness has emitted
 * since the early runs, so existing agent prompts already know how to
 * read it.
 */
function renderWikiPointerHeader(page: WikiPage): string {
    const lines: string[] = [];
    const updated = page.updated ?? "(unknown)";
    const confidence = page.confidence ? `, confidence ${page.confidence}` : "";
    lines.push(`=== Wiki: ${page.slug} (updated ${updated}${confidence}) ===`);
    if (page.name) lines.push(page.name);
    if (page.description) lines.push(page.description);

    if (page.sources.length > 0) {
        lines.push("");
        lines.push(`Cited dailies (${page.sources.length}):`);
        for (const src of page.sources) {
            const range = formatSourceRange(src.range);
            const summary = src.summary ? ` — ${src.summary}` : "";
            lines.push(`- ${src.uri}${range}${summary}`);
        }
    }

    if (page.supersedes && page.supersedes.length > 0) {
        lines.push("");
        lines.push("Superseded claims:");
        for (const sup of page.supersedes) {
            const fact = sup.fact ? `"${sup.fact}"` : "(prior claim)";
            lines.push(
                `- ${fact} (was in ${sup.source}, superseded ${sup.supersededOn})`,
            );
        }
    }

    if (page.related.length > 0) {
        lines.push("");
        lines.push("Related: " + page.related.map((s) => `[[${s}]]`).join(", "));
    }

    if (page.redirectTo) {
        lines.push("");
        lines.push(`Redirects to: [[${page.redirectTo}]]`);
    }

    lines.push("");
    lines.push("--- body ---");
    return lines.join("\n") + "\n";
}
