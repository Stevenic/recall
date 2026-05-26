import { describe, it, expect, beforeEach } from "vitest";
import * as path from "path";
import { DreamEngine } from "../src/dream-engine.js";
import { WikiEngine } from "../src/wiki-engine.js";
import { MemoryFiles } from "../src/files.js";
import { SearchLogger } from "../src/search-logger.js";
import { VirtualFileStorage } from "../src/defaults/virtual-file-storage.js";
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
import type { DreamCandidate, AnalysisResult } from "../src/dreaming-config.js";

const ROOT = "/root";
const p = (...parts: string[]) => path.join(ROOT, ...parts);

class StubModel implements MemoryModel {
    public response = "";
    public lastSystem = "";
    public lastPrompt = "";
    async complete(prompt: string, options?: CompleteOptions): Promise<CompletionResult> {
        this.lastPrompt = prompt;
        this.lastSystem = options?.systemPrompt ?? "";
        return { text: this.response };
    }
}

class MockIndex implements MemoryIndex {
    async createIndex(_options?: CreateIndexOptions): Promise<void> {}
    async isCreated(): Promise<boolean> { return true; }
    async upsertDocument(_uri: string, _text: string, _metadata?: DocumentMetadata): Promise<void> {}
    async deleteDocument(_uri: string): Promise<void> {}
    async hasDocument(_uri: string): Promise<boolean> { return false; }
    async query(_text: string, _options?: QueryOptions): Promise<SearchResult[]> { return []; }
    async getStats(): Promise<IndexStats> { return { documentCount: 0, chunkCount: 0 }; }
    async getEmbedding(_uri: string): Promise<number[] | null> { return null; }
    async upsertEmbedding(): Promise<void> {}
}

async function setup() {
    const storage = new VirtualFileStorage();
    const files = new MemoryFiles(ROOT, storage);
    await files.initialize();
    const index = new MockIndex();
    const logger = new SearchLogger(ROOT, storage);
    const wiki = new WikiEngine(ROOT, storage, { enabled: true });
    await wiki.initialize();
    const model = new StubModel();
    const engine = new DreamEngine(
        files,
        index,
        model,
        storage,
        logger,
        { writeToWiki: true },
        { wiki },
    );
    return { storage, files, wiki, model, engine };
}

function candidate(uris: string[]): DreamCandidate {
    return {
        type: "high_frequency",
        score: 1,
        uris,
        description: "test candidate",
    };
}

function emptyAnalysisResult(c: DreamCandidate): AnalysisResult {
    return {
        candidate: c,
        insights: [],
        promotions: [],
        contradictions: [],
        gaps: [],
        wikiOps: [],
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
    };
}

describe("DreamEngine — wiki ops application (Phase D)", () => {
    it("applies a create op as a new wiki page", async () => {
        const { engine, wiki } = await setup();
        const ar = emptyAnalysisResult(candidate(["memory/2026-04-01.md"]));
        ar.wikiOps.push({
            op: "create",
            slug: "auth-middleware",
            category: "concept",
            name: "Auth Middleware",
            description: "The auth middleware module's design and tradeoffs.",
            body: "Cookies → JWT migration is in progress.\n\n**Why:** Compliance.\n\n**How to apply:** Prefer JWT path.",
            sources: [{ uri: "memory/2026-04-01.md" }, { uri: "memory/2026-04-02.md" }],
            related: ["postgres"],
            confidence: "medium",
        });
        const result = await engine.writeResults([ar], 1);
        expect(result.wikiUpdates).toHaveLength(1);
        expect(result.wikiUpdates[0]).toMatchObject({
            op: "create",
            slug: "auth-middleware",
            ok: true,
        });

        const page = await wiki.read("auth-middleware");
        expect(page).not.toBeNull();
        expect(page!.category).toBe("concept");
        expect(page!.name).toBe("Auth Middleware");
        // stub() only takes the first source; the rest are appended.
        expect(page!.sources.map((s) => s.uri)).toContain("memory/2026-04-01.md");
        expect(page!.sources.map((s) => s.uri)).toContain("memory/2026-04-02.md");
        expect(page!.related).toContain("postgres");
    });

    it("applies an update op as an append", async () => {
        const { engine, wiki } = await setup();
        await wiki.stub({
            slug: "auth-middleware",
            name: "Auth Middleware",
            description: "Existing page.",
            category: "concept",
            source: "memory/2026-04-01.md",
            body: "Initial body.\n\n**Why:** initial.\n\n**How to apply:** use JWT.",
        });
        const ar = emptyAnalysisResult(candidate(["memory/2026-04-02.md"]));
        ar.wikiOps.push({
            op: "update",
            slug: "auth-middleware",
            appendBody: "Update: rolled out to staging.",
            source: "memory/2026-04-02.md",
        });
        const result = await engine.writeResults([ar], 1);
        expect(result.wikiUpdates[0].ok).toBe(true);
        const page = await wiki.read("auth-middleware");
        expect(page!.body).toContain("Initial body");
        expect(page!.body).toContain("rolled out to staging");
        expect(page!.sources.map((s) => s.uri)).toContain("memory/2026-04-02.md");
    });

    it("applies a contradict op by setting contradicts frontmatter", async () => {
        const { engine, wiki } = await setup();
        await wiki.stub({
            slug: "new-claim",
            name: "New Claim",
            description: "Newer position.",
            category: "concept",
            source: "memory/2026-04-10.md",
            body: "Lede.\n\n**Why:** new evidence.\n\n**How to apply:** use this path.",
        });
        await wiki.stub({
            slug: "old-claim",
            name: "Old Claim",
            description: "Older position.",
            category: "concept",
            source: "memory/2026-03-01.md",
            body: "Lede.\n\n**Why:** old evidence.\n\n**How to apply:** use that path.",
        });
        const ar = emptyAnalysisResult(candidate(["memory/2026-04-10.md"]));
        ar.wikiOps.push({
            op: "contradict",
            slug: "new-claim",
            contradicts: ["old-claim"],
            note: "Replaces last quarter's approach.",
        });
        await engine.writeResults([ar], 1);
        const page = await wiki.read("new-claim");
        expect(page!.contradicts).toContain("old-claim");
    });

    it("treats create-on-existing as an append rather than failing", async () => {
        const { engine, wiki } = await setup();
        await wiki.stub({
            slug: "topic",
            name: "Topic",
            description: "Pre-existing.",
            category: "concept",
            source: "memory/2026-04-01.md",
            body: "Original.\n\n**Why:** w.\n\n**How to apply:** h.",
        });
        const ar = emptyAnalysisResult(candidate(["memory/2026-04-02.md"]));
        ar.wikiOps.push({
            op: "create",
            slug: "topic",
            category: "concept",
            name: "Topic",
            description: "From dream.",
            body: "Additional context from dreaming.",
            sources: ["memory/2026-04-02.md"],
        });
        const result = await engine.writeResults([ar], 1);
        expect(result.wikiUpdates[0].ok).toBe(true);
        expect(result.wikiUpdates[0].detail).toContain("appended");
        const page = await wiki.read("topic");
        expect(page!.body).toContain("Original");
        expect(page!.body).toContain("Additional context from dreaming");
        expect(page!.sources.map((s) => s.uri)).toContain("memory/2026-04-02.md");
    });

    it("reports a failure (rather than throwing) when contradict targets a nonexistent page", async () => {
        const { engine } = await setup();
        const ar = emptyAnalysisResult(candidate(["memory/2026-04-10.md"]));
        ar.wikiOps.push({
            op: "contradict",
            slug: "missing",
            contradicts: ["other"],
        });
        const result = await engine.writeResults([ar], 1);
        expect(result.wikiUpdates).toHaveLength(1);
        expect(result.wikiUpdates[0].ok).toBe(false);
        expect(result.wikiUpdates[0].detail).toMatch(/no such page/);
    });

    it("skips wiki ops when skipWiki is true", async () => {
        const { engine, wiki } = await setup();
        const ar = emptyAnalysisResult(candidate(["memory/2026-04-01.md"]));
        ar.wikiOps.push({
            op: "create",
            slug: "skip-me",
            category: "concept",
            name: "Skipped",
            description: "Should not be created.",
            body: "Lede.\n\n**Why:** w.\n\n**How to apply:** h.",
            sources: [{ uri: "memory/2026-04-01.md" }],
        });
        const result = await engine.writeResults([ar], 1, { skipWiki: true });
        expect(result.wikiUpdates).toHaveLength(0);
        const page = await wiki.read("skip-me");
        expect(page).toBeNull();
    });
});

describe("DreamEngine — wiki ops in DREAMS.md", () => {
    it("includes a Wiki Updates section in the diary", async () => {
        const { engine, storage } = await setup();
        const ar = emptyAnalysisResult(candidate(["memory/2026-04-01.md"]));
        ar.wikiOps.push({
            op: "create",
            slug: "diary-target",
            category: "concept",
            name: "Diary Target",
            description: "For testing diary output.",
            body: "Body.\n\n**Why:** w.\n\n**How to apply:** h.",
            sources: [{ uri: "memory/2026-04-01.md" }],
        });
        await engine.writeResults([ar], 1);
        const diaryBuf = await storage.readFile(path.join(ROOT, "DREAMS.md"));
        const diary = diaryBuf.toString("utf-8");
        expect(diary).toContain("### Wiki Updates");
        expect(diary).toContain("[[diary-target]]");
    });
});

describe("DreamEngine — wiki_ops parsing from JSON", () => {
    it("harvests wiki_ops from a model response", async () => {
        const { engine, model, storage } = await setup();
        // _loadCandidateContext requires the URI to be readable, otherwise
        // the analyze step short-circuits before calling the model.
        await storage.upsertFile(
            p("memory", "2026-04-01.md"),
            "# Day 1\nSomething happened.",
        );
        model.response = JSON.stringify({
            insights: [],
            promotions: [],
            contradictions: [],
            gaps: [],
            wiki_ops: [
                {
                    op: "create",
                    slug: "via-json",
                    category: "concept",
                    name: "Via JSON",
                    description: "Came from the model.",
                    body: "Body content.\n\n**Why:** w.\n\n**How to apply:** h.",
                    sources: [{ uri: "memory/2026-04-01.md" }],
                },
            ],
        });
        const results = await engine.analyze([
            candidate(["memory/2026-04-01.md"]),
        ]);
        expect(results).toHaveLength(1);
        expect(results[0].wikiOps).toHaveLength(1);
        expect(results[0].wikiOps[0]).toMatchObject({
            op: "create",
            slug: "via-json",
        });
    });

    it("rejects wiki_ops with invalid slugs", async () => {
        const { engine, model, storage } = await setup();
        await storage.upsertFile(
            p("memory", "2026-04-01.md"),
            "# Day 1\nSomething happened.",
        );
        model.response = JSON.stringify({
            insights: [],
            promotions: [],
            contradictions: [],
            gaps: [],
            wiki_ops: [
                { op: "create", slug: "Bad Slug!", category: "concept", body: "x", sources: ["memory/2026-04-01.md"] },
                { op: "create", slug: "valid-slug", category: "concept", name: "Valid", description: "", body: "Body", sources: ["memory/2026-04-01.md"] },
            ],
        });
        const results = await engine.analyze([
            candidate(["memory/2026-04-01.md"]),
        ]);
        expect(results[0].wikiOps).toHaveLength(1);
        expect(results[0].wikiOps[0].slug).toBe("valid-slug");
    });
});

describe("WikiEngine.migrateInsights", () => {
    it("converts insight files into theme wiki pages", async () => {
        const { wiki, storage } = await setup();
        await storage.upsertFile(
            p("memory", "dreams", "insights", "2026-04-15-auth-evolution.md"),
            "---\ntype: insight\ndate: 2026-04-15\ntheme: auth evolution\nsources:\n  - memory/2026-04-01.md\n  - memory/2026-04-08.md\nconfidence: medium\n---\n\nThe auth layer migrated from cookies to JWT over Q2.\n",
        );
        const report = await wiki.migrateInsights();
        expect(report.created).toContain("auth-evolution");
        const page = await wiki.read("auth-evolution");
        expect(page).not.toBeNull();
        expect(page!.category).toBe("theme");
        expect(page!.sources.map((s) => s.uri)).toEqual([
            "memory/2026-04-01.md",
            "memory/2026-04-08.md",
        ]);
        expect(page!.body).toContain("cookies to JWT");
    });

    it("is idempotent — re-running skips already-migrated pages", async () => {
        const { wiki, storage } = await setup();
        await storage.upsertFile(
            p("memory", "dreams", "insights", "2026-04-15-x.md"),
            "---\ntype: insight\ndate: 2026-04-15\ntheme: x\nsources:\n  - memory/2026-04-01.md\n---\n\nbody\n",
        );
        const first = await wiki.migrateInsights();
        expect(first.created).toEqual(["x"]);
        const second = await wiki.migrateInsights();
        expect(second.created).toEqual([]);
        expect(second.skipped[0].reason).toMatch(/already exists/);
    });

    it("returns an empty report when there's no insights directory", async () => {
        const { wiki } = await setup();
        const report = await wiki.migrateInsights();
        expect(report.created).toEqual([]);
        expect(report.skipped).toEqual([]);
    });
});

describe("DreamEngine — entity rename detection (post-write hook)", () => {
    it("redirects the obsolete page and supersedes the canonical when verifier says 'same'", async () => {
        const { engine, wiki, model } = await setup();
        // Two pages with overlapping sources but divergent name tokens —
        // the rename case the detector targets.
        await wiki.stub({
            slug: "northstar-components",
            name: "Northstar Components",
            description: "Original vendor name for the Condor target.",
            category: "entity",
            source: "memory/2026-01-03.md",
            body: "Initial entity stub for the target acquisition.",
        });
        // Bring it to >=3 sources so the rename detector trips the gate.
        await wiki.append(
            "northstar-components",
            "memory/2026-01-05.md",
            "Additional sources.",
        );
        await wiki.append(
            "northstar-components",
            "memory/2026-01-07.md",
            "More activity around the entity.",
        );
        await wiki.stub({
            slug: "northstar-gridworks",
            name: "Northstar Gridworks",
            description: "Renamed vendor (post-2026-01-14).",
            category: "entity",
            source: "memory/2026-01-14.md",
            body: "Second entity stub after the rename.",
        });
        await wiki.append(
            "northstar-gridworks",
            "memory/2026-01-05.md", // shared source with the first page
            "Cross-reference back to the original entity.",
        );
        await wiki.append(
            "northstar-gridworks",
            "memory/2026-01-07.md", // also shared
            "Another shared source.",
        );
        // Verifier confirms the rename with canonical = the later-named page.
        model.response = JSON.stringify({
            same: true,
            canonical_slug: "northstar-gridworks",
            old_name: "Northstar Components",
            confidence: "high",
            reasoning: "explicit rename language.",
        });
        // Trigger by issuing a fresh write to the canonical page.
        const ar = emptyAnalysisResult(candidate(["memory/2026-01-14.md"]));
        ar.wikiOps.push({
            op: "update",
            slug: "northstar-gridworks",
            appendBody: "Post-rename activity.",
            source: "memory/2026-01-14.md",
        });
        await engine.writeResults([ar], 1);

        const obsolete = await wiki.read("northstar-components");
        const canonical = await wiki.read("northstar-gridworks");
        expect(obsolete).not.toBeNull();
        expect(canonical).not.toBeNull();
        expect(obsolete!.redirectTo).toBe("northstar-gridworks");
        expect(obsolete!.body).toContain("merged into");
        expect(canonical!.supersedes ?? []).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    source: "wiki:northstar-components",
                    fact: expect.stringContaining("renamed"),
                }),
            ]),
        );
    });

    it("does nothing when the verifier returns same=false", async () => {
        const { engine, wiki, model } = await setup();
        await wiki.stub({
            slug: "acme-launch",
            name: "Acme Launch",
            description: "A launch program.",
            category: "project",
            source: "memory/2026-02-01.md",
            body: "Launch prep.",
        });
        await wiki.append("acme-launch", "memory/2026-02-02.md", "More prep.");
        await wiki.append("acme-launch", "memory/2026-02-03.md", "Even more prep.");
        await wiki.stub({
            slug: "globex-launch",
            name: "Globex Launch",
            description: "A different launch.",
            category: "project",
            source: "memory/2026-02-01.md", // intentionally overlaps
            body: "Different launch context.",
        });
        await wiki.append("globex-launch", "memory/2026-02-02.md", "Shared meeting notes.");
        await wiki.append("globex-launch", "memory/2026-02-03.md", "More shared context.");
        model.response = JSON.stringify({
            same: false,
            canonical_slug: null,
            old_name: null,
            confidence: "high",
            reasoning: "two distinct launches.",
        });
        const ar = emptyAnalysisResult(candidate(["memory/2026-02-03.md"]));
        ar.wikiOps.push({
            op: "update",
            slug: "globex-launch",
            appendBody: "More work.",
            source: "memory/2026-02-04.md",
        });
        await engine.writeResults([ar], 1);
        const acme = await wiki.read("acme-launch");
        const globex = await wiki.read("globex-launch");
        expect(acme!.redirectTo).toBeUndefined();
        expect(globex!.redirectTo).toBeUndefined();
        expect(acme!.supersedes ?? []).toEqual([]);
        expect(globex!.supersedes ?? []).toEqual([]);
    });

    it("skips pages with fewer than 3 sources (structural pre-filter)", async () => {
        const { engine, wiki, model } = await setup();
        await wiki.stub({
            slug: "a-page",
            name: "A Page",
            description: "Too few sources.",
            category: "entity",
            source: "memory/2026-04-01.md",
            body: "Body.",
        });
        // Only 1 source — below the ≥3 trigger.
        await wiki.stub({
            slug: "b-page",
            name: "B Page",
            description: "Also too few sources.",
            category: "entity",
            source: "memory/2026-04-01.md",
            body: "Body.",
        });
        // If the verifier WERE called, it would merge. Set response
        // to confirm — the assertion is that we DON'T see a merge.
        model.response = JSON.stringify({
            same: true,
            canonical_slug: "b-page",
            old_name: "A Page",
            confidence: "high",
            reasoning: "should-not-be-asked.",
        });
        const ar = emptyAnalysisResult(candidate(["memory/2026-04-02.md"]));
        ar.wikiOps.push({
            op: "update",
            slug: "b-page",
            appendBody: "More.",
            source: "memory/2026-04-02.md",
        });
        await engine.writeResults([ar], 1);
        const a = await wiki.read("a-page");
        const b = await wiki.read("b-page");
        expect(a!.redirectTo).toBeUndefined();
        expect(b!.redirectTo).toBeUndefined();
    });
});
