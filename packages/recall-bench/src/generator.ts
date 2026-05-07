/**
 * Day Generator — produces daily memory logs for benchmark personas.
 *
 * Two-pass generation pipeline:
 *   Pass 1 (arc-by-arc): For each arc sorted by start day, select activity
 *     days (directives + spread) and generate focused content. Days with
 *     content from earlier arcs get merged.
 *   Pass 2 (gap-fill): Identify weeks with fewer than minDaysPerWeek active
 *     days and generate routine filler to reach the target.
 *
 * Each day's prompt is assembled from:
 *   - Static system prompt (persona profile)
 *   - Day context (date, density hint)
 *   - Active arcs with phase annotations
 *   - Directives (key events that must appear)
 *   - Correction state (for correction arcs)
 *   - Arc summaries (for long-running arcs > 30 days)
 *   - Recent history (sliding window of previous generated days)
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
    GeneratedDayKind,
    GenerationResult,
    GeneratorConfig,
    GeneratorModel,
    LoadedStory,
    PersonaDefinition,
    RecentDay,
    SessionDef,
    SessionLifecycle,
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
 * Determine whether an arc should emit echoes into its `referencedSessions`
 * on the given day. Touchpoint policy (intentionally conservative — see
 * specs/recall-bench.md §3.3 "Be conservative — too many echoes pollutes
 * referenced sessions"):
 *
 *   - arc start day
 *   - arc end day
 *   - any explicit `directives[].day` entry
 *   - correction key days (`wrongDay`, `correctedDay`)
 *   - sprint boundaries — every 14 days of arc-internal time after start
 *
 * Returns false unconditionally when the arc declares no `referencedSessions`.
 */
export function computeEchoToday(arc: ArcDefinition, dayNumber: number): boolean {
    if (!arc.referencedSessions || arc.referencedSessions.length === 0) return false;
    if (dayNumber === arc.startDay) return true;
    if (dayNumber === arc.endDay) return true;
    if (arc.wrongDay === dayNumber) return true;
    if (arc.correctedDay === dayNumber) return true;
    if (arc.directives && arc.directives.some(d => d.day === dayNumber)) return true;
    const dayInArc = dayNumber - arc.startDay + 1;
    if (dayInArc > 14 && (dayInArc - 1) % 14 === 0) return true;
    return false;
}

/**
 * Get arcs active on a given day, annotated with phase information and
 * session affinity (see specs/recall-bench.md §2.3.1 / §3.3).
 *
 * `primarySession` and `referencedSessions` are surfaced verbatim from the
 * arc definition. `echoToday` is computed per `computeEchoToday`.
 */
export function getActiveArcs(arcs: ArcDefinition[], dayNumber: number): ActiveArc[] {
    return arcs
        .filter(a => dayNumber >= a.startDay && dayNumber <= a.endDay)
        .map(a => {
            const dayInArc = dayNumber - a.startDay + 1;
            const arcLength = a.endDay - a.startDay + 1;
            const result: ActiveArc = {
                id: a.id,
                type: a.type,
                title: a.title,
                description: a.description,
                phase: computePhase(dayInArc, arcLength),
                dayInArc,
                arcLength,
            };
            if (a.primarySession !== undefined) result.primarySession = a.primarySession;
            if (a.referencedSessions !== undefined) result.referencedSessions = a.referencedSessions;
            const echo = computeEchoToday(a, dayNumber);
            if (echo) result.echoToday = true;
            return result;
        });
}

/**
 * Compute today's active session list — the set of session IDs that should
 * emit a `# session: <id>` H1 in today's daily log.
 *
 * Active sessions are:
 *   1. Every `primarySession` of an arc active today (always emits).
 *   2. Every `referencedSessions` entry of an arc whose `echoToday` is true.
 *
 * Order: `principal` first if active, then group sessions in the order they
 * were declared in the persona definition (specs/day-generator.md §3.1.2).
 * Any session referenced by an arc but not declared in the persona is
 * appended at the end (defensive — shouldn't happen with consistent inputs).
 */
export function computeActiveSessions(
    activeArcs: ActiveArc[],
    personaSessions: SessionDef[] | undefined,
): string[] {
    const seen = new Set<string>();
    for (const arc of activeArcs) {
        if (arc.primarySession) seen.add(arc.primarySession);
        if (arc.echoToday && arc.referencedSessions) {
            for (const s of arc.referencedSessions) seen.add(s);
        }
    }
    if (seen.size === 0) return [];
    const result: string[] = [];
    if (seen.has('principal')) result.push('principal');
    if (personaSessions) {
        for (const s of personaSessions) {
            if (s.id !== 'principal' && seen.has(s.id)) result.push(s.id);
        }
    }
    for (const s of seen) {
        if (!result.includes(s)) result.push(s);
    }
    return result;
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

// ---------------------------------------------------------------------------
// Day Selection (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Select which days an arc should have activity on.
 *
 * Always includes: directive days, arc start/end days, correction key days.
 * Fills remaining weekdays at intervals based on arc length:
 *   - Short arcs (< 15 days): every 2 weekdays
 *   - Medium arcs (15–100 days): every 3 weekdays
 *   - Long arcs (100+ days): every 5 weekdays
 *
 * Weekends are skipped unless the arc is an incident.
 */
export function selectArcDays(arc: ArcDefinition, epoch: string): number[] {
    const pinned = new Set<number>();

    // Directive days (mandatory)
    if (arc.directives) {
        for (const d of arc.directives) {
            if (d.day >= arc.startDay && d.day <= arc.endDay) {
                pinned.add(d.day);
            }
        }
    }

    // Arc boundaries
    pinned.add(arc.startDay);
    pinned.add(arc.endDay);

    // Correction key days
    if (arc.wrongDay && arc.wrongDay >= arc.startDay && arc.wrongDay <= arc.endDay) {
        pinned.add(arc.wrongDay);
    }
    if (arc.correctedDay && arc.correctedDay >= arc.startDay && arc.correctedDay <= arc.endDay) {
        pinned.add(arc.correctedDay);
    }

    // Compute interval based on arc length
    const arcLength = arc.endDay - arc.startDay + 1;
    let interval: number;
    if (arcLength < 15) {
        interval = 2;
    } else if (arcLength < 100) {
        interval = 3;
    } else {
        interval = 5;
    }

    // Walk weekdays, adding activity at interval gaps
    const all = new Set<number>(pinned);
    let sinceLastActivity = interval; // start ready to place one
    for (let day = arc.startDay; day <= arc.endDay; day++) {
        const date = computeCalendarDate(epoch, day);
        const dow = getDayOfWeek(date);
        const isWeekend = dow === 'Saturday' || dow === 'Sunday';

        // Skip weekends for non-incident arcs
        if (isWeekend && arc.type !== 'incident') continue;

        if (pinned.has(day)) {
            sinceLastActivity = 0;
            continue;
        }

        sinceLastActivity++;
        if (sinceLastActivity >= interval) {
            all.add(day);
            sinceLastActivity = 0;
        }
    }

    return [...all].sort((a, b) => a - b);
}

/**
 * Identify gap days that need filler content to reach the target activity
 * density (default: 5 days/week). Only selects weekdays.
 *
 * Weeks are computed from the epoch's first Monday to keep alignment stable.
 */
export function identifyGapDays(
    activeDays: Set<number>,
    startDay: number,
    endDay: number,
    epoch: string,
    targetPerWeek: number = 5,
): number[] {
    const gaps: number[] = [];

    // Process in 7-day calendar weeks (Mon–Sun)
    // Find the first Monday on or before startDay
    const startDate = computeCalendarDate(epoch, startDay);
    const startDow = startDate.getUTCDay(); // 0=Sun..6=Sat
    const mondayOffset = startDow === 0 ? -6 : 1 - startDow;
    let weekStartDay = startDay + mondayOffset;

    while (weekStartDay <= endDay) {
        const weekEndDay = weekStartDay + 6;
        const weekdays: number[] = [];
        let activeCount = 0;

        for (let day = Math.max(weekStartDay, startDay); day <= Math.min(weekEndDay, endDay); day++) {
            const date = computeCalendarDate(epoch, day);
            const dow = getDayOfWeek(date);
            if (dow === 'Saturday' || dow === 'Sunday') continue;

            weekdays.push(day);
            if (activeDays.has(day)) activeCount++;
        }

        const needed = Math.max(0, Math.min(targetPerWeek, weekdays.length) - activeCount);
        if (needed > 0) {
            const empty = weekdays.filter(d => !activeDays.has(d));
            // Spread picks evenly across the empty slots
            const step = Math.max(1, Math.floor(empty.length / needed));
            let picked = 0;
            for (let i = 0; i < empty.length && picked < needed; i += step) {
                gaps.push(empty[i]);
                picked++;
            }
        }

        weekStartDay += 7;
    }

    return gaps;
}

// ---------------------------------------------------------------------------
// Calendar Helpers
// ---------------------------------------------------------------------------

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
 * Build the system prompt for a single-session generation call.
 *
 * In the per-session pipeline, each (day, session) pair is generated by an
 * independent LLM call with this system prompt. The output of that call is
 * the body that goes UNDER one `# session: <id>` H1 — H3 topic sub-sections
 * and prose. The day-level assembler emits the H1 and frontmatter; the
 * model never writes those itself.
 *
 * Each session call sees only its own context — no cross-session content
 * leaks into prompts (per-session conversation history is filtered by
 * session in `SessionDayGenerator`). For isolated sessions, the focus
 * block surfaces `sensitive_topics` and instructs the model to record
 * concretely; isolation is structurally guaranteed because the content
 * of an isolated session is never seen by other sessions' calls.
 */
export function buildSessionSystemPrompt(
    persona: PersonaDefinition,
    focusSessionId: string,
    sessionLifecycles?: SessionLifecycle[],
): string {
    const lines: string[] = [];

    const affiliation = persona.institution ?? persona.company ?? '';
    const mergedSessions = mergeSessionLifecycles(persona.sessions, sessionLifecycles);
    const focusSession = mergedSessions?.find(s => s.id === focusSessionId);

    lines.push(`You are an AI agent named "${persona.name}" — a computer program. Your job is to`);
    lines.push(`produce ONE session's worth of YOUR OWN memory log, written from your perspective`);
    lines.push(`as the agent. The log records who interacted with you today (humans and other`);
    lines.push(`agents), what they asked, what you did, what you decided, what files or outputs`);
    lines.push(`you produced, and what you handed off — but ONLY for the focus session named`);
    lines.push(`below. Other sessions are generated by separate calls and are not your concern here.`);
    lines.push('');
    lines.push('# Identity');
    lines.push(`- Name: ${persona.name}`);
    lines.push(`- Role: ${persona.role}`);
    lines.push(`- Domain: ${persona.domain}`);
    if (affiliation) {
        lines.push(`- Affiliation: ${affiliation}`);
    }
    lines.push(`- Team supported: ${persona.team_size} people`);
    lines.push('');
    lines.push('# Profile');
    lines.push(persona.profile.trim());
    lines.push('');
    lines.push('# Communication style');
    lines.push(persona.communication_style.trim());

    if (persona.principal) {
        lines.push('');
        lines.push('# Principal — the human you primarily serve');
        lines.push(`- Name: ${persona.principal.name}`);
        lines.push(`- Role: ${persona.principal.role}`);
        if (persona.principal.profile) {
            lines.push('- Profile:');
            for (const pl of persona.principal.profile.trim().split('\n')) {
                lines.push(`    ${pl.trim()}`);
            }
        }
    }

    if (persona.cast && persona.cast.length > 0) {
        lines.push('');
        lines.push('# Cast — humans and other agents you interact with');
        for (const c of persona.cast) {
            const kind = c.kind ?? (c.name.startsWith('@') ? 'agent' : 'human');
            lines.push(`- ${c.name} (${kind}) — ${c.role}`);
        }
    }

    if (mergedSessions && mergedSessions.length > 0) {
        lines.push('');
        lines.push('# Sessions catalog (the full set of conversation contexts you participate in)');
        for (const s of mergedSessions) {
            const flags: string[] = [s.kind];
            if (s.isolated) flags.push('isolated');
            if (s.shared) flags.push('shared');
            const participants = s.participants.join(', ');
            lines.push(`- ${s.id} (${flags.join(', ')}) — participants: ${participants}`);
        }
        lines.push('You write only ONE of these per call. The focus session for this call is named below.');
    }

    if (persona.sharedKnowledge && persona.sharedKnowledge.length > 0) {
        lines.push('');
        lines.push('# Shared knowledge — facts available to every session');
        for (const k of persona.sharedKnowledge) {
            lines.push(`- ${k}`);
        }
    }

    // Focus session block — the most important section
    lines.push('');
    lines.push('# FOCUS SESSION (for this call)');
    if (focusSession) {
        const flags: string[] = [focusSession.kind];
        if (focusSession.isolated) flags.push('isolated');
        if (focusSession.shared) flags.push('shared');
        lines.push(`- id: ${focusSession.id}`);
        lines.push(`- kind: ${flags.join(', ')}`);
        lines.push(`- participants: ${focusSession.participants.join(', ')}`);
        if (focusSession.sensitive_topics && focusSession.sensitive_topics.length > 0) {
            lines.push('- sensitive topics that belong in THIS session (record concretely with names, numbers, dates — the boundary protects this content from other sessions):');
            for (const t of focusSession.sensitive_topics) {
                lines.push(`    - ${t}`);
            }
        }
        if (focusSession.firstDay !== undefined || focusSession.lastDay !== undefined) {
            const start = focusSession.firstDay ?? 1;
            const end = focusSession.lastDay !== undefined ? String(focusSession.lastDay) : 'end';
            lines.push(`- lifecycle: day ${start}–${end}`);
        }
    } else {
        lines.push(`- id: ${focusSessionId}`);
        lines.push('- (no detailed shape declared in persona — write content scoped to this session)');
    }

    lines.push('');
    lines.push('# How to write THIS session\'s log');
    lines.push('- You are writing ONLY the inside of one session\'s entry. Output goes BELOW the');
    lines.push('  `# session: <id>` H1 — the assembler emits the H1 itself; do not write it.');
    lines.push('- Do NOT emit frontmatter (no `---` blocks). The assembler adds frontmatter once at');
    lines.push('  the top of the day file.');
    lines.push('- Write in FIRST PERSON from your own perspective as the agent. This is YOUR');
    lines.push('  working memory log of what YOU did, what people asked YOU, what YOU decided,');
    lines.push('  what YOU produced, what YOU handed off. Use "I" / "my" when it adds clarity');
    lines.push('  ("I noted...", "my next step", "I pushed back on the topology choice"); use');
    lines.push('  implicit subject when natural ("Captured the onboarding baseline", "Sent the');
    lines.push('  brief to Jamie", "Updated `KN_toggle_v1/design_brief.md`"). Past tense throughout.');
    lines.push('- This is NOT a third-person narrator describing what an agent did. Do NOT write');
    lines.push('  about yourself by name in the third person ("Jordan staged the briefing" — wrong;');
    lines.push('  "Staged the briefing for Jamie\'s morning review" — right).');
    lines.push('- This is NOT a personal diary either. Do NOT write feelings or lifestyle prose');
    lines.push('  ("Long day", "Feeling stuck", "Coffee was good"). Stay focused: what happened,');
    lines.push('  what was decided, what is outstanding. Direct, technical, concrete.');
    lines.push('- Reference humans by name ("Jamie asked..."). Reference other AI agents with');
    lines.push('  @-handles ("Handed off the PubMed query to @lit-search-agent").');
    lines.push('- Each section describes an interaction or unit of work: who initiated it, what');
    lines.push('  was asked, what got produced or decided, files/handoffs. Quote the principal\'s');
    lines.push('  asks verbatim when material, with `>` blockquote attribution.');
    lines.push('- Organize by TOPIC (not clock time). Section titles name the topic + person');
    lines.push('  (e.g., "### Kenji — pKN001 colony screen review").');
    lines.push('- For group sessions, attribute other speakers verbatim with `> Name: "..."` when');
    lines.push('  their words are load-bearing. Decisions and dissent must be attributed.');
    lines.push('- List files produced/changed and decisions explicitly. End with an "Outstanding"');
    lines.push('  line listing follow-up work.');
    if (focusSession?.isolated) {
        lines.push('- This session is ISOLATED. Be concrete about sensitive topics — names, numbers,');
        lines.push('  dates, positions. The boundary keeps this content out of other sessions, so');
        lines.push('  you do not need to be vague to "protect" it.');
    }

    lines.push('');
    lines.push('# Required output structure');
    lines.push('```');
    lines.push('### <topic / interaction title>');
    lines.push('');
    lines.push('<body — narrate the interaction, decision, or output>');
    lines.push('');
    lines.push('### <next topic>');
    lines.push('...');
    lines.push('```');
    lines.push('');
    lines.push('Output begins with the first `###` topic header. No frontmatter, no `# session: <id>` H1.');

    return lines.join('\n');
}

/**
 * Build the user message for a single-session generation call.
 *
 * The user message contains only the day-level context (date, density)
 * and the per-arc content that belongs in THIS session — primary arcs
 * (whose primarySession matches the focus) get full detail; arcs that
 * reference this session as an echo get brief touchpoint context only.
 * Recent history is filtered to this session's prior days, never the
 * full day's content — that's how cross-session leakage is prevented
 * structurally during generation.
 */
export function buildSessionUserMessage(
    dayNumber: number,
    calendarDate: string,
    dayOfWeek: string,
    densityHint: DensityHint,
    focusSessionId: string,
    activeArcs: ActiveArc[],
    directives: Directive[],
    correctionStates: CorrectionState[],
    sessionRecentHistory: RecentDay[],
    arcSummaries: ArcSummary[] = [],
): string {
    const lines: string[] = [];

    lines.push(`Generate the "${focusSessionId}" session entry of the daily memory log for day ${dayNumber}.`);
    lines.push('');
    lines.push(`Date: ${calendarDate} (${dayOfWeek})`);
    lines.push(`Density: ${densityHint}`);
    lines.push('');

    // Filter active arcs into "primary in this session" vs "echoing here today"
    const primaryArcs: ActiveArc[] = [];
    const echoArcs: ActiveArc[] = [];
    for (const arc of activeArcs) {
        if (arc.primarySession === focusSessionId) {
            primaryArcs.push(arc);
        } else if (arc.echoToday && arc.referencedSessions?.includes(focusSessionId)) {
            echoArcs.push(arc);
        }
    }

    if (primaryArcs.length > 0) {
        lines.push('Primary arcs for THIS session today (the deep work — main content here):');
        for (const arc of primaryArcs) {
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

    if (echoArcs.length > 0) {
        lines.push('');
        lines.push('Arcs primarily based in OTHER sessions but echoing here today (brief touchpoint only — a status update, briefing, or dissent moment, NOT a recap):');
        for (const arc of echoArcs) {
            lines.push(`  - id: ${arc.id}`);
            lines.push(`    type: ${arc.type}`);
            lines.push(`    title: "${arc.title}"`);
            lines.push(`    primary_session: ${arc.primarySession}`);
            lines.push(`    phase: ${arc.phase}`);
            lines.push(`    description: |`);
            const lines2 = arc.description.trim().split('\n');
            for (const dl of lines2.slice(0, 3)) {
                lines.push(`      ${dl.trim()}`);
            }
        }
    }

    if (primaryArcs.length === 0 && echoArcs.length === 0) {
        lines.push('No active arcs for this session today. Produce a brief routine entry');
        lines.push('reflecting standing habits and any quiet-day work that would naturally');
        lines.push('happen in this session — or, if nothing meaningful would be recorded,');
        lines.push('output a single H3 section with a one-line "Quiet day for this session." note.');
    }

    // Directives for the focus session's arcs
    const focusedDirectives = directives.filter(d =>
        primaryArcs.some(a => a.id === d.arc) || echoArcs.some(a => a.id === d.arc)
    );
    if (focusedDirectives.length > 0) {
        lines.push('');
        lines.push("Today's events for arcs in this session (MUST appear in the log):");
        for (const d of focusedDirectives) {
            lines.push(`  - arc: ${d.arc}`);
            lines.push(`    event: "${d.event}"`);
        }
    }

    // Correction states for the focus session's arcs
    const focusedCorrections = correctionStates.filter(c =>
        primaryArcs.some(a => a.id === c.arc) || echoArcs.some(a => a.id === c.arc)
    );
    if (focusedCorrections.length > 0) {
        lines.push('');
        lines.push('Correction state:');
        for (const c of focusedCorrections) {
            lines.push(`  - arc: ${c.arc}`);
            lines.push(`    phase: ${c.phase}`);
            lines.push(`    belief: "${c.belief}"`);
            if (c.correctedBelief) {
                lines.push(`    corrected_belief: "${c.correctedBelief}"`);
            }
        }
    }

    // Arc summaries for long-running arcs whose primary session is this one
    const focusedSummaries = arcSummaries.filter(s =>
        primaryArcs.some(a => a.id === s.id) && s.summary.trim().length > 0
    );
    if (focusedSummaries.length > 0) {
        lines.push('');
        lines.push('Arc progress summaries (for long-running arcs already in flight):');
        for (const s of focusedSummaries) {
            lines.push(`  - id: ${s.id}`);
            lines.push(`    summary: |`);
            for (const sl of s.summary.trim().split('\n')) {
                lines.push(`      ${sl.trim()}`);
            }
        }
    }

    // Per-session recent history (this session's prior days only — no cross-session leakage)
    lines.push('');
    if (sessionRecentHistory.length > 0) {
        lines.push(`Recent days for THIS session (for continuity — do NOT repeat content from these):`);
        lines.push('');
        for (const r of sessionRecentHistory) {
            lines.push(`### Day ${r.dayNumber} (${r.calendarDate}, ${r.dayOfWeek}) — ${focusSessionId}`);
            lines.push(r.content);
            lines.push('');
        }
    } else {
        lines.push(`No recent history for the "${focusSessionId}" session yet — this is its first or earliest entry.`);
    }

    lines.push('');
    lines.push(`Output now: H3 topics for the "${focusSessionId}" session. No frontmatter, no \`# session:\` H1.`);

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// SessionDayGenerator Class
// ---------------------------------------------------------------------------

interface ResolvedSessionGenConfig {
    historyWindow: number;
    temperature: number;
    maxTokens: number;
    startDay: number;
    endDay: number;
    onDay?: (dayNumber: number, content: string, kind: GeneratedDayKind) => void | Promise<void>;
}

interface SessionCallResult {
    sessionId: string;
    content: string | null;
    inputTokens: number;
    outputTokens: number;
}

/**
 * Generates daily memory logs by producing each (day, session) pair via an
 * independent LLM call. Sessions for a given day are generated in parallel;
 * per-session conversation history is maintained separately so cross-session
 * content never leaks into prompts.
 *
 * Output for each day is the canonical single-file format: `day-NNNN.md`
 * with frontmatter and `# session: <id>` H1 boundaries (spec §4.7). Each
 * session's prompt sees only its own history and only the arcs that touch
 * this session, so isolation is structural rather than prompt-instructed.
 *
 * Replaces the v0.5/v0.6 arc-merge pipeline. The merge pipeline produced
 * single-H1 collapses on heavy-overlap days because the LLM consolidated
 * multi-arc merge calls into a single session block. Per-session generation
 * removes that failure mode by never asking the LLM to manage multi-session
 * structure within a single call.
 */
export class SessionDayGenerator {
    private persona: PersonaDefinition;
    private arcs: ArcDefinition[];
    private model: GeneratorModel;
    private epoch: string;
    private sessionLifecycles: SessionLifecycle[] | undefined;
    private config: ResolvedSessionGenConfig;

    /** Per-session sliding window of recent days, keyed by session id. */
    private sessionHistory: Map<string, RecentDay[]> = new Map();

    /** Assembled day contents, keyed by day number. */
    private generatedDays: Map<number, string> = new Map();

    /** Token tracking per day (sum across all session calls for that day). */
    private dayTokens: Map<number, { input: number; output: number }> = new Map();

    constructor(
        persona: PersonaDefinition,
        arcs: ArcDefinition[],
        model: GeneratorModel,
        config: GeneratorConfig = {},
    ) {
        this.persona = persona;
        this.arcs = arcs;
        this.model = model;
        this.epoch = config.epoch ?? persona.epoch ?? '2024-01-01';
        this.sessionLifecycles = config.sessionLifecycles;
        this.config = {
            historyWindow: config.historyWindow ?? 3,
            temperature: config.temperature ?? 0.7,
            maxTokens: config.maxTokens ?? 2000,
            startDay: config.startDay ?? 1,
            endDay: config.endDay ?? 1000,
            onDay: config.onDay,
        };
    }

    /**
     * Generate every day in [startDay, endDay] that has at least one
     * active session. Returns a GenerationResult with per-day token totals.
     */
    async generateAll(): Promise<GenerationResult> {
        for (let day = this.config.startDay; day <= this.config.endDay; day++) {
            await this.generateDay(day);
        }
        return this.buildResult();
    }

    /**
     * Generate one day. Computes active sessions, fires per-session calls
     * in parallel, assembles the output, updates per-session history, and
     * fires the onDay callback. No-op if the day has no active sessions.
     */
    async generateDay(dayNumber: number): Promise<void> {
        const activeArcs = getActiveArcs(this.arcs, dayNumber);
        if (activeArcs.length === 0) return;

        const activeSessions = computeActiveSessions(activeArcs, this.persona.sessions);
        if (activeSessions.length === 0) return;

        const date = computeCalendarDate(this.epoch, dayNumber);
        const calendarDate = formatDate(date);
        const dayOfWeek = getDayOfWeek(date);
        const directives = getDirectives(this.arcs, dayNumber);
        const correctionStates = getCorrectionStates(this.arcs, dayNumber);
        const densityHint = computeDensity(dayOfWeek, activeArcs, directives, correctionStates);

        // All session calls fire in parallel. Per-session failures are
        // isolated — a single skipped session doesn't abort the day.
        const sessionResults = await Promise.all(
            activeSessions.map(sessionId => this.generateSession(
                dayNumber, calendarDate, dayOfWeek, densityHint,
                sessionId, activeArcs, directives, correctionStates,
            ))
        );

        const successful = sessionResults.filter(r => r.content !== null);
        if (successful.length === 0) return; // every session failed; skip the day

        const dayContent = this.assembleDayFile(activeSessions, sessionResults);
        this.generatedDays.set(dayNumber, dayContent);

        // Update per-session history with the produced content for each session
        for (const r of successful) {
            this.pushSessionHistory(r.sessionId, dayNumber, calendarDate, dayOfWeek, r.content!);
        }

        const totalIn = sessionResults.reduce((s, r) => s + r.inputTokens, 0);
        const totalOut = sessionResults.reduce((s, r) => s + r.outputTokens, 0);
        this.dayTokens.set(dayNumber, { input: totalIn, output: totalOut });

        if (this.config.onDay) {
            await this.config.onDay(dayNumber, dayContent, 'day');
        }
    }

    /**
     * Generate one session's content for one day. Pure: returns the
     * result; does not mutate generator state. Caller updates history.
     */
    private async generateSession(
        dayNumber: number,
        calendarDate: string,
        dayOfWeek: string,
        densityHint: DensityHint,
        sessionId: string,
        activeArcs: ActiveArc[],
        directives: Directive[],
        correctionStates: CorrectionState[],
    ): Promise<SessionCallResult> {
        const history = this.sessionHistory.get(sessionId) ?? [];
        const systemPrompt = buildSessionSystemPrompt(this.persona, sessionId, this.sessionLifecycles);
        const userMessage = buildSessionUserMessage(
            dayNumber, calendarDate, dayOfWeek, densityHint,
            sessionId, activeArcs, directives, correctionStates, history,
        );

        try {
            const result = await this.model.complete(systemPrompt, userMessage, {
                maxTokens: this.config.maxTokens,
                temperature: this.config.temperature,
            });
            return {
                sessionId,
                content: this.cleanSessionContent(result.text, sessionId),
                inputTokens: result.inputTokens ?? 0,
                outputTokens: result.outputTokens ?? 0,
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`\n[generator] day=${dayNumber} session=${sessionId} skipped: ${msg.split('\n')[0]}\n`);
            return { sessionId, content: null, inputTokens: 0, outputTokens: 0 };
        }
    }

    /**
     * Strip stray frontmatter or `# session: <id>` H1 the model may have
     * emitted despite the prompt instructing it not to. Defensive cleanup.
     */
    private cleanSessionContent(text: string, sessionId: string): string {
        let cleaned = text.trim();
        const fmMatch = cleaned.match(/^---\s*\n[\s\S]*?\n---\s*\n+/);
        if (fmMatch) cleaned = cleaned.substring(fmMatch[0].length).trim();
        const h1Pattern = new RegExp(`^# session:\\s*${escapeRegex(sessionId)}\\s*\\n+`);
        cleaned = cleaned.replace(h1Pattern, '').trim();
        return cleaned;
    }

    private pushSessionHistory(
        sessionId: string,
        dayNumber: number,
        calendarDate: string,
        dayOfWeek: string,
        content: string,
    ): void {
        const list = this.sessionHistory.get(sessionId) ?? [];
        list.push({ dayNumber, calendarDate, dayOfWeek, content });
        while (list.length > this.config.historyWindow) {
            list.shift();
        }
        this.sessionHistory.set(sessionId, list);
    }

    /**
     * Assemble per-session outputs into the canonical day-file format:
     * frontmatter, then one `# session: <id>` H1 per active session in
     * canonical order, each followed by that session's body. Internal
     * narration (pre-H1 body, spec §4.7) is omitted in v1; future
     * enhancement: a separate `_internal` pass for cross-session reflection.
     */
    private assembleDayFile(
        activeSessions: string[],
        sessionResults: SessionCallResult[],
    ): string {
        const lines: string[] = [];
        lines.push('---');
        lines.push('type: daily');
        lines.push('---');
        lines.push('');
        for (const sessionId of activeSessions) {
            const result = sessionResults.find(r => r.sessionId === sessionId);
            if (!result || result.content === null) continue;
            lines.push(`# session: ${sessionId}`);
            lines.push('');
            lines.push(result.content);
            lines.push('');
        }
        return lines.join('\n').replace(/\n+$/, '\n');
    }

    private buildResult(): GenerationResult {
        const sortedDays = [...this.generatedDays.keys()].sort((a, b) => a - b);
        const days: GeneratedDay[] = [];
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        for (const dayNumber of sortedDays) {
            const content = this.generatedDays.get(dayNumber)!;
            const date = computeCalendarDate(this.epoch, dayNumber);
            const tokens = this.dayTokens.get(dayNumber) ?? { input: 0, output: 0 };
            days.push({
                dayNumber,
                calendarDate: formatDate(date),
                content,
                inputTokens: tokens.input,
                outputTokens: tokens.output,
            });
            totalInputTokens += tokens.input;
            totalOutputTokens += tokens.output;
        }
        return {
            personaId: this.persona.id,
            days,
            totalInputTokens,
            totalOutputTokens,
        };
    }
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Persona & Arcs Loading
// ---------------------------------------------------------------------------

/**
 * On-disk shape of an arcs file. Carries arcs plus story-level metadata
 * that varies across corpora for the same persona — epoch (calendar anchor)
 * and per-session lifecycle overrides. Both fields are optional; when
 * absent, callers fall back to the persona's epoch and treat sessions as
 * always-on within the corpus.
 */
export interface ArcsFile {
    epoch?: string;
    sessions?: SessionLifecycle[];
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
 * Load a story (arcs + story-level metadata) from an arcs file.
 *
 * Default filename is `arcs-1000d.yaml` (the canonical 1000-day story).
 * Every persona's arcs file is labeled by intended corpus duration —
 * convention: `arcs-<NNN>d.yaml` (e.g., `arcs-180d.yaml`, `arcs-30d.yaml`).
 *
 * The returned `LoadedStory` carries:
 *   - `arcs` — the arc definitions
 *   - `epoch?` — calendar anchor for this story (overrides persona's epoch
 *     if present); falls back to persona.epoch when undefined
 *   - `sessions?` — per-session lifecycle overrides (firstDay/lastDay) that
 *     apply only to this story; merged with persona-declared sessions at
 *     prompt-build time via `mergeSessionLifecycles`
 *
 * Memory-dir and Q&A-dir derivation off the filename is the
 * responsibility of callers (see `deriveSiblingDir`).
 */
export async function loadArcs(personaDir: string, filename: string = 'arcs-1000d.yaml'): Promise<LoadedStory> {
    const raw = await readFile(join(personaDir, filename), 'utf-8');
    const data = YAML.parse(raw) as ArcsFile;
    const story: LoadedStory = { arcs: data.arcs };
    if (data.epoch !== undefined) story.epoch = data.epoch;
    if (data.sessions !== undefined) story.sessions = data.sessions;
    return story;
}

/**
 * Merge per-session lifecycle overrides from a story into the persona's
 * declared session shapes. The persona owns the shape (id, kind,
 * participants, isolated, sensitive_topics); the story owns the timing
 * (firstDay, lastDay). Sessions not listed in `lifecycles` keep their
 * persona-declared shape unchanged (no lifecycle = always-on within the
 * corpus).
 */
export function mergeSessionLifecycles(
    personaSessions: SessionDef[] | undefined,
    lifecycles: SessionLifecycle[] | undefined,
): SessionDef[] | undefined {
    if (!personaSessions) return undefined;
    if (!lifecycles || lifecycles.length === 0) return personaSessions;
    const lcMap = new Map<string, SessionLifecycle>();
    for (const lc of lifecycles) lcMap.set(lc.id, lc);
    return personaSessions.map(s => {
        const lc = lcMap.get(s.id);
        if (!lc) return s;
        const merged: SessionDef = { ...s };
        if (lc.firstDay !== undefined) merged.firstDay = lc.firstDay;
        else delete merged.firstDay;
        if (lc.lastDay !== undefined) merged.lastDay = lc.lastDay;
        else delete merged.lastDay;
        return merged;
    });
}

/**
 * Derive a sibling directory name from an arcs filename.
 *
 * Convention: arcs files are labeled by intended corpus duration —
 * `arcs-<suffix>.yaml` (e.g., `arcs-1000d.yaml` for the canonical default,
 * `arcs-180d.yaml` for a 180-day variant). Memory and Q&A directories
 * share the same suffix so each story's outputs land alongside it
 * without colliding across variants.
 *
 *   deriveSiblingDir('arcs-1000d.yaml', 'memories') -> 'memories-1000d'
 *   deriveSiblingDir('arcs-180d.yaml',  'memories') -> 'memories-180d'
 *   deriveSiblingDir('arcs-30d.yaml',   'qa')       -> 'qa-30d'
 *   deriveSiblingDir('arcs.yaml',       'memories') -> 'memories'  (legacy fallback)
 *
 * Returns the base unchanged if the filename doesn't match the
 * `arcs(-suffix)?.yaml` shape — defensive against unexpected names.
 */
export function deriveSiblingDir(arcsFilename: string, base: string): string {
    const match = arcsFilename.match(/^arcs(?:-(.+))?\.ya?ml$/);
    if (!match) return base;
    return match[1] ? `${base}-${match[1]}` : base;
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
