import { describe, it, expect, beforeEach } from "vitest";
import * as path from "path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { WikiEngine } from "../src/wiki-engine.js";
import { MemoryFiles } from "../src/files.js";
import { Compactor } from "../src/compactor.js";
import { SearchService } from "../src/search.js";
import { VirtualFileStorage } from "../src/defaults/virtual-file-storage.js";
import { LocalFileStorage } from "../src/defaults/local-file-storage.js";
import type {
    MemoryModel,
    CompleteOptions,
    CompletionResult,
} from "../src/interfaces/model.js";
import type {
    MemoryIndex,
    SearchResult,
    QueryOptions,
    IndexStats,
    CreateIndexOptions,
    DocumentMetadata,
} from "../src/interfaces/index.js";

class StubModel implements MemoryModel {
    public response = "";
    async complete(_prompt: string, _options?: CompleteOptions): Promise<CompletionResult> {
        return { text: this.response };
    }
}

class MockIndex implements MemoryIndex {
    public docs: Map<string, { text: string; metadata: DocumentMetadata }> = new Map();
    private _results: SearchResult[] = [];
    setResults(results: SearchResult[]): void {
        this._results = results;
    }
    async createIndex(_options?: CreateIndexOptions): Promise<void> {}
    async isCreated(): Promise<boolean> { return true; }
    async upsertDocument(uri: string, text: string, metadata?: DocumentMetadata): Promise<void> {
        this.docs.set(uri, { text, metadata: metadata ?? {} });
    }
    async deleteDocument(uri: string): Promise<void> { this.docs.delete(uri); }
    async hasDocument(uri: string): Promise<boolean> { return this.docs.has(uri); }
    async query(_text: string, _options?: QueryOptions): Promise<SearchResult[]> {
        return this._results;
    }
    async getStats(): Promise<IndexStats> {
        return { documentCount: this.docs.size, chunkCount: this.docs.size };
    }
    async getEmbedding(_uri: string): Promise<number[] | null> { return null; }
    async upsertEmbedding(): Promise<void> {}
}

describe("Per-silo wiki — end-to-end flow without explicit initialize()", () => {
    // Use the REAL filesystem to catch the LocalFileStorage missing-parent-dir
    // edge case that VirtualFileStorage masks.
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "recall-per-silo-"));
    });

    it("stub() succeeds on LocalFileStorage without calling initialize() first", async () => {
        // LocalFileStorage without a root takes absolute paths verbatim
        // (matches the MemoryService wiring in service.ts). The engine
        // creates the wiki dir on demand inside write().
        const storage = new LocalFileStorage();
        const engine = new WikiEngine(root, storage, { enabled: true });
        const page = await engine.stub({
            slug: "auth-middleware",
            name: "Auth middleware",
            description: "Module description.",
            category: "concept",
            source: "memory/2026-04-01.md",
            body: "Lede.\n\n**Why:** w.\n\n**How to apply:** h.",
        });
        expect(page.slug).toBe("auth-middleware");
        // Confirm the file actually lives on disk.
        const wikiPath = path.join(root, "memory", "wiki", "auth-middleware.md");
        const stat = await fs.stat(wikiPath);
        expect(stat.isFile()).toBe(true);
    });

    it("list() returns [] cleanly when the wiki dir doesn't exist yet", async () => {
        const storage = new LocalFileStorage();
        const engine = new WikiEngine(root, storage, { enabled: true });
        const slugs = await engine.list();
        expect(slugs).toEqual([]);
    });
});

describe("Per-silo wiki — wisdom distillation reads wiki pages by default", () => {
    let storage: VirtualFileStorage;
    let files: MemoryFiles;
    let wiki: WikiEngine;
    let model: StubModel;
    let compactor: Compactor;

    beforeEach(async () => {
        storage = new VirtualFileStorage();
        files = new MemoryFiles("/root", storage);
        await files.initialize();
        wiki = new WikiEngine("/root", storage, { enabled: true });
        await wiki.initialize();
        model = new StubModel();
        compactor = new Compactor(files, { model, wiki });
    });

    it("the wiki-aware path activates when wiki is enabled (no explicit opt-in)", async () => {
        // Plant a wiki page and a monthly summary so distillation has input.
        await wiki.stub({
            slug: "auth-middleware",
            name: "Auth middleware",
            description: "The auth layer.",
            category: "concept",
            source: "memory/2026-04-01.md",
            body: "Lede.\n\n**Why:** w.\n\n**How to apply:** h.",
        });
        await files.writeMonthly(
            "2026-04",
            "---\ntype: monthly\nperiod: 2026-04\n---\n\n# April\n\nMonthly content.\n",
        );
        model.response = JSON.stringify({
            wisdom: "# Agent - Wisdom\n\n**Always validate**\nValidate inputs.\n",
            wiki_promotions: [],
        });
        const result = await compactor.distillWisdom();
        expect(result.filesCreated).toContain("WISDOM.md");
        const wisdom = (await storage.readFile(path.join("/root", "WISDOM.md"))).toString("utf-8");
        // Wiki-aware path always regenerates the Knowledge Map.
        expect(wisdom).toContain("## Knowledge Map");
        expect(wisdom).toContain("[[auth-middleware]]");
    });

    it("a freshly-promoted page from the model appears in the Knowledge Map immediately", async () => {
        await files.writeMonthly(
            "2026-04",
            "---\ntype: monthly\nperiod: 2026-04\n---\n\n# April\n\nMonthly.\n",
        );
        model.response = JSON.stringify({
            wisdom: "# Agent - Wisdom\n\n(principles)\n",
            wiki_promotions: [
                {
                    slug: "new-project",
                    category: "project",
                    name: "New project",
                    description: "Just promoted from wisdom distillation.",
                    body: "Body.\n\n**Why:** w.\n\n**How to apply:** h.",
                    sources: [{ uri: "memory/2026-04-01.md" }],
                },
            ],
        });
        await compactor.distillWisdom();
        const wisdom = (await storage.readFile(path.join("/root", "WISDOM.md"))).toString("utf-8");
        expect(wisdom).toContain("## Knowledge Map");
        expect(wisdom).toContain("[[new-project]]");
        // And the wiki page itself exists.
        const page = await wiki.read("new-project");
        expect(page).not.toBeNull();
    });
});

describe("Per-silo wiki — search ranks wiki pages with the default boost", () => {
    it("default boost (1.3×) applies when wiki is enabled and no per-query override", async () => {
        const storage = new VirtualFileStorage();
        const files = new MemoryFiles("/root", storage);
        await files.initialize();
        const index = new MockIndex();

        // Stage a daily and a wiki hit with equal raw scores. The search
        // service should rank the wiki page first courtesy of the boost.
        const queries: SearchResult[] = [
            {
                uri: "memory/2026-04-01.md",
                text: "Daily entry.",
                score: 0.5,
                metadata: { contentType: "daily", period: "2026-04-01" },
            },
            {
                uri: "memory/wiki/auth.md",
                text: "Wiki page.",
                score: 0.5,
                metadata: { contentType: "wiki", wikiSlug: "auth", wikiTarget: "private" },
            },
        ];
        index.setResults(queries);
        const search = new SearchService(index, files, undefined, { scoreBoost: 1.3 });
        const results = await search.search("anything");
        // Wiki hit should outrank daily.
        expect(results[0].uri).toBe("memory/wiki/auth.md");
        expect(results[0].score).toBeGreaterThan(results[1].score);
    });
});
