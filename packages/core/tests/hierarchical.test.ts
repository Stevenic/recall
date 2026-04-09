import { describe, it, expect, beforeEach } from "vitest";
import { Compactor } from "../src/compactor.js";
import { MemoryFiles } from "../src/files.js";
import { SearchService } from "../src/search.js";
import { VirtualFileStorage } from "../src/defaults/virtual-file-storage.js";
import { ResultType } from "../src/interfaces/index.js";
import type {
    MemoryModel,
    CompletionResult,
    CompleteOptions,
} from "../src/interfaces/model.js";
import type {
    MemoryIndex,
    SearchResult,
    QueryOptions,
    IndexStats,
    CreateIndexOptions,
    DocumentMetadata,
} from "../src/interfaces/index.js";

class MockModel implements MemoryModel {
    async complete(
        prompt: string,
        _options?: CompleteOptions,
    ): Promise<CompletionResult> {
        return { text: `Summary of: ${prompt.substring(0, 50)}...` };
    }
}

/** Mock index that tracks upserts and supports getEmbedding/upsertEmbedding */
class MockIndex implements MemoryIndex {
    private _results: SearchResult[] = [];
    private _documents: Map<string, { text: string; metadata?: DocumentMetadata }> =
        new Map();
    private _embeddings: Map<string, number[]> = new Map();

    setResults(results: SearchResult[]) {
        this._results = results;
    }

    getDocuments() {
        return this._documents;
    }

    getStoredEmbeddings() {
        return this._embeddings;
    }

    async createIndex(_options?: CreateIndexOptions): Promise<void> {}
    async isCreated(): Promise<boolean> {
        return true;
    }
    async upsertDocument(
        uri: string,
        text: string,
        metadata?: DocumentMetadata,
    ): Promise<void> {
        this._documents.set(uri, { text, metadata });
    }
    async deleteDocument(_uri: string): Promise<void> {}
    async hasDocument(_uri: string): Promise<boolean> {
        return false;
    }
    async query(
        _text: string,
        _options?: QueryOptions,
    ): Promise<SearchResult[]> {
        return this._results;
    }
    async getStats(): Promise<IndexStats> {
        return { documentCount: 0, chunkCount: 0 };
    }
    async getEmbedding(uri: string): Promise<number[] | null> {
        return this._embeddings.get(uri) ?? null;
    }
    async upsertEmbedding(
        uri: string,
        embedding: number[],
        _metadata?: DocumentMetadata,
    ): Promise<void> {
        this._embeddings.set(uri, embedding);
    }
}

describe("Eidetic Compaction (Phase A)", () => {
    let storage: VirtualFileStorage;
    let files: MemoryFiles;
    let model: MockModel;

    beforeEach(async () => {
        storage = new VirtualFileStorage();
        files = new MemoryFiles("/root", storage);
        await files.initialize();
        model = new MockModel();
    });

    it("does NOT delete daily files after compaction", async () => {
        await files.writeDaily("2026-01-05", "Monday log");
        await files.writeDaily("2026-01-06", "Tuesday log");
        await files.writeDaily("2026-01-07", "Wednesday log");

        const compactor = new Compactor(files, {
            model,
            minDailiesForWeekly: 2,
            extractTypedMemories: false,
        });

        const result = await compactor.compactDaily();

        // Weekly should be created
        expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);

        // Dailies should NOT be deleted (eidetic)
        expect(result.filesDeleted).toHaveLength(0);

        // Verify dailies still exist
        expect(await files.readDaily("2026-01-05")).not.toBeNull();
        expect(await files.readDaily("2026-01-06")).not.toBeNull();
        expect(await files.readDaily("2026-01-07")).not.toBeNull();
    });

    it("generates pointers in weekly frontmatter", async () => {
        await files.writeDaily("2026-01-05", "Monday log");
        await files.writeDaily("2026-01-06", "Tuesday log");
        await files.writeDaily("2026-01-07", "Wednesday log");

        const compactor = new Compactor(files, {
            model,
            minDailiesForWeekly: 2,
            extractTypedMemories: false,
        });

        await compactor.compactDaily();

        const weeklies = await files.listWeeklies();
        expect(weeklies.length).toBeGreaterThanOrEqual(1);

        const weeklyContent = await files.readWeekly(weeklies[0]);
        expect(weeklyContent).not.toBeNull();

        const pointers = files.parsePointers(weeklyContent!);
        expect(pointers.length).toBeGreaterThanOrEqual(2);
        expect(pointers).toContain("memory/2026-01-05.md");
    });

    it("generates salience weights in weekly frontmatter", async () => {
        await files.writeDaily(
            "2026-01-05",
            "Quiet day. Reviewed PRs.",
        );
        await files.writeDaily(
            "2026-01-06",
            "Major day. Decided to switch to PostgreSQL. Deployed auth service. Fixed ECONNREFUSED errors. Discussed with Alex.",
        );

        const compactor = new Compactor(files, {
            model,
            minDailiesForWeekly: 2,
            extractTypedMemories: false,
            aggregationStrategy: "salience",
        });

        await compactor.compactDaily();

        const weeklies = await files.listWeeklies();
        const weeklyContent = await files.readWeekly(weeklies[0]);
        const salience = files.parseSalience(weeklyContent!);

        expect(Object.keys(salience).length).toBeGreaterThanOrEqual(2);

        // Weights should sum to ~1.0
        const total = Object.values(salience).reduce((s, v) => s + v, 0);
        expect(total).toBeCloseTo(1.0, 1);
    });

    it("does NOT delete weekly files after monthly compaction", async () => {
        // Create weeklies for January
        await files.writeWeekly(
            "2026-W01",
            "---\ntype: weekly\nperiod: 2026-W01\npointers:\n  - memory/2026-01-01.md\n---\n\nWeek 1",
        );
        await files.writeWeekly(
            "2026-W02",
            "---\ntype: weekly\nperiod: 2026-W02\npointers:\n  - memory/2026-01-05.md\n---\n\nWeek 2",
        );
        await files.writeWeekly(
            "2026-W03",
            "---\ntype: weekly\nperiod: 2026-W03\npointers:\n  - memory/2026-01-12.md\n---\n\nWeek 3",
        );

        const compactor = new Compactor(files, {
            model,
            minWeekliesForMonthly: 2,
            extractTypedMemories: false,
        });

        const result = await compactor.compactWeekly();

        // Monthly created
        expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);

        // Weeklies NOT deleted
        expect(result.filesDeleted).toHaveLength(0);
        expect(await files.readWeekly("2026-W01")).not.toBeNull();
    });
});

describe("Dual Embeddings (Phase B)", () => {
    it("stores #summary and #agg entries in index", async () => {
        const storage = new VirtualFileStorage();
        const files = new MemoryFiles("/root", storage);
        await files.initialize();
        const model = new MockModel();
        const index = new MockIndex();

        // Pre-seed embeddings for daily files
        await index.upsertEmbedding("memory/2026-01-05.md", [0.5, 0.5, 0.0]);
        await index.upsertEmbedding("memory/2026-01-06.md", [0.0, 0.5, 0.5]);

        await files.writeDaily("2026-01-05", "Monday log");
        await files.writeDaily("2026-01-06", "Tuesday log");

        const compactor = new Compactor(files, {
            model,
            index,
            minDailiesForWeekly: 2,
            extractTypedMemories: false,
            aggregationStrategy: "uniform",
        });

        await compactor.compactDaily();

        // Check that summary was stored as a document
        const docs = index.getDocuments();
        const summaryKey = Array.from(docs.keys()).find((k) =>
            k.includes("#summary"),
        );
        expect(summaryKey).toBeDefined();

        // Check that aggregated embedding was stored
        const embeddings = index.getStoredEmbeddings();
        const aggKey = Array.from(embeddings.keys()).find((k) =>
            k.includes("#agg"),
        );
        expect(aggKey).toBeDefined();

        // Aggregated embedding should be normalized
        const agg = embeddings.get(aggKey!)!;
        const norm = Math.sqrt(agg.reduce((s, v) => s + v * v, 0));
        expect(norm).toBeCloseTo(1.0, 3);
    });
});

describe("Two-Phase Search (Phase C)", () => {
    let storage: VirtualFileStorage;
    let files: MemoryFiles;
    let index: MockIndex;

    beforeEach(async () => {
        storage = new VirtualFileStorage();
        files = new MemoryFiles("/root", storage);
        await files.initialize();
        index = new MockIndex();
    });

    it("expands parent pointers to raw memories", async () => {
        // Create a weekly with pointers
        await files.writeWeekly(
            "2026-W15",
            "---\ntype: weekly\nperiod: 2026-W15\npointers:\n  - memory/2026-04-07.md\n  - memory/2026-04-08.md\n---\n\nWeek 15 summary content.",
        );
        await files.writeDaily("2026-04-07", "Monday work");
        await files.writeDaily("2026-04-08", "Tuesday work with auth migration");

        // Mock: parent search returns the weekly
        index.setResults([
            {
                uri: "weekly/2026-W15#agg",
                text: "",
                score: 0.8,
                metadata: { contentType: "weekly", embeddingType: "agg" },
            },
        ]);

        const search = new SearchService(index, files, { enabled: true });
        const results = await search.search("auth migration", {
            maxResults: 10,
            recencyDepth: 0,
            skipSync: true,
        });

        // Should have expanded to raw memories
        const rawResults = results.filter(
            (r) => r.resultType === ResultType.RAW,
        );
        expect(rawResults.length).toBeGreaterThanOrEqual(1);

        // Should include summary
        const summaryResults = results.filter(
            (r) => r.resultType === ResultType.SUMMARY,
        );
        expect(summaryResults.length).toBeGreaterThanOrEqual(1);
    });

    it("deduplicates expanded results", async () => {
        await files.writeWeekly(
            "2026-W15",
            "---\ntype: weekly\nperiod: 2026-W15\npointers:\n  - memory/2026-04-07.md\n---\n\nSummary",
        );
        await files.writeDaily("2026-04-07", "Content");

        // Both parent and raw search return the same daily
        index.setResults([
            {
                uri: "weekly/2026-W15#agg",
                text: "",
                score: 0.8,
                metadata: { contentType: "weekly", embeddingType: "agg" },
            },
            {
                uri: "memory/2026-04-07.md",
                text: "Content",
                score: 0.7,
                metadata: { contentType: "daily" },
            },
        ]);

        const search = new SearchService(index, files, { enabled: true });
        const results = await search.search("test", {
            maxResults: 10,
            recencyDepth: 0,
            skipSync: true,
        });

        // memory/2026-04-07.md should appear only once
        const dailyHits = results.filter((r) =>
            r.uri === "memory/2026-04-07.md",
        );
        expect(dailyHits).toHaveLength(1);
    });

    it("falls back to legacy search when hierarchical disabled", async () => {
        index.setResults([
            {
                uri: "memory/2026-04-01.md",
                text: "content",
                score: 0.9,
                metadata: {},
            },
        ]);

        const search = new SearchService(index, files, { enabled: false });
        const results = await search.search("test");
        expect(results).toHaveLength(1);
        expect(results[0].uri).toBe("memory/2026-04-01.md");
    });
});

describe("Migration", () => {
    it("MemoryFiles.parsePointers extracts pointer URIs", async () => {
        const storage = new VirtualFileStorage();
        const files = new MemoryFiles("/root", storage);

        const content = `---
type: weekly
period: 2026-W15
pointers:
  - memory/2026-04-07.md
  - memory/2026-04-08.md
---

# Week 2026-W15`;

        const pointers = files.parsePointers(content);
        expect(pointers).toEqual([
            "memory/2026-04-07.md",
            "memory/2026-04-08.md",
        ]);
    });

    it("MemoryFiles.parseSalience extracts weights", async () => {
        const storage = new VirtualFileStorage();
        const files = new MemoryFiles("/root", storage);

        const content = `---
type: weekly
salience:
  memory/2026-04-07.md: 0.4
  memory/2026-04-08.md: 0.6
---

Body`;

        const salience = files.parseSalience(content);
        expect(salience["memory/2026-04-07.md"]).toBeCloseTo(0.4);
        expect(salience["memory/2026-04-08.md"]).toBeCloseTo(0.6);
    });

    it("parsePointers returns empty for legacy files", async () => {
        const storage = new VirtualFileStorage();
        const files = new MemoryFiles("/root", storage);

        const content = `---
type: weekly
---

# Legacy weekly summary`;

        expect(files.parsePointers(content)).toEqual([]);
    });
});
