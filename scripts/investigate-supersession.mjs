#!/usr/bin/env node
/**
 * Diagnostic for the q021-style supersession failure.
 *
 * The hypothesis: when EA day 3 establishes "synergy base case $18M /
 * stretch $26M" and day 14 revises to "base $28M / stretch $38M",
 * dreaming should detect the change and supersede the Condor synergy
 * wiki page so it reflects the new values. The bench evidence says
 * this is NOT happening — the agent reads the wiki and gets $18M/$26M
 * even at the day-60 checkpoint. We need to know why.
 *
 * Walk: ingest days 1-14 in two batches matching the bench's 6-day
 * checkpoint cadence (days 1-6, then 7-14), dream after each, dump
 * Condor wiki state at each stage, and grep for synergy values across
 * pages + supersedes entries.
 *
 *   node scripts/investigate-supersession.mjs
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

// Map day-N file → ISO date (the bench reads dates from arcs.yaml; we
// fake a clean Jan-2026 sequence so the investigation is self-contained).
function isoDateForDay(n) {
    const d = new Date(Date.UTC(2026, 0, 1));
    d.setUTCDate(d.getUTCDate() + n - 1);
    return d.toISOString().slice(0, 10);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "supersession-"));
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
    wiki: { enabled: true },
    dreaming: { enabled: true },
});
await service.initialize();

async function ingestDays(startDay, endDay) {
    for (let n = startDay; n <= endDay; n++) {
        const src = path.join(memoriesDir, `day-${String(n).padStart(4, "0")}.md`);
        const dstDate = isoDateForDay(n);
        const dst = path.join(tmp, "memory", `${dstDate}.md`);
        const content = await fs.readFile(src, "utf-8");
        await fs.writeFile(dst, content, "utf-8");
    }
}

async function dumpCondorWikiState(label) {
    console.log(`\n=== ${label} ===`);
    const wikiDir = path.join(tmp, "memory", "wiki");
    if (!(await fs.stat(wikiDir).catch(() => null))) {
        console.log("(no wiki dir yet)");
        return;
    }
    const files = (await fs.readdir(wikiDir)).filter((f) => f.endsWith(".md"));
    console.log(`Wiki pages: ${files.length}`);
    const condorFiles = files.filter(
        (f) => /condor|synerg/i.test(f),
    );
    if (condorFiles.length === 0) {
        console.log("  no Condor-related pages");
        return;
    }
    for (const f of condorFiles) {
        const body = await fs.readFile(path.join(wikiDir, f), "utf-8");
        const has18 = /\$18M|\$26M/.test(body);
        const has28 = /\$28M|\$38M/.test(body);
        const supersedesMatch = body.match(/supersedes:\s*\n([\s\S]*?)(?=\n[a-z]+:\s|\n---)/);
        console.log(`  · ${f}`);
        console.log(`      values: 18/26=${has18}  28/38=${has28}`);
        if (supersedesMatch) {
            const lines = supersedesMatch[1].split("\n").filter((l) => l.trim()).slice(0, 8);
            console.log(`      supersedes entries:`);
            for (const l of lines) console.log(`        ${l.trim()}`);
        } else {
            console.log(`      supersedes: (none)`);
        }
        // Show first paragraph of body so we can see what the page actually claims.
        const bodyOnly = body.split(/^---[\s\S]*?---\s*/m)[1] ?? body;
        const firstPara = bodyOnly.split(/\n\n/)[0].trim().slice(0, 320);
        console.log(`      first body paragraph: ${firstPara.replace(/\n/g, " ")}`);
    }
}

// Walk through checkpoints matching the bench (every 6 days). Day 14 is
// where synergy is revised; later days keep restating the new values, so
// dreaming gets more chances to either create a synergy wiki page or
// update an existing one.
const checkpoints = [6, 12, 18, 24, 30];
let lastDay = 0;
for (const ckpt of checkpoints) {
    console.log(`\n[ckpt ${ckpt}d] ingest days ${lastDay + 1}-${ckpt}, dream ...`);
    await ingestDays(lastDay + 1, ckpt);
    await service.sync();
    await service.compact();
    await service.dream();
    await dumpCondorWikiState(`After dreaming through day ${ckpt}`);
    lastDay = ckpt;
}

console.log("\n[verify] sync + search for synergy assumptions ...");
// sync so wiki pages dreaming created in the last pass are visible to
// the agent path — matches the bench's flow where every checkpoint runs
// sync before answering questions.
await service.sync();
const hits = await service.search(
    "What were the base-case and upside synergy assumptions for Project Condor?",
    { maxResults: 5, skipSync: true },
);
console.log(`Got ${hits.length} hits:`);
for (const h of hits) {
    const has18 = /\$18M|\$26M/.test(h.text || "");
    const has28 = /\$28M|\$38M/.test(h.text || "");
    console.log(`  - ${h.uri}  (18/26=${has18}  28/38=${has28})  score=${h.score.toFixed(2)}`);
}

console.log(`\nmemory root: ${tmp}`);
