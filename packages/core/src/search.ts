import type { MemoryIndex, SearchResult, QueryOptions } from "./interfaces/index.js";
import type { MemoryFiles } from "./files.js";
import { parseCatalogEntry, matchCatalog, type CatalogEntry } from "./catalog.js";
import { expandQuery } from "./query-expansion.js";

export interface SearchOptions {
    maxResults?: number; // default: 5
    maxChunks?: number; // default: 3
    maxTokens?: number; // default: 500
    skipSync?: boolean; // default: false
    recencyDepth?: number; // default: 2 (recent weekly summaries)
    typedMemoryBoost?: number; // default: 1.2
}

export interface MultiSearchOptions extends SearchOptions {
    additionalQueries?: string[];
    catalogMatches?: SearchResult[];
}

/**
 * Two-pass search: catalog matching + semantic search with recency injection.
 */
export class SearchService {
    private readonly _index: MemoryIndex;
    private readonly _files: MemoryFiles;

    constructor(index: MemoryIndex, files: MemoryFiles) {
        this._index = index;
        this._files = files;
    }

    /**
     * Single-query search with catalog matching and recency pass.
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

        // Pass 1: Catalog matching (frontmatter keyword overlap)
        const catalogResults = await this._catalogSearch(query, maxResults);

        // Pass 2: Semantic search via the index
        const queryOpts: QueryOptions = {
            maxResults,
            maxChunks,
            maxTokens,
        };
        const semanticResults = await this._index.query(query, queryOpts);

        // Merge and deduplicate
        let merged = this._mergeResults(
            catalogResults,
            semanticResults,
            typedMemoryBoost,
        );

        // Recency pass: inject recent weekly summaries
        if (recencyDepth > 0) {
            const recentWeeklies = await this._getRecentWeeklies(recencyDepth);
            merged = this._mergeResults(merged, recentWeeklies, 1.0);
        }

        // Sort by score and limit
        return merged
            .sort((a, b) => b.score - a.score)
            .slice(0, maxResults);
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

        // Run all queries in parallel
        const allResults = await Promise.all(
            queries.map((q) => this.search(q, options)),
        );

        // Merge all result sets
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
     * Pass 1: match typed memories by frontmatter keywords.
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

        // Fill in text content for matches
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
                    score: 0.3, // Low base score — recency, not relevance
                    metadata: { contentType: "weekly", period: week },
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
