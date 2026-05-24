import type { MemoryModel } from "./interfaces/model.js";
import type { MemoryIndex } from "./interfaces/index.js";
import type { MemoryFiles } from "./files.js";
import type { WikiEngine } from "./wiki-engine.js";
import type { WikiCategory } from "./wiki-types.js";
import { computeSalienceWeights, type SalienceWeights } from "./salience.js";

export interface CompactionConfig {
    model: MemoryModel;
    index?: MemoryIndex;
    agentName?: string; // default: "Agent"
    minDailiesForWeekly?: number; // default: 3
    minWeekliesForMonthly?: number; // default: 2
    autoCompactThreshold?: number; // default: 12000
    compressionTarget?: number; // default: 0.3
    extractTypedMemories?: boolean; // default: true
    /** Aggregation weighting strategy for parent embeddings (default: "salience") */
    aggregationStrategy?: "uniform" | "recency" | "salience";
    wisdom?: WisdomConfig;
    /**
     * Optional WikiEngine. When wired AND `enabled`, distillWisdom switches
     * to a structured prompt that (a) reads wiki pages as source material and
     * (b) emits topical promotions as wiki ops in addition to the principles
     * markdown. Knowledge Map regeneration also happens at the end of the
     * wisdom pass. When absent, distillWisdom keeps the legacy behavior
     * verbatim — typed memories + monthly summary → WISDOM.md text.
     */
    wiki?: WikiEngine;
}

export interface WisdomConfig {
    maxEntries?: number; // default: 20
    autoDistill?: boolean; // default: true
    minMonthliesForDistill?: number; // default: 1
    categories?: string[];
    systemPrompt?: string;
}

/**
 * A wiki promotion proposed by the wisdom distiller for a topical item that
 * shouldn't live in WISDOM.md. Mirrors the create-shape of `DreamWikiOp` but
 * lives here so the compactor doesn't take a runtime dep on dream-engine.
 */
export interface WisdomWikiPromotion {
    slug: string;
    category: WikiCategory;
    name: string;
    description: string;
    body: string;
    sources: string[];
    related?: string[];
}

export interface WisdomDistillResult {
    /** WISDOM.md content the model produced (principles + optional categories). */
    wisdom: string;
    /** Topical items the model elected to push into the wiki instead. */
    wiki_promotions: WisdomWikiPromotion[];
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
     * Eidetic: raw dailies are NEVER deleted. Parents store pointers + salience.
     */
    async compactDaily(
        week?: string,
        dryRun: boolean = false,
    ): Promise<CompactionResult> {
        const result = emptyResult();
        const minDailies = this._config.minDailiesForWeekly ?? 3;

        // Group dailies by ISO week
        const dailies = await this._files.listDailies();
        const weekGroups = groupByWeek(dailies);

        for (const [isoWeek, dates] of Object.entries(weekGroups)) {
            if (week && isoWeek !== week) continue;
            if (isCurrentWeek(isoWeek)) continue;
            if (dates.length < minDailies) continue;

            const existing = await this._files.readWeekly(isoWeek);
            if (existing) continue;

            // Collect daily content and build pointer URIs
            const dailyContents: { date: string; content: string }[] = [];
            const pointerUris: string[] = [];
            for (const date of dates) {
                const content = await this._files.readDaily(date);
                if (content) {
                    dailyContents.push({ date, content });
                    pointerUris.push(`memory/${date}.md`);
                    result.filesCompacted.push(`memory/${date}.md`);
                }
            }

            if (dailyContents.length === 0) continue;

            if (!dryRun) {
                const combinedText = dailyContents
                    .map((d) => `## ${d.date}\n\n${d.content}`)
                    .join("\n\n---\n\n");

                // Generate weekly summary
                const summary = await this._config.model.complete(
                    combinedText,
                    { systemPrompt: WEEKLY_SYSTEM_PROMPT, temperature: 0.2 },
                );
                if (summary.error) continue;

                // Compute salience weights
                const strategy = this._config.aggregationStrategy ?? "salience";
                let salienceMap: SalienceWeights = {};
                if (strategy === "salience") {
                    const entries = dailyContents.map((d) => ({
                        uri: `memory/${d.date}.md`,
                        text: d.content,
                    }));
                    salienceMap = await computeSalienceWeights(entries);
                } else {
                    // Uniform weights
                    const w = 1 / pointerUris.length;
                    for (const uri of pointerUris) {
                        salienceMap[uri] = Math.round(w * 100) / 100;
                    }
                }

                // Build frontmatter with pointers and salience
                const pointerYaml = pointerUris
                    .map((p) => `  - ${p}`)
                    .join("\n");
                const salienceYaml = Object.entries(salienceMap)
                    .map(([k, v]) => `  ${k}: ${v.toFixed(2)}`)
                    .join("\n");
                const weeklyContent = `---\ntype: weekly\nperiod: ${isoWeek}\npointers:\n${pointerYaml}\nsalience:\n${salienceYaml}\n---\n\n# Week ${isoWeek}\n\n${summary.text}`;
                await this._files.writeWeekly(isoWeek, weeklyContent);
                result.filesCreated.push(`memory/weekly/${isoWeek}.md`);

                // Compute and store dual embeddings if index is available
                if (this._config.index) {
                    await this._storeDualEmbeddings(
                        `weekly/${isoWeek}`,
                        summary.text,
                        pointerUris,
                        salienceMap,
                        { contentType: "weekly", period: isoWeek },
                    );
                }

                // Extract typed memories if configured
                if (this._config.extractTypedMemories !== false) {
                    const extracted = await this._extractTypedMemories(
                        combinedText,
                    );
                    result.typedMemoriesExtracted.push(...extracted);
                }

                // Eidetic: NO deletion of daily files
            }
        }

        return result;
    }

    /**
     * Compact weekly summaries into monthly summaries.
     * Eidetic: weekly nodes are NEVER deleted.
     */
    async compactWeekly(
        month?: string,
        dryRun: boolean = false,
    ): Promise<CompactionResult> {
        const result = emptyResult();
        const minWeeklies = this._config.minWeekliesForMonthly ?? 2;

        const weeklies = await this._files.listWeeklies();
        const monthGroups = groupWeekliesByMonth(weeklies);

        for (const [yearMonth, weeks] of Object.entries(monthGroups)) {
            if (month && yearMonth !== month) continue;
            if (isCurrentMonth(yearMonth)) continue;
            if (weeks.length < minWeeklies) continue;

            const existing = await this._files.readMonthly(yearMonth);
            if (existing) continue;

            const weeklyContents: { week: string; content: string }[] = [];
            const pointerUris: string[] = [];
            for (const w of weeks) {
                const content = await this._files.readWeekly(w);
                if (content) {
                    weeklyContents.push({ week: w, content });
                    pointerUris.push(`memory/weekly/${w}.md`);
                    result.filesCompacted.push(`memory/weekly/${w}.md`);
                }
            }

            if (weeklyContents.length === 0) continue;

            if (!dryRun) {
                const combinedText = weeklyContents
                    .map((w) => w.content)
                    .join("\n\n---\n\n");

                const summary = await this._config.model.complete(
                    combinedText,
                    { systemPrompt: MONTHLY_SYSTEM_PROMPT, temperature: 0.2 },
                );
                if (summary.error) continue;

                // Compute salience weights for weekly children
                const strategy = this._config.aggregationStrategy ?? "salience";
                let salienceMap: SalienceWeights = {};
                if (strategy === "salience") {
                    const entries = weeklyContents.map((w) => ({
                        uri: `memory/weekly/${w.week}.md`,
                        text: w.content,
                    }));
                    salienceMap = await computeSalienceWeights(entries);
                } else {
                    const w = 1 / pointerUris.length;
                    for (const uri of pointerUris) {
                        salienceMap[uri] = Math.round(w * 100) / 100;
                    }
                }

                const pointerYaml = pointerUris
                    .map((p) => `  - ${p}`)
                    .join("\n");
                const salienceYaml = Object.entries(salienceMap)
                    .map(([k, v]) => `  ${k}: ${v.toFixed(2)}`)
                    .join("\n");
                const monthlyContent = `---\ntype: monthly\nperiod: ${yearMonth}\npointers:\n${pointerYaml}\nsalience:\n${salienceYaml}\n---\n\n# ${yearMonth}\n\n${summary.text}`;
                await this._files.writeMonthly(yearMonth, monthlyContent);
                result.filesCreated.push(`memory/monthly/${yearMonth}.md`);

                // Compute and store dual embeddings if index is available
                if (this._config.index) {
                    await this._storeDualEmbeddings(
                        `monthly/${yearMonth}`,
                        summary.text,
                        pointerUris,
                        salienceMap,
                        { contentType: "monthly", period: yearMonth },
                    );
                }

                // Eidetic: NO deletion of weekly files
            }
        }

        return result;
    }

    /**
     * Distill wisdom from typed memories, wiki pages, and monthly summaries.
     *
     * When `config.wiki` is enabled, the distiller switches to a structured
     * JSON prompt that asks the model to (a) keep WISDOM.md principles-only
     * and (b) push topical content into wiki ops. The Knowledge Map section
     * is regenerated at the end. Wiki-disabled callers get the legacy
     * markdown prompt unchanged.
     */
    async distillWisdom(dryRun: boolean = false): Promise<CompactionResult> {
        const result = emptyResult();
        const wisdomConfig = this._config.wisdom ?? {};
        const maxEntries = wisdomConfig.maxEntries ?? 20;
        const wiki = this._config.wiki;
        const wikiActive = wiki?.enabled === true;

        // Gather inputs
        const currentWisdom = (await this._files.readWisdom()) ?? "";
        const typedMemories = await this._files.listTypedMemories();
        const monthlies = await this._files.listMonthlies();

        // Get latest monthly summary
        const latestMonthly = monthlies.length > 0
            ? await this._files.readMonthly(monthlies[monthlies.length - 1])
            : null;

        // Read typed memory contents (still relevant for repos that haven't
        // migrated yet via `recall wiki migrate-typed-memories`)
        const typedContents: string[] = [];
        for (const filename of typedMemories) {
            const content = await this._files.readTypedMemory(filename);
            if (content) {
                typedContents.push(`### ${filename}\n\n${content}`);
                result.filesCompacted.push(`memory/${filename}`);
            }
        }

        // Read wiki pages (when the wiki layer is enabled). Skip redirects
        // and stubs — they're either pointers (no content to distill) or
        // single-source observations that haven't compounded yet.
        const wikiContents: string[] = [];
        if (wikiActive) {
            const slugs = await wiki!.list("private");
            for (const slug of slugs) {
                const page = await wiki!.read(slug, "private");
                if (!page || page.redirectTo) continue;
                wikiContents.push(
                    `### wiki/${slug}.md (category: ${page.category}, sources: ${page.sources.length})\n\n` +
                        `**${page.name}** — ${page.description}\n\n${page.body.trim()}`,
                );
                result.filesCompacted.push(`memory/wiki/${slug}.md`);
            }
        }

        if (
            typedContents.length === 0 &&
            wikiContents.length === 0 &&
            !latestMonthly
        ) {
            return result;
        }

        if (!dryRun) {
            const agentName = this._config.agentName ?? "Agent";
            const todayDate = new Date().toISOString().split("T")[0];

            if (wikiActive) {
                // Wiki-aware structured path: model emits JSON with the
                // updated WISDOM markdown and a list of topical promotions.
                const prompt = [
                    "## Current Wisdom\n\n" + (currentWisdom || "(none)"),
                    typedContents.length > 0
                        ? "## Typed Memories\n\n" +
                          typedContents.join("\n\n---\n\n")
                        : "",
                    wikiContents.length > 0
                        ? "## Wiki Pages\n\n" +
                          wikiContents.join("\n\n---\n\n")
                        : "",
                    latestMonthly
                        ? "## Latest Monthly Summary\n\n" + latestMonthly
                        : "",
                ]
                    .filter(Boolean)
                    .join("\n\n---\n\n");

                const systemPrompt =
                    wisdomConfig.systemPrompt ??
                    wisdomStructuredSystemPrompt(
                        maxEntries,
                        agentName,
                        todayDate,
                    );

                const completion = await this._config.model.complete(prompt, {
                    systemPrompt,
                    temperature: 0.3,
                });
                if (completion.error) return result;

                const parsed = parseWisdomDistillResult(completion.text);
                if (!parsed) {
                    // Model returned something the structured parser couldn't
                    // make sense of. Fall back to writing the raw text into
                    // WISDOM.md so the pass isn't a total loss.
                    await this._files.writeWisdom(completion.text);
                    result.filesCreated.push("WISDOM.md");
                    return result;
                }

                // Apply wiki promotions. Failures are caught per-op and
                // surfaced via stderr-style logging — they shouldn't fail
                // the whole compaction.
                const promotedSlugs: string[] = [];
                for (const promo of parsed.wiki_promotions) {
                    try {
                        const existing = await wiki!.read(promo.slug, "private");
                        if (existing) {
                            await wiki!.append(
                                promo.slug,
                                promo.sources[0] ??
                                    `wisdom-distill:${todayDate}`,
                                promo.body,
                                "private",
                            );
                        } else {
                            await wiki!.stub({
                                slug: promo.slug,
                                name: promo.name,
                                description: promo.description,
                                category: promo.category,
                                source:
                                    promo.sources[0] ??
                                    `wisdom-distill:${todayDate}`,
                                body: promo.body,
                                related: promo.related ?? [],
                            });
                            for (const extra of promo.sources.slice(1)) {
                                await wiki!.append(
                                    promo.slug,
                                    extra,
                                    "",
                                    "private",
                                );
                            }
                        }
                        promotedSlugs.push(promo.slug);
                    } catch {
                        // Skip malformed promotions; the model proposed
                        // something the wiki rejected. The principles still
                        // get written below.
                    }
                }

                // Write WISDOM.md and regenerate the Knowledge Map. The
                // rebuildKnowledgeMap call always runs after wisdom is
                // written so the Map reflects any promotions just applied.
                await this._files.writeWisdom(parsed.wisdom);
                result.filesCreated.push("WISDOM.md");
                if (promotedSlugs.length > 0) {
                    for (const slug of promotedSlugs) {
                        result.filesCreated.push(`memory/wiki/${slug}.md`);
                    }
                }
                try {
                    await wiki!.rebuildKnowledgeMap();
                } catch {
                    // Best-effort — a Knowledge Map failure shouldn't fail
                    // the distillation pass.
                }
                return result;
            }

            // Legacy path: markdown-emitting prompt, behavior unchanged.
            const prompt = [
                "## Current Wisdom\n\n" + (currentWisdom || "(none)"),
                "## Typed Memories\n\n" +
                    (typedContents.join("\n\n---\n\n") || "(none)"),
                latestMonthly
                    ? "## Latest Monthly Summary\n\n" + latestMonthly
                    : "",
            ]
                .filter(Boolean)
                .join("\n\n---\n\n");

            const systemPrompt =
                wisdomConfig.systemPrompt ??
                wisdomSystemPrompt(maxEntries, agentName, todayDate);

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
     * Compute and store dual embeddings (aggregated + summary) for a parent node.
     */
    private async _storeDualEmbeddings(
        parentUri: string,
        summaryText: string,
        childUris: string[],
        salienceMap: SalienceWeights,
        baseMeta: { contentType: string; period: string },
    ): Promise<void> {
        const index = this._config.index!;

        // 1. Store the summary embedding via normal document upsert
        await index.upsertDocument(`${parentUri}#summary`, summaryText, {
            ...baseMeta,
            embeddingType: "summary",
        });

        // 2. Compute aggregated embedding from children
        const childEmbeddings: { uri: string; vec: number[] }[] = [];
        for (const uri of childUris) {
            // For weekly parents, children are raw dailies; for monthly, children are weeklies
            // Try to get the #agg embedding first (for weekly children), fall back to raw
            const aggUri = uri.replace(/\.md$/, "").replace(/^memory\//, "");
            let vec = await index.getEmbedding(`${aggUri}#agg`);
            if (!vec) {
                vec = await index.getEmbedding(uri);
            }
            if (vec) {
                childEmbeddings.push({ uri, vec });
            }
        }

        if (childEmbeddings.length === 0) return;

        // Compute weighted average
        const dim = childEmbeddings[0].vec.length;
        const agg = new Float64Array(dim);
        for (const { uri, vec } of childEmbeddings) {
            const weight = salienceMap[uri] ?? 1 / childEmbeddings.length;
            for (let i = 0; i < dim; i++) {
                agg[i] += weight * vec[i];
            }
        }

        // L2-normalize
        let norm = 0;
        for (let i = 0; i < dim; i++) norm += agg[i] * agg[i];
        norm = Math.sqrt(norm);
        const normalized = Array.from(agg).map((v) =>
            norm > 0 ? v / norm : 0,
        );

        await index.upsertEmbedding(`${parentUri}#agg`, normalized, {
            ...baseMeta,
            embeddingType: "agg",
        });
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

function wisdomStructuredSystemPrompt(
    maxEntries: number,
    agentName: string,
    todayDate: string,
): string {
    return `You are a wisdom distillation engine for an agent's long-term memory. Your job is to keep WISDOM.md PRINCIPLES-ONLY while pushing topical knowledge into the wiki.

<TWO_LAYER_RULE>
WISDOM.md should contain ONLY:
- Principles — actionable rules that apply across topics ("Plans should reduce ambiguity")
- Anti-patterns — things to avoid that span topics ("Practice drifts from templates")
- The Knowledge Map (regenerated automatically — don't include it in your output)

Topical material — anything about a specific person, project, system, or recurring theme — belongs in a wiki page, not WISDOM.md. Push it.

<TASK>
Examine the inputs (current WISDOM.md, typed memories, wiki pages, latest monthly summary). For each item, decide:

1. PRINCIPLE — actionable rule that applies across topics → keep in WISDOM.md
2. TOPICAL — concrete subject (person, project, concept, reference) → emit as a wiki promotion
3. DROP — ephemeral, already covered, or contradicted by newer info

<OUTPUT_FORMAT>
Respond with a single JSON object:

{
  "wisdom": "<the complete updated WISDOM.md markdown>",
  "wiki_promotions": [
    {
      "slug": "kebab-case-slug",
      "category": "entity" | "concept" | "project" | "reference" | "theme",
      "name": "Human-readable title",
      "description": "One-line description",
      "body": "Markdown body (use ## headings; no frontmatter, no H1)",
      "sources": ["memory/YYYY-MM-DD.md", ...],
      "related": ["other-slug", ...]
    }
  ]
}

<WISDOM_RULES>
- Maximum ${maxEntries} entries in WISDOM.md
- Every entry must be actionable — change future behavior, not just record history
- Do NOT include the Knowledge Map (regenerated separately)
- Preserve voice and phrasing of unchanged entries
- Use this skeleton for the wisdom field:

# ${agentName} - Wisdom

Distilled principles. Read this first every session (after SOUL.md).

Last compacted: ${todayDate}

---

## {Category}

**{Entry title}**
{1-3 sentence principle. Lead with the actionable rule. If there is a "why", include it in one sentence.}

(repeat for each entry; categories optional)

<WIKI_PROMOTION_RULES>
- Concept and project bodies SHOULD lead with a rule/fact followed by **Why:** and **How to apply:** lines
- Entity pages capture stable facts about a person, system, or organization
- Theme pages synthesize a recurring topic across many sources
- Reference pages catalog external URLs, dashboards, or runbooks
- Slugs are lowercase ASCII, hyphen-separated
- Sources must be URIs from the provided inputs — do not invent
- If an item already lives in the provided "Wiki Pages" input, propose an UPDATE: same slug, sources include the originating dailies/typed memories that motivated the update
- Do NOT promote an item to wiki AND keep it in WISDOM.md — pick one`;
}

/**
 * Parse the structured wisdom-distillation response. Tolerates a ``` fence
 * the model often wraps the JSON in, and verifies the required fields.
 * Returns null when the response is unparseable so the caller can fall back.
 */
function parseWisdomDistillResult(text: string): WisdomDistillResult | null {
    const trimmed = text.trim();
    // Strip a leading/trailing ```json fence if present.
    const unwrapped = trimmed
        .replace(/^```(?:json)?\s*\n/, "")
        .replace(/\n```\s*$/, "");
    let parsed: unknown;
    try {
        parsed = JSON.parse(unwrapped);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    const wisdom = obj.wisdom;
    if (typeof wisdom !== "string" || wisdom.trim().length === 0) return null;
    const rawPromotions = obj.wiki_promotions ?? obj.wikiPromotions ?? [];
    const promotions: WisdomWikiPromotion[] = [];
    const validCategories: WikiCategory[] = [
        "entity",
        "concept",
        "project",
        "reference",
        "theme",
    ];
    const slugRe = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    if (Array.isArray(rawPromotions)) {
        for (const raw of rawPromotions) {
            if (!raw || typeof raw !== "object") continue;
            const r = raw as Record<string, unknown>;
            const slug = typeof r.slug === "string" ? r.slug.trim() : "";
            if (!slug || !slugRe.test(slug)) continue;
            const category = r.category;
            if (
                typeof category !== "string" ||
                !validCategories.includes(category as WikiCategory)
            ) {
                continue;
            }
            const body = typeof r.body === "string" ? r.body : "";
            if (!body.trim()) continue;
            const sourcesIn = Array.isArray(r.sources)
                ? (r.sources as unknown[]).filter(
                      (s): s is string => typeof s === "string" && s.length > 0,
                  )
                : [];
            if (sourcesIn.length === 0) continue;
            promotions.push({
                slug,
                category: category as WikiCategory,
                name:
                    typeof r.name === "string" && r.name.length > 0
                        ? r.name
                        : slug,
                description:
                    typeof r.description === "string" ? r.description : "",
                body,
                sources: sourcesIn,
                related: Array.isArray(r.related)
                    ? (r.related as unknown[]).filter(
                          (s): s is string =>
                              typeof s === "string" && slugRe.test(s),
                      )
                    : undefined,
            });
        }
    }
    return { wisdom, wiki_promotions: promotions };
}

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

