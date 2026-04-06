import type { MemoryModel } from "./interfaces/model.js";
import type { MemoryFiles } from "./files.js";

export interface CompactionConfig {
    model: MemoryModel;
    agentName?: string; // default: "Agent"
    dailyRetentionDays?: number; // default: 30
    weeklyRetentionWeeks?: number; // default: 52
    minDailiesForWeekly?: number; // default: 3
    minWeekliesForMonthly?: number; // default: 2
    autoCompactThreshold?: number; // default: 12000
    compressionTarget?: number; // default: 0.3
    extractTypedMemories?: boolean; // default: true
    wisdom?: WisdomConfig;
}

export interface WisdomConfig {
    maxEntries?: number; // default: 20
    autoDistill?: boolean; // default: true
    minMonthliesForDistill?: number; // default: 1
    categories?: string[];
    systemPrompt?: string;
}

export interface CompactOptions {
    level?: "weekly" | "monthly" | "wisdom";
    dryRun?: boolean;
}

export interface CompactionResult {
    filesCompacted: string[];
    filesCreated: string[];
    filesDeleted: string[];
    typedMemoriesExtracted: string[];
}

function emptyResult(): CompactionResult {
    return {
        filesCompacted: [],
        filesCreated: [],
        filesDeleted: [],
        typedMemoriesExtracted: [],
    };
}

function mergeResults(a: CompactionResult, b: CompactionResult): CompactionResult {
    return {
        filesCompacted: [...a.filesCompacted, ...b.filesCompacted],
        filesCreated: [...a.filesCreated, ...b.filesCreated],
        filesDeleted: [...a.filesDeleted, ...b.filesDeleted],
        typedMemoriesExtracted: [
            ...a.typedMemoriesExtracted,
            ...b.typedMemoriesExtracted,
        ],
    };
}

/**
 * Compaction pipeline: daily->weekly->monthly->wisdom.
 */
export class Compactor {
    private readonly _files: MemoryFiles;
    private readonly _config: CompactionConfig;

    constructor(files: MemoryFiles, config: CompactionConfig) {
        this._files = files;
        this._config = config;
    }

    /**
     * Run the full compaction pipeline (or up to the specified level).
     */
    async compact(options?: CompactOptions): Promise<CompactionResult> {
        const level = options?.level;
        const dryRun = options?.dryRun ?? false;

        let result = emptyResult();

        // Weekly compaction
        if (!level || level === "weekly") {
            const weeklyResult = await this.compactDaily(undefined, dryRun);
            result = mergeResults(result, weeklyResult);
        }

        // Monthly compaction
        if (!level || level === "monthly") {
            const monthlyResult = await this.compactWeekly(undefined, dryRun);
            result = mergeResults(result, monthlyResult);
        }

        // Wisdom distillation
        if (!level || level === "wisdom") {
            const wisdomResult = await this.distillWisdom(dryRun);
            result = mergeResults(result, wisdomResult);
        }

        return result;
    }

    /**
     * Compact daily logs into weekly summaries.
     */
    async compactDaily(
        week?: string,
        dryRun: boolean = false,
    ): Promise<CompactionResult> {
        const result = emptyResult();
        const minDailies = this._config.minDailiesForWeekly ?? 3;
        const retentionDays = this._config.dailyRetentionDays ?? 30;

        // Group dailies by ISO week
        const dailies = await this._files.listDailies();
        const weekGroups = groupByWeek(dailies);

        for (const [isoWeek, dates] of Object.entries(weekGroups)) {
            // If a specific week was requested, skip others
            if (week && isoWeek !== week) continue;

            // Skip if the week hasn't ended (current week)
            if (isCurrentWeek(isoWeek)) continue;

            // Skip if not enough dailies
            if (dates.length < minDailies) continue;

            // Skip if weekly already exists
            const existing = await this._files.readWeekly(isoWeek);
            if (existing) continue;

            // Collect daily content
            const dailyContents: string[] = [];
            for (const date of dates) {
                const content = await this._files.readDaily(date);
                if (content) {
                    dailyContents.push(`## ${date}\n\n${content}`);
                    result.filesCompacted.push(`memory/${date}.md`);
                }
            }

            if (dailyContents.length === 0) continue;

            if (!dryRun) {
                // Use the model to generate the weekly summary
                const summary = await this._config.model.complete(
                    dailyContents.join("\n\n---\n\n"),
                    {
                        systemPrompt: WEEKLY_SYSTEM_PROMPT,
                        temperature: 0.2,
                    },
                );

                if (summary.error) continue;

                const weeklyContent = `---\ntype: weekly\n---\n\n# Week ${isoWeek}\n\n${summary.text}`;
                await this._files.writeWeekly(isoWeek, weeklyContent);
                result.filesCreated.push(`memory/weekly/${isoWeek}.md`);

                // Extract typed memories if configured
                if (this._config.extractTypedMemories !== false) {
                    const extracted = await this._extractTypedMemories(
                        dailyContents.join("\n\n"),
                    );
                    result.typedMemoriesExtracted.push(...extracted);
                }

                // Delete old dailies past retention
                const cutoff = daysAgo(retentionDays);
                for (const date of dates) {
                    if (date < cutoff) {
                        await this._files.deleteDaily(date);
                        result.filesDeleted.push(`memory/${date}.md`);
                    }
                }
            }
        }

        return result;
    }

    /**
     * Compact weekly summaries into monthly summaries.
     */
    async compactWeekly(
        month?: string,
        dryRun: boolean = false,
    ): Promise<CompactionResult> {
        const result = emptyResult();
        const minWeeklies = this._config.minWeekliesForMonthly ?? 2;
        const retentionWeeks = this._config.weeklyRetentionWeeks ?? 52;

        const weeklies = await this._files.listWeeklies();
        const monthGroups = groupWeekliesByMonth(weeklies);

        for (const [yearMonth, weeks] of Object.entries(monthGroups)) {
            if (month && yearMonth !== month) continue;

            // Skip current month
            if (isCurrentMonth(yearMonth)) continue;

            // Skip if not enough weeklies
            if (weeks.length < minWeeklies) continue;

            // Skip if monthly already exists
            const existing = await this._files.readMonthly(yearMonth);
            if (existing) continue;

            const weeklyContents: string[] = [];
            for (const w of weeks) {
                const content = await this._files.readWeekly(w);
                if (content) {
                    weeklyContents.push(content);
                    result.filesCompacted.push(`memory/weekly/${w}.md`);
                }
            }

            if (weeklyContents.length === 0) continue;

            if (!dryRun) {
                const summary = await this._config.model.complete(
                    weeklyContents.join("\n\n---\n\n"),
                    {
                        systemPrompt: MONTHLY_SYSTEM_PROMPT,
                        temperature: 0.2,
                    },
                );

                if (summary.error) continue;

                const monthlyContent = `---\ntype: monthly\n---\n\n# ${yearMonth}\n\n${summary.text}`;
                await this._files.writeMonthly(yearMonth, monthlyContent);
                result.filesCreated.push(`memory/monthly/${yearMonth}.md`);

                // Delete old weeklies past retention
                const cutoff = weeksAgo(retentionWeeks);
                for (const w of weeks) {
                    if (w < cutoff) {
                        await this._files.deleteWeekly(w);
                        result.filesDeleted.push(`memory/weekly/${w}.md`);
                    }
                }
            }
        }

        return result;
    }

    /**
     * Distill wisdom from typed memories and monthly summaries.
     */
    async distillWisdom(dryRun: boolean = false): Promise<CompactionResult> {
        const result = emptyResult();
        const wisdomConfig = this._config.wisdom ?? {};
        const maxEntries = wisdomConfig.maxEntries ?? 20;

        // Gather inputs
        const currentWisdom = (await this._files.readWisdom()) ?? "";
        const typedMemories = await this._files.listTypedMemories();
        const monthlies = await this._files.listMonthlies();

        // Get latest monthly summary
        const latestMonthly = monthlies.length > 0
            ? await this._files.readMonthly(monthlies[monthlies.length - 1])
            : null;

        // Read typed memory contents
        const typedContents: string[] = [];
        for (const filename of typedMemories) {
            const content = await this._files.readTypedMemory(filename);
            if (content) {
                typedContents.push(`### ${filename}\n\n${content}`);
                result.filesCompacted.push(`memory/${filename}`);
            }
        }

        if (typedContents.length === 0 && !latestMonthly) return result;

        if (!dryRun) {
            const prompt = [
                "## Current Wisdom\n\n" + (currentWisdom || "(none)"),
                "## Typed Memories\n\n" + (typedContents.join("\n\n---\n\n") || "(none)"),
                latestMonthly
                    ? "## Latest Monthly Summary\n\n" + latestMonthly
                    : "",
            ]
                .filter(Boolean)
                .join("\n\n---\n\n");

            const agentName = this._config.agentName ?? "Agent";
            const todayDate = new Date().toISOString().split("T")[0];
            const systemPrompt =
                wisdomConfig.systemPrompt ?? wisdomSystemPrompt(maxEntries, agentName, todayDate);

            const completion = await this._config.model.complete(prompt, {
                systemPrompt,
                temperature: 0.3,
            });

            if (completion.error) return result;

            await this._files.writeWisdom(completion.text);
            result.filesCreated.push("WISDOM.md");
        }

        return result;
    }

    /**
     * Extract typed memories from compacted content.
     */
    private async _extractTypedMemories(
        content: string,
    ): Promise<string[]> {
        const completion = await this._config.model.complete(content, {
            systemPrompt: EXTRACT_TYPED_PROMPT,
            temperature: 0.2,
        });

        if (completion.error || !completion.text.trim()) return [];

        // Parse the model's output — expects JSON array of { filename, content }
        try {
            const extracted = JSON.parse(completion.text);
            if (!Array.isArray(extracted)) return [];

            const filenames: string[] = [];
            for (const item of extracted) {
                if (item.filename && item.content) {
                    await this._files.writeTypedMemory(
                        item.filename,
                        item.content,
                    );
                    filenames.push(item.filename);
                }
            }
            return filenames;
        } catch {
            // Model output wasn't valid JSON — skip extraction
            return [];
        }
    }
}

// --- Prompts ---

const WEEKLY_SYSTEM_PROMPT = `You are a memory compaction engine. You compress daily agent logs into a structured weekly summary.

<RULES>
- Output ONLY the sections described below. No preamble, no commentary, no frontmatter.
- Every claim must trace to a specific daily entry. Do not infer beyond what is written.
- Target approximately 30% of the combined input length.
- Preserve names — if an entry mentions a person or teammate, keep the attribution.

<OUTPUT_FORMAT>
Use exactly these sections:

### Key Outcomes
- (what was accomplished, shipped, merged, or resolved — one bullet per item)

### Decisions
- (decisions made, with rationale if stated — include the date)

### Blockers & Open Items
- (unresolved issues or items carried forward)

### Context
- (anything else worth preserving at the week level that doesn't fit above)

<COMPRESSION_RULES>
DROP these:
- Routine status checks and trivial updates
- Verbose tool output or error traces
- Entries repeated across multiple days without new information
- Work that was started and abandoned with no lasting impact

KEEP these:
- Decisions and their rationale
- Outcomes and deliverables
- Blockers, surprises, and things that changed direction
- Feedback received from others
- External references or resources discovered

Each bullet must be self-contained — readable without the original daily log.`;

const MONTHLY_SYSTEM_PROMPT = `You are a memory compaction engine. You compress weekly summaries into a single monthly summary. This is the "what mattered" layer — aggressive compression, not restating.

<RULES>
- Output ONLY the sections described below. No preamble, no commentary, no frontmatter.
- Every claim must trace to a specific weekly summary. Do not infer beyond what is written.
- Target approximately 30% of the combined input length.

<OUTPUT_FORMAT>
Use exactly these sections:

### Themes
- (recurring patterns, focus areas, or threads that spanned multiple weeks)

### Milestones
- (concrete things accomplished — shipped, resolved, decided, or delivered)

### Trajectory
- (where is the work heading? what shifted direction? what accelerated or stalled?)

### Carried Forward
- (unresolved blockers or open items that persist into the next month)

<COMPRESSION_RULES>
MERGE related items across weeks into single bullets. The most common failure is restating each week sequentially — synthesize instead.
DROP anything raised and resolved within the same week.
DROP week-level detail that does not represent a milestone, decision, or persistent blocker.
KEEP decisions that set direction, milestones that mark progress, and blockers that persisted across weeks.

Each bullet must be self-contained — readable without the original weekly summaries.`;

function wisdomSystemPrompt(maxEntries: number, agentName: string, todayDate: string): string {
    return `You are a wisdom distillation engine. You maintain a curated set of durable, actionable entries — decisions, invariants, gotchas, and validated patterns — by merging new material into an existing wisdom file.

<RULES>
- Output ONLY the complete updated wisdom file in the exact format below.
- Maximum ${maxEntries} entries. If merging would exceed the cap, drop the least durable entries first.
- Every entry must be actionable — it should change future behavior, not just record history.
- Do not include: implementation recipes derivable from code, ephemeral status, or task lists.
- Preserve the voice and phrasing of existing entries that haven't changed.

<DECISIONS>
For each item in the new material (typed memories and monthly summary), make exactly one decision:

MERGE — the insight updates, refines, or reinforces an existing entry. Edit the existing entry in place. Combine rather than duplicate.
ADD — the insight is genuinely new and durable. Add it. If at the cap, DROP a less durable entry to make room.
DROP — the insight is ephemeral, already covered, derivable from code, or contradicted by newer information.

Staleness rule: entries not reinforced by any new material in 3+ months are candidates for DROP.
Contradiction rule: when old and new conflict, newer information wins. Update or remove the stale entry.
Deduplication rule: if two entries say the same thing, merge into one — keep the richer version.

<OUTPUT_FORMAT>
# ${agentName} - Wisdom

Distilled principles. Read this first every session (after SOUL.md).

Last compacted: ${todayDate}

---

## {Category}

**{Entry title}**
{1-3 sentence principle. Lead with the actionable rule, not the history. If there is a "why", include it in one sentence.}

(repeat for each entry, organized by category if categories are configured, otherwise omit ## headings and use a flat list)`;
}

const EXTRACT_TYPED_PROMPT = `You extract durable knowledge from daily logs as typed memory entries.

<TYPES>
user — facts about a person's role, preferences, expertise, or working style
feedback — guidance on how to approach work: corrections OR validated approaches. Must include why.
project — decisions, goals, timelines, or context about ongoing work. Convert relative dates to absolute.
reference — pointers to external resources (URLs, tools, dashboards, channels)

<RULES>
- Output a JSON array. Each element: { "filename": "type_topic.md", "content": "..." }
- The filename pattern is: {type}_{topic}.md — use lowercase, hyphens for spaces (e.g., "feedback_testing-approach.md")
- The content field must include YAML frontmatter with name, description, and type fields, followed by the memory body
- For feedback and project types, structure the body as: statement, then **Why:** line, then **How to apply:** line
- If NO entries qualify, output: []

<CONSERVATIVE_BIAS>
When in doubt, skip. Do NOT extract:
- Facts derivable from code or git history
- Ephemeral task state (in-progress work that will change soon)
- Information already documented in existing files
- Routine status updates with no generalizable lesson

<EXAMPLE_OUTPUT>
[
  {
    "filename": "feedback_frontmatter-parsing.md",
    "content": "---\\nname: Frontmatter parsing\\ndescription: Use gray-matter for YAML frontmatter, not custom parsing\\ntype: feedback\\n---\\n\\nUse gray-matter for frontmatter parsing.\\n\\n**Why:** Custom parser flagged in PR review — gray-matter is battle-tested and handles edge cases.\\n\\n**How to apply:** Any code that reads or writes markdown frontmatter should use gray-matter."
  }
]`;

// --- Date helpers ---

function getISOWeek(dateStr: string): string {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil(
        ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
    );
    return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function groupByWeek(dates: string[]): Record<string, string[]> {
    const groups: Record<string, string[]> = {};
    for (const date of dates) {
        const week = getISOWeek(date);
        if (!groups[week]) groups[week] = [];
        groups[week].push(date);
    }
    return groups;
}

function groupWeekliesByMonth(weeks: string[]): Record<string, string[]> {
    // Map ISO weeks to their approximate month (based on the Thursday of that week)
    const groups: Record<string, string[]> = {};
    for (const week of weeks) {
        const match = week.match(/^(\d{4})-W(\d{2})$/);
        if (!match) continue;
        const year = parseInt(match[1]);
        const weekNum = parseInt(match[2]);
        // Approximate: get the Thursday of the ISO week
        const jan4 = new Date(Date.UTC(year, 0, 4));
        const dayOfWeek = jan4.getUTCDay() || 7;
        const monday = new Date(jan4.getTime());
        monday.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1 + (weekNum - 1) * 7);
        const thursday = new Date(monday.getTime());
        thursday.setUTCDate(monday.getUTCDate() + 3);
        const yearMonth = `${thursday.getUTCFullYear()}-${String(thursday.getUTCMonth() + 1).padStart(2, "0")}`;
        if (!groups[yearMonth]) groups[yearMonth] = [];
        groups[yearMonth].push(week);
    }
    return groups;
}

function isCurrentWeek(isoWeek: string): boolean {
    const now = new Date();
    const nowStr = now.toISOString().split("T")[0];
    return getISOWeek(nowStr) === isoWeek;
}

function isCurrentMonth(yearMonth: string): boolean {
    const now = new Date();
    const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    return current === yearMonth;
}

function daysAgo(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().split("T")[0];
}

function weeksAgo(weeks: number): string {
    const d = new Date();
    d.setDate(d.getDate() - weeks * 7);
    return getISOWeek(d.toISOString().split("T")[0]);
}
