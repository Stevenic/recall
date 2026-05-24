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

function getService(opts: {
    dir: string;
    agent?: string;
    enableWiki?: boolean;
}): MemoryService {
    const memoryRoot = path.resolve(opts.dir);
    const model = opts.agent
        ? new CliAgentModel({ agent: opts.agent })
        : undefined;
    return new MemoryService({
        memoryRoot,
        model,
        dreaming: { enabled: true, logSearches: true },
        wiki: opts.enableWiki ? { enabled: true } : undefined,
    });
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
    .option(
        "--wiki-boost <n>",
        "Wiki page score multiplier (defaults to config; 1.0 disables)",
    )
    .option("--no-wiki-boost", "Disable wiki score boost (sets multiplier to 1.0)")
    .option("--wiki-only", "Return only wiki pages")
    .option("--no-wiki", "Exclude wiki pages from results")
    .action(async (query: string, cmdOpts: any) => {
        const globalOpts = program.opts();
        // The CLI always enables the wiki path so --wiki-only / --wiki-boost
        // have something to act on. Indexing of wiki pages is gated by the
        // wiki layer being enabled in service config.
        const svc = getService({ dir: globalOpts.dir, enableWiki: true });
        const opts: any = {
            maxResults: parseInt(cmdOpts.results),
            maxChunks: parseInt(cmdOpts.maxChunks),
            maxTokens: parseInt(cmdOpts.maxTokens),
            recencyDepth: parseInt(cmdOpts.recencyDepth),
            typedMemoryBoost: parseFloat(cmdOpts.typedMemoryBoost),
            skipSync: cmdOpts.sync === false,
        };
        // commander turns `--no-wiki-boost` into `wikiBoost: false`. If the
        // user passed an explicit numeric `--wiki-boost <n>` it's a string.
        if (typeof cmdOpts.wikiBoost === "string") {
            opts.wikiBoost = parseFloat(cmdOpts.wikiBoost);
        } else if (cmdOpts.wikiBoost === false) {
            opts.wikiBoost = 1.0;
        }
        if (cmdOpts.wikiOnly) opts.wikiOnly = true;
        if (cmdOpts.wiki === false) opts.includeWiki = false;
        const results = await svc.search(query, opts);
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

// --- migrate ---
program
    .command("migrate")
    .description("Migrate to hierarchical memory architecture")
    .option("--to <target>", "Target architecture", "hierarchical")
    .option("--dry-run", "Report only, don't execute")
    .action(async (cmdOpts: Record<string, string | boolean>) => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir });
        const dryRun = "dryRun" in cmdOpts;

        if (cmdOpts.to !== "hierarchical") {
            output(
                globalOpts.json
                    ? { error: `Unknown target: ${cmdOpts.to}` }
                    : `Unknown migration target: ${cmdOpts.to}`,
                globalOpts.json,
            );
            process.exitCode = 1;
            return;
        }

        const report = await svc.migrateToHierarchical(dryRun);
        output(report, globalOpts.json);
    });

// --- dream ---
const dreamCmd = program
    .command("dream")
    .description("Run a dreaming session (asynchronous knowledge synthesis)")
    .option("--dry-run", "Show candidates without running LLM")
    .option("--phase <phase>", "Only run a specific phase (gather | analyze | write)")
    .option("--max-candidates <n>", "Max candidates to analyze", "20")
    .option("--agent <name>", "CLI agent for synthesis", "claude")
    .option("--no-wiki", "Disable wiki page writes for this session (legacy outputs only)")
    .action(async (cmdOpts: Record<string, string | boolean>) => {
        const globalOpts = program.opts();
        const svc = getService({
            dir: globalOpts.dir,
            agent: typeof cmdOpts.agent === "string" ? cmdOpts.agent : "claude",
            enableWiki: cmdOpts.wiki !== false,
        });

        const phases = typeof cmdOpts.phase === "string"
            ? [cmdOpts.phase as "gather" | "analyze" | "write"]
            : undefined;

        const result = await svc.dream({
            dryRun: "dryRun" in cmdOpts,
            maxCandidates: parseInt(cmdOpts.maxCandidates as string) || 20,
            phases,
            skipWiki: cmdOpts.wiki === false,
        });

        if (globalOpts.json) {
            output(result, true);
        } else {
            console.log(`Dreaming session complete:`);
            console.log(`  Candidates: ${result.candidatesExamined} of ${result.candidatesTotal} examined`);
            console.log(`  Insights: ${result.insights.length}`);
            console.log(`  Promotions: ${result.promotions.length}`);
            console.log(`  Contradictions: ${result.contradictions.length}`);
            console.log(`  Gaps: ${result.gaps.length}`);
            console.log(`  Wiki updates: ${result.wikiUpdates.length}`);
            console.log(`  LLM calls: ${result.modelCalls}`);

            if (result.insights.length > 0) {
                console.log(`\nInsights:`);
                for (const i of result.insights) {
                    console.log(`  - ${i.theme} (${i.confidence}, ${i.sources.length} sources)`);
                }
            }
            if (result.promotions.length > 0) {
                console.log(`\nPromotions:`);
                for (const p of result.promotions) {
                    console.log(`  - ${p}`);
                }
            }
            if (result.contradictions.length > 0) {
                console.log(`\nContradictions:`);
                for (const c of result.contradictions) {
                    console.log(`  - ${c.wisdomEntry}`);
                }
            }
            if (result.gaps.length > 0) {
                console.log(`\nGaps:`);
                for (const g of result.gaps) {
                    console.log(`  - "${g.query}" (${g.frequency} queries)`);
                }
            }
            if (result.wikiUpdates.length > 0) {
                console.log(`\nWiki updates:`);
                for (const u of result.wikiUpdates) {
                    const prefix = u.ok ? "  ✓" : "  ✗";
                    console.log(`${prefix} [[${u.slug}]] ${u.op}: ${u.detail}`);
                }
            }
        }
    });

dreamCmd
    .command("status")
    .description("Show dreaming status (last run, pending candidates, signal stats)")
    .action(async () => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir });
        const status = await svc.dreamStatus();

        if (globalOpts.json) {
            output(status, true);
        } else {
            console.log(`Dreaming status:`);
            console.log(`  Last run: ${status.lastRun ?? "never"}`);
            console.log(`  Pending candidates: ${status.pendingCandidates}`);
            console.log(`  Search log entries: ${status.searchLogEntries}`);
            if (status.searchLogOldest) {
                console.log(`  Search log oldest: ${status.searchLogOldest}`);
            }
        }
    });

// --- watch ---
program
    .command("watch")
    .description("Watch for changes and auto-sync/compact")
    .option("--compact", "Enable auto-compaction on threshold")
    .option("--dream", "Enable dreaming on schedule")
    .option("--dream-interval <ms>", "Dreaming interval in ms", "86400000")
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

        // Dreaming on interval
        if ("dream" in cmdOpts) {
            const dreamInterval = parseInt(cmdOpts.dreamInterval) || 86400000;
            console.log(`Dreaming enabled (interval: ${dreamInterval}ms)`);
            const dreamSvc = getService({
                dir: globalOpts.dir,
                agent: "claude",
            });
            setInterval(async () => {
                try {
                    const result = await dreamSvc.dream();
                    console.log(
                        `Dream session: ${result.insights.length} insights, ${result.promotions.length} promotions`,
                    );
                } catch (err) {
                    console.error("Dream error:", err);
                }
            }, dreamInterval);
        }
    });

// --- wiki ---
const wikiCmd = program
    .command("wiki")
    .description("Wiki page operations (list, show, stub, append, status)");

wikiCmd
    .command("targets")
    .description("List configured wiki targets and roles")
    .action(async () => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir, enableWiki: true });
        const targets = svc.wiki.resolveTargets();
        if (globalOpts.json) {
            output(targets, true);
        } else {
            for (const t of targets) {
                console.log(`${t.name} (${t.role}) — ${t.wikiDir}`);
            }
        }
    });

wikiCmd
    .command("list")
    .description("List wiki page slugs")
    .option("--shared <name>", "List pages in a shared wiki")
    .option("--all", "List across private + every shared wiki")
    .option("--stubs", "Only stubs (sources <= 1)")
    .option("--category <c>", "Filter by category")
    .action(async (cmdOpts: Record<string, string | boolean>) => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir, enableWiki: true });
        await svc.initialize();

        let entries: { target: string; slug: string }[];
        if ("all" in cmdOpts) {
            entries = await svc.wiki.listAll();
        } else {
            const target =
                typeof cmdOpts.shared === "string" ? cmdOpts.shared : "private";
            const slugs = await svc.wiki.list(target);
            entries = slugs.map((slug) => ({ target, slug }));
        }

        const stubsOnly = "stubs" in cmdOpts;
        const categoryFilter =
            typeof cmdOpts.category === "string" ? cmdOpts.category : null;

        const detailed: {
            target: string;
            slug: string;
            category: string;
            sources: number;
            description: string;
        }[] = [];
        for (const { target, slug } of entries) {
            const page = await svc.wiki.read(slug, target);
            if (!page) continue;
            if (categoryFilter && page.category !== categoryFilter) continue;
            if (stubsOnly && page.sources.length > 1) continue;
            detailed.push({
                target,
                slug,
                category: page.category,
                sources: page.sources.length,
                description: page.description,
            });
        }

        if (globalOpts.json) {
            output(detailed, true);
        } else if (detailed.length === 0) {
            console.log("(no wiki pages)");
        } else {
            for (const d of detailed) {
                const stub = d.sources <= 1 ? " (stub)" : "";
                const tgt = d.target === "private" ? "" : `[${d.target}] `;
                console.log(
                    `${tgt}${d.slug} [${d.category}]${stub} — ${d.description}`,
                );
            }
        }
    });

wikiCmd
    .command("show <slug>")
    .description("Print a wiki page")
    .option("--shared <name>", "Read from a shared wiki")
    .action(async (slug: string, cmdOpts: Record<string, string>) => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir, enableWiki: true });
        await svc.initialize();
        const target =
            typeof cmdOpts.shared === "string" ? cmdOpts.shared : "private";
        const page = await svc.wiki.read(slug, target);
        if (!page) {
            output(
                globalOpts.json
                    ? { error: "Page not found", slug, target }
                    : `Page not found: ${slug} (target: ${target})`,
                globalOpts.json,
            );
            process.exitCode = 1;
            return;
        }
        if (globalOpts.json) {
            output(page, true);
        } else {
            console.log(
                `# ${page.name} [${page.category}] (${page.sources.length} source${page.sources.length === 1 ? "" : "s"})`,
            );
            console.log(`Slug: ${page.slug}`);
            console.log(
                `Created: ${page.created} | Updated: ${page.updated} | Confidence: ${page.confidence ?? "—"}`,
            );
            console.log(`Description: ${page.description}`);
            console.log("");
            console.log(page.body.trimEnd());
        }
    });

wikiCmd
    .command("stub <slug>")
    .description("Create a stub wiki page from a category template")
    .requiredOption(
        "--category <c>",
        "Category: entity | concept | project | reference",
    )
    .requiredOption("--name <name>", "Display name for the page")
    .requiredOption("--description <text>", "One-line description")
    .requiredOption("--lede <text>", "Lede paragraph")
    .option("--why <text>", "Required for concept and project categories")
    .option("--how-to-apply <text>", "Required for concept and project")
    .option("--where <text>", "Used by reference category")
    .option("--when <text>", "Used by reference category")
    .option("--source <uri>", "Source URI (default: today's daily log)")
    .option("--shared <name>", "Stub directly in a shared wiki")
    .action(async (slug: string, cmdOpts: Record<string, string>) => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir, enableWiki: true });
        await svc.initialize();
        const today = new Date().toISOString().split("T")[0];
        const source =
            cmdOpts.source ?? `memory/${today}.md`;
        const target =
            typeof cmdOpts.shared === "string" ? cmdOpts.shared : "private";

        const { renderStubBody } = await import("./wiki-templates.js");
        const body = renderStubBody(
            cmdOpts.category as
                | "entity"
                | "concept"
                | "project"
                | "reference",
            {
                lede: cmdOpts.lede,
                why: cmdOpts.why,
                howToApply: cmdOpts.howToApply,
                where: cmdOpts.where,
                when: cmdOpts.when,
            },
        );
        const page = await svc.wiki.stub({
            slug,
            name: cmdOpts.name,
            description: cmdOpts.description,
            category: cmdOpts.category as
                | "entity"
                | "concept"
                | "project"
                | "reference",
            source,
            body,
            target,
        });
        await svc.wiki.rebuildIndex(target);
        output(
            globalOpts.json
                ? page
                : `Stubbed ${target === "private" ? "" : `[${target}] `}${page.slug} (${page.category})`,
            globalOpts.json,
        );
    });

wikiCmd
    .command("append <slug>")
    .description("Append a source + body fragment to an existing wiki page")
    .requiredOption("--source <uri>", "Source URI to add")
    .requiredOption("--body <text>", "Body fragment to append")
    .option("--shared <name>", "Append to a shared wiki page")
    .action(async (slug: string, cmdOpts: Record<string, string>) => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir, enableWiki: true });
        await svc.initialize();
        const target =
            typeof cmdOpts.shared === "string" ? cmdOpts.shared : "private";
        const page = await svc.wiki.append(
            slug,
            cmdOpts.source,
            cmdOpts.body,
            target,
        );
        await svc.wiki.rebuildIndex(target);
        output(
            globalOpts.json
                ? page
                : `Appended source to ${target === "private" ? "" : `[${target}] `}${page.slug} (${page.sources.length} source${page.sources.length === 1 ? "" : "s"} now)`,
            globalOpts.json,
        );
    });

wikiCmd
    .command("lint")
    .description("Validate the private wiki (broken links, orphans, stale, drift, contradictions)")
    .option("--include-shared", "Also lint shared wikis")
    .action(async (cmdOpts: any) => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir, enableWiki: true });
        await svc.initialize();
        const report = await svc.wiki.lint({
            includeShared: cmdOpts.includeShared === true,
        });
        if (globalOpts.json) {
            output(report, true);
            return;
        }
        const totalScanned = Object.values(report.scanned).reduce(
            (a, b) => a + b,
            0,
        );
        console.log(`Scanned ${totalScanned} page(s) across ${Object.keys(report.scanned).length} target(s).`);
        if (report.brokenLinks.length > 0) {
            console.log(`\nBroken links (${report.brokenLinks.length}):`);
            for (const b of report.brokenLinks) {
                console.log(`  ${b.from} → [[${b.target === "private" ? "" : b.target + ":"}${b.toSlug}]]`);
            }
        }
        if (report.orphans.length > 0) {
            console.log(`\nOrphans — no inbound links (${report.orphans.length}):`);
            for (const o of report.orphans) console.log(`  ${o}`);
        }
        if (report.stalePages.length > 0) {
            console.log(`\nStale pages (${report.stalePages.length}):`);
            for (const s of report.stalePages) {
                console.log(`  ${s.slug} — last updated ${s.updated}`);
            }
        }
        if (report.missingCategory.length > 0) {
            console.log(`\nMissing category (${report.missingCategory.length}):`);
            for (const m of report.missingCategory) console.log(`  ${m}`);
        }
        if (report.slugDrift.length > 0) {
            console.log(`\nSlug drift (${report.slugDrift.length}):`);
            for (const d of report.slugDrift) {
                console.log(`  ${d.file} → frontmatter declares "${d.declaredSlug}"`);
            }
        }
        if (report.contradictionLoops.length > 0) {
            console.log(`\nContradiction loops (${report.contradictionLoops.length}):`);
            for (const [a, b] of report.contradictionLoops) {
                console.log(`  ${a} ↔ ${b}`);
            }
        }
        if (report.unknownTargets.length > 0) {
            console.log(`\nUnknown shared-wiki targets (${report.unknownTargets.length}):`);
            for (const u of report.unknownTargets) {
                console.log(`  ${u.from} → [[${u.targetName}:…]]`);
            }
        }
        const issueCount =
            report.brokenLinks.length +
            report.orphans.length +
            report.stalePages.length +
            report.missingCategory.length +
            report.slugDrift.length +
            report.contradictionLoops.length +
            report.unknownTargets.length;
        if (issueCount === 0) console.log("\nNo issues found.");
    });

wikiCmd
    .command("merge <src> <dst>")
    .description("Merge two wiki pages (leaves a redirect at src)")
    .option("--shared <name>", "Operate within a shared wiki")
    .action(async (src: string, dst: string, cmdOpts: any) => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir, enableWiki: true });
        await svc.initialize();
        const target: string = cmdOpts.shared ?? "private";
        await svc.wiki.merge(src, dst, target);
        await svc.wiki.rebuildIndex(target);
        output(
            globalOpts.json
                ? { merged: { src, dst, target } }
                : `Merged "${src}" into "${dst}" (${target === "private" ? "private" : `[${target}]`}). Redirect left at "${src}".`,
            globalOpts.json,
        );
    });

wikiCmd
    .command("rename <oldSlug> <newSlug>")
    .description("Rename a wiki page (leaves a redirect at the old slug)")
    .option("--shared <name>", "Operate within a shared wiki")
    .action(async (oldSlug: string, newSlug: string, cmdOpts: any) => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir, enableWiki: true });
        await svc.initialize();
        const target: string = cmdOpts.shared ?? "private";
        await svc.wiki.rename(oldSlug, newSlug, target);
        await svc.wiki.rebuildIndex(target);
        output(
            globalOpts.json
                ? { renamed: { from: oldSlug, to: newSlug, target } }
                : `Renamed "${oldSlug}" → "${newSlug}" (${target === "private" ? "private" : `[${target}]`}). Redirect left at "${oldSlug}".`,
            globalOpts.json,
        );
    });

wikiCmd
    .command("rebuild [slug]")
    .description("Regenerate a wiki page (or every page with --all) from sources via LLM")
    .option("--all", "Rebuild every multi-source page in the target")
    .option("--shared <name>", "Operate within a shared wiki")
    .option(
        "--agent <name>",
        "CLI agent to drive synthesis (claude/codex/copilot)",
        "claude",
    )
    .action(async (slug: string | undefined, cmdOpts: any) => {
        const globalOpts = program.opts();
        const svc = getService({
            dir: globalOpts.dir,
            enableWiki: true,
            agent: cmdOpts.agent,
        });
        await svc.initialize();
        const target: string = cmdOpts.shared ?? "private";
        if (cmdOpts.all) {
            const report = await svc.wiki.rebuildAll(target);
            output(
                globalOpts.json
                    ? report
                    : `Rebuilt ${report.rebuilt.length} page(s); skipped ${report.skipped.length}; failed ${report.failed.length}.\n` +
                          (report.failed.length > 0
                              ? "Failures:\n" +
                                report.failed
                                    .map((f) => `  ${f.slug}: ${f.reason}`)
                                    .join("\n")
                              : ""),
                globalOpts.json,
            );
            return;
        }
        if (!slug) {
            console.error("Provide a slug, or use --all to rebuild every page.");
            process.exitCode = 1;
            return;
        }
        const page = await svc.wiki.rebuild(slug, target);
        output(
            globalOpts.json
                ? page
                : `Rebuilt "${slug}" (${page.sources.length} source${page.sources.length === 1 ? "" : "s"}, confidence: ${page.confidence ?? "unset"}).`,
            globalOpts.json,
        );
    });

wikiCmd
    .command("migrate-insights")
    .description("Convert legacy memory/dreams/insights/*.md into wiki pages (idempotent, non-destructive)")
    .action(async () => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir, enableWiki: true });
        await svc.initialize();
        const report = await svc.wiki.migrateInsights();
        if (globalOpts.json) {
            output(report, true);
            return;
        }
        console.log(`Created ${report.created.length} wiki page(s); skipped ${report.skipped.length}.`);
        if (report.created.length > 0) {
            console.log("\nCreated:");
            for (const slug of report.created) console.log(`  ${slug}`);
        }
        if (report.skipped.length > 0) {
            console.log("\nSkipped:");
            for (const s of report.skipped) console.log(`  ${s.file}: ${s.reason}`);
        }
    });

wikiCmd
    .command("status")
    .description("Per-target page counts and identity summary")
    .action(async () => {
        const globalOpts = program.opts();
        const svc = getService({ dir: globalOpts.dir, enableWiki: true });
        await svc.initialize();
        const targets = svc.wiki.resolveTargets();
        const identity = await svc.identity.resolve();
        type TargetStatus = {
            target: string;
            role: "member" | "reader";
            wikiDir: string;
            total: number;
            stubs: number;
            byCategory: Record<string, number>;
        };
        const perTarget: TargetStatus[] = [];
        for (const t of targets) {
            const slugs = await svc.wiki.list(t.name);
            let stubs = 0;
            const byCategory: Record<string, number> = {};
            for (const slug of slugs) {
                const page = await svc.wiki.read(slug, t.name);
                if (!page) continue;
                if (page.sources.length <= 1) stubs += 1;
                byCategory[page.category] =
                    (byCategory[page.category] ?? 0) + 1;
            }
            perTarget.push({
                target: t.name,
                role: t.role,
                wikiDir: t.wikiDir,
                total: slugs.length,
                stubs,
                byCategory,
            });
        }

        if (globalOpts.json) {
            output(
                {
                    identity: {
                        name: identity.name,
                        role: identity.role,
                        fallback: identity.fallback,
                        path: identity.resolvedPath,
                    },
                    targets: perTarget,
                },
                true,
            );
        } else {
            const idLabel = identity.fallback
                ? `${identity.name} (fallback — IDENTITY.md missing or empty)`
                : `${identity.name}`;
            console.log(`Identity: ${idLabel}`);
            console.log(`  ${identity.role}`);
            console.log("");
            for (const t of perTarget) {
                console.log(
                    `${t.target} (${t.role}): ${t.total} pages, ${t.stubs} stubs`,
                );
                for (const [cat, n] of Object.entries(t.byCategory)) {
                    console.log(`  ${cat}: ${n}`);
                }
            }
        }
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
