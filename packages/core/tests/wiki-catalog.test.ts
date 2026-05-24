import { describe, it, expect, beforeEach } from "vitest";
import { SearchService } from "../src/search.js";
import { MemoryFiles } from "../src/files.js";
import { WikiEngine } from "../src/wiki-engine.js";
import { VirtualFileStorage } from "../src/defaults/virtual-file-storage.js";
import type {
    MemoryIndex,
    SearchResult,
    QueryOptions,
    IndexStats,
    CreateIndexOptions,
    DocumentMetadata,
} from "../src/interfaces/index.js";

class EmptyIndex implements MemoryIndex {
    async createIndex(_options?: CreateIndexOptions): Promise<void> {}
    async isCreated(): Promise<boolean> { return true; }
    async upsertDocument(): Promise<void> {}
    async deleteDocument(): Promise<void> {}
    async hasDocument(): Promise<boolean> { return false; }
    async query(_text: string, _options?: QueryOptions): Promise<SearchResult[]> {
        return [];
    }
    async getStats(): Promise<IndexStats> { return { documentCount: 0, chunkCount: 0 }; }
    async getEmbedding(): Promise<number[] | null> { return null; }
    async upsertEmbedding(): Promise<void> {}
    // satisfy DocumentMetadata reference
    _: DocumentMetadata = {};
}

describe("SearchService catalog branch — wiki pages", () => {
    let storage: VirtualFileStorage;
    let files: MemoryFiles;
    let wiki: WikiEngine;
    let search: SearchService;

    beforeEach(async () => {
        storage = new VirtualFileStorage();
        files = new MemoryFiles("/root", storage);
        await files.initialize();
        wiki = new WikiEngine("/root", storage, { enabled: true });
        await wiki.initialize();
        search = new SearchService(
            new EmptyIndex(),
            files,
            undefined,
            { scoreBoost: 1.5 },
            wiki,
        );
    });

    it("matches a wiki page when the query overlaps name/description", async () => {
        await wiki.stub({
            slug: "auth-middleware",
            name: "Auth middleware",
            description: "JWT-based authentication layer.",
            category: "concept",
            source: "memory/2026-04-01.md",
            body: "Lede.\n\n**Why:** w.\n\n**How to apply:** h.",
        });
        // Empty index → only catalog branch contributes results.
        const results = await search.search("auth middleware JWT");
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].uri).toBe("memory/wiki/auth-middleware.md");
        expect(results[0].metadata.contentType).toBe("wiki");
    });

    it("matches typed memories that haven't been migrated yet (legacy path)", async () => {
        await files.writeTypedMemory(
            "feedback_testing.md",
            "---\nname: Don't mock the database\ndescription: Integration tests must hit a real DB\ntype: feedback\n---\n\nBody.",
        );
        const results = await search.search("mock database integration");
        expect(results.length).toBeGreaterThan(0);
        const uris = results.map((r) => r.uri);
        expect(uris).toContain("feedback_testing.md");
    });

    it("matches both typed and wiki sources when a repo is mid-migration", async () => {
        await files.writeTypedMemory(
            "project_old.md",
            "---\nname: Old project\ndescription: Legacy entry that hasn't been migrated\ntype: project\n---\n\nBody.",
        );
        await wiki.stub({
            slug: "new-project",
            name: "New project",
            description: "Already migrated to wiki",
            category: "project",
            source: "memory/2026-04-01.md",
            body: "Lede.\n\n**Why:** w.\n\n**How to apply:** h.",
        });
        const results = await search.search("project");
        const uris = results.map((r) => r.uri);
        expect(uris).toContain("project_old.md");
        expect(uris).toContain("memory/wiki/new-project.md");
    });

    it("skips redirect wiki pages in the catalog branch", async () => {
        await wiki.stub({
            slug: "real-page",
            name: "Real page",
            description: "The actual page about postgres",
            category: "concept",
            source: "memory/2026-04-01.md",
            body: "Lede.\n\n**Why:** w.\n\n**How to apply:** h.",
        });
        await wiki.rename("real-page", "renamed-page");
        const results = await search.search("postgres");
        const uris = results.map((r) => r.uri);
        expect(uris).toContain("memory/wiki/renamed-page.md");
        expect(uris).not.toContain("memory/wiki/real-page.md");
    });

    it("returns empty when no wiki is wired and no typed memories exist", async () => {
        const noWikiSearch = new SearchService(new EmptyIndex(), files);
        const results = await noWikiSearch.search("anything");
        expect(results).toEqual([]);
    });

    it("populates wiki metadata on the matched result so downstream boosts fire", async () => {
        await wiki.stub({
            slug: "x",
            name: "Xylophone topic",
            description: "Lookup catchphrase",
            category: "concept",
            source: "memory/2026-04-01.md",
            body: "Lede.\n\n**Why:** w.\n\n**How to apply:** h.",
        });
        const results = await search.search("xylophone catchphrase");
        const hit = results.find((r) => r.uri === "memory/wiki/x.md");
        expect(hit).toBeDefined();
        expect(hit!.metadata.contentType).toBe("wiki");
        expect(hit!.metadata.wikiSlug).toBe("x");
        expect(hit!.metadata.wikiCategory).toBe("concept");
    });
});
