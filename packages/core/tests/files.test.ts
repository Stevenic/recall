import { describe, it, expect, beforeEach } from "vitest";
import { MemoryFiles } from "../src/files.js";
import { VirtualFileStorage } from "../src/defaults/virtual-file-storage.js";

describe("MemoryFiles", () => {
    let storage: VirtualFileStorage;
    let files: MemoryFiles;

    beforeEach(async () => {
        storage = new VirtualFileStorage();
        files = new MemoryFiles("/root", storage);
        await files.initialize();
    });

    describe("daily logs", () => {
        it("returns null for non-existent daily", async () => {
            expect(await files.readDaily("2026-04-01")).toBeNull();
        });

        it("writes and reads a daily log", async () => {
            await files.writeDaily("2026-04-01", "Hello world");
            expect(await files.readDaily("2026-04-01")).toBe("Hello world");
        });

        it("appends to an existing daily", async () => {
            await files.appendDaily("2026-04-01", "First entry");
            await files.appendDaily("2026-04-01", "Second entry");
            const content = await files.readDaily("2026-04-01");
            expect(content).toContain("First entry");
            expect(content).toContain("Second entry");
        });

        it("creates daily with frontmatter on first append", async () => {
            await files.appendDaily("2026-04-01", "New entry");
            const content = await files.readDaily("2026-04-01");
            expect(content).toContain("type: daily");
            expect(content).toContain("New entry");
        });

        it("lists dailies sorted by date", async () => {
            await files.writeDaily("2026-04-03", "c");
            await files.writeDaily("2026-04-01", "a");
            await files.writeDaily("2026-04-02", "b");
            const list = await files.listDailies();
            expect(list).toEqual(["2026-04-01", "2026-04-02", "2026-04-03"]);
        });

        it("filters dailies by after/before", async () => {
            await files.writeDaily("2026-04-01", "a");
            await files.writeDaily("2026-04-02", "b");
            await files.writeDaily("2026-04-03", "c");
            const list = await files.listDailies({
                after: "2026-04-02",
                before: "2026-04-02",
            });
            expect(list).toEqual(["2026-04-02"]);
        });

        it("deletes a daily", async () => {
            await files.writeDaily("2026-04-01", "content");
            await files.deleteDaily("2026-04-01");
            expect(await files.readDaily("2026-04-01")).toBeNull();
        });
    });

    describe("weekly summaries", () => {
        it("writes and reads a weekly", async () => {
            await files.writeWeekly("2026-W14", "Weekly summary");
            expect(await files.readWeekly("2026-W14")).toBe("Weekly summary");
        });

        it("lists weeklies", async () => {
            await files.writeWeekly("2026-W14", "a");
            await files.writeWeekly("2026-W13", "b");
            expect(await files.listWeeklies()).toEqual([
                "2026-W13",
                "2026-W14",
            ]);
        });
    });

    describe("monthly summaries", () => {
        it("writes and reads a monthly", async () => {
            await files.writeMonthly("2026-03", "Monthly summary");
            expect(await files.readMonthly("2026-03")).toBe("Monthly summary");
        });

        it("lists monthlies", async () => {
            await files.writeMonthly("2026-04", "a");
            await files.writeMonthly("2026-03", "b");
            expect(await files.listMonthlies()).toEqual([
                "2026-03",
                "2026-04",
            ]);
        });
    });

    describe("wisdom", () => {
        it("returns null when no wisdom exists", async () => {
            expect(await files.readWisdom()).toBeNull();
        });

        it("writes and reads wisdom", async () => {
            await files.writeWisdom("Be wise");
            expect(await files.readWisdom()).toBe("Be wise");
        });
    });

    describe("typed memories", () => {
        it("writes and reads a typed memory", async () => {
            const content =
                "---\nname: test\ntype: project\n---\n\nSome content";
            await files.writeTypedMemory("project_test.md", content);
            expect(await files.readTypedMemory("project_test.md")).toBe(
                content,
            );
        });

        it("lists typed memories (excludes dailies)", async () => {
            await files.writeTypedMemory("project_test.md", "a");
            await files.writeTypedMemory("feedback_code.md", "b");
            await files.writeDaily("2026-04-01", "not this");
            const list = await files.listTypedMemories();
            expect(list).toEqual(["feedback_code.md", "project_test.md"]);
        });

        it("deletes a typed memory", async () => {
            await files.writeTypedMemory("project_test.md", "content");
            await files.deleteTypedMemory("project_test.md");
            expect(
                await files.readTypedMemory("project_test.md"),
            ).toBeNull();
        });
    });

    describe("listAll", () => {
        it("returns a complete manifest", async () => {
            await files.writeDaily("2026-04-01", "d");
            await files.writeWeekly("2026-W14", "w");
            await files.writeMonthly("2026-03", "m");
            await files.writeTypedMemory("project_x.md", "t");
            await files.writeWisdom("wisdom");

            const manifest = await files.listAll();
            expect(manifest.dailies).toEqual(["2026-04-01"]);
            expect(manifest.weeklies).toEqual(["2026-W14"]);
            expect(manifest.monthlies).toEqual(["2026-03"]);
            expect(manifest.typedMemories).toEqual(["project_x.md"]);
            expect(manifest.hasWisdom).toBe(true);
        });
    });
});
