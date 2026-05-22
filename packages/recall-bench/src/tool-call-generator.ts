/**
 * Tool-Call Generator — Pass 3 of the persona generation pipeline.
 *
 * Takes generated daily memory logs and produces the **tool calls** the agent
 * would have made into a long-term memory store (`memorySave`). Each call
 * captures one durable item — a fact, preference, decision, hard rule, or
 * status milestone — that the agent would want to recall on a future day.
 *
 * Output: `personas/<id>/tools-NNNd/day-NNNN.yaml`. The hand-authored
 * `personas/executive-assistant/tools-180d/day-0001.yaml` is the canonical
 * reference for shape and voice. See specs/recall-bench-loki.md §3.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import type {
    GeneratedToolCalls,
    GeneratorModel,
    PersonaDefinition,
    ToolCallEntry,
    ToolCallFile,
    ToolCallGenerationResult,
    ToolCallGeneratorConfig,
} from './generator-types.js';

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const TOOL_CALL_SYSTEM_PROMPT = `You are converting a persona agent's daily memory log into the tool calls that agent would have made into a long-term memory store. The store has one tool: \`memorySave(content: string)\`. Each call captures ONE durable item — a fact, preference, decision, hard rule, or status milestone — that the agent would want to recall on a future day.

Rules:

1. **Durable items only.** Save facts, preferences, hard rules, decisions made, status milestones, sensitivity boundaries, participant rosters, dated commitments. DO NOT save process narrative ("I opened the thread", "I documented the cadence", "I logged the touchpoint"), routine acknowledgements, or one-off observations the agent would not re-read.

2. **One memorySave per atomic item.** Do not pack multiple unrelated facts into one call. If a single durable item is intrinsically a list (calendar rules, preference profile, participant roster), keep it as one call with a bulleted body.

3. **Session attribution is authoritative.** Each call has a \`session\` field naming the \`# session: <id>\` H1 the item lives under in the memory log. Pre-H1 internal narration almost never produces durable saves; only use \`session: internal\` when truly unavoidable.

4. **Calendar voice — real dates, never arc-day numbers.** Reference "2026-01-01", "by end of January", "around the Q2 board" — never "day 1" or "the corpus". The agent does not know it lives inside a bounded simulation.

5. **First-person agent voice.** Write as the agent saving for its own future use: "I'll validate...", "Jamie's morning briefing preference (provisional baseline...)". Quote the principal and other speakers verbatim when material; mark paraphrases as such.

6. **Order matters.** Within \`calls\`, group by session in the order the sessions appear in the day's memory log. Within each session, list calls in the order the durable items appear in the source.

7. **Be selective.** A typical day produces 8–18 tool calls. Dense days with onboarding, kickoffs, or multiple decisions may produce more (~20). Quiet days may produce 3–6. If the log is mostly process narrative with little durable content, fewer calls is correct.

Output a single JSON object with this exact shape:

{
  "calls": [
    { "session": "<session-id>", "tool": "memorySave", "content": "<free-text>" },
    ...
  ]
}

Output ONLY the JSON. No markdown fences, no commentary.`;

function buildToolCallPrompt(
    persona: PersonaDefinition,
    dayNumber: number,
    calendarDate: string,
    dayOfWeek: string,
    dayLog: string,
    previousDayCalls?: string,
): string {
    const sessionLines = (persona.sessions ?? [])
        .map((s) => {
            const flags: string[] = [s.kind];
            if (s.isolated) flags.push('isolated');
            return `  - ${s.id} (${flags.join(', ')})`;
        })
        .join('\n');

    const castLines = (persona.cast ?? [])
        .slice(0, 30)
        .map((c) => `  - ${c.name} — ${c.role}`)
        .join('\n');

    const sharedKnowledgeLines = (persona.sharedKnowledge ?? [])
        .map((k) => `  - ${k}`)
        .join('\n');

    const principalLine = persona.principal
        ? `${persona.principal.name} (${persona.principal.role})`
        : '(not specified)';

    const prevSection = previousDayCalls
        ? `\nPrevious day's tool calls (for voice continuity — do NOT copy):\n---\n${previousDayCalls.trim()}\n---\n`
        : '';

    return `Convert the following memory log into the agent's memorySave tool calls.

Persona: ${persona.name}
Role: ${persona.role}
Domain: ${persona.domain}
Principal: ${principalLine}

Communication style:
${persona.communication_style.trim()}

Sessions:
${sessionLines || '  (none defined)'}

Cast (other humans/agents the persona works with):
${castLines || '  (none defined)'}

Shared knowledge (global facts available to every session):
${sharedKnowledgeLines || '  (none)'}

Day ${dayNumber} — ${calendarDate} (${dayOfWeek})

Daily memory log:
---
${dayLog.trim()}
---
${prevSection}
Output ONLY the JSON object: { "calls": [ ... ] }`;
}

// ---------------------------------------------------------------------------
// ToolCallGenerator
// ---------------------------------------------------------------------------

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export class ToolCallGenerator {
    private persona: PersonaDefinition;
    private model: GeneratorModel;
    private epoch?: string;
    private config: Required<Omit<ToolCallGeneratorConfig, 'onDay' | 'epoch'>> & Pick<ToolCallGeneratorConfig, 'onDay'>;

    constructor(
        persona: PersonaDefinition,
        model: GeneratorModel,
        config: ToolCallGeneratorConfig = {},
    ) {
        this.persona = persona;
        this.model = model;
        this.epoch = config.epoch ?? persona.epoch;
        this.config = {
            temperature: config.temperature ?? 0.3,
            maxTokens: config.maxTokens ?? 4000,
            startDay: config.startDay ?? 1,
            endDay: config.endDay ?? 1000,
            onDay: config.onDay,
        };
    }

    /**
     * Generate tool calls for all days in [startDay, endDay] from a directory
     * of day log files (`day-NNNN.md`). Days whose log file is missing are
     * skipped silently.
     */
    async generateAll(dayLogsDir: string): Promise<ToolCallGenerationResult> {
        const days: GeneratedToolCalls[] = [];
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let previousYaml: string | undefined;

        for (let dayNumber = this.config.startDay; dayNumber <= this.config.endDay; dayNumber++) {
            const padded = String(dayNumber).padStart(4, '0');
            const filePath = join(dayLogsDir, `day-${padded}.md`);

            let dayLog: string;
            try {
                dayLog = await readFile(filePath, 'utf-8');
            } catch {
                continue;
            }

            let result: GeneratedToolCalls;
            try {
                result = await this.generateDay(dayNumber, dayLog, previousYaml);
            } catch (err) {
                process.stderr.write(`\n[tool-call-generator] day ${dayNumber} failed: ${(err as Error).message}\n`);
                continue;
            }
            if (result.calls.length === 0) {
                process.stderr.write(`\n[tool-call-generator] day ${dayNumber} produced no parseable calls; skipping write.\n`);
                continue;
            }
            days.push(result);
            totalInputTokens += result.inputTokens ?? 0;
            totalOutputTokens += result.outputTokens ?? 0;

            const yamlBody = serializeToolCallsYaml({
                day: result.dayNumber,
                date: result.calendarDate,
                day_of_week: result.dayOfWeek,
                persona: this.persona.id,
                calls: result.calls,
            });

            if (this.config.onDay) {
                await this.config.onDay(dayNumber, yamlBody);
            }

            previousYaml = yamlBody;
        }

        return {
            personaId: this.persona.id,
            days,
            totalInputTokens,
            totalOutputTokens,
        };
    }

    /**
     * Generate tool calls for a single day given its log content.
     */
    async generateDay(dayNumber: number, dayLog: string, previousDayYaml?: string): Promise<GeneratedToolCalls> {
        const calendarDate = extractDateFromLog(dayLog) ?? deriveDate(this.epoch, dayNumber);
        const dayOfWeek = dayOfWeekFor(calendarDate);

        const result = await this.model.complete(
            TOOL_CALL_SYSTEM_PROMPT,
            buildToolCallPrompt(
                this.persona,
                dayNumber,
                calendarDate,
                dayOfWeek,
                dayLog,
                previousDayYaml,
            ),
            { maxTokens: this.config.maxTokens, temperature: this.config.temperature },
        );

        const calls = parseToolCallsJson(result.text);

        const out: GeneratedToolCalls = {
            dayNumber,
            calendarDate,
            dayOfWeek,
            calls,
        };
        if (result.inputTokens !== undefined) out.inputTokens = result.inputTokens;
        if (result.outputTokens !== undefined) out.outputTokens = result.outputTokens;
        return out;
    }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Pull the YYYY-MM-DD from a memory log's frontmatter, if present. */
function extractDateFromLog(log: string): string | undefined {
    const match = log.match(/^date:\s*"?(\d{4}-\d{2}-\d{2})"?\s*$/m);
    return match?.[1];
}

/** Compute a calendar date by adding `dayNumber - 1` days to the epoch. */
function deriveDate(epoch: string | undefined, dayNumber: number): string {
    if (!epoch) return '';
    const start = new Date(epoch + 'T00:00:00Z');
    if (Number.isNaN(start.getTime())) return '';
    start.setUTCDate(start.getUTCDate() + (dayNumber - 1));
    return start.toISOString().slice(0, 10);
}

function dayOfWeekFor(isoDate: string): string {
    if (!isoDate) return '';
    const d = new Date(isoDate + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return '';
    return DAYS_OF_WEEK[d.getUTCDay()];
}

/**
 * Parse the LLM's JSON output into a validated list of tool calls.
 * Strips markdown fences and is tolerant of leading/trailing prose.
 */
export function parseToolCallsJson(text: string): ToolCallEntry[] {
    let cleaned = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return [];
    cleaned = cleaned.slice(start, end + 1);

    let parsed: unknown;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        return [];
    }

    const callsRaw = (parsed as { calls?: unknown })?.calls;
    if (!Array.isArray(callsRaw)) return [];

    const calls: ToolCallEntry[] = [];
    for (const c of callsRaw) {
        if (!c || typeof c !== 'object') continue;
        const obj = c as { session?: unknown; tool?: unknown; content?: unknown };
        const session = typeof obj.session === 'string' ? obj.session.trim() : '';
        const tool = typeof obj.tool === 'string' ? obj.tool.trim() : '';
        const content = typeof obj.content === 'string' ? obj.content.trim() : '';
        if (!session || tool !== 'memorySave' || !content) continue;
        calls.push({ session, tool: 'memorySave', content });
    }
    return calls;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Render a ToolCallFile as YAML matching the hand-authored exemplar
 * (`personas/executive-assistant/tools-180d/day-0001.yaml`):
 *   - Top-level scalar fields (day, date, day_of_week, persona) first.
 *   - `calls:` array, one entry per memorySave with `content` as a `|` block
 *     scalar so multi-line free-text reads naturally and diffs cleanly.
 */
export function serializeToolCallsYaml(file: ToolCallFile): string {
    const doc = new YAML.Document(file);

    // Walk into the `calls` sequence and force each call's `content` to use a
    // literal block scalar. The `yaml` library auto-picks between plain,
    // single-quoted, double-quoted, folded, and literal — for multi-line
    // markdown-flavored prose, literal (`|`) is the only readable option.
    const calls = doc.get('calls') as { items?: unknown[] } | undefined;
    if (calls && Array.isArray(calls.items)) {
        for (const node of calls.items) {
            const callNode = node as { get?: (k: string) => unknown };
            const contentNode = callNode.get?.('content') as { type?: string } | undefined;
            if (contentNode && typeof contentNode === 'object') {
                (contentNode as { type: string }).type = 'BLOCK_LITERAL';
            }
        }
    }

    const yamlBody = doc.toString({ lineWidth: 0 });

    const header = `# ${file.date} — Tool calls (memorySave invocations) for ${file.persona} day ${file.day}.
# Generated by recall-bench generate-tool-calls (Pass 3).
# Each entry is a single tool call the agent made during the named session
# today. See specs/recall-bench-loki.md §3 for the schema and voice rules.

`;
    return header + yamlBody;
}

/**
 * Parse a tool-call YAML file back into the typed shape. Used by the harness
 * to load `tools-NNNd/day-NNNN.yaml` for adapters that consume tool calls.
 */
export function parseToolCallsYaml(yamlBody: string): ToolCallFile {
    const data = YAML.parse(yamlBody) as ToolCallFile;
    return data;
}
