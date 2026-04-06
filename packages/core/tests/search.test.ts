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

/** Minimal mock index that returns canned results */
class MockIndex implements MemoryIndex {
    private _results: SearchResult[] = [];

    setResults(results: SearchResult[]) {
        this._results = results;
    }

    async createIndex(_options?: CreateIndexOptions): Promise<void> {}
    async isCreated(): Promise<boolean> { return true; }
    async upsertDocument(_uri: string, _text: string, _metadata?: DocumentMetadata): Promise<void> {}
    async deleteDocument(_uri: string): Promise<void> {}
    async hasDocument(_uri: string): Promise<boolean> { return false; }
    async query(_text: string, _options?: QueryOptions): Promise<SearchResult[]> {
        return this._results;
    }
    async getStats(): Promise<IndexStats> {
        return { documentCount: 0, chunkCount: 0 };
    }
}

describe("SearchService", () => {
    let storage: VirtualFileStorage;
    let files: MemoryFiles;
    let index: MockIndex;
    let search: SearchService;

    beforeEach(async () => {
        storage = new VirtualFileStorage();
        files = new MemoryFiles("/root", storage);
        await files.initialize();
        index = new MockIndex();
        search = new SearchService(index, files);
    });

    it("returns semantic search results", async () => {
        index.setResults([
            { uri: "memory/2026-04-01.md", text: "daily content", score: 0.9, metadata: {} },
        ]);
        const results = await search.search("test query");
        expect(results).toHaveLength(1);
        expect(results[0].uri).toBe("memory/2026-04-01.md");
    });

    it("merges catalog matches with semantic results", async () => {
        // Create a typed memory that will match catalog search
        const content =
            "---\nname: database migration\ndescription: SQLite decision\ntype: project\n---\n\nWe chose SQLite";
        await files.writeTypedMemory("project_db.md", content);

        // Semantic results
        index.setResults([
            { uri: "memory/2026-04-01.md", text: "daily stuff", score: 0.8, metadata: {} },
        ]);

        const results = await search.search("database migration");
        // Should have both catalog match and semantic result
        expect(results.length).toBeGreaterThanOrEqual(1);
        const uris = results.map((r) => r.uri);
        expect(uris).toContain("project_db.md");
    });

    it("deduplicates by URI (keeps highest score)", async () => {
        const content =
            "---\nname: database migration\ndescription: SQLite\ntype: project\n---\n\nContent";
        await files.writeTypedMemory("project_db.md", content);

        index.setResults([
            { uri: "project_db.md", text: "from index", score: 0.5, metadata: {} },
        ]);

        const results = await search.search("database migration");
        const dbResults = results.filter((r) => r.uri === "project_db.md");
        expect(dbResults).toHaveLength(1);
    });

    it("injects recent weekly summaries", async () => {
        await files.writeWeekly("2026-W13", "Week 13 summary");
        await files.writeWeekly("2026-W14", "Week 14 summary");

        index.setResults([]);

        const results = await search.search("anything", {
            recencyDepth: 2,
            maxResults: 10,
        });
        const weeklyUris = results
            .filter((r) => r.metadata.contentType === "weekly")
            .map((r) => r.uri);
        expect(weeklyUris).toContain("weekly/2026-W13.md");
        expect(weeklyUris).toContain("weekly/2026-W14.md");
    });

    it("multiSearch expands queries and merges", async () => {
        index.setResults([
            { uri: "memory/test.md", text: "content", score: 0.7, metadata: {} },
        ]);

        const results = await search.multiSearch("database migration strategy");
        // Should get results (multi-query runs the base query + expansions)
        expect(results.length).toBeGreaterThanOrEqual(1);
    });
});
