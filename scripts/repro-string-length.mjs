#!/usr/bin/env node
/**
 * Reproducer for the V8 "Invalid string length" RangeError that surfaces in
 * the Recall search path at certain checkpoints. Ingests EA days 1-6 from
 * the bench corpus, runs compaction + dreaming (matching the bench profile),
 * then issues the exact agent queries from q004 / q009 / q007 / q012 that
 * blew up in run 5 of `ea-60d-recall-dreaming`. Logs the full stack of any
 * thrown error so we can pin the offending string operation.
 *
 *   node scripts/repro-string-length.mjs
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({ path: path.resolve(process.cwd(), ".env") });

const { MemoryService } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/core/dist/index.js")).href,
);
const benchMod = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/recall-bench/dist/index.js")).href,
);
const { AzureOpenAiGeneratorModel } = benchMod;

const personaRoot = path.resolve(
    process.cwd(),
    "packages/recall-bench/personas/executive-assistant",
);
const memoriesDir = path.join(personaRoot, "memories-180d");

const dailyFiles = (await fs.readdir(memoriesDir))
    .filter((f) => /^day-\d{4}\.md$/.test(f))
    .sort()
    .slice(0, 6); // days 1..6

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "repro-bm25-"));
console.log("memory root:", tmp);
await fs.mkdir(path.join(tmp, "memory"), { recursive: true });

// Bench harness names dailies by their date (from frontmatter "date:"), not
// by sequential day number. Pull the date from each daily file's frontmatter
// — defensive: if missing, fall back to day-N-keyed name to keep the script
// running.
for (let i = 0; i < dailyFiles.length; i++) {
    const content = await fs.readFile(path.join(memoriesDir, dailyFiles[i]), "utf-8");
    const m = content.match(/^---\n[\s\S]*?date:\s*"?([\d-]+)"?[\s\S]*?\n---/);
    const date = m ? m[1] : `2026-01-${String(i + 1).padStart(2, "0")}`;
    await fs.writeFile(path.join(tmp, "memory", `${date}.md`), content, "utf-8");
    console.log(`  wrote ${date}.md (from ${dailyFiles[i]})`);
}

// Mirror the bench's GeneratorMemoryModel bridge.
class GeneratorMemoryModel {
    constructor(model) {
        this._model = model;
    }
    async complete(prompt, options) {
        const sys = options?.systemPrompt ?? "";
        const opts = {};
        if (options?.temperature !== undefined) opts.temperature = options.temperature;
        if (options?.maxTokens !== undefined) opts.maxTokens = options.maxTokens;
        const r = await this._model.complete(sys, prompt, opts);
        const out = { text: r.text };
        if (r.inputTokens !== undefined) out.inputTokens = r.inputTokens;
        if (r.outputTokens !== undefined) out.outputTokens = r.outputTokens;
        return out;
    }
}

const azure = new AzureOpenAiGeneratorModel({ deployment: "gpt-5.4-mini" });
const service = new MemoryService({
    memoryRoot: tmp,
    model: new GeneratorMemoryModel(azure),
    wiki: { enabled: true },
    dreaming: { enabled: true },
});
await service.initialize();

console.log("\n[1/4] sync ...");
await service.sync();
console.log("[2/4] compact ...");
await service.compact();
console.log("[3/4] dream ...");
await service.dream();
console.log("[4/4] search ...");

const queries = [
    "codename for the bolt-on acquisition workstream",
    "bolt-on acquisition workstream codename",
    "bolt-on acquisition",
    "bolt-on",
    "acquisition workstream codename",
    "Condor thread financing structure being kept",
    "Condor thread financing structure kept",
    "Condor financing structure kept",
    "Condor approach posture 2026-01-07",
    "Condor approach posture January 7 2026",
];

let firstError = null;
for (const q of queries) {
    process.stdout.write(`  search "${q}" ... `);
    try {
        const hits = await service.search(q, { maxResults: 5, skipSync: true });
        console.log(`ok (${hits.length} hits)`);
    } catch (err) {
        console.log("THREW:", err?.message);
        console.error(err?.stack ?? err);
        if (!firstError) firstError = { q, err };
        break;
    }
}

// Also exercise the parallel call path that _hierarchicalSearch uses
// (three index.query calls in a Promise.all). This is what hits the
// "consolidation can be carried out only once!" bug — the sequential
// loop above doesn't surface it because each call completes before the
// next starts.
console.log("\nParallel search stress (mirrors _hierarchicalSearch fan-out):");
for (let round = 0; round < 5; round++) {
    const batch = queries.slice(0, 3).map((q) =>
        service.search(q, { maxResults: 5, skipSync: true }),
    );
    try {
        const results = await Promise.all(batch);
        console.log(
            `  round ${round + 1}: ok (${results.map((r) => r.length).join(",")} hits)`,
        );
    } catch (err) {
        console.log(`  round ${round + 1}: THREW`, err?.message);
        console.error(err?.stack ?? err);
        if (!firstError) firstError = { round, err };
        break;
    }
}

if (!firstError) {
    console.log("\nNo error reproduced.");
}
