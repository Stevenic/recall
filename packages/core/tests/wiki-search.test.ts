import { describe, it, expect, beforeEach } from "vitest";
import { SearchService } from "../src/search.js";
import { MemoryFiles } from "../src/files.js";
import { VirtualFileStorage } from "../src/defaults/virtual-file-storage.js";
import type {
    MemoryIndex,
    SearchResult,
    QueryOptions,
    IndexStats,
    CreateIndexOptions,
    DocumentMetadata,
} from "../src/interfaces/index.js";

/**
 * Mock index that returns canned results filtered by `contentType`. Lets us
 * exercise the wiki-vs-raw branching in SearchService without standing up
 * the embedder.
 */
class MockIndex implements MemoryIndex {
    private _resultsByContentType = new Map<string, SearchResult[]>();
    private _defaultResults: SearchResult[] = [];

    setResults(results: SearchResult[]): void {
        this._defaultResults = results;
    }

    setResultsForContentType(contentType: string, results: SearchResult[]): void {
        this._resultsByContentType.set(contentType, results);
    }

    async createIndex(_options?: CreateIndexOptions): Promise<void> {}
    async isCreated(): Promise<boolean> { return true; }
    async upsertDocument(_uri: string, _text: string, _metadata?: DocumentMetadata): Promise<void> {}
    async deleteDocument(_uri: string): Promise<void> {}
    async hasDocument(_uri: string): Promise<boolean> { return false; }
    async getStats(): Promise<IndexStats> { return { documentCount: 0, chunkCount: 0 }; }
    async getEmbedding(_uri: string): Promise<number[] | null> { return null; }
    async upsertEmbedding(): Promise<void> {}

    async query(_text: string, options?: QueryOptions): Promise<SearchResult[]> {
        // If the query filters by a specific contentType, return only those.
        const filter = options?.filter as { contentType?: unknown } | undefined;
        const ct = filter?.contentType;
        if (typeof ct === "string") {
            return this._resultsByContentType.get(ct) ?? [];
        }
        if (ct && typeof ct === "object" && "$in" in (ct as object)) {
            const set = new Set(((ct as { $in: string[] }).$in) ?? []);
            const out: SearchResult[] = [];
            for (const [k, v] of this._resultsByContentType) {
                if (set.has(k)) out.push(...v);
            }
            // Also include any default-bucket results that look like daily memories,
            // for the legacy / mixed-filter cases.
            for (const r of this._defaultResults) {
                if (!r.metadata?.contentType || set.has(r.metadata.contentType)) {
                    out.push(r);
                }
            }
            return out;
        }
        // No filter: return everything.
        const all: SearchResult[] = [...this._defaultResults];
        for (const arr of this._resultsByContentType.values()) all.push(...arr);
        return all;
    }
}

function wikiResult(slug: string, score: number): SearchResult {
    return {
        uri: `memory/wiki/${slug}.md`,
        text: `Wiki page content for ${slug}`,
        score,
        metadata: {
            contentType: "wiki",
            wikiCategory: "concept",
            wikiSlug: slug,
            wikiTarget: "private",
        },
    };
}

function dailyResult(date: string, score: number): SearchResult {
    return {
        uri: `memory/${date}.md`,
        text: `Daily entry ${date}`,
        score,
        metadata: { contentType: "daily", period: date },
    };
}

describe("SearchService — wiki integration", () => {
    let storage: VirtualFileStorage;
    let files: MemoryFiles;
    let index: MockIndex;

    beforeEach(async () => {
        storage = new VirtualFileStorage();
        files = new MemoryFiles("/root", storage);
        await files.initialize();
        index = new MockIndex();
    });

    describe("score boost", () => {
        it("applies the default 1.3× boost to wiki hits over equally-scored raw hits", async () => {
            // Hierarchical search is the default — both branches return the same raw score.
            index.setResultsForContentType("wiki", [wikiResult("auth-middleware", 0.5)]);
            index.setResultsForContentType("daily", [dailyResult("2026-04-08", 0.5)]);

            const search = new SearchService(index, files, undefined, { scoreBoost: 1.3 });
            const results = await search.search("auth setup");

            // Wiki hit should outrank the daily after boost (0.5 * 1.3 = 0.65 > 0.5).
            expect(results.length).toBeGreaterThanOrEqual(2);
            expect(results[0].uri).toBe("memory/wiki/auth-middleware.md");
            expect(results[0].score).toBeGreaterThan(results[1].score);
        });

        it("honors wikiBoost: 1.0 to disable boost for a single query", async () => {
            index.setResultsForContentType("wiki", [wikiResult("auth-middleware", 0.5)]);
            index.setResultsForContentType("daily", [dailyResult("2026-04-08", 0.6)]);

            const search = new SearchService(index, files, undefined, { scoreBoost: 1.3 });
            const results = await search.search("auth setup", { wikiBoost: 1.0 });

            // With boost disabled, the higher-scoring daily wins.
            expect(results[0].uri).toBe("memory/2026-04-08.md");
        });

        it("honors a custom wikiBoost > 1.3", async () => {
            index.setResultsForContentType("wiki", [wikiResult("auth-middleware", 0.5)]);
            index.setResultsForContentType("daily", [dailyResult("2026-04-08", 0.9)]);

            const search = new SearchService(index, files, undefined, { scoreBoost: 1.3 });
            // Default boost (1.3) wouldn't be enough (0.5*1.3 = 0.65 < 0.9). Bump to 2.0.
            const results = await search.search("auth setup", { wikiBoost: 2.0 });

            expect(results[0].uri).toBe("memory/wiki/auth-middleware.md");
        });
    });

    describe("filtering", () => {
        it("wikiOnly returns only wiki results", async () => {
            index.setResultsForContentType("wiki", [
                wikiResult("auth-middleware", 0.7),
                wikiResult("postgres-migration", 0.6),
            ]);
            index.setResultsForContentType("daily", [
                dailyResult("2026-04-08", 0.95),
            ]);

            const search = new SearchService(index, files, undefined, { scoreBoost: 1.3 });
            const results = await search.search("anything", { wikiOnly: true });

            for (const r of results) {
                expect(r.metadata.contentType).toBe("wiki");
            }
            expect(results.length).toBe(2);
        });

        it("includeWiki: false excludes wiki results", async () => {
            index.setResultsForContentType("wiki", [wikiResult("auth-middleware", 0.95)]);
            index.setResultsForContentType("daily", [dailyResult("2026-04-08", 0.5)]);

            const search = new SearchService(index, files, undefined, { scoreBoost: 1.3 });
            const results = await search.search("anything", { includeWiki: false });

            for (const r of results) {
                expect(r.metadata.contentType).not.toBe("wiki");
            }
        });
    });

    describe("config", () => {
        it("falls back to the spec default (1.3×) when no service config is provided", async () => {
            index.setResultsForContentType("wiki", [wikiResult("auth-middleware", 0.5)]);
            index.setResultsForContentType("daily", [dailyResult("2026-04-08", 0.5)]);

            // No wikiConfig passed at all → default boost should still apply.
            const search = new SearchService(index, files);
            const results = await search.search("auth setup");

            expect(results[0].uri).toBe("memory/wiki/auth-middleware.md");
        });

        it("does not apply boost when scoreBoost is exactly 1.0", async () => {
            index.setResultsForContentType("wiki", [wikiResult("auth-middleware", 0.5)]);
            index.setResultsForContentType("daily", [dailyResult("2026-04-08", 0.5)]);

            const search = new SearchService(index, files, undefined, { scoreBoost: 1.0 });
            const results = await search.search("auth setup");

            // Both scored equal; either could come first, but they're tied.
            const wikiHit = results.find((r) => r.metadata.contentType === "wiki");
            const dailyHit = results.find((r) => r.metadata.contentType === "daily");
            expect(wikiHit).toBeDefined();
            expect(dailyHit).toBeDefined();
            expect(wikiHit!.score).toBe(dailyHit!.score);
        });
    });
});
