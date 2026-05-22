import { describe, it, expect, beforeEach, vi } from "vitest";
import * as path from "path";
import { IdentityLoader, parseIdentityMarkdown, formatIdentityFrame, } from "../src/identity.js";
import { VirtualFileStorage } from "../src/defaults/virtual-file-storage.js";
const ROOT = "/root";
const idPath = (relative = "IDENTITY.md") => path.join(ROOT, relative);
describe("parseIdentityMarkdown", () => {
    it("extracts name from H1 and role from body", () => {
        const raw = "# Beacon\n\nA software engineer focused on backend systems.\n";
        const { name, role } = parseIdentityMarkdown(raw);
        expect(name).toBe("Beacon");
        expect(role).toBe("A software engineer focused on backend systems.");
    });
    it("returns null name when H1 is missing", () => {
        const raw = "Just a role with no heading\n";
        const { name, role } = parseIdentityMarkdown(raw);
        expect(name).toBeNull();
        expect(role).toBe("Just a role with no heading");
    });
    it("ignores blank lines before the H1", () => {
        const raw = "\n\n# Scribe\n\nA project manager.\n";
        const { name, role } = parseIdentityMarkdown(raw);
        expect(name).toBe("Scribe");
        expect(role).toBe("A project manager.");
    });
    it("preserves multi-line role bodies", () => {
        const raw = "# Beacon\n\nLine one.\n\nLine two.\n";
        const { role } = parseIdentityMarkdown(raw);
        expect(role).toContain("Line one.");
        expect(role).toContain("Line two.");
    });
});
describe("IdentityLoader", () => {
    let storage;
    beforeEach(() => {
        storage = new VirtualFileStorage();
    });
    it("falls back to a generic role when IDENTITY.md is missing", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
        const loader = new IdentityLoader("/root", storage);
        const id = await loader.resolve();
        expect(id.fallback).toBe(true);
        expect(id.role).toBe("a knowledge-worker agent");
        expect(warn).toHaveBeenCalledOnce();
        warn.mockRestore();
    });
    it("emits the warning only once across multiple resolves", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
        const loader = new IdentityLoader("/root", storage);
        await loader.resolve();
        await loader.resolve();
        await loader.resolve();
        expect(warn).toHaveBeenCalledOnce();
        warn.mockRestore();
    });
    it("falls back when IDENTITY.md is empty", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
        await storage.upsertFile(idPath(), "   \n\n  \n");
        const loader = new IdentityLoader("/root", storage);
        const id = await loader.resolve();
        expect(id.fallback).toBe(true);
        warn.mockRestore();
    });
    it("loads the role from IDENTITY.md when present", async () => {
        await storage.upsertFile(idPath(), "# Beacon\n\nA software engineer.\n");
        const loader = new IdentityLoader("/root", storage);
        const id = await loader.resolve();
        expect(id.fallback).toBe(false);
        expect(id.name).toBe("Beacon");
        expect(id.role).toBe("A software engineer.");
        expect(id.resolvedPath).toContain("IDENTITY.md");
    });
    it("honors a config name override", async () => {
        await storage.upsertFile(idPath(), "# Beacon\n\nA software engineer.\n");
        const loader = new IdentityLoader("/root", storage, {
            name: "Override",
        });
        const id = await loader.resolve();
        expect(id.name).toBe("Override");
    });
    it("caches the resolved identity until invalidate() is called", async () => {
        await storage.upsertFile(idPath(), "# A\n\nfirst role\n");
        const loader = new IdentityLoader("/root", storage);
        const first = await loader.resolve();
        expect(first.name).toBe("A");
        await storage.upsertFile(idPath(), "# B\n\nsecond role\n");
        const cached = await loader.resolve();
        expect(cached.name).toBe("A");
        loader.invalidate();
        const refreshed = await loader.resolve();
        expect(refreshed.name).toBe("B");
        expect(refreshed.role).toBe("second role");
    });
    it("respects a custom relative path in config", async () => {
        await storage.upsertFile(idPath("profile/me.md"), "# Custom\n\nrole text\n");
        const loader = new IdentityLoader("/root", storage, {
            path: "profile/me.md",
        });
        const id = await loader.resolve();
        expect(id.fallback).toBe(false);
        expect(id.name).toBe("Custom");
    });
    it("frame() wraps content in <IDENTITY> tags", async () => {
        await storage.upsertFile(idPath(), "# Beacon\n\nA software engineer.\n");
        const loader = new IdentityLoader("/root", storage);
        const frame = await loader.frame();
        expect(frame.startsWith("<IDENTITY>")).toBe(true);
        expect(frame.endsWith("</IDENTITY>")).toBe(true);
        expect(frame).toContain("# Beacon");
        expect(frame).toContain("A software engineer.");
    });
    it("frame() works with fallback identity", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
        const loader = new IdentityLoader("/root", storage);
        const frame = await loader.frame();
        expect(frame).toContain("<IDENTITY>");
        expect(frame).toContain("a knowledge-worker agent");
        warn.mockRestore();
    });
});
describe("formatIdentityFrame", () => {
    it("uses the raw file content when available", () => {
        const frame = formatIdentityFrame({
            name: "Beacon",
            role: "ignored",
            raw: "# Beacon\n\nThe canonical role.",
            resolvedPath: "/x/IDENTITY.md",
            fallback: false,
        });
        expect(frame).toContain("The canonical role.");
        expect(frame).not.toContain("ignored");
    });
    it("synthesizes a frame from name + role when raw is empty", () => {
        const frame = formatIdentityFrame({
            name: "Agent",
            role: "a knowledge-worker agent",
            raw: "",
            resolvedPath: "/x/IDENTITY.md",
            fallback: true,
        });
        expect(frame).toContain("# Agent");
        expect(frame).toContain("a knowledge-worker agent");
    });
});
//# sourceMappingURL=identity.test.js.map