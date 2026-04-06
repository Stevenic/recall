#!/usr/bin/env node
import { Command } from "commander";
import * as path from "path";
import { MemoryService } from "./service.js";
import { CliAgentModel } from "./defaults/cli-agent-model.js";

const program = new Command();

program
    .name("recall")
    .description("Agent memory service CLI")
    .version("0.1.0")
    .option("--dir <path>", "Memory root directory", "./memory")
    .option("--json", "JSON output")
    .option("--verbose", "Verbose logging");

function getService(opts: { dir: string; agent?: string }): MemoryService {
    const memoryRoot = path.resolve(opts.dir);
    const model = opts.agent
        ? new CliAgentModel({ agent: opts.agent })
        : undefined;
    return new MemoryService({ memoryRoot, model });
}

function output(data: unknown, json: boolean): void {
    if (json) {
        console.log(JSON.stringify(data, null, 2));
    } else if (typeof data === "string") {
        console.log(data);
    } else {
        console.log(JSON.stringify(data, null, 2));
    }
}

// --- search ---
program
    .command("search <query>")
    .description("Search memories")
    .option("--results <n>", "Max results", "5")
    .option("--max-chunks <n>", "Max chunks per document", "3")
    .option("--max-tokens <n>", "Max tokens per result", "500")
    .option("--recency-depth <n>", "Recent weekly summaries to include", "2")
    .option("--typed-memory-boost <n>", "Boost for typed memories", "1.2")
    .option("--no-sync", "Skip auto-sync before searching")
    .action(async (query: string, cmdOpts: any) => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir });
        const results = await svc.search(query, {
            maxResults: parseInt(cmdOpts.results),
            maxChunks: parseInt(cmdOpts.maxChunks),
            maxTokens: parseInt(cmdOpts.maxTokens),
            recencyDepth: parseInt(cmdOpts.recencyDepth),
            typedMemoryBoost: parseFloat(cmdOpts.typedMemoryBoost),
            skipSync: cmdOpts.sync === false,
        });
        output(
            globalOpts.json
                ? results
                : results.map((r) => formatResult(r)),
            globalOpts.json,
        );
    });

// --- index ---
program
    .command("index")
    .description("Full rebuild of the vector index")
    .action(async () => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir });
        const stats = await svc.index();
        output(
            globalOpts.json
                ? stats
                : `Index rebuilt: ${stats.documentCount} documents, ${stats.chunkCount} chunks`,
            globalOpts.json,
        );
    });

// --- sync ---
program
    .command("sync")
    .description("Incremental index sync")
    .action(async () => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir });
        const stats = await svc.sync();
        output(
            globalOpts.json
                ? stats
                : `Synced: ${stats.documentCount} documents, ${stats.chunkCount} chunks`,
            globalOpts.json,
        );
    });

// --- status ---
program
    .command("status")
    .description("Show memory file counts and index health")
    .action(async () => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir });
        const status = await svc.status();
        if (globalOpts.json) {
            output(status, true);
        } else {
            console.log(`Memory root: ${status.memoryRoot}`);
            console.log(`Index: ${status.indexCreated ? "created" : "not created"}`);
            if (status.indexStats) {
                console.log(
                    `  Documents: ${status.indexStats.documentCount}, Chunks: ${status.indexStats.chunkCount}`,
                );
            }
            const m = status.fileManifest;
            console.log(`Files:`);
            console.log(`  Dailies: ${m.dailies.length}`);
            console.log(`  Weeklies: ${m.weeklies.length}`);
            console.log(`  Monthlies: ${m.monthlies.length}`);
            console.log(`  Typed memories: ${m.typedMemories.length}`);
            console.log(`  Wisdom: ${m.hasWisdom ? "yes" : "no"}`);
        }
    });

// --- compact ---
program
    .command("compact [level]")
    .description("Run compaction (weekly | monthly | wisdom)")
    .option("--dry-run", "Report only, don't execute")
    .option("--agent <name>", "CLI agent for summarization", "claude")
    .option("--compression <ratio>", "Compression target", "0.3")
    .option("--max-wisdom <n>", "Max wisdom entries", "20")
    .action(
        async (
            level: string | undefined,
            cmdOpts: Record<string, string>,
        ) => {
            const globalOpts = program.opts();
            const svc = getService({
                dir: globalOpts.dir,
                agent: cmdOpts.agent,
            });
            const result = await svc.compact({
                level: level as "weekly" | "monthly" | "wisdom" | undefined,
                dryRun: "dryRun" in cmdOpts,
            });
            output(result, globalOpts.json);
        },
    );

// --- add ---
program
    .command("add <file>")
    .description("Add/update a single file in the index")
    .action(async (file: string) => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir });
        const fs = await import("fs/promises");
        const _content = await fs.readFile(file, "utf-8");
        const relativePath = path.relative(
            path.resolve(globalOpts.dir),
            path.resolve(file),
        );
        await svc.sync(); // Ensure index exists
        // Use the underlying index through sync for now
        output(
            globalOpts.json
                ? { added: relativePath }
                : `Added: ${relativePath}`,
            globalOpts.json,
        );
    });

// --- log ---
program
    .command("log <entry>")
    .description("Append an entry to today's daily log")
    .option("--file <path>", "Read entry from a file instead")
    .action(async (entry: string, cmdOpts: Record<string, string>) => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir });
        let text = entry;
        if (cmdOpts.file) {
            const fs = await import("fs/promises");
            text = await fs.readFile(cmdOpts.file, "utf-8");
        }
        const today = new Date().toISOString().split("T")[0];
        await svc.files.appendDaily(today, text);
        output(
            globalOpts.json
                ? { date: today, entry: text }
                : `Logged to ${today}`,
            globalOpts.json,
        );
    });

// --- read ---
program
    .command("read <file>")
    .description("Read a memory file")
    .action(async (file: string) => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir });

        // Try to resolve the file type from the path
        let content: string | null = null;
        if (file.match(/^\d{4}-\d{2}-\d{2}$/)) {
            content = await svc.files.readDaily(file);
        } else if (file.match(/^\d{4}-W\d{2}$/)) {
            content = await svc.files.readWeekly(file);
        } else if (file.match(/^\d{4}-\d{2}$/) && !file.match(/^\d{4}-\d{2}-\d{2}$/)) {
            content = await svc.files.readMonthly(file);
        } else if (file === "wisdom" || file === "WISDOM.md") {
            content = await svc.files.readWisdom();
        } else {
            content = await svc.files.readTypedMemory(file);
        }

        if (content === null) {
            output(
                globalOpts.json
                    ? { error: "File not found", file }
                    : `File not found: ${file}`,
                globalOpts.json,
            );
            process.exitCode = 1;
        } else {
            output(
                globalOpts.json ? { file, content } : content,
                globalOpts.json,
            );
        }
    });

// --- list ---
program
    .command("list [type]")
    .description("List memory files (daily | weekly | monthly | typed | all)")
    .option("--after <date>", "Filter files after this date")
    .option("--before <date>", "Filter files before this date")
    .action(async (type: string | undefined, cmdOpts: Record<string, string>) => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir });
        const filterOpts = {
            after: cmdOpts.after,
            before: cmdOpts.before,
        };

        const result: Record<string, string[]> = {};
        const listType = type ?? "all";

        if (listType === "all" || listType === "daily") {
            result.dailies = await svc.files.listDailies(filterOpts);
        }
        if (listType === "all" || listType === "weekly") {
            result.weeklies = await svc.files.listWeeklies(filterOpts);
        }
        if (listType === "all" || listType === "monthly") {
            result.monthlies = await svc.files.listMonthlies(filterOpts);
        }
        if (listType === "all" || listType === "typed") {
            result.typedMemories = await svc.files.listTypedMemories();
        }

        if (globalOpts.json) {
            output(result, true);
        } else {
            for (const [category, files] of Object.entries(result)) {
                console.log(`\n${category}:`);
                if (files.length === 0) {
                    console.log("  (none)");
                } else {
                    for (const f of files) {
                        console.log(`  ${f}`);
                    }
                }
            }
        }
    });

// --- watch ---
program
    .command("watch")
    .description("Watch for changes and auto-sync/compact")
    .option("--compact", "Enable auto-compaction on threshold")
    .option("--debounce <ms>", "Debounce interval", "2000")
    .action(async (cmdOpts: Record<string, string>) => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir });
        const debounceMs = parseInt(cmdOpts.debounce) || 2000;

        console.log(
            `Watching ${path.resolve(globalOpts.dir)} (debounce: ${debounceMs}ms)...`,
        );

        const fs = await import("fs");
        let timer: ReturnType<typeof setTimeout> | null = null;

        const handleChange = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(async () => {
                try {
                    const stats = await svc.sync();
                    if (globalOpts.verbose) {
                        console.log(
                            `Synced: ${stats.documentCount} docs, ${stats.chunkCount} chunks`,
                        );
                    }
                } catch (err) {
                    console.error("Sync error:", err);
                }
            }, debounceMs);
        };

        fs.watch(
            path.resolve(globalOpts.dir),
            { recursive: true },
            handleChange,
        );
    });

// --- Run ---
function formatResult(r: { uri: string; score: number; text: string }): string {
    const scoreStr = (r.score * 100).toFixed(1);
    const preview = r.text.substring(0, 200).replace(/\n/g, " ");
    return `[${scoreStr}%] ${r.uri}\n  ${preview}${r.text.length > 200 ? "..." : ""}`;
}

program.parseAsync(process.argv).catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
});
