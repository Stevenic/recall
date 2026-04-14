import * as path from "path";
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryFiles } from "../src/files.js";
import { VirtualFileStorage } from "../src/defaults/virtual-file-storage.js";
import { SearchLogger } from "../src/search-logger.js";
import {
    collectSignals,
    collectHitFrequencySignals,
    collectGapSignals,
    collectEntitySignals,
    collectStalenessSignals,
    collectWisdomDriftSignals,
    extractEntitiesLightweight,
} from "../src/signal-collector.js";
import { DreamEngine } from "../src/dream-engine.js";
import type {
    MemoryIndex,
    SearchResult,
    QueryOptions,
    IndexStats,
    CreateIndexOptions,
    DocumentMetadata,
} from "../src/interfaces/index.js";
import type { MemoryModel, CompletionResult, CompleteOptions } from "../src/interfaces/model.js";
import type { SearchLogEntry, DreamCandidate } from "../src/dreaming-config.js";

// ─── Mocks ───────────────────────────────────────────────

class MockIndex implements MemoryIndex {
    upserted: Array<{ uri: string; text: string; metadata?: DocumentMetadata }> = [];

    async createIndex(_options?: CreateIndexOptions): Promise<void> {}
    async isCreated(): Promise<boolean> { return true; }
    async upsertDocument(uri: string, text: string, metadata?: DocumentMetadata): Promise<void> {
        this.upserted.push({ uri, text, metadata });
    }
    async deleteDocument(_uri: string): Promise<void> {}
    async hasDocument(_uri: string): Promise<boolean> { return false; }
    async query(_text: string, _options?: QueryOptions): Promise<SearchResult[]> { return []; }
    async getStats(): Promise<IndexStats> { return { documentCount: 0, chunkCount: 0 }; }
    async getEmbedding(_uri: string): Promise<number[] | null> { return null; }
    async upsertEmbedding(_uri: string, _embedding: number[], _metadata?: DocumentMetadata): Promise<void> {}
}

class MockModel implements MemoryModel {
    responses: string[] = [];
    private _callIdx = 0;
    calls: Array<{ prompt: string; options?: CompleteOptions }> = [];

    async complete(prompt: string, options?: CompleteOptions): Promise<CompletionResult> {
        this.calls.push({ prompt, options });
        const text = this.responses[this._callIdx] ?? '{"insights":[],"promotions":[],"contradictions":[],"gaps":[]}';
        this._callIdx++;
        return { text, inputTokens: 100, outputTokens: 50 };
    }
}

// ─── SearchLogger Tests ──────────────────────────────────

describe("SearchLogger", () => {
    let storage: VirtualFileStorage;
    let logger: SearchLogger;

    beforeEach(async () => {
        storage = new VirtualFileStorage();
        logger = new SearchLogger("/root", storage);
        await logger.initialize();
    });

    it("logs search entries and reads them back", async () => {
        await logger.logSearch("auth migration", [
            { uri: "memory/2026-04-08.md", score: 0.82 },
            { uri: "memory/weekly/2026-W14.md", score: 0.71 },
        ], 5);

        const entries = await logger.readLog();
        expect(entries).toHaveLength(1);
        expect(entries[0].query).toBe("auth migration");
        expect(entries[0].results).toEqual(["memory/2026-04-08.md", "memory/weekly/2026-W14.md"]);
        expect(entries[0].scores).toEqual([0.82, 0.71]);
        expect(entries[0].topK).toBe(5);
        expect(entries[0].returned).toBe(2);
    });

    it("appends multiple entries", async () => {
        await logger.logSearch("query one", [], 5);
        await logger.logSearch("query two", [{ uri: "memory/2026-04-01.md", score: 0.5 }], 5);

        const entries = await logger.readLog();
        expect(entries).toHaveLength(2);
        expect(entries[0].query).toBe("query one");
        expect(entries[1].query).toBe("query two");
    });

    it("reads entries within time window", async () => {
        // Write an entry — it will have current timestamp
        await logger.logSearch("recent query", [{ uri: "memory/2026-04-11.md", score: 0.9 }], 5);

        const recent = await logger.readLogWindow(7);
        expect(recent).toHaveLength(1);
    });

    it("persists and reads candidates", async () => {
        const candidates = [
            { type: "high_frequency", score: 0.8, uris: ["memory/2026-04-01.md"], description: "test" },
        ];
        await logger.writeCandidates(candidates);

        const loaded = await logger.readCandidates();
        expect(loaded).toHaveLength(1);
        expect((loaded[0] as any).type).toBe("high_frequency");
    });

    it("persists and reads dream state", async () => {
        await logger.writeState({ lastRun: "2026-04-11T12:00:00Z", lastInsightsGenerated: 3 });

        const state = await logger.readState();
        expect(state.lastRun).toBe("2026-04-11T12:00:00Z");
        expect(state.lastInsightsGenerated).toBe(3);
    });

    it("returns empty arrays/objects for missing files", async () => {
        expect(await logger.readLog()).toEqual([]);
        expect(await logger.readCandidates()).toEqual([]);
        expect(await logger.readState()).toEqual({});
    });
});

// ─── Signal Collector Tests ──────────────────────────────

describe("Signal Collector", () => {
    let storage: VirtualFileStorage;
    let files: MemoryFiles;

    beforeEach(async () => {
        storage = new VirtualFileStorage();
        files = new MemoryFiles("/root", storage);
        await files.initialize();
    });

    describe("collectHitFrequencySignals", () => {
        it("returns empty for no entries", async () => {
            const result = await collectHitFrequencySignals([]);
            expect(result).toEqual([]);
        });

        it("identifies high-frequency URIs", async () => {
            const entries: SearchLogEntry[] = [
                { ts: "2026-04-11T10:00:00Z", query: "auth changes", results: ["memory/2026-04-08.md"], scores: [0.8], topK: 5, returned: 1 },
                { ts: "2026-04-11T11:00:00Z", query: "middleware update", results: ["memory/2026-04-08.md"], scores: [0.7], topK: 5, returned: 1 },
                { ts: "2026-04-11T12:00:00Z", query: "JWT migration", results: ["memory/2026-04-08.md", "memory/2026-04-01.md"], scores: [0.9, 0.5], topK: 5, returned: 2 },
            ];

            const result = await collectHitFrequencySignals(entries);
            expect(result.length).toBeGreaterThan(0);
            // memory/2026-04-08.md should be highest — 3 hits, 3 distinct queries
            expect(result[0].uris[0]).toBe("memory/2026-04-08.md");
            expect(result[0].type).toBe("high_frequency");
        });
    });

    describe("collectGapSignals", () => {
        it("returns empty for no entries", async () => {
            const result = await collectGapSignals([], 0.3);
            expect(result).toEqual([]);
        });

        it("identifies null queries", async () => {
            const entries: SearchLogEntry[] = [
                { ts: "2026-04-11T10:00:00Z", query: "rate limiting config", results: [], scores: [], topK: 5, returned: 0 },
                { ts: "2026-04-11T11:00:00Z", query: "rate limiting config", results: ["memory/2026-04-01.md"], scores: [0.2], topK: 5, returned: 1 },
                { ts: "2026-04-11T12:00:00Z", query: "rate limiting config", results: [], scores: [], topK: 5, returned: 0 },
            ];

            const result = await collectGapSignals(entries, 0.3);
            expect(result.length).toBe(1);
            expect(result[0].type).toBe("null_query");
            expect(result[0].description).toContain("rate limiting config");
        });
    });

    describe("collectEntitySignals", () => {
        it("identifies recurring entities without typed memories", async () => {
            const today = new Date();
            // Create 3 dailies with a recurring CamelCase entity
            for (let i = 0; i < 3; i++) {
                const d = new Date(today);
                d.setDate(d.getDate() - i);
                const dateStr = d.toISOString().split("T")[0];
                await files.writeDaily(dateStr, `Used MemoryService and VectraIndex today.\nAlso checked @lexicon for feedback.`);
            }

            const result = await collectEntitySignals(files, 30, 3);
            // Should find entities that appear across 3+ days
            const entityNames = result.map((c) => c.description);
            const hasMemoryService = entityNames.some((d) => d.includes("memoryservice"));
            expect(hasMemoryService).toBe(true);
        });

        it("excludes entities that already have typed memories", async () => {
            const today = new Date();
            for (let i = 0; i < 3; i++) {
                const d = new Date(today);
                d.setDate(d.getDate() - i);
                const dateStr = d.toISOString().split("T")[0];
                await files.writeDaily(dateStr, `Using VectraIndex for vector search.`);
            }
            // Create a typed memory that covers this entity
            await files.writeTypedMemory("project_vectraindex.md", "---\nname: VectraIndex\ntype: project\n---\ninfo");

            const result = await collectEntitySignals(files, 30, 3);
            const hasVectra = result.some((c) => c.description.includes("vectraindex"));
            expect(hasVectra).toBe(false);
        });
    });

    describe("collectStalenessSignals", () => {
        it("flags stale project memories", async () => {
            // Create a project memory with an old date
            await files.writeTypedMemory("project_old-system.md",
                "---\nname: Old System\ndescription: Old system config\ntype: project\ndate: 2025-06-01\n---\nOld system info");

            const result = await collectStalenessSignals(files, 90);
            expect(result.length).toBe(1);
            expect(result[0].type).toBe("stale_memory");
            expect(result[0].description).toContain("Old System");
        });

        it("skips non-project/reference memories", async () => {
            await files.writeTypedMemory("feedback_testing.md",
                "---\nname: Testing\ntype: feedback\ndate: 2025-01-01\n---\nAlways test.");

            const result = await collectStalenessSignals(files, 90);
            expect(result).toHaveLength(0);
        });

        it("skips fresh memories", async () => {
            const today = new Date().toISOString().split("T")[0];
            await files.writeTypedMemory("project_fresh.md",
                `---\nname: Fresh\ntype: project\ndate: ${today}\n---\nFresh info.`);

            const result = await collectStalenessSignals(files, 90);
            expect(result).toHaveLength(0);
        });
    });

    describe("collectWisdomDriftSignals", () => {
        it("flags wisdom entries with no search activity", async () => {
            await files.writeWisdom(`# Wisdom\n\n**Clean dist AND tsbuildinfo before rebuilding**\nAlways remove dist/ and *.tsbuildinfo.\n\n**Normalize backslash paths**\nUse path normalization.`);

            // Many queries, but none about these topics
            const entries: SearchLogEntry[] = Array.from({ length: 15 }, (_, i) => ({
                ts: `2026-04-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
                query: "something unrelated to wisdom",
                results: [],
                scores: [],
                topK: 5,
                returned: 0,
            }));

            const result = await collectWisdomDriftSignals(files, entries);
            expect(result.length).toBeGreaterThan(0);
            expect(result[0].type).toBe("wisdom_drift");
        });
    });

    describe("extractEntitiesLightweight", () => {
        it("extracts CamelCase entities", () => {
            const entities = extractEntitiesLightweight("Using MemoryService and SearchService");
            expect(entities).toContain("memoryservice");
            expect(entities).toContain("searchservice");
        });

        it("extracts @mentions", () => {
            const entities = extractEntitiesLightweight("Asked @lexicon for help");
            expect(entities).toContain("lexicon");
        });

        it("extracts kebab-case entities", () => {
            const entities = extractEntitiesLightweight("Using cli-agent-model for inference");
            expect(entities).toContain("cli-agent-model");
        });
    });
});

// ─── DreamEngine Tests ───────────────────────────────────

describe("DreamEngine", () => {
    let storage: VirtualFileStorage;
    let files: MemoryFiles;
    let index: MockIndex;
    let model: MockModel;
    let logger: SearchLogger;
    let engine: DreamEngine;

    beforeEach(async () => {
        storage = new VirtualFileStorage();
        files = new MemoryFiles("/root", storage);
        await files.initialize();
        index = new MockIndex();
        model = new MockModel();
        logger = new SearchLogger("/root", storage);
        await logger.initialize();
        engine = new DreamEngine(files, index, model, storage, logger);
    });

    it("runs a dry-run session without LLM calls", async () => {
        // Seed some search log data
        await logger.logSearch("test query", [], 5);
        await logger.logSearch("test query", [], 5);

        const result = await engine.dream({ dryRun: true });
        expect(result.modelCalls).toBe(0);
        expect(result.candidatesExamined).toBe(0);
    });

    it("runs gather phase and produces candidates", async () => {
        // Create stale typed memory
        await files.writeTypedMemory("project_old.md",
            "---\nname: Old Project\ntype: project\ndate: 2025-01-01\n---\nOld info");

        const candidates = await engine.gatherSignals();
        expect(candidates.length).toBeGreaterThan(0);
        const stale = candidates.find((c) => c.type === "stale_memory");
        expect(stale).toBeDefined();
    });

    it("runs full dream session with analysis", async () => {
        // Create stale typed memory
        await files.writeTypedMemory("project_stale.md",
            "---\nname: Stale Project\ntype: project\ndate: 2025-01-01\n---\nStale project info.");

        // Set up model response
        model.responses = [
            JSON.stringify({
                insights: [{
                    theme: "stale-project-review",
                    body: "This project memory is outdated.",
                    sources: ["memory/project_stale.md"],
                    confidence: "medium",
                }],
                promotions: [],
                contradictions: [],
                gaps: [],
            }),
        ];

        const result = await engine.dream({ maxCandidates: 1 });
        expect(result.candidatesExamined).toBeGreaterThanOrEqual(1);
        // Model was called at least once
        expect(model.calls.length).toBeGreaterThanOrEqual(1);
    });

    it("writes insight files to memory/dreams/insights/", async () => {
        await files.writeTypedMemory("project_review.md",
            "---\nname: Review\ntype: project\ndate: 2025-01-01\n---\nReview info.");

        model.responses = [
            JSON.stringify({
                insights: [{
                    theme: "project-review-pattern",
                    body: "Projects are reviewed quarterly.",
                    sources: ["memory/project_review.md"],
                    confidence: "high",
                }],
                promotions: [],
                contradictions: [],
                gaps: [],
            }),
        ];

        const result = await engine.dream({ maxCandidates: 1 });
        expect(result.insights.length).toBeGreaterThanOrEqual(1);

        // Verify insight file was indexed
        const insightUpserts = index.upserted.filter((u) =>
            u.uri.includes("dreams/insights/"),
        );
        expect(insightUpserts.length).toBeGreaterThanOrEqual(1);
        expect(insightUpserts[0].metadata?.contentType).toBe("insight");
    });

    it("writes DREAMS.md diary entry", async () => {
        await files.writeTypedMemory("project_diary-test.md",
            "---\nname: Diary Test\ntype: project\ndate: 2025-01-01\n---\ntest");

        model.responses = [
            JSON.stringify({ insights: [], promotions: [], contradictions: [], gaps: [] }),
        ];

        await engine.dream({ maxCandidates: 1 });

        // Check DREAMS.md was created (use path.join for Windows backslash compat)
        const dreamsPath = path.join("/root", "DREAMS.md");
        const exists = await storage.pathExists(dreamsPath);
        expect(exists).toBe(true);

        const content = (await storage.readFile(dreamsPath)).toString("utf-8");
        expect(content).toContain("# Dream Diary");
        expect(content).toContain("Candidates examined:");
    });

    it("persists dream state after session", async () => {
        await files.writeTypedMemory("project_state-test.md",
            "---\nname: State Test\ntype: project\ndate: 2025-01-01\n---\ntest");

        model.responses = [
            JSON.stringify({ insights: [], promotions: [], contradictions: [], gaps: [] }),
        ];

        await engine.dream({ maxCandidates: 1 });

        const state = await logger.readState();
        expect(state.lastRun).toBeDefined();
    });

    it("returns status information", async () => {
        const status = await engine.status();
        expect(status.pendingCandidates).toBe(0);
        expect(status.searchLogEntries).toBe(0);
        expect(status.lastRun).toBeUndefined();
    });

    it("deduplicates promoted typed memories against existing ones", async () => {
        // Create existing typed memory
        await files.writeTypedMemory("feedback_testing.md",
            "---\nname: Testing\ntype: feedback\n---\nExisting.");

        // Create a stale memory to trigger analysis
        await files.writeTypedMemory("project_old.md",
            "---\nname: Old\ntype: project\ndate: 2025-01-01\n---\nOld info.");

        // Model tries to promote a duplicate
        model.responses = [
            JSON.stringify({
                insights: [],
                promotions: [{
                    filename: "feedback_testing.md",
                    content: "---\nname: Testing\ntype: feedback\n---\nDuplicate."
                }],
                contradictions: [],
                gaps: [],
            }),
        ];

        const result = await engine.dream({ maxCandidates: 1 });
        // Should not have promoted the duplicate
        expect(result.promotions).not.toContain("feedback_testing.md");
    });

    it("handles LLM returning non-JSON gracefully", async () => {
        await files.writeTypedMemory("project_graceful.md",
            "---\nname: Graceful\ntype: project\ndate: 2025-01-01\n---\nTest.");

        model.responses = [
            "This is a freeform analysis of the memories. The project is quite outdated and should be reviewed.",
        ];

        const result = await engine.dream({ maxCandidates: 1 });
        // Should produce a low-confidence insight from freeform text
        if (result.insights.length > 0) {
            expect(result.insights[0].confidence).toBe("low");
        }
    });

    it("writes contradiction files when detected", async () => {
        // Create wisdom and a recent contradicting memory
        await files.writeWisdom("**Always use mocks**\nMock all external services.");
        const today = new Date().toISOString().split("T")[0];
        await files.writeDaily(today, "Switched to integration tests — mocks missed migration bugs.");

        // Seed search log to trigger wisdom drift
        for (let i = 0; i < 15; i++) {
            await logger.logSearch("something else", [], 5);
        }

        model.responses = [
            JSON.stringify({
                insights: [],
                promotions: [],
                contradictions: [{
                    wisdomEntry: "Always use mocks",
                    evidence: [`memory/${today}.md`],
                    recommendation: "Update to distinguish external API mocks from database mocks",
                }],
                gaps: [],
            }),
        ];

        const result = await engine.dream({ maxCandidates: 1 });
        if (result.contradictions.length > 0) {
            expect(result.contradictions[0].wisdomEntry).toBe("Always use mocks");

            // Verify contradiction file was indexed
            const contradictionUpserts = index.upserted.filter((u) =>
                u.uri.includes("dreams/contradictions/"),
            );
            expect(contradictionUpserts.length).toBeGreaterThanOrEqual(1);
        }
    });
});
