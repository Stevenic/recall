import { describe, it, expect, beforeEach } from "vitest";
import * as path from "path";
import { WikiEngine } from "../src/wiki-engine.js";
import { VirtualFileStorage } from "../src/defaults/virtual-file-storage.js";
import type { MemoryModel, CompleteOptions, CompletionResult } from "../src/interfaces/model.js";
import type { WikiPage } from "../src/wiki-types.js";

// Paths the engine produces internally go through Node's `path.join`. On
// Windows the resulting `\`-separated keys normalize differently in vectra
// than `/`-separated literals do, so when tests write files directly into
// storage they MUST do so via `path.join("/root", ...)` to land at the same
// key the engine reads back. Use this helper everywhere we go around the
// engine API to plant test fixtures.
const ROOT = "/root";
const p = (...parts: string[]) => path.join(ROOT, ...parts);

async function setup(opts?: {
    model?: MemoryModel;
    shared?: { name: string; path: string; role: "member" | "reader" }[];
    stalenessThresholdDays?: number;
}): Promise<{ storage: VirtualFileStorage; engine: WikiEngine }> {
    const storage = new VirtualFileStorage();
    const engine = new WikiEngine(
        "/root",
        storage,
        {
            enabled: true,
            shared: opts?.shared,
            ...(opts?.stalenessThresholdDays !== undefined
                ? { stalenessThresholdDays: opts.stalenessThresholdDays }
                : {}),
        },
        opts?.model ? { model: opts.model } : undefined,
    );
    // initialize() creates the wiki dir entries the storage layer needs for
    // list()/pathExists() to find pages. Without it, list() short-circuits
    // even when files have been written.
    await engine.initialize();
    return { storage, engine };
}

async function makePage(
    engine: WikiEngine,
    slug: string,
    body: string,
    overrides: Partial<WikiPage> = {},
): Promise<void> {
    const page: WikiPage = {
        slug,
        name: overrides.name ?? slug,
        description: overrides.description ?? `Page about ${slug}.`,
        category: overrides.category ?? "concept",
        created: overrides.created ?? "2026-04-01",
        updated: overrides.updated ?? "2026-04-01",
        sources: overrides.sources ?? [`memory/2026-04-01.md`],
        related: overrides.related ?? [],
        body,
        ...overrides,
    };
    await engine.write(page);
}

describe("WikiEngine.lint", () => {
    let storage: VirtualFileStorage;
    let engine: WikiEngine;

    beforeEach(async () => {
        ({ storage, engine } = await setup());
    });

    it("flags broken [[links]]", async () => {
        await makePage(engine, "auth", "See [[postgres-migration]] for context.");
        const report = await engine.lint();
        expect(report.brokenLinks).toHaveLength(1);
        expect(report.brokenLinks[0]).toMatchObject({
            from: "private:auth",
            toSlug: "postgres-migration",
            target: "private",
        });
    });

    it("does not flag a resolved link", async () => {
        await makePage(engine, "auth", "See [[postgres]] for context.");
        await makePage(engine, "postgres", "Database choice.");
        const report = await engine.lint();
        expect(report.brokenLinks).toHaveLength(0);
    });

    it("flags orphans (no inbound links)", async () => {
        await makePage(engine, "auth", "Standalone page.");
        await makePage(engine, "postgres", "Another standalone.");
        const report = await engine.lint();
        // Both pages are orphans — no one links to them.
        expect(report.orphans.sort()).toEqual(["private:auth", "private:postgres"]);
    });

    it("does not flag pages linked from another page's body", async () => {
        await makePage(engine, "auth", "See [[postgres]].");
        await makePage(engine, "postgres", "Database choice.");
        const report = await engine.lint();
        // postgres has an inbound link from auth.
        expect(report.orphans).not.toContain("private:postgres");
    });

    it("does not flag pages linked via related[]", async () => {
        await makePage(engine, "auth", "Standalone.", { related: ["postgres"] });
        await makePage(engine, "postgres", "Database choice.");
        const report = await engine.lint();
        expect(report.orphans).not.toContain("private:postgres");
    });

    it("does not flag redirects as orphans", async () => {
        await makePage(engine, "old-slug", "Body", {
            redirectTo: "new-slug",
        });
        await makePage(engine, "new-slug", "Body");
        const report = await engine.lint();
        expect(report.orphans).not.toContain("private:old-slug");
    });

    it("flags stale pages (older than stalenessThresholdDays)", async () => {
        const veryOld = "2024-01-01";
        ({ storage, engine } = await setup({ stalenessThresholdDays: 30 }));
        await makePage(engine, "ancient", "Old body.", {
            updated: veryOld,
            created: veryOld,
        });
        const report = await engine.lint();
        expect(report.stalePages.length).toBeGreaterThan(0);
        expect(report.stalePages[0].slug).toBe("private:ancient");
    });

    it("detects slug drift between filename and frontmatter slug", async () => {
        // Write a file at `auth.md` whose frontmatter declares slug `postgres`.
        await storage.upsertFile(
            p("memory", "wiki", "auth.md"),
            "---\nname: drift\ndescription: drift\ncategory: concept\nslug: postgres\nsources:\n  - memory/2026-04-01.md\n---\nbody\n",
        );
        const report = await engine.lint();
        expect(report.slugDrift.length).toBe(1);
        expect(report.slugDrift[0]).toMatchObject({
            file: "auth.md",
            declaredSlug: "postgres",
        });
    });

    it("detects contradiction loops (A.contradicts ↔ B.contradicts)", async () => {
        await makePage(engine, "a", "From A.", { contradicts: ["b"] });
        await makePage(engine, "b", "From B.", { contradicts: ["a"] });
        const report = await engine.lint();
        expect(report.contradictionLoops).toHaveLength(1);
        const [a, b] = report.contradictionLoops[0];
        expect([a, b].sort()).toEqual(["private:a", "private:b"]);
    });

    it("flags qualified [[unknown:slug]] references to unconfigured wikis", async () => {
        await makePage(engine, "auth", "See [[engineering:postgres]].");
        const report = await engine.lint();
        expect(report.unknownTargets).toHaveLength(1);
        expect(report.unknownTargets[0]).toMatchObject({
            from: "private:auth",
            targetName: "engineering",
        });
    });

    it("populates scanned counts per target", async () => {
        await makePage(engine, "a", "body");
        await makePage(engine, "b", "body");
        const report = await engine.lint();
        expect(report.scanned).toEqual({ private: 2 });
    });
});

describe("WikiEngine.merge", () => {
    let engine: WikiEngine;

    beforeEach(async () => {
        ({ engine } = await setup());
    });

    it("merges src body into dst and leaves a redirect at src", async () => {
        await makePage(engine, "src", "Source body content.", {
            sources: ["memory/2026-04-01.md"],
        });
        await makePage(engine, "dst", "Destination body.", {
            sources: ["memory/2026-04-02.md"],
        });

        await engine.merge("src", "dst");

        const dst = await engine.read("dst");
        expect(dst).not.toBeNull();
        expect(dst!.body).toContain("Destination body");
        expect(dst!.body).toContain("Source body content");
        expect(dst!.body).toContain("merged from `src`");
        expect(dst!.sources.sort()).toEqual([
            "memory/2026-04-01.md",
            "memory/2026-04-02.md",
        ]);

        const src = await engine.read("src");
        expect(src).not.toBeNull();
        expect(src!.redirectTo).toBe("dst");
        expect(src!.body).toContain("[[dst]]");
    });

    it("refuses to merge a page into itself", async () => {
        await makePage(engine, "x", "body");
        await expect(engine.merge("x", "x")).rejects.toThrow(/identical/);
    });

    it("refuses to merge when dst doesn't exist", async () => {
        await makePage(engine, "src", "body");
        await expect(engine.merge("src", "missing")).rejects.toThrow(
            /does not exist/,
        );
    });

    it("dedupes source URIs when merging", async () => {
        const shared = "memory/2026-04-01.md";
        await makePage(engine, "src", "S", { sources: [shared, "memory/2026-04-03.md"] });
        await makePage(engine, "dst", "D", { sources: [shared, "memory/2026-04-02.md"] });
        await engine.merge("src", "dst");
        const dst = await engine.read("dst");
        expect(dst!.sources.filter((s) => s === shared)).toHaveLength(1);
        expect(dst!.sources).toContain("memory/2026-04-02.md");
        expect(dst!.sources).toContain("memory/2026-04-03.md");
    });
});

describe("WikiEngine.rename", () => {
    let engine: WikiEngine;

    beforeEach(async () => {
        ({ engine } = await setup());
    });

    it("renames a page and leaves a redirect", async () => {
        await makePage(engine, "old", "body");
        await engine.rename("old", "new");

        const renamed = await engine.read("new");
        expect(renamed).not.toBeNull();
        expect(renamed!.slug).toBe("new");

        const redirect = await engine.read("old");
        expect(redirect).not.toBeNull();
        expect(redirect!.redirectTo).toBe("new");
    });

    it("refuses to rename onto an existing slug", async () => {
        await makePage(engine, "old", "body");
        await makePage(engine, "occupied", "body");
        await expect(engine.rename("old", "occupied")).rejects.toThrow(
            /already exists/,
        );
    });

    it("refuses to rename to the same slug", async () => {
        await makePage(engine, "x", "body");
        await expect(engine.rename("x", "x")).rejects.toThrow(/identical/);
    });
});

describe("WikiEngine.rebuild", () => {
    class StubModel implements MemoryModel {
        public lastPrompt = "";
        public lastSystem = "";
        public response = "## Rebuilt\n\nFresh synthesized content.";
        async complete(prompt: string, options?: CompleteOptions): Promise<CompletionResult> {
            this.lastPrompt = prompt;
            this.lastSystem = options?.systemPrompt ?? "";
            return { text: this.response };
        }
    }

    let storage: VirtualFileStorage;
    let engine: WikiEngine;
    let model: StubModel;

    beforeEach(async () => {
        model = new StubModel();
        ({ storage, engine } = await setup({ model }));
        // Plant two source files that the page references.
        await storage.upsertFile(
            p("memory", "2026-04-01.md"),
            "# Day 1\nDiscussed Postgres vs Memcached. Chose Postgres.",
        );
        await storage.upsertFile(
            p("memory", "2026-04-02.md"),
            "# Day 2\nFollowed up on Postgres setup; team confirmed.",
        );
    });

    it("rebuilds a multi-source page from its sources", async () => {
        await makePage(engine, "postgres-decision", "Old body to be replaced.", {
            sources: ["memory/2026-04-01.md", "memory/2026-04-02.md"],
        });
        const page = await engine.rebuild("postgres-decision");
        expect(page.body.trim()).toContain("Rebuilt");
        // The prompt includes both source contents.
        expect(model.lastPrompt).toContain("Discussed Postgres");
        expect(model.lastPrompt).toContain("Followed up on Postgres");
    });

    it("includes the page's existing context in the prompt", async () => {
        await makePage(engine, "postgres-decision", "Prior body.", {
            sources: ["memory/2026-04-01.md", "memory/2026-04-02.md"],
            related: ["postgres-migration"],
        });
        await engine.rebuild("postgres-decision");
        expect(model.lastPrompt).toContain("Prior body");
        expect(model.lastPrompt).toContain("[[postgres-migration]]");
    });

    it("strips code-fence wrapping from the model response", async () => {
        model.response = "```markdown\n## Rebuilt\n\nFresh content.\n```";
        await makePage(engine, "postgres-decision", "Old body.", {
            sources: ["memory/2026-04-01.md", "memory/2026-04-02.md"],
        });
        const page = await engine.rebuild("postgres-decision");
        expect(page.body).not.toContain("```");
        expect(page.body).toContain("## Rebuilt");
    });

    it("throws when no model was injected", async () => {
        const noModel = await setup({});
        await makePage(noModel.engine, "x", "body", {
            sources: ["memory/2026-04-01.md"],
        });
        await expect(noModel.engine.rebuild("x")).rejects.toThrow(/requires a model/);
    });

    it("throws when sources can't be read", async () => {
        await makePage(engine, "ghost", "body", {
            sources: ["memory/does-not-exist.md"],
        });
        await expect(engine.rebuild("ghost")).rejects.toThrow(/could be read/);
    });

    it("throws when the model returns an empty body", async () => {
        model.response = "   \n   ";
        await makePage(engine, "x", "body", {
            sources: ["memory/2026-04-01.md", "memory/2026-04-02.md"],
        });
        await expect(engine.rebuild("x")).rejects.toThrow(/empty body/);
    });
});

describe("WikiEngine.rebuildAll", () => {
    class StubModel implements MemoryModel {
        public calls = 0;
        async complete(): Promise<CompletionResult> {
            this.calls++;
            return { text: "## Rebuilt\n\nNew content." };
        }
    }

    let storage: VirtualFileStorage;
    let engine: WikiEngine;
    let model: StubModel;

    beforeEach(async () => {
        model = new StubModel();
        ({ storage, engine } = await setup({ model }));
        await storage.upsertFile(p("memory", "2026-04-01.md"), "src content 1");
        await storage.upsertFile(p("memory", "2026-04-02.md"), "src content 2");
    });

    it("rebuilds multi-source pages and skips stubs and redirects", async () => {
        await makePage(engine, "stub", "body", {
            sources: ["memory/2026-04-01.md"],
        });
        await makePage(engine, "multi", "body", {
            sources: ["memory/2026-04-01.md", "memory/2026-04-02.md"],
        });
        await makePage(engine, "redirect", "body", {
            sources: ["memory/2026-04-01.md", "memory/2026-04-02.md"],
            redirectTo: "multi",
        });

        const report = await engine.rebuildAll();
        expect(report.rebuilt).toEqual(["multi"]);
        expect(report.skipped.sort()).toEqual(["redirect", "stub"]);
        expect(report.failed).toEqual([]);
        expect(model.calls).toBe(1);
    });
});
