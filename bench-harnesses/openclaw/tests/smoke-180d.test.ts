/**
 * End-to-end smoke test against the 180-day executive-assistant persona from
 * the recall-bench dataset. Exercises real OpenClaw memory (FTS-only) with
 * either fake or OpenAI-backed synthesis depending on env.
 *
 * Opt-in: set `RUN_SMOKE_180D=1` (and optionally `RECALL_REPO=<path>`,
 * `OPENAI_API_KEY=...`).
 *
 * Run with:
 *   RUN_SMOKE_180D=1 pnpm test
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { describe, it, expect, vi } from "vitest";
import { OpenClawMemoryAdapter } from "../src/adapter.js";
import type { SynthesisModel } from "../src/synthesis.js";

// Bypass OpenClaw's embedding-provider auto-selection (which would try to
// import node-llama-cpp etc.) and the optional sqlite-vec extension. Mirrors
// the pattern from `extensions/memory-core/src/memory/manager.fts-only-reindex.test.ts`.
vi.mock("@openclaw/memory-core/src/memory/embeddings.js", () => ({
    createEmbeddingProvider: async () => ({
        requestedProvider: "auto",
        provider: null,
        providerUnavailableReason: "No embeddings provider available.",
    }),
    resolveEmbeddingProviderFallbackModel: () => "fts-only",
}));
vi.mock("@openclaw/memory-core/src/memory/sqlite-vec.js", () => ({
    loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in smoke" }),
}));

const ENABLED = process.env.RUN_SMOKE_180D === "1";
const RECALL_REPO = process.env.RECALL_REPO ?? "C:/source/recall";
const PERSONA = "executive-assistant";

interface RawQa {
    id: string;
    question: string;
    answer: string;
    category: string;
    difficulty: string;
    relevant_days: number[];
}

class FakeSynthesisModel implements SynthesisModel {
    async complete(_system: string, user: string): Promise<{ text: string }> {
        // Surface the assembled context block so a human can eyeball whether
        // OpenClaw retrieved the right snippets.
        const excerpts = user.split("Memory excerpts:\n")[1] ?? "";
        const firstFew = excerpts
            .split("\n\n")
            .slice(0, 3)
            .join("\n\n");
        return { text: `[fake-synth] top hits:\n${firstFew}` };
    }
}

describe.runIf(ENABLED)("OpenClaw harness — 180d EA smoke", () => {
    it("ingests 180 days, runs sample queries, prints results", { timeout: 600_000 }, async () => {
        const personaDir = path.join(
            RECALL_REPO,
            "packages",
            "recall-bench",
            "personas",
            PERSONA,
        );
        const memoriesDir = path.join(personaDir, "memories-180d");
        const qaFile = path.join(personaDir, "qa-180d", "questions.yaml");
        const epoch = new Date("2026-01-01");

        // --- Load days ---
        const dayFiles = (await readdir(memoriesDir))
            .filter((f) => /^day-\d{4}\.md$/.test(f))
            .sort();
        const days = await Promise.all(
            dayFiles.map(async (f) => {
                const dayNumber = parseInt(f.replace("day-", "").replace(".md", ""), 10);
                const content = await readFile(path.join(memoriesDir, f), "utf8");
                const date = new Date(epoch);
                date.setUTCDate(date.getUTCDate() + dayNumber - 1);
                return {
                    dayNumber,
                    content,
                    metadata: {
                        dayNumber,
                        date: date.toISOString().slice(0, 10),
                        personaId: PERSONA,
                        activeArcs: [] as string[],
                    },
                };
            }),
        );
        console.log(`[smoke] loaded ${days.length} day files from ${memoriesDir}`);

        // --- Load Q&A ---
        const qaRaw = await readFile(qaFile, "utf8");
        const qaPairs = YAML.parse(qaRaw) as RawQa[];
        console.log(`[smoke] loaded ${qaPairs.length} Q&A pairs`);

        // --- Build adapter ---
        // FTS-only mode (no embedding API). Use OpenAI for synthesis if a key
        // is present, otherwise a fake that surfaces retrieved chunks.
        const useRealLlm = Boolean(process.env.OPENAI_API_KEY);
        const config: ConstructorParameters<typeof OpenClawMemoryAdapter>[0] = {
            embeddingProvider: "auto",
            maxSearchResults: 10,
        };
        if (!useRealLlm) {
            config.synthesisModelImpl = new FakeSynthesisModel();
        }
        const adapter = new OpenClawMemoryAdapter(config);
        console.log(`[smoke] adapter: ${adapter.name}, synthesis: ${useRealLlm ? "openai" : "fake"}`);

        // --- Lifecycle ---
        const setupStart = Date.now();
        await adapter.setup();
        console.log(`[smoke] setup ok (${Date.now() - setupStart}ms)`);

        const ingestStart = Date.now();
        for (const d of days) {
            await adapter.ingestDay(d.dayNumber, d.content, d.metadata);
        }
        console.log(`[smoke] ingestDay ×${days.length} (${Date.now() - ingestStart}ms)`);

        const finalizeStart = Date.now();
        await adapter.finalizeIngestion();
        console.log(`[smoke] finalizeIngestion ok (${Date.now() - finalizeStart}ms)`);

        // --- Query a sample ---
        // Mix of factual-recall, contradiction-resolution, and synthesis.
        const sample = pickSample(qaPairs, [
            "executive-assistant-q001",
            "executive-assistant-q002",
            "executive-assistant-q004",
            "executive-assistant-q005",
        ]);

        for (const qa of sample) {
            const start = Date.now();
            const answer = await adapter.query(qa.question);
            const elapsed = Date.now() - start;
            console.log("---");
            console.log(`Q[${qa.id}] (${qa.category}, ${elapsed}ms): ${qa.question}`);
            console.log(`REFERENCE: ${qa.answer}`);
            console.log(`ANSWER:    ${answer}`);
        }

        await adapter.teardown();
        console.log(`[smoke] teardown ok`);

        expect(days.length).toBe(180);
        expect(qaPairs.length).toBeGreaterThan(0);
    });
});

function pickSample(all: RawQa[], ids: string[]): RawQa[] {
    const map = new Map(all.map((q) => [q.id, q]));
    return ids.map((id) => map.get(id)).filter((q): q is RawQa => q !== undefined);
}
