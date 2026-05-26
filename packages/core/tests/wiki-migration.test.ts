import { describe, it, expect, beforeEach } from "vitest";
import * as path from "path";
import { WikiEngine } from "../src/wiki-engine.js";
import { VirtualFileStorage } from "../src/defaults/virtual-file-storage.js";

const ROOT = "/root";
const p = (...parts: string[]) => path.join(ROOT, ...parts);

async function setup() {
    const storage = new VirtualFileStorage();
    const engine = new WikiEngine(ROOT, storage, { enabled: true });
    await engine.initialize();
    return { storage, engine };
}

describe("WikiEngine.migrateTypedMemories", () => {
    let storage: VirtualFileStorage;
    let engine: WikiEngine;

    beforeEach(async () => {
        ({ storage, engine } = await setup());
    });

    it("maps user_* → entity, feedback_* → concept, project_* → project, reference_* → reference", async () => {
        await storage.upsertFile(
            p("memory", "user_jordan.md"),
            "---\nname: Jordan\ndescription: The principal Jordan supports.\n---\n\nJordan is the executive Jamie supports day-to-day.\n",
        );
        await storage.upsertFile(
            p("memory", "feedback_testing.md"),
            "---\nname: Don't mock the database\ndescription: Integration tests must hit a real DB.\n---\n\nMock-vs-prod divergence masked a broken migration last quarter.\n\n**Why:** Real bug.\n\n**How to apply:** Always real DB in integration tests.\n",
        );
        await storage.upsertFile(
            p("memory", "project_auth-migration.md"),
            "---\nname: Auth migration\ndescription: Cookies to JWT.\n---\n\nDriven by compliance review.\n\n**Why:** Legal flag.\n\n**How to apply:** Prefer JWT path.\n",
        );
        await storage.upsertFile(
            p("memory", "reference_grafana.md"),
            "---\nname: Grafana dashboard\ndescription: API latency.\n---\n\nhttps://grafana.internal/d/api-latency\n",
        );

        const report = await engine.migrateTypedMemories();
        expect(Object.keys(report.migrated).sort()).toEqual([
            "feedback_testing.md",
            "project_auth-migration.md",
            "reference_grafana.md",
            "user_jordan.md",
        ]);
        expect(report.failed).toEqual([]);

        const jordan = await engine.read("jordan");
        expect(jordan!.category).toBe("entity");
        expect(jordan!.name).toBe("Jordan");

        const testing = await engine.read("testing");
        expect(testing!.category).toBe("concept");
        expect(testing!.body).toContain("**Why:**");

        const project = await engine.read("auth-migration");
        expect(project!.category).toBe("project");

        const reference = await engine.read("grafana");
        expect(reference!.category).toBe("reference");
    });

    it("archives originals (non-destructive) and removes them from memory/", async () => {
        await storage.upsertFile(
            p("memory", "user_jordan.md"),
            "---\nname: Jordan\ndescription: x\n---\n\nbody\n",
        );
        const report = await engine.migrateTypedMemories();
        const archived = await storage.pathExists(
            p("memory", ".archive", "typed-memories", "user_jordan.md"),
        );
        expect(archived).toBe(true);
        const original = await storage.pathExists(p("memory", "user_jordan.md"));
        expect(original).toBe(false);
        expect(report.archivePath).toContain(".archive");
    });

    it("is idempotent — re-running skips already-archived files", async () => {
        await storage.upsertFile(
            p("memory", "user_jordan.md"),
            "---\nname: Jordan\ndescription: x\n---\n\nbody\n",
        );
        const first = await engine.migrateTypedMemories();
        expect(Object.keys(first.migrated)).toEqual(["user_jordan.md"]);

        // Re-add the typed file (simulating someone resurrecting it). With the
        // archive in place, the second migration should treat it as
        // already-migrated rather than overwriting.
        await storage.upsertFile(
            p("memory", "user_jordan.md"),
            "---\nname: Jordan\ndescription: x\n---\n\nbody\n",
        );
        const second = await engine.migrateTypedMemories();
        expect(second.alreadyMigrated).toEqual(["user_jordan.md"]);
        expect(Object.keys(second.migrated)).toEqual([]);
    });

    it("resolves slug collisions by appending the category", async () => {
        // Pre-existing wiki page at slug `testing`.
        await engine.stub({
            slug: "testing",
            name: "Testing",
            description: "Pre-existing wiki entry.",
            category: "concept",
            source: "memory/2026-04-01.md",
            body: "Existing body.\n\n**Why:** w.\n\n**How to apply:** h.",
        });
        // A typed memory that would also slug to `testing`.
        await storage.upsertFile(
            p("memory", "project_testing.md"),
            "---\nname: Testing infra\ndescription: Test infrastructure project.\n---\n\nBody.\n",
        );
        const report = await engine.migrateTypedMemories();
        // Should rename to testing-project.
        expect(report.renamedOnCollision).toEqual({ testing: "testing-project" });
        expect(report.migrated).toEqual({ "project_testing.md": "testing-project" });

        const original = await engine.read("testing");
        expect(original!.description).toBe("Pre-existing wiki entry.");
        const renamed = await engine.read("testing-project");
        expect(renamed!.category).toBe("project");
    });

    it("extracts dated source URIs from the body when possible", async () => {
        await storage.upsertFile(
            p("memory", "feedback_redis.md"),
            "---\nname: Use Redis\ndescription: x\n---\n\nDecided on 2026-04-08 after reviewing the cache benchmark from 2026-03-15.\n",
        );
        const report = await engine.migrateTypedMemories();
        const page = await engine.read("redis");
        expect(report.migrated["feedback_redis.md"]).toBe("redis");
        expect(page!.sources.map((s) => s.uri)).toEqual([
            "memory/2026-04-08.md",
            "memory/2026-03-15.md",
        ]);
    });

    it("falls back to a migration:<date> source when no dates are findable", async () => {
        await storage.upsertFile(
            p("memory", "user_alice.md"),
            "---\nname: Alice\ndescription: x\n---\n\nAlice is the CFO.\n",
        );
        await engine.migrateTypedMemories();
        const page = await engine.read("alice");
        expect(page!.sources).toHaveLength(1);
        expect(page!.sources[0].uri).toMatch(/^migration:\d{4}-\d{2}-\d{2}:user_alice\.md$/);
    });

    it("ignores files that don't match the <type>_<topic>.md pattern", async () => {
        await storage.upsertFile(
            p("memory", "2026-04-01.md"),
            "daily log — should be left alone",
        );
        await storage.upsertFile(p("memory", "MEMORY.md"), "root note");
        const report = await engine.migrateTypedMemories();
        expect(report.migrated).toEqual({});
        // Daily log and MEMORY.md still in place.
        expect(await storage.pathExists(p("memory", "2026-04-01.md"))).toBe(true);
        expect(await storage.pathExists(p("memory", "MEMORY.md"))).toBe(true);
    });
});

describe("WikiEngine.rebuildKnowledgeMap", () => {
    let storage: VirtualFileStorage;
    let engine: WikiEngine;

    beforeEach(async () => {
        ({ storage, engine } = await setup());
    });

    it("writes a Knowledge Map section grouping by category", async () => {
        await engine.stub({
            slug: "auth-middleware",
            name: "Auth Middleware",
            description: "The auth layer.",
            category: "concept",
            source: "memory/2026-04-01.md",
            body: "Body.\n\n**Why:** w.\n\n**How to apply:** h.",
        });
        await engine.stub({
            slug: "ledger-refactor",
            name: "Ledger refactor",
            description: "Q2 effort.",
            category: "project",
            source: "memory/2026-04-01.md",
            body: "Body.\n\n**Why:** w.\n\n**How to apply:** h.",
        });
        await engine.rebuildKnowledgeMap();
        const wisdom = (await storage.readFile(p("WISDOM.md"))).toString("utf-8");
        expect(wisdom).toContain("## Knowledge Map");
        expect(wisdom).toContain("### Active Projects (1)");
        expect(wisdom).toContain("### Core Concepts (1)");
        expect(wisdom).toContain("[[auth-middleware]]");
        expect(wisdom).toContain("[[ledger-refactor]]");
    });

    it("replaces an existing Knowledge Map section in place", async () => {
        await storage.upsertFile(
            p("WISDOM.md"),
            "# Wisdom\n\n## Principles\n\n- Always validate.\n\n## Knowledge Map\n\nold content\n\n## Other Section\n\npreserved\n",
        );
        await engine.stub({
            slug: "auth-middleware",
            name: "Auth Middleware",
            description: "The auth layer.",
            category: "concept",
            source: "memory/2026-04-01.md",
            body: "Body.\n\n**Why:** w.\n\n**How to apply:** h.",
        });
        await engine.rebuildKnowledgeMap();
        const wisdom = (await storage.readFile(p("WISDOM.md"))).toString("utf-8");
        expect(wisdom).toContain("# Wisdom");
        expect(wisdom).toContain("## Principles");
        expect(wisdom).toContain("[[auth-middleware]]");
        expect(wisdom).toContain("## Other Section");
        expect(wisdom).toContain("preserved");
        expect(wisdom).not.toContain("old content");
    });

    it("returns updated: false when there are no wiki pages", async () => {
        const result = await engine.rebuildKnowledgeMap();
        expect(result.updated).toBe(false);
        expect(result.pages).toBe(0);
    });

    it("skips redirect pages from the Knowledge Map", async () => {
        await engine.stub({
            slug: "real",
            name: "Real",
            description: "The real page.",
            category: "concept",
            source: "memory/2026-04-01.md",
            body: "Body.\n\n**Why:** w.\n\n**How to apply:** h.",
        });
        await engine.rename("real", "renamed");
        await engine.rebuildKnowledgeMap();
        const wisdom = (await storage.readFile(p("WISDOM.md"))).toString("utf-8");
        expect(wisdom).toContain("[[renamed]]");
        // The redirect at `real` should NOT appear.
        expect(wisdom).not.toContain("[[real]]");
    });
});
