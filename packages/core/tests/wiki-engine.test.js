import { describe, it, expect } from "vitest";
import * as path from "path";
import { WikiEngine, parseWikiPage, serializeWikiPage, parseWikiLinks, validateSlug, } from "../src/wiki-engine.js";
import { renderStubBody, isStubbable } from "../src/wiki-templates.js";
import { isStub } from "../src/wiki-types.js";
import { VirtualFileStorage } from "../src/defaults/virtual-file-storage.js";
function makeEngine(opts) {
    const storage = new VirtualFileStorage();
    const engine = new WikiEngine("/root", storage, {
        enabled: opts?.enabled ?? true,
        shared: opts?.shared,
    });
    return { storage, engine };
}
describe("validateSlug", () => {
    it("accepts kebab-case ASCII slugs", () => {
        expect(() => validateSlug("auth-middleware")).not.toThrow();
        expect(() => validateSlug("postgres")).not.toThrow();
        expect(() => validateSlug("two-phase-search")).not.toThrow();
    });
    it("rejects empty / non-string slugs", () => {
        expect(() => validateSlug("")).toThrow();
        // @ts-expect-error testing runtime guard
        expect(() => validateSlug(undefined)).toThrow();
    });
    it("rejects reserved slug `index`", () => {
        expect(() => validateSlug("index")).toThrow(/reserved/);
    });
    it("rejects uppercase, underscores, spaces, and slashes", () => {
        expect(() => validateSlug("Auth")).toThrow();
        expect(() => validateSlug("auth_middleware")).toThrow();
        expect(() => validateSlug("auth middleware")).toThrow();
        expect(() => validateSlug("auth/middle")).toThrow();
    });
});
describe("renderStubBody", () => {
    it("renders concept stubs with **Why:** and **How to apply:**", () => {
        const body = renderStubBody("concept", {
            lede: "Don't mock the database in integration tests.",
            why: "Mocked tests masked a broken migration last quarter.",
            howToApply: "Hit a real database in any test that exercises a query path.",
        });
        expect(body).toContain("Don't mock the database");
        expect(body).toContain("**Why:**");
        expect(body).toContain("**How to apply:**");
    });
    it("renders project stubs with **Why:** and **How to apply:**", () => {
        const body = renderStubBody("project", {
            lede: "Auth middleware is migrating from cookies to JWT.",
            why: "Compliance review flagged the cookie storage scheme.",
            howToApply: "When touching auth code, prefer the JWT path; cookies are deprecated.",
        });
        expect(body).toContain("**Why:**");
        expect(body).toContain("**How to apply:**");
    });
    it("requires why + howToApply for concept stubs", () => {
        expect(() => renderStubBody("concept", { lede: "Just a rule" })).toThrow(/concept/i);
    });
    it("requires why + howToApply for project stubs", () => {
        expect(() => renderStubBody("project", { lede: "Just a fact" })).toThrow(/project/i);
    });
    it("renders entity stubs from a single lede paragraph", () => {
        const body = renderStubBody("entity", {
            lede: "Stripe is the payments processor; webhook integration in services/billing.",
        });
        expect(body).toContain("Stripe is the payments processor");
        expect(body).not.toContain("**Why:**");
    });
    it("renders reference stubs with where/when sections", () => {
        const body = renderStubBody("reference", {
            lede: "Grafana API latency dashboard.",
            where: "https://grafana.internal/d/api-latency",
            when: "Editing request-path code or investigating regressions.",
        });
        expect(body).toContain("## Where to find it");
        expect(body).toContain("## When to use it");
        expect(body).toContain("grafana.internal");
    });
    it("rejects theme stubs (synthesis-only)", () => {
        expect(() => renderStubBody("theme", { lede: "Recurring topic" })).toThrow(/theme/i);
    });
    it("isStubbable rejects theme", () => {
        expect(isStubbable("theme")).toBe(false);
        expect(isStubbable("concept")).toBe(true);
    });
});
describe("parseWikiLinks", () => {
    it("extracts bare [[slug]] references", () => {
        const links = parseWikiLinks("See [[auth-middleware]] and [[compliance-review]].");
        expect(links).toHaveLength(2);
        expect(links[0].slug).toBe("auth-middleware");
        expect(links[0].target).toBeNull();
        expect(links[1].slug).toBe("compliance-review");
    });
    it("extracts qualified [[name:slug]] references", () => {
        const links = parseWikiLinks("From [[team-wiki:auth-middleware]].");
        expect(links).toHaveLength(1);
        expect(links[0].target).toBe("team-wiki");
        expect(links[0].slug).toBe("auth-middleware");
    });
    it("extracts pipe-display syntax [[slug|text]]", () => {
        const links = parseWikiLinks("See [[compliance-review|the legal review]].");
        expect(links).toHaveLength(1);
        expect(links[0].slug).toBe("compliance-review");
        expect(links[0].display).toBe("the legal review");
    });
    it("ignores invalid slugs", () => {
        const links = parseWikiLinks("[[Invalid Slug]] [[has_underscores]]");
        expect(links).toHaveLength(0);
    });
    it("records correct start/end offsets", () => {
        const text = "ab [[foo]] cd";
        const links = parseWikiLinks(text);
        expect(links).toHaveLength(1);
        expect(text.slice(links[0].start, links[0].end)).toBe("[[foo]]");
    });
    it("WikiEngine.resolveLink resolves bare links to source target", () => {
        const links = parseWikiLinks("[[bar]]");
        const resolved = WikiEngine.resolveLink(links[0], "private");
        expect(resolved).toEqual({ target: "private", slug: "bar" });
    });
    it("WikiEngine.resolveLink rejects [[private:...]] from shared pages", () => {
        const links = parseWikiLinks("[[private:foo]]");
        expect(() => WikiEngine.resolveLink(links[0], "team-wiki")).toThrow(/private/);
    });
});
describe("WikiEngine — read/write/list", () => {
    it("returns null for a missing page", async () => {
        const { engine } = makeEngine();
        await engine.initialize();
        expect(await engine.read("auth-middleware")).toBeNull();
    });
    it("writes and reads a page round-trip", async () => {
        const { engine } = makeEngine();
        await engine.initialize();
        await engine.write({
            slug: "auth-middleware",
            name: "Auth Middleware",
            description: "JWT migration",
            category: "project",
            created: "2026-04-01",
            updated: "2026-04-15",
            sources: ["memory/2026-04-01.md", "memory/2026-04-15.md"],
            related: ["compliance-review"],
            confidence: "medium",
            body: "Body content here.\n",
        });
        const page = await engine.read("auth-middleware");
        expect(page).not.toBeNull();
        expect(page.name).toBe("Auth Middleware");
        expect(page.category).toBe("project");
        expect(page.sources).toEqual([
            "memory/2026-04-01.md",
            "memory/2026-04-15.md",
        ]);
        expect(page.related).toEqual(["compliance-review"]);
        expect(page.confidence).toBe("medium");
        expect(page.body.trim()).toBe("Body content here.");
    });
    it("rejects writes to non-private targets when reader role", async () => {
        const { engine } = makeEngine({
            shared: [
                {
                    name: "org-glossary",
                    path: "/shared/org",
                    role: "reader",
                },
            ],
        });
        await engine.initialize();
        await expect(engine.write({
            slug: "stripe",
            name: "Stripe",
            description: "Payments processor",
            category: "entity",
            created: "2026-04-01",
            updated: "2026-04-01",
            sources: ["memory/2026-04-01.md"],
            related: [],
            body: "Stripe.\n",
        }, "org-glossary")).rejects.toThrow(/read-only/);
    });
    it("lists slugs sorted, excluding index.md", async () => {
        const { engine } = makeEngine();
        await engine.initialize();
        for (const slug of ["zeta", "alpha", "beta"]) {
            await engine.write({
                slug,
                name: slug,
                description: "x",
                category: "entity",
                created: "2026-04-01",
                updated: "2026-04-01",
                sources: ["memory/2026-04-01.md"],
                related: [],
                body: "body\n",
            });
        }
        await engine.rebuildIndex();
        const slugs = await engine.list();
        expect(slugs).toEqual(["alpha", "beta", "zeta"]);
    });
    it("targets() includes private + shared names", () => {
        const { engine } = makeEngine({
            shared: [
                { name: "team", path: "/x", role: "member" },
                { name: "org", path: "/y", role: "reader" },
            ],
        });
        expect(engine.targets()).toEqual(["private", "team", "org"]);
    });
    it("rejects shared wiki named `private` and duplicates", () => {
        expect(() => new WikiEngine("/root", new VirtualFileStorage(), {
            enabled: true,
            shared: [{ name: "private", path: "/x", role: "member" }],
        })).toThrow(/reserved/);
        expect(() => new WikiEngine("/root", new VirtualFileStorage(), {
            enabled: true,
            shared: [
                { name: "team", path: "/x", role: "member" },
                { name: "team", path: "/y", role: "reader" },
            ],
        })).toThrow(/[Dd]uplicate/);
    });
    it("rejects unknown target on read", async () => {
        const { engine } = makeEngine();
        await engine.initialize();
        await expect(engine.read("foo", "missing")).rejects.toThrow(/Unknown wiki target/);
    });
});
describe("WikiEngine — stub", () => {
    it("creates a stub from the concept template", async () => {
        const { engine } = makeEngine();
        await engine.initialize();
        const body = renderStubBody("concept", {
            lede: "Don't mock the DB.",
            why: "Mocked tests hid a broken migration.",
            howToApply: "Use a real DB in integration tests.",
        });
        const page = await engine.stub({
            slug: "database-mocks",
            name: "Database Mocks",
            description: "Don't mock the database in integration tests.",
            category: "concept",
            source: "memory/2026-04-26.md",
            body,
        });
        expect(page.confidence).toBe("low");
        expect(page.sources).toEqual(["memory/2026-04-26.md"]);
        expect(isStub(page)).toBe(true);
        expect(page.body).toContain("**Why:**");
    });
    it("refuses to stub when the slug already exists", async () => {
        const { engine } = makeEngine();
        await engine.initialize();
        await engine.stub({
            slug: "stripe",
            name: "Stripe",
            description: "Payments processor",
            category: "entity",
            source: "memory/2026-04-01.md",
            body: "Stripe.\n",
        });
        await expect(engine.stub({
            slug: "stripe",
            name: "Stripe",
            description: "Payments processor",
            category: "entity",
            source: "memory/2026-04-02.md",
            body: "Stripe again.\n",
        })).rejects.toThrow(/already exists/);
    });
    it("refuses to stub theme pages", async () => {
        const { engine } = makeEngine();
        await engine.initialize();
        await expect(engine.stub({
            slug: "test-reliability",
            name: "Test reliability",
            description: "Recurring topic",
            category: "theme",
            source: "memory/2026-04-01.md",
            body: "x\n",
        })).rejects.toThrow(/synthesis-only/);
    });
});
describe("WikiEngine — append", () => {
    it("appends a source and advances `updated`", async () => {
        const { engine } = makeEngine();
        await engine.initialize();
        await engine.stub({
            slug: "auth-middleware",
            name: "Auth Middleware",
            description: "JWT migration",
            category: "project",
            source: "memory/2026-04-01.md",
            body: "Phase 1: cookies.\n",
        });
        const updated = await engine.append("auth-middleware", "memory/2026-04-15.md", "Phase 2: JWT migration begins.");
        expect(updated.sources).toEqual([
            "memory/2026-04-01.md",
            "memory/2026-04-15.md",
        ]);
        expect(updated.body).toContain("Phase 2");
    });
    it("does not duplicate an existing source", async () => {
        const { engine } = makeEngine();
        await engine.initialize();
        await engine.stub({
            slug: "x",
            name: "X",
            description: "y",
            category: "entity",
            source: "memory/2026-04-01.md",
            body: "body\n",
        });
        const updated = await engine.append("x", "memory/2026-04-01.md", "more");
        expect(updated.sources).toEqual(["memory/2026-04-01.md"]);
    });
    it("throws when the page does not exist", async () => {
        const { engine } = makeEngine();
        await engine.initialize();
        await expect(engine.append("missing", "memory/x.md", "fragment")).rejects.toThrow(/does not exist/);
    });
});
describe("WikiEngine — listAll + rebuildIndex", () => {
    it("listAll merges private + shared targets", async () => {
        const { engine } = makeEngine({
            shared: [{ name: "team", path: "/team", role: "member" }],
        });
        await engine.initialize();
        await engine.stub({
            slug: "private-page",
            name: "p",
            description: "x",
            category: "entity",
            source: "memory/2026-04-01.md",
            body: "p\n",
        });
        await engine.stub({
            slug: "team-page",
            name: "t",
            description: "y",
            category: "entity",
            source: "memory/2026-04-01.md",
            body: "t\n",
            target: "team",
        });
        const all = await engine.listAll();
        expect(all).toEqual([
            { target: "private", slug: "private-page" },
            { target: "team", slug: "team-page" },
        ]);
    });
    it("rebuildIndex writes a categorized index.md", async () => {
        const { engine, storage } = makeEngine();
        await engine.initialize();
        await engine.stub({
            slug: "stripe",
            name: "Stripe",
            description: "Payments",
            category: "entity",
            source: "memory/2026-04-01.md",
            body: "x\n",
        });
        await engine.stub({
            slug: "auth-middleware",
            name: "Auth",
            description: "JWT migration",
            category: "project",
            source: "memory/2026-04-01.md",
            body: "x\n",
        });
        await engine.rebuildIndex();
        const indexPath = path.join("/root", "memory", "wiki", "index.md");
        const buf = await storage.readFile(indexPath);
        const index = buf.toString("utf-8");
        expect(index).toContain("# Wiki Index");
        expect(index).toContain("## Entities (1)");
        expect(index).toContain("## Projects (1)");
        expect(index).toContain("[[stripe]]");
        expect(index).toContain("[[auth-middleware]]");
        expect(index).toContain("Recent Updates");
    });
});
describe("parseWikiPage / serializeWikiPage", () => {
    it("round-trips a page through serialize -> parse", () => {
        const original = {
            slug: "auth-middleware",
            name: "Auth Middleware",
            description: "JWT migration",
            category: "project",
            created: "2026-02-15",
            updated: "2026-04-26",
            sources: ["memory/2026-02-15.md", "memory/2026-04-26.md"],
            related: ["compliance-review"],
            confidence: "high",
            contradicts: ["legacy-auth"],
            body: "Body text.\n",
        };
        const serialized = serializeWikiPage(original);
        const parsed = parseWikiPage(serialized, "auth-middleware");
        expect(parsed.slug).toBe(original.slug);
        expect(parsed.name).toBe(original.name);
        expect(parsed.category).toBe(original.category);
        expect(parsed.sources).toEqual(original.sources);
        expect(parsed.related).toEqual(original.related);
        expect(parsed.confidence).toBe(original.confidence);
        expect(parsed.contradicts).toEqual(original.contradicts);
        expect(parsed.body.trim()).toBe(original.body.trim());
    });
    it("throws when category is missing", () => {
        const content = "---\nname: x\ndescription: y\nslug: z\nsources: []\n---\n\nbody";
        expect(() => parseWikiPage(content, "z")).toThrow(/category/);
    });
});
//# sourceMappingURL=wiki-engine.test.js.map