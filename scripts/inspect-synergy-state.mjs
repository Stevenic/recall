#!/usr/bin/env node
/**
 * Deep-inspect what dreaming actually does to the wiki when day 14
 * revises the Condor synergy assumptions. Walks through ingest +
 * dream of days 1-18 and dumps the full state at each step:
 *
 *   - every wiki page (full body), grouped by Condor / synergy / financial keywords
 *   - every wiki page's supersedes frontmatter
 *   - the running list of wiki_op results from each dream pass
 *
 * Goal: answer the question "did the merge step run on day 14's
 * revision, and what did it do?" cleanly so we stop guessing.
 *
 *   node scripts/inspect-synergy-state.mjs
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

function isoDateForDay(n) {
    const d = new Date(Date.UTC(2026, 0, 1));
    d.setUTCDate(d.getUTCDate() + n - 1);
    return d.toISOString().slice(0, 10);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-state-"));
console.log("memory root:", tmp);
await fs.mkdir(path.join(tmp, "memory"), { recursive: true });

class GeneratorMemoryModel {
    constructor(model) { this._model = model; }
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
    dreamingModel: new GeneratorMemoryModel(
        new AzureOpenAiGeneratorModel({ deployment: "gpt-5.4" }),
    ),
    wiki: { enabled: true },
    dreaming: { enabled: true },
});
await service.initialize();

async function ingestDays(startDay, endDay) {
    for (let n = startDay; n <= endDay; n++) {
        const src = path.join(memoriesDir, `day-${String(n).padStart(4, "0")}.md`);
        const dst = path.join(tmp, "memory", `${isoDateForDay(n)}.md`);
        await fs.writeFile(dst, await fs.readFile(src, "utf-8"), "utf-8");
    }
}

async function dumpFullState(label) {
    console.log("\n" + "=".repeat(72));
    console.log(label);
    console.log("=".repeat(72));
    const wikiDir = path.join(tmp, "memory", "wiki");
    if (!(await fs.stat(wikiDir).catch(() => null))) {
        console.log("(no wiki dir)");
        return;
    }
    const files = (await fs.readdir(wikiDir)).filter((f) => f.endsWith(".md")).sort();
    console.log(`Total wiki pages: ${files.length}`);
    // Filter to Condor/synergy-related pages
    const targetFiles = files.filter((f) =>
        /condor|synerg|valuation|financ|deal/i.test(f),
    );
    console.log(`Condor-related pages: ${targetFiles.length}`);
    for (const f of targetFiles) {
        const full = await fs.readFile(path.join(wikiDir, f), "utf-8");
        // Parse YAML frontmatter manually so we don't need gray-matter here.
        const fmMatch = full.match(/^---\n([\s\S]*?)\n---\n*([\s\S]*)$/);
        const frontmatter = fmMatch ? fmMatch[1] : "";
        const body = fmMatch ? fmMatch[2] : full;
        console.log(`\n──── ${f} ────`);
        // Pull sources + supersedes from frontmatter
        const sourcesMatch = frontmatter.match(/sources:\n((?:\s*-\s.+\n)+)/);
        if (sourcesMatch) {
            const sources = sourcesMatch[1].split("\n").filter((l) => l.trim()).map((l) => l.replace(/^\s*-\s/, "").trim());
            console.log(`sources (${sources.length}): ${sources.slice(0, 10).join(", ")}${sources.length > 10 ? " …" : ""}`);
        }
        const supersedesMatch = frontmatter.match(/supersedes:\n((?:\s+.+\n)+)/);
        if (supersedesMatch) {
            console.log(`supersedes:`);
            console.log(supersedesMatch[1].split("\n").filter((l) => l.trim()).map((l) => "  " + l.trim()).join("\n"));
        } else {
            console.log(`supersedes: (none)`);
        }
        // Show full body
        console.log(`body:`);
        const lines = body.trim().split("\n");
        for (const ln of lines) console.log(`  ${ln}`);
    }
}

async function ingestDreamDump(start, end, label) {
    console.log(`\n>>> Ingesting days ${start}-${end} + dreaming ...`);
    await ingestDays(start, end);
    await service.sync();
    await service.compact();
    const dr = await service.dream();
    console.log(`Dream report: ${dr.modelCalls} model calls, ${dr.wikiUpdates.length} wiki ops`);
    for (const u of dr.wikiUpdates) {
        console.log(`  ${u.ok ? "✓" : "✗"} ${u.op} ${u.slug} — ${u.detail}`);
    }
    await dumpFullState(label);
}

// Ingest days 1-7 first (pre-revision state). Synergy should be $18M/$26M.
await ingestDreamDump(1, 7, "AFTER days 1-7 (synergy = $18M/$26M era)");

// Ingest days 8-14 (revision day). Synergy revised to $28M/$38M on day 14.
await ingestDreamDump(8, 14, "AFTER days 8-14 (day 14 revised to $28M/$38M)");

// Ingest days 15-18. Days 15-18 continue with new values.
await ingestDreamDump(15, 18, "AFTER days 15-18 (post-revision)");

console.log(`\nmemory root: ${tmp}`);
