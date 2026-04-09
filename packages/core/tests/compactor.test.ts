import { describe, it, expect, beforeEach } from "vitest";
import { Compactor } from "../src/compactor.js";
import { MemoryFiles } from "../src/files.js";
import { VirtualFileStorage } from "../src/defaults/virtual-file-storage.js";
import type { MemoryModel, CompletionResult, CompleteOptions } from "../src/interfaces/model.js";

/** Mock model that echoes back a summary */
class MockModel implements MemoryModel {
    async complete(prompt: string, _options?: CompleteOptions): Promise<CompletionResult> {
        return { text: `Summary of: ${prompt.substring(0, 50)}...` };
    }
}

describe("Compactor", () => {
    let storage: VirtualFileStorage;
    let files: MemoryFiles;
    let model: MockModel;
    let compactor: Compactor;

    beforeEach(async () => {
        storage = new VirtualFileStorage();
        files = new MemoryFiles("/root", storage);
        await files.initialize();
        model = new MockModel();
        compactor = new Compactor(files, {
            model,
            minDailiesForWeekly: 2,
            extractTypedMemories: false, // Disable for simpler tests
            aggregationStrategy: "uniform", // Skip NER for unit tests
        });
    });

    describe("compactDaily", () => {
        it("skips current week", async () => {
            // Write dailies for the current week
            const today = new Date().toISOString().split("T")[0];
            await files.writeDaily(today, "Today's log");
            const result = await compactor.compactDaily();
            expect(result.filesCreated).toHaveLength(0);
        });

        it("compacts past week dailies into weekly summary", async () => {
            // Write dailies for a past week (2026-01-05 is a Monday in W02)
            await files.writeDaily("2026-01-05", "Monday log");
            await files.writeDaily("2026-01-06", "Tuesday log");
            await files.writeDaily("2026-01-07", "Wednesday log");

            const result = await compactor.compactDaily();

            expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);
            expect(result.filesCompacted.length).toBeGreaterThanOrEqual(2);

            // Weekly file should exist
            const weeklies = await files.listWeeklies();
            expect(weeklies.length).toBeGreaterThanOrEqual(1);
        });

        it("skips week if weekly already exists", async () => {
            await files.writeDaily("2026-01-05", "Monday");
            await files.writeDaily("2026-01-06", "Tuesday");

            // Pre-create the weekly
            await files.writeWeekly("2026-W02", "Already exists");

            const result = await compactor.compactDaily();
            // Should not create a new weekly for W02
            const w02Created = result.filesCreated.filter((f) =>
                f.includes("W02"),
            );
            expect(w02Created).toHaveLength(0);
        });

        it("dry run reports without writing", async () => {
            await files.writeDaily("2026-01-05", "Monday");
            await files.writeDaily("2026-01-06", "Tuesday");

            const result = await compactor.compactDaily(undefined, true);
            // In dry run, files are listed as compacted but nothing is created
            expect(result.filesCreated).toHaveLength(0);

            // The weekly should NOT exist
            expect(await files.readWeekly("2026-W02")).toBeNull();
        });
    });

    describe("compactWeekly", () => {
        it("compacts past month weeklies into monthly summary", async () => {
            // Write weeklies for January 2026
            await files.writeWeekly("2026-W01", "Week 1 summary");
            await files.writeWeekly("2026-W02", "Week 2 summary");
            await files.writeWeekly("2026-W03", "Week 3 summary");

            const result = await compactor.compactWeekly();

            // Should have created a monthly
            expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);

            const monthlies = await files.listMonthlies();
            expect(monthlies.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe("distillWisdom", () => {
        it("generates wisdom from typed memories", async () => {
            await files.writeTypedMemory(
                "feedback_testing.md",
                "---\nname: Testing\ntype: feedback\n---\n\nUse integration tests",
            );

            const result = await compactor.distillWisdom();
            expect(result.filesCreated).toContain("WISDOM.md");

            const wisdom = await files.readWisdom();
            expect(wisdom).not.toBeNull();
            expect(wisdom).toContain("Summary of:");
        });

        it("skips when no typed memories or monthlies exist", async () => {
            const result = await compactor.distillWisdom();
            expect(result.filesCreated).toHaveLength(0);
        });
    });
});
