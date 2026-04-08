/**
 * Day Generator — produces daily memory logs for benchmark personas.
 *
 * Implements the sequential generation pipeline from specs/day-generator.md:
 *   persona.yaml + arcs.yaml → 1,000 daily markdown logs per persona.
 *
 * Each day's prompt is assembled from:
 *   - Static system prompt (persona profile)
 *   - Day context (date, density hint)
 *   - Active arcs with phase annotations
 *   - Directives (key events that must appear)
 *   - Correction state (for correction arcs)
 *   - Arc summaries (for long-running arcs > 30 days)
 *   - Recent history (sliding window of previous 3 days)
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import type {
    ActiveArc,
    ArcDefinition,
    ArcPhase,
    ArcSummary,
    CorrectionPhase,
    CorrectionState,
    DayContext,
    DensityHint,
    Directive,
    GeneratedDay,
    GenerationResult,
    GeneratorConfig,
    GeneratorModel,
    PersonaDefinition,
    RecentDay,
} from './generator-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ARC_SUMMARY_COMPRESS_PROMPT = `Compress this arc progress log into a ~100-word status summary.
Keep: current status, key metrics, blocking issues, recent decisions.
Drop: routine progress, repeated information, resolved issues.

Arc: {{title}}
Running log:
{{log}}`;

// ---------------------------------------------------------------------------
// Phase & Density Calculation (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Compute the phase of an arc based on how far through it the current day is.
 *   early:      < 15% of arc length
 *   mid:        15%–75%
 *   late:       75%–90%
 *   concluding: > 90%
 */
export function computePhase(dayInArc: number, arcLength: number): ArcPhase {
    if (arcLength <= 0) return 'mid';
    const pct = dayInArc / arcLength;
    if (pct < 0.15) return 'early';
    if (pct <= 0.75) return 'mid';
    if (pct <= 0.90) return 'late';
    return 'concluding';
}

/**
 * Get arcs active on a given day, annotated with phase information.
 */
export function getActiveArcs(arcs: ArcDefinition[], dayNumber: number): ActiveArc[] {
    return arcs
        .filter(a => dayNumber >= a.startDay && dayNumber <= a.endDay)
        .map(a => {
            const dayInArc = dayNumber - a.startDay + 1;
            const arcLength = a.endDay - a.startDay + 1;
            return {
                id: a.id,
                type: a.type,
                title: a.title,
                description: a.description,
                phase: computePhase(dayInArc, arcLength),
                dayInArc,
                arcLength,
            };
        });
}

/**
 * Compute a density hint for the day based on day-of-week, active arcs,
 * directives, and arc phases.
 */
export function computeDensity(
    dayOfWeek: string,
    activeArcs: ActiveArc[],
    directives: Directive[],
    correctionStates: CorrectionState[],
): DensityHint {
    const isWeekend = dayOfWeek === 'Saturday' || dayOfWeek === 'Sunday';
    const hasIncident = activeArcs.some(a => a.type === 'incident');

    // Weekends are quiet unless an incident is active
    if (isWeekend && !hasIncident) return 'quiet';

    // Correction days and multi-arc convergences with directives → dense
    const isCorrectionDay = correctionStates.some(c => c.phase === 'correction_day');
    if (isCorrectionDay) return 'dense';
    if (directives.length >= 2 && activeArcs.length >= 3) return 'dense';

    // Arc starts, ends, or incidents bump density
    const hasArcBoundary = activeArcs.some(a => a.dayInArc === 1 || a.phase === 'concluding');
    if (hasIncident || directives.length >= 1 || hasArcBoundary) return 'busy';

    // Many active arcs
    if (activeArcs.length >= 3) return 'busy';

    // No active arcs at all
    if (activeArcs.length === 0) return 'quiet';

    return 'normal';
}

/**
 * Collect directives for a specific day from all arc definitions.
 */
export function getDirectives(arcs: ArcDefinition[], dayNumber: number): Directive[] {
    const directives: Directive[] = [];
    for (const arc of arcs) {
        if (!arc.directives) continue;
        for (const d of arc.directives) {
            if (d.day === dayNumber) {
                directives.push({ arc: arc.id, event: d.event });
            }
        }
    }
    return directives;
}

/**
 * Compute correction state for correction-type arcs on a given day.
 */
export function getCorrectionStates(arcs: ArcDefinition[], dayNumber: number): CorrectionState[] {
    const states: CorrectionState[] = [];
    for (const arc of arcs) {
        if (arc.type !== 'correction') continue;
        if (dayNumber < arc.startDay || dayNumber > arc.endDay) continue;
        if (!arc.wrongBelief || !arc.correctedDay) continue;

        let phase: CorrectionPhase;
        if (dayNumber < arc.correctedDay) {
            phase = 'wrong_belief';
        } else if (dayNumber === arc.correctedDay) {
            phase = 'correction_day';
        } else {
            phase = 'post_correction';
        }

        const state: CorrectionState = {
            arc: arc.id,
            phase,
            belief: arc.wrongBelief,
        };
        if (phase === 'correction_day' || phase === 'post_correction') {
            state.correctedBelief = arc.correctedBelief;
        }

        states.push(state);
    }
    return states;
}

/**
 * Compute a calendar date from an epoch date and a 1-based day number.
 */
export function computeCalendarDate(epoch: string, dayNumber: number): Date {
    const d = new Date(epoch);
    d.setDate(d.getDate() + dayNumber - 1);
    return d;
}

/**
 * Format a Date as ISO date string (YYYY-MM-DD).
 */
export function formatDate(d: Date): string {
    return d.toISOString().split('T')[0];
}

/**
 * Get the day-of-week name for a Date.
 */
export function getDayOfWeek(d: Date): string {
    return DAYS_OF_WEEK[d.getUTCDay()];
}

// ---------------------------------------------------------------------------
// Prompt Assembly
// ---------------------------------------------------------------------------

/**
 * Build the static system prompt for a persona (§3.1).
 */
export function buildSystemPrompt(persona: PersonaDefinition): string {
    return `You are a daily memory log generator for a synthetic benchmark persona.
Your job is to produce a single day's memory log that reads like a real
agent's daily record — not a story, not fiction, but a working
professional's actual log of what happened today.

Persona: ${persona.name}
Role: ${persona.role}
Domain: ${persona.domain}
Company/Institution: ${persona.company}
Team size: ${persona.team_size}

Profile:
${persona.profile}

Communication style:
${persona.communication_style}

IMPORTANT: Write in the voice and style described above. The log should
sound like ${persona.name} wrote it, not like an AI describing what
${persona.name} did.`;
}

/**
 * Build the user message for a single day (§7.1).
 */
export function buildUserMessage(ctx: DayContext): string {
    const lines: string[] = [];

    lines.push(`Generate the daily memory log for day ${ctx.dayNumber}.`);
    lines.push('');
    lines.push(`Date: ${ctx.calendarDate} (${ctx.dayOfWeek})`);
    lines.push(`Density: ${ctx.densityHint}`);
    lines.push('');

    // Active arcs as YAML
    lines.push('Active arcs:');
    if (ctx.activeArcs.length === 0) {
        lines.push('  (none)');
    } else {
        for (const arc of ctx.activeArcs) {
            lines.push(`  - id: ${arc.id}`);
            lines.push(`    type: ${arc.type}`);
            lines.push(`    title: "${arc.title}"`);
            lines.push(`    phase: ${arc.phase}`);
            lines.push(`    day_in_arc: ${arc.dayInArc}`);
            lines.push(`    arc_length: ${arc.arcLength}`);
            lines.push(`    description: |`);
            for (const dl of arc.description.trim().split('\n')) {
                lines.push(`      ${dl.trim()}`);
            }
        }
    }

    // Directives
    if (ctx.directives.length > 0) {
        lines.push('');
        lines.push("Today's events (MUST appear in the log):");
        for (const d of ctx.directives) {
            lines.push(`  - arc: ${d.arc}`);
            lines.push(`    event: "${d.event}"`);
        }
    }

    // Correction state
    if (ctx.correctionStates.length > 0) {
        lines.push('');
        lines.push('Correction state:');
        for (const c of ctx.correctionStates) {
            lines.push(`  - arc: ${c.arc}`);
            lines.push(`    phase: ${c.phase}`);
            lines.push(`    belief: "${c.belief}"`);
            if (c.correctedBelief) {
                lines.push(`    corrected_belief: "${c.correctedBelief}"`);
            }
        }
    }

    // Arc summaries (for arcs > 30 days in)
    const summariesForPrompt = ctx.arcSummaries.filter(s => s.summary.trim().length > 0);
    if (summariesForPrompt.length > 0) {
        lines.push('');
        lines.push('Arc progress summaries:');
        for (const s of summariesForPrompt) {
            lines.push(`  - id: ${s.id}`);
            lines.push(`    summary: |`);
            for (const sl of s.summary.trim().split('\n')) {
                lines.push(`      ${sl.trim()}`);
            }
        }
    }

    // Recent history
    lines.push('');
    if (ctx.recentHistory.length > 0) {
        lines.push('Recent days (for continuity — do NOT repeat content from these):');
        lines.push('');
        for (const r of ctx.recentHistory) {
            lines.push(`### Day ${r.dayNumber} (${r.calendarDate}, ${r.dayOfWeek})`);
            lines.push(r.content);
            lines.push('');
        }
    } else {
        lines.push('(This is the first day — no recent history.)');
    }

    lines.push('Produce ONLY the markdown content for this day\'s log, including the');
    lines.push('YAML frontmatter. Do not include any explanation or commentary outside');
    lines.push('the log.');

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// DayGenerator Class
// ---------------------------------------------------------------------------

export class DayGenerator {
    private persona: PersonaDefinition;
    private arcs: ArcDefinition[];
    private model: GeneratorModel;
    private config: Required<Omit<GeneratorConfig, 'onDay'>> & Pick<GeneratorConfig, 'onDay'>;

    /** Sliding window of recently generated days. */
    private recentDays: RecentDay[] = [];

    /** Arc summaries, keyed by arc ID. */
    private arcSummaries = new Map<string, ArcSummary>();

    /** All generated day contents, keyed by day number (for arc summary extraction). */
    private generatedDays = new Map<number, string>();

    constructor(
        persona: PersonaDefinition,
        arcs: ArcDefinition[],
        model: GeneratorModel,
        config: GeneratorConfig = {},
    ) {
        this.persona = persona;
        this.arcs = arcs;
        this.model = model;
        this.config = {
            historyWindow: config.historyWindow ?? 3,
            temperature: config.temperature ?? 0.7,
            maxTokens: config.maxTokens ?? 2000,
            summaryCompressInterval: config.summaryCompressInterval ?? 10,
            summaryTemperature: config.summaryTemperature ?? 0.2,
            startDay: config.startDay ?? 1,
            endDay: config.endDay ?? 1000,
            onDay: config.onDay,
        };
    }

    /**
     * Generate all days sequentially. Returns the full generation result.
     */
    async generateAll(): Promise<GenerationResult> {
        const days: GeneratedDay[] = [];
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        for (let dayNumber = this.config.startDay; dayNumber <= this.config.endDay; dayNumber++) {
            const result = await this.generateDay(dayNumber);
            days.push(result);
            totalInputTokens += result.inputTokens ?? 0;
            totalOutputTokens += result.outputTokens ?? 0;

            if (this.config.onDay) {
                await this.config.onDay(dayNumber, result.content);
            }
        }

        return {
            personaId: this.persona.id,
            days,
            totalInputTokens,
            totalOutputTokens,
        };
    }

    /**
     * Generate a single day. Updates internal state (recent history, arc summaries).
     */
    async generateDay(dayNumber: number): Promise<GeneratedDay> {
        const ctx = this.buildDayContext(dayNumber);
        const systemPrompt = buildSystemPrompt(this.persona);
        const userMessage = buildUserMessage(ctx);

        const result = await this.model.complete(systemPrompt, userMessage, {
            maxTokens: this.config.maxTokens,
            temperature: this.config.temperature,
        });

        const content = result.text;

        // Update state
        this.generatedDays.set(dayNumber, content);
        this.updateRecentHistory(dayNumber, ctx.calendarDate, ctx.dayOfWeek, content);
        await this.updateArcSummaries(dayNumber, ctx.activeArcs, content);

        return {
            dayNumber,
            calendarDate: ctx.calendarDate,
            content,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
        };
    }

    /**
     * Build the full context for a single day.
     */
    buildDayContext(dayNumber: number): DayContext {
        const date = computeCalendarDate(this.persona.epoch, dayNumber);
        const calendarDate = formatDate(date);
        const dayOfWeek = getDayOfWeek(date);

        const activeArcs = getActiveArcs(this.arcs, dayNumber);
        const directives = getDirectives(this.arcs, dayNumber);
        const correctionStates = getCorrectionStates(this.arcs, dayNumber);
        const densityHint = computeDensity(dayOfWeek, activeArcs, directives, correctionStates);

        // Arc summaries for arcs > 30 days in
        const arcSummaries: ArcSummary[] = [];
        for (const arc of activeArcs) {
            if (arc.dayInArc > 30) {
                const summary = this.arcSummaries.get(arc.id);
                if (summary) {
                    arcSummaries.push(summary);
                }
            }
        }

        return {
            dayNumber,
            calendarDate,
            dayOfWeek,
            densityHint,
            activeArcs,
            directives,
            correctionStates,
            arcSummaries,
            recentHistory: [...this.recentDays],
        };
    }

    // -----------------------------------------------------------------------
    // Internal state management
    // -----------------------------------------------------------------------

    private updateRecentHistory(dayNumber: number, calendarDate: string, dayOfWeek: string, content: string): void {
        this.recentDays.push({ dayNumber, calendarDate, dayOfWeek, content });
        if (this.recentDays.length > this.config.historyWindow) {
            this.recentDays.shift();
        }
    }

    /**
     * After each generated day, update arc summaries:
     *   1. Append a one-line delta to each active arc's running log.
     *   2. Every N days (summaryCompressInterval), compress the running log via LLM.
     */
    private async updateArcSummaries(dayNumber: number, activeArcs: ActiveArc[], content: string): Promise<void> {
        for (const arc of activeArcs) {
            let summary = this.arcSummaries.get(arc.id);
            if (!summary) {
                summary = { id: arc.id, summary: '', runningLog: [] };
                this.arcSummaries.set(arc.id, summary);
            }

            // Append a one-line delta
            const delta = `Day ${dayNumber}: ${extractArcDelta(content, arc.id, arc.title)}`;
            summary.runningLog.push(delta);

            // Compress every N days
            if (summary.runningLog.length > 0 &&
                summary.runningLog.length % this.config.summaryCompressInterval === 0) {
                summary.summary = await this.compressArcSummary(arc.title, summary.runningLog);
            }
        }
    }

    private async compressArcSummary(arcTitle: string, runningLog: string[]): Promise<string> {
        const prompt = ARC_SUMMARY_COMPRESS_PROMPT
            .replace('{{title}}', arcTitle)
            .replace('{{log}}', runningLog.join('\n'));

        const result = await this.model.complete(
            'You compress progress logs into concise status summaries.',
            prompt,
            { maxTokens: 200, temperature: this.config.summaryTemperature },
        );
        return result.text;
    }
}

// ---------------------------------------------------------------------------
// Persona & Arcs Loading
// ---------------------------------------------------------------------------

export interface ArcsFile {
    arcs: ArcDefinition[];
}

/**
 * Load a persona definition from a persona.yaml file.
 */
export async function loadPersonaDefinition(personaDir: string): Promise<PersonaDefinition> {
    const raw = await readFile(join(personaDir, 'persona.yaml'), 'utf-8');
    return YAML.parse(raw) as PersonaDefinition;
}

/**
 * Load arc definitions from an arcs.yaml file.
 */
export async function loadArcs(personaDir: string): Promise<ArcDefinition[]> {
    const raw = await readFile(join(personaDir, 'arcs.yaml'), 'utf-8');
    const data = YAML.parse(raw) as ArcsFile;
    return data.arcs;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a brief one-line delta about an arc from a day's generated content.
 * This is a heuristic: look for sentences mentioning the arc title/id keywords.
 * Falls back to a generic progress note.
 */
function extractArcDelta(content: string, arcId: string, arcTitle: string): string {
    const keywords = [
        ...arcId.split('-').filter(w => w.length > 2),
        ...arcTitle.toLowerCase().split(/\s+/).filter(w => w.length > 3),
    ];

    const sentences = content
        .replace(/\n/g, ' ')
        .split(/(?<=[.!?])\s+/)
        .filter(s => s.length > 10);

    for (const sentence of sentences) {
        const lower = sentence.toLowerCase();
        if (keywords.some(kw => lower.includes(kw.toLowerCase()))) {
            // Truncate to ~100 chars
            return sentence.length > 120 ? sentence.slice(0, 117) + '...' : sentence;
        }
    }

    return '(routine progress)';
}
