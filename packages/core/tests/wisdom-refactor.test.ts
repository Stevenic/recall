import { describe, it, expect, beforeEach } from "vitest";
import * as path from "path";
import { Compactor } from "../src/compactor.js";
import { MemoryFiles } from "../src/files.js";
import { WikiEngine } from "../src/wiki-engine.js";
import { VirtualFileStorage } from "../src/defaults/virtual-file-storage.js";
import type {
    MemoryModel,
    CompleteOptions,
    CompletionResult,
} from "../src/interfaces/model.js";

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

async function setup(opts?: { wikiEnabled?: boolean }) {
    const storage = new VirtualFileStorage();
    const files = new MemoryFiles(ROOT, storage);
    await files.initialize();
    const wiki = new WikiEngine(ROOT, storage, {
        enabled: opts?.wikiEnabled ?? true,
    });
    await wiki.initialize();
    const model = new StubModel();
    const compactor = new Compactor(files, {
        model,
        wiki: opts?.wikiEnabled === false ? undefined : wiki,
    });
    return { storage, files, wiki, model, compactor };
}

describe("Compactor.distillWisdom — wiki-aware path (§12 refactor)", () => {
    let storage: VirtualFileStorage;
    let model: StubModel;
    let compactor: Compactor;
    let wiki: WikiEngine;
    let files: MemoryFiles;

    beforeEach(async () => {
        ({ storage, model, compactor, wiki, files } = await setup());
        // Plant a monthly summary so distillWisdom has something to work with.
        await files.writeMonthly(
            "2026-04",
            "---\ntype: monthly\nperiod: 2026-04\n---\n\n# April\n\nSwitched the auth layer to JWT; team chose Postgres for the ledger.\n",
        );
    });

    it("emits the structured prompt when a wiki engine is wired", async () => {
        model.response = JSON.stringify({
            wisdom: "# Agent - Wisdom\n\n**Principle**\nKeep things small.\n",
            wiki_promotions: [],
        });
        await compactor.distillWisdom();
        // The structured system prompt is the distinguishing marker.
        expect(model.lastSystem).toContain("PRINCIPLES-ONLY");
        expect(model.lastSystem).toContain("wiki_promotions");
    });

    it("applies create-shaped wiki_promotions as new wiki pages", async () => {
        model.response = JSON.stringify({
            wisdom: "# Agent - Wisdom\n\n(principles only)\n",
            wiki_promotions: [
                {
                    slug: "ledger-storage",
                    category: "project",
                    name: "Ledger storage",
                    description: "Postgres-backed ledger; chosen for Q2.",
                    body: "Lede.\n\n**Why:** Throughput.\n\n**How to apply:** Use the new schema.",
                    sources: ["memory/2026-04-15.md", "memory/monthly/2026-04.md"],
                },
            ],
        });
        await compactor.distillWisdom();
        const page = await wiki.read("ledger-storage");
        expect(page).not.toBeNull();
        expect(page!.category).toBe("project");
        expect(page!.name).toBe("Ledger storage");
        expect(page!.sources).toContain("memory/2026-04-15.md");
        expect(page!.sources).toContain("memory/monthly/2026-04.md");
    });

    it("appends to existing pages when the promotion's slug already exists", async () => {
        await wiki.stub({
            slug: "ledger-storage",
            name: "Ledger storage",
            description: "Pre-existing context.",
            category: "project",
            source: "memory/2026-03-01.md",
            body: "Original.\n\n**Why:** w.\n\n**How to apply:** h.",
        });
        model.response = JSON.stringify({
            wisdom: "# Agent - Wisdom\n\n(principles only)\n",
            wiki_promotions: [
                {
                    slug: "ledger-storage",
                    category: "project",
                    name: "Ledger storage",
                    description: "Update from wisdom distillation.",
                    body: "April update: rolled out to prod.",
                    sources: ["memory/2026-04-15.md"],
                },
            ],
        });
        await compactor.distillWisdom();
        const page = await wiki.read("ledger-storage");
        expect(page!.body).toContain("Original");
        expect(page!.body).toContain("April update");
        expect(page!.sources).toContain("memory/2026-04-15.md");
    });

    it("writes WISDOM.md from the wisdom field and rebuilds the Knowledge Map", async () => {
        model.response = JSON.stringify({
            wisdom: "# Agent - Wisdom\n\n## Principles\n\n**Always validate inputs**\nValidate at boundaries.\n",
            wiki_promotions: [
                {
                    slug: "auth-system",
                    category: "concept",
                    name: "Auth system",
                    description: "JWT-based auth layer.",
                    body: "Body.\n\n**Why:** w.\n\n**How to apply:** h.",
                    sources: ["memory/2026-04-15.md"],
                },
            ],
        });
        await compactor.distillWisdom();
        const wisdom = (await storage.readFile(p("WISDOM.md"))).toString("utf-8");
        expect(wisdom).toContain("Always validate inputs");
        // Knowledge Map was rebuilt with the new wiki page.
        expect(wisdom).toContain("## Knowledge Map");
        expect(wisdom).toContain("[[auth-system]]");
    });

    it("reports promoted slugs in filesCreated", async () => {
        model.response = JSON.stringify({
            wisdom: "# Agent - Wisdom\n\n(principles)\n",
            wiki_promotions: [
                {
                    slug: "promo-a",
                    category: "concept",
                    name: "A",
                    description: "x",
                    body: "Body.\n\n**Why:** w.\n\n**How to apply:** h.",
                    sources: ["memory/2026-04-15.md"],
                },
                {
                    slug: "promo-b",
                    category: "concept",
                    name: "B",
                    description: "x",
                    body: "Body.\n\n**Why:** w.\n\n**How to apply:** h.",
                    sources: ["memory/2026-04-15.md"],
                },
            ],
        });
        const result = await compactor.distillWisdom();
        expect(result.filesCreated).toContain("WISDOM.md");
        expect(result.filesCreated).toContain("memory/wiki/promo-a.md");
        expect(result.filesCreated).toContain("memory/wiki/promo-b.md");
    });

    it("falls back to writing the raw text into WISDOM.md when the response isn't parseable JSON", async () => {
        // Non-JSON. The wiki-aware path should still produce a WISDOM.md
        // rather than failing silently.
        model.response =
            "# Agent - Wisdom\n\nMalformed JSON response but valid markdown.\n";
        const result = await compactor.distillWisdom();
        expect(result.filesCreated).toContain("WISDOM.md");
        const wisdom = (await storage.readFile(p("WISDOM.md"))).toString("utf-8");
        expect(wisdom).toContain("Malformed JSON response");
    });

    it("reads wiki pages as input alongside typed memories and monthly summary", async () => {
        // Plant an existing wiki page, a typed memory, and check the prompt
        // contains content from each input lane.
        await wiki.stub({
            slug: "existing-concept",
            name: "Existing concept",
            description: "Already a page.",
            category: "concept",
            source: "memory/2026-04-01.md",
            body: "Existing concept body.\n\n**Why:** w.\n\n**How to apply:** h.",
        });
        await files.writeTypedMemory(
            "feedback_legacy.md",
            "---\nname: Legacy feedback\ndescription: Legacy.\n---\n\nLegacy typed memory body.",
        );
        model.response = JSON.stringify({
            wisdom: "# Agent - Wisdom\n\n(principles)\n",
            wiki_promotions: [],
        });
        await compactor.distillWisdom();
        expect(model.lastPrompt).toContain("Existing concept body");
        expect(model.lastPrompt).toContain("Legacy typed memory body");
        expect(model.lastPrompt).toContain("Switched the auth layer to JWT");
    });

    it("skips redirect pages when assembling the wiki input", async () => {
        await wiki.stub({
            slug: "real",
            name: "Real",
            description: "Live.",
            category: "concept",
            source: "memory/2026-04-01.md",
            body: "Real body.\n\n**Why:** w.\n\n**How to apply:** h.",
        });
        await wiki.rename("real", "renamed");
        model.response = JSON.stringify({
            wisdom: "# Agent - Wisdom\n\n(principles)\n",
            wiki_promotions: [],
        });
        await compactor.distillWisdom();
        // The redirect's stub body shouldn't get fed back into the distiller.
        expect(model.lastPrompt).not.toContain("renamed on ");
        expect(model.lastPrompt).toContain("Real body");
    });

    it("rejects wiki_promotions with bad slugs or missing categories", async () => {
        model.response = JSON.stringify({
            wisdom: "# Agent - Wisdom\n\n(principles)\n",
            wiki_promotions: [
                { slug: "Bad Slug!", category: "concept", body: "x", sources: ["memory/2026-04-15.md"] },
                { slug: "no-category", category: "not-a-real-category", body: "x", sources: ["memory/2026-04-15.md"] },
                { slug: "no-sources", category: "concept", body: "x", sources: [] },
                {
                    slug: "valid-slug",
                    category: "concept",
                    name: "Valid",
                    description: "ok",
                    body: "Body.\n\n**Why:** w.\n\n**How to apply:** h.",
                    sources: ["memory/2026-04-15.md"],
                },
            ],
        });
        await compactor.distillWisdom();
        expect(await wiki.read("bad-slug")).toBeNull();
        expect(await wiki.read("no-category")).toBeNull();
        expect(await wiki.read("no-sources")).toBeNull();
        expect(await wiki.read("valid-slug")).not.toBeNull();
    });
});

describe("Compactor.distillWisdom — legacy path (wiki disabled)", () => {
    it("emits the markdown-only prompt and writes the response verbatim", async () => {
        const { storage, model, compactor, files } = await setup({
            wikiEnabled: false,
        });
        await files.writeMonthly(
            "2026-04",
            "---\ntype: monthly\nperiod: 2026-04\n---\n\n# April\n\nMonthly content.\n",
        );
        model.response = "# Agent - Wisdom\n\n**Be terse**\nKeep entries short.\n";
        await compactor.distillWisdom();
        // The legacy system prompt is identified by the OUTPUT_FORMAT block
        // emitting raw markdown rather than JSON.
        expect(model.lastSystem).not.toContain("wiki_promotions");
        expect(model.lastSystem).toContain("wisdom distillation engine");
        const wisdom = (await storage.readFile(p("WISDOM.md"))).toString("utf-8");
        expect(wisdom).toContain("Be terse");
        // No Knowledge Map should be appended in the legacy path.
        expect(wisdom).not.toContain("## Knowledge Map");
    });
});
