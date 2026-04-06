import { describe, it, expect } from "vitest";
import {
    parseCatalogEntry,
    scoreCatalogEntry,
    matchCatalog,
} from "../src/catalog.js";

describe("parseCatalogEntry", () => {
    it("parses valid frontmatter", () => {
        const content =
            "---\nname: Auth rewrite\ndescription: Legal compliance\ntype: project\n---\n\nBody text";
        const entry = parseCatalogEntry("project_auth.md", content);
        expect(entry).not.toBeNull();
        expect(entry!.name).toBe("Auth rewrite");
        expect(entry!.type).toBe("project");
    });

    it("returns null for missing name", () => {
        const content = "---\ntype: project\n---\n\nBody";
        expect(parseCatalogEntry("test.md", content)).toBeNull();
    });

    it("returns null for missing type", () => {
        const content = "---\nname: Test\n---\n\nBody";
        expect(parseCatalogEntry("test.md", content)).toBeNull();
    });

    it("returns null for invalid frontmatter", () => {
        expect(parseCatalogEntry("test.md", "No frontmatter")).toBeNull();
    });
});

describe("scoreCatalogEntry", () => {
    const entry = {
        uri: "test.md",
        name: "database migration strategy",
        description: "decided to use SQLite for storage",
        type: "project",
        metadata: { contentType: "typed_memory" as const },
    };

    it("scores matching terms", () => {
        expect(scoreCatalogEntry(entry, "database migration")).toBeGreaterThan(
            0,
        );
    });

    it("returns 0 for no overlap", () => {
        expect(scoreCatalogEntry(entry, "authentication oauth")).toBe(0);
    });

    it("scores higher for more keyword overlap", () => {
        const oneMatch = scoreCatalogEntry(entry, "database authentication");
        const twoMatch = scoreCatalogEntry(entry, "database migration");
        expect(twoMatch).toBeGreaterThan(oneMatch);
    });
});

describe("matchCatalog", () => {
    const entries = [
        {
            uri: "project_db.md",
            name: "database migration",
            description: "SQLite backend decision",
            type: "project",
            metadata: { contentType: "typed_memory" as const },
        },
        {
            uri: "feedback_testing.md",
            name: "testing approach",
            description: "Use integration tests, not mocks",
            type: "feedback",
            metadata: { contentType: "typed_memory" as const },
        },
    ];

    it("returns matching entries sorted by score", () => {
        const results = matchCatalog(entries, "database migration");
        expect(results).toHaveLength(1);
        expect(results[0].uri).toBe("project_db.md");
    });

    it("respects maxResults", () => {
        const results = matchCatalog(entries, "database testing", 1);
        expect(results).toHaveLength(1);
    });

    it("returns empty for no matches", () => {
        const results = matchCatalog(entries, "authentication oauth");
        expect(results).toHaveLength(0);
    });
});
