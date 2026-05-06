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
    GenerationResult,
    GeneratorConfig,
    GeneratorModel,
    PersonaDefinition,
    RecentDay,
    SessionDef,
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
 * Build the static system prompt for a persona (§3.1).
 *
 * The persona is an AI agent — a computer program that supports a human
 * (the `principal`) and works with other humans + agents (the `cast`).
 * The daily log is the AI agent's own working memory: a third-person
 * record of who interacted with the agent, what they asked, what the
 * agent produced, and what it handed off. The log is NOT a first-person
 * human professional's diary.
 */
export function buildSystemPrompt(persona: PersonaDefinition): string {
    const lines: string[] = [];

    const affiliation = persona.institution ?? persona.company ?? '';
    const hasSessions = persona.sessions !== undefined && persona.sessions.length > 0;

    lines.push(`You are an AI agent named "${persona.name}" — a computer program. Your job is to`);
    lines.push(`produce a single day's entry of YOUR OWN memory log, written from your perspective`);
    lines.push(`as the agent. The log records who interacted with you today (humans and other`);
    lines.push(`agents), what they asked, what you did, what you decided, what files or outputs`);
    lines.push(`you produced, and what you handed off.`);
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

    if (hasSessions) {
        lines.push('');
        lines.push('# Sessions — conversation contexts you participate in');
        for (const s of persona.sessions!) {
            const flags: string[] = [s.kind];
            if (s.isolated) flags.push('isolated');
            if (s.shared) flags.push('shared');
            const participants = s.participants.join(', ');
            lines.push(`- ${s.id} (${flags.join(', ')}) — participants: ${participants}`);
            if (s.sensitive_topics && s.sensitive_topics.length > 0) {
                lines.push('  sensitive topics (must stay in this session):');
                for (const t of s.sensitive_topics) {
                    lines.push(`    - ${t}`);
                }
            }
            if (s.firstDay !== undefined || s.lastDay !== undefined) {
                const start = s.firstDay ?? 1;
                const end = s.lastDay !== undefined ? String(s.lastDay) : 'end';
                lines.push(`  lifecycle: day ${start}–${end}`);
            }
        }
    }

    if (persona.sharedKnowledge && persona.sharedKnowledge.length > 0) {
        lines.push('');
        lines.push('# Shared knowledge — facts available to every session');
        for (const k of persona.sharedKnowledge) {
            lines.push(`- ${k}`);
        }
    }

    lines.push('');
    lines.push('# How to write the log');
    lines.push('- Write in third-person from the agent\'s perspective. Refer to yourself implicitly');
    lines.push('  ("Drafted Aim 2…", "Sent the sgRNA list to Sarah") or by name when needed.');
    lines.push('  DO NOT write a first-person human diary ("I came in early…", "Kicking off…").');
    lines.push('- Reference humans by name (e.g., "Kenji asked…"). Reference other AI agents with');
    lines.push('  @-handles (e.g., "Handed off PubMed query to @lit-search-agent").');
    lines.push('- Each section should describe an interaction or unit of work: who initiated it,');
    lines.push('  what was asked, what the agent produced or decided, and what files or handoffs');
    lines.push('  resulted. Quote the principal\'s ask verbatim when material.');
    lines.push('- Organize by TOPIC, not by clock time. Section titles should name the topic and');
    lines.push('  the person involved (e.g., "### Kenji — pKN001 colony screen review").');
    lines.push('- List files produced/changed and decisions explicitly. End with an "Outstanding"');
    lines.push('  or "Tomorrow" section when follow-up work exists.');

    if (hasSessions) {
        lines.push('');
        lines.push('# How to partition the log by session');
        lines.push('- The day\'s log is partitioned into **sessions**. Each session is a separate');
        lines.push('  conversation context (1:1 with the principal, a group meeting, an isolated');
        lines.push('  client room, etc.). Today\'s active sessions are listed in the user message.');
        lines.push('- Render one `# session: <id>` H1 per session that had activity today, in');
        lines.push('  canonical order: `principal` first if present, then group sessions in the');
        lines.push('  order they were declared in the persona definition. **Skip sessions with no');
        lines.push('  activity** — do not emit an empty H1.');
        lines.push('- Inside each session H1, organize by topic with H3 sub-sections as described');
        lines.push('  above. Topics belong under the session where the interaction actually occurred.');
        lines.push('- **Internal narration** (the agent\'s own scratchpad — reflections, planning,');
        lines.push('  cross-session summaries the agent makes for itself) is rendered as');
        lines.push('  un-prefixed body content **above** the first `# session:` H1. It is not a');
        lines.push('  session and is never quoted as such.');
        lines.push('- **Group session attribution.** Inside a group session H1, attribute speakers');
        lines.push('  verbatim when their words are load-bearing — e.g.,');
        lines.push('  `> Sarah: "We should hold off on the v2 transfection until LNP-7 is ready."`');
        lines.push('  Decisions, action items, and dissent must be attributed; never collapse into');
        lines.push('  "the team decided." If three participants agreed and one objected, record both.');
        lines.push('- **Isolated session no-leak invariant.** When a session is marked `isolated`,');
        lines.push('  its `sensitive_topics` are grounded as load-bearing facts under that session\'s');
        lines.push('  H1 only. Never echo a sensitive topic from an isolated session into a different');
        lines.push('  session\'s H1, except into `# session: principal` and only when the principal');
        lines.push('  explicitly authorizes the disclosure (the day must record that authorization).');
        lines.push('- **Cross-session arc echoes.** When today\'s user message marks an arc with');
        lines.push('  `referencedSessions`, render the arc\'s content under `primarySession` in detail');
        lines.push('  AND emit a brief, attributable echo under each referenced session — a status');
        lines.push('  update, briefing, or dissent moment, not a recap. The echo must be consistent');
        lines.push('  with the primary content; contradictions are bugs.');
        lines.push('- **Shared knowledge** (listed above) may be voiced in any session without');
        lines.push('  triggering a leak.');
    }

    lines.push('');
    lines.push('# Required output structure');
    lines.push('```');
    lines.push('---');
    lines.push('type: daily');
    lines.push('---');
    lines.push('');
    if (hasSessions) {
        lines.push('<optional internal narration — un-prefixed body, before any session H1>');
        lines.push('');
        lines.push('# session: <session-id>');
        lines.push('');
        lines.push('### <topic / interaction title>');
        lines.push('');
        lines.push('<body — narrate the interaction, decision, or output>');
        lines.push('');
        lines.push('### <next topic>');
        lines.push('...');
        lines.push('');
        lines.push('# session: <next-session-id>');
        lines.push('');
        lines.push('### <topic / interaction title>');
        lines.push('...');
        lines.push('```');
        lines.push('');
        lines.push('Frontmatter is minimal. Use one `# session: <id>` H1 per active session.');
        lines.push('Each topic inside a session is an H3. The agent does not perform physical');
        lines.push('actions itself (no pipetting, no surgery, no courtroom appearances) — it');
        lines.push('drafts, analyzes, searches, summarizes, schedules, and coordinates. Physical');
        lines.push('actions are taken by humans, who report results back to the agent.');
    } else {
        lines.push('## YYYY-MM-DD');
        lines.push('');
        lines.push('### <topic / interaction title>');
        lines.push('');
        lines.push('<body — narrate the interaction, decision, or output>');
        lines.push('');
        lines.push('### <next topic>');
        lines.push('...');
        lines.push('```');
        lines.push('');
        lines.push('Use a single H2 for the date. Each section is an H3. Frontmatter is minimal.');
        lines.push('The agent does not perform physical actions itself (no pipetting, no surgery, no');
        lines.push('courtroom appearances) — it drafts, analyzes, searches, summarizes, schedules,');
        lines.push('and coordinates. Physical actions are taken by humans, who report results back to');
        lines.push('the agent.');
    }

    return lines.join('\n');
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

    // Today's active sessions — emit one `# session: <id>` H1 per session, in this order.
    // Skipped entirely for v0.2 personas (no sessions block in the system prompt).
    if (ctx.activeSessions && ctx.activeSessions.length > 0) {
        lines.push('Active sessions today (emit one `# session: <id>` H1 per session, in this order):');
        for (const s of ctx.activeSessions) {
            lines.push(`  - ${s}`);
        }
        lines.push('');
    }

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
            if (arc.primarySession !== undefined) {
                lines.push(`    primarySession: ${arc.primarySession}`);
            }
            if (arc.referencedSessions !== undefined && arc.referencedSessions.length > 0) {
                lines.push(`    referencedSessions: [${arc.referencedSessions.join(', ')}]`);
                lines.push(`    echo_today: ${arc.echoToday === true}`);
            }
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
    lines.push('the log. Write as the AI agent in third person — record interactions,');
    lines.push('decisions, files produced, and handoffs. Do NOT write a first-person');
    lines.push('human diary.');

    return lines.join('\n');
}

/**
 * Build the user message for Pass 1 — arc-focused generation.
 *
 * When existingContent is provided, the LLM is asked to merge the new arc's
 * activity into the existing log rather than starting from scratch.
 */
export function buildArcUserMessage(
    ctx: DayContext,
    focusArc: ActiveArc,
    existingContent: string | null,
): string {
    const lines: string[] = [];

    if (existingContent) {
        lines.push(`Update the daily memory log for day ${ctx.dayNumber} to include activity from the "${focusArc.title}" arc.`);
        lines.push('');
        lines.push('EXISTING LOG (integrate new activity into this — keep all existing content):');
        lines.push('');
        lines.push(existingContent);
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push('IMPORTANT — merge rules when integrating into the existing log:');
        lines.push('- Each session must have AT MOST ONE `# session: <id>` H1 in the final output.');
        lines.push('  If the existing log already has `# session: principal` (or any other session),');
        lines.push('  append your new ### topic sections UNDER that existing H1. Do NOT create a');
        lines.push('  duplicate H1 for the same session.');
        lines.push('- Only emit a new `# session: <id>` H1 if the existing log doesn\'t already have');
        lines.push('  one for that session AND the new arc activity belongs in that session today.');
        lines.push('- Keep all existing content verbatim — only add new ### topic sections for the');
        lines.push('  focus arc, placed under the appropriate session H1.');
        lines.push('');
    } else {
        lines.push(`Generate the daily memory log for day ${ctx.dayNumber}.`);
        lines.push('');
    }

    lines.push(`Date: ${ctx.calendarDate} (${ctx.dayOfWeek})`);
    lines.push(`Density: ${ctx.densityHint}`);
    lines.push('');

    // Focus arc (prominent)
    lines.push('PRIMARY arc for this entry:');
    lines.push(`  - id: ${focusArc.id}`);
    lines.push(`    type: ${focusArc.type}`);
    lines.push(`    title: "${focusArc.title}"`);
    lines.push(`    phase: ${focusArc.phase}`);
    lines.push(`    day_in_arc: ${focusArc.dayInArc}`);
    lines.push(`    arc_length: ${focusArc.arcLength}`);
    lines.push(`    description: |`);
    for (const dl of focusArc.description.trim().split('\n')) {
        lines.push(`      ${dl.trim()}`);
    }

    // Other active arcs (brief context)
    const others = ctx.activeArcs.filter(a => a.id !== focusArc.id);
    if (others.length > 0) {
        lines.push('');
        lines.push('Other active arcs (for background context only):');
        for (const arc of others) {
            lines.push(`  - id: ${arc.id}`);
            lines.push(`    type: ${arc.type}`);
            lines.push(`    title: "${arc.title}"`);
            lines.push(`    phase: ${arc.phase}`);
        }
    }

    // Directives for the focus arc on this day
    const focusDirectives = ctx.directives.filter(d => d.arc === focusArc.id);
    if (focusDirectives.length > 0) {
        lines.push('');
        lines.push("Today's events (MUST appear in the log):");
        for (const d of focusDirectives) {
            lines.push(`  - arc: ${d.arc}`);
            lines.push(`    event: "${d.event}"`);
        }
    }

    // Correction state for the focus arc
    const focusCorrections = ctx.correctionStates.filter(c => c.arc === focusArc.id);
    if (focusCorrections.length > 0) {
        lines.push('');
        lines.push('Correction state:');
        for (const c of focusCorrections) {
            lines.push(`  - arc: ${c.arc}`);
            lines.push(`    phase: ${c.phase}`);
            lines.push(`    belief: "${c.belief}"`);
            if (c.correctedBelief) {
                lines.push(`    corrected_belief: "${c.correctedBelief}"`);
            }
        }
    }

    // Arc summary for the focus arc
    const focusSummary = ctx.arcSummaries.find(s => s.id === focusArc.id);
    if (focusSummary && focusSummary.summary.trim().length > 0) {
        lines.push('');
        lines.push('Arc progress summary:');
        lines.push(`  - id: ${focusSummary.id}`);
        lines.push(`    summary: |`);
        for (const sl of focusSummary.summary.trim().split('\n')) {
            lines.push(`      ${sl.trim()}`);
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
        lines.push('(This is the first generated day — no recent history.)');
    }

    lines.push('Produce ONLY the markdown content for this day\'s log, including the');
    lines.push('YAML frontmatter. Do not include any explanation or commentary outside');
    lines.push('the log. Write as the AI agent in third person — record interactions,');
    lines.push('decisions, files produced, and handoffs. Do NOT write a first-person');
    lines.push('human diary.');

    return lines.join('\n');
}

/**
 * Build the user message for Pass 2 — gap-filling generation.
 *
 * Produces routine/light activity days referencing active arcs in passing.
 */
export function buildGapUserMessage(ctx: DayContext): string {
    const lines: string[] = [];

    lines.push(`Generate a routine daily memory log for day ${ctx.dayNumber}.`);
    lines.push('This is a lighter day — no major arc milestones. Include routine');
    lines.push('work activity: code reviews, standup notes, small tasks, meetings,');
    lines.push('or background progress on active arcs.');
    lines.push('');
    lines.push(`Date: ${ctx.calendarDate} (${ctx.dayOfWeek})`);
    lines.push(`Density: quiet`);
    lines.push('');

    // Active arcs for background reference
    if (ctx.activeArcs.length > 0) {
        lines.push('Active arcs (mention in passing if natural, do NOT create major events):');
        for (const arc of ctx.activeArcs) {
            lines.push(`  - id: ${arc.id}`);
            lines.push(`    type: ${arc.type}`);
            lines.push(`    title: "${arc.title}"`);
            lines.push(`    phase: ${arc.phase}`);
        }
    } else {
        lines.push('(No major arcs active — generate general work activity.)');
    }

    // Correction state (so the LLM uses the right beliefs)
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
        lines.push('(No recent history available.)');
    }

    lines.push('Produce ONLY the markdown content for this day\'s log, including the');
    lines.push('YAML frontmatter. Do not include any explanation or commentary outside');
    lines.push('the log. Write as the AI agent in third person — record interactions,');
    lines.push('decisions, files produced, and handoffs. Do NOT write a first-person');
    lines.push('human diary.');

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

    /** Sliding window of recently generated days (ordered by dayNumber). */
    private recentDays: RecentDay[] = [];

    /** Arc summaries, keyed by arc ID. */
    private arcSummaries = new Map<string, ArcSummary>();

    /** All generated day contents, keyed by day number. */
    private generatedDays = new Map<number, string>();

    /** Token tracking per day (accumulated across passes). */
    private dayTokens = new Map<number, { input: number; output: number }>();

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
            minDaysPerWeek: config.minDaysPerWeek ?? 5,
            onDay: config.onDay,
        };
    }

    /**
     * Two-pass generation pipeline.
     *
     * Pass 1: Process each arc in startDay order. For each arc, select activity
     *   days and generate focused content. Days that already have content from
     *   earlier arcs are merged.
     *
     * Pass 2: Scan weeks for fewer than minDaysPerWeek active days. Generate
     *   routine filler for empty weekdays until the target is reached.
     *
     * After both passes, fires onDay for every generated day in order and
     * returns the full GenerationResult.
     */
    async generateAll(): Promise<GenerationResult> {
        // Pass 1 — arc-by-arc (writes onDay incrementally as each day is generated)
        await this.runArcPass();

        // Pass 2 — gap filling (also writes onDay incrementally)
        await this.runGapPass();

        // Build the GenerationResult from in-memory state. onDay has already
        // been called for every generated day during the passes above; we do
        // not re-fire it here.
        const sortedDays = [...this.generatedDays.keys()].sort((a, b) => a - b);
        const days: GeneratedDay[] = [];
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        for (const dayNumber of sortedDays) {
            const content = this.generatedDays.get(dayNumber)!;
            const date = computeCalendarDate(this.persona.epoch, dayNumber);
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

        const activeSessions = computeActiveSessions(activeArcs, this.persona.sessions);

        return {
            dayNumber,
            calendarDate,
            dayOfWeek,
            densityHint,
            activeArcs,
            directives,
            correctionStates,
            arcSummaries,
            recentHistory: this.getRecentHistory(dayNumber),
            activeSessions,
        };
    }

    // -----------------------------------------------------------------------
    // Pass 1 — Arc-by-arc generation
    // -----------------------------------------------------------------------

    private async runArcPass(): Promise<void> {
        // Sort arcs by start day (stable — arcs with the same startDay keep YAML order)
        const sorted = [...this.arcs]
            .filter(a => a.endDay >= this.config.startDay && a.startDay <= this.config.endDay)
            .sort((a, b) => a.startDay - b.startDay);

        const systemPrompt = buildSystemPrompt(this.persona);

        for (const arc of sorted) {
            const days = selectArcDays(arc, this.persona.epoch)
                .filter(d => d >= this.config.startDay && d <= this.config.endDay);

            for (const dayNumber of days) {
                const ctx = this.buildDayContext(dayNumber);
                const focusArc = ctx.activeArcs.find(a => a.id === arc.id);
                if (!focusArc) continue; // shouldn't happen, but guard

                const existing = this.generatedDays.get(dayNumber) ?? null;
                const userMessage = buildArcUserMessage(ctx, focusArc, existing);

                let result;
                try {
                    result = await this.model.complete(systemPrompt, userMessage, {
                        maxTokens: this.config.maxTokens,
                        temperature: this.config.temperature,
                    });
                } catch (err) {
                    // Per-call failures (timeout, subprocess crash) must not
                    // abort the run — keep going so we don't lose all prior days.
                    const msg = err instanceof Error ? err.message : String(err);
                    process.stderr.write(`\n[generator] arc=${arc.id} day=${dayNumber} skipped: ${msg.split('\n')[0]}\n`);
                    continue;
                }

                const content = result.text;
                this.generatedDays.set(dayNumber, content);
                this.trackTokens(dayNumber, result.inputTokens ?? 0, result.outputTokens ?? 0);
                this.insertRecentDay(dayNumber, ctx.calendarDate, ctx.dayOfWeek, content);
                await this.updateArcSummaries(dayNumber, [focusArc], content);

                // Write through onDay so progress is durable on disk before
                // the next subprocess call. A mid-run crash keeps prior days.
                if (this.config.onDay) {
                    await this.config.onDay(dayNumber, content, 'arc');
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Pass 2 — Gap filling
    // -----------------------------------------------------------------------

    private async runGapPass(): Promise<void> {
        const activeDays = new Set(this.generatedDays.keys());
        const gapDays = identifyGapDays(
            activeDays,
            this.config.startDay,
            this.config.endDay,
            this.persona.epoch,
            this.config.minDaysPerWeek,
        );

        if (gapDays.length === 0) return;

        const systemPrompt = buildSystemPrompt(this.persona);

        for (const dayNumber of gapDays) {
            const ctx = this.buildDayContext(dayNumber);
            const userMessage = buildGapUserMessage(ctx);

            let result;
            try {
                result = await this.model.complete(systemPrompt, userMessage, {
                    maxTokens: this.config.maxTokens,
                    temperature: this.config.temperature,
                });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`\n[generator] gap day=${dayNumber} skipped: ${msg.split('\n')[0]}\n`);
                continue;
            }

            const content = result.text;
            this.generatedDays.set(dayNumber, content);
            this.trackTokens(dayNumber, result.inputTokens ?? 0, result.outputTokens ?? 0);
            this.insertRecentDay(dayNumber, ctx.calendarDate, ctx.dayOfWeek, content);

            if (this.config.onDay) {
                await this.config.onDay(dayNumber, content, 'gap');
            }
        }
    }

    // -----------------------------------------------------------------------
    // Internal state management
    // -----------------------------------------------------------------------

    /**
     * Get the N most recent generated days before the given dayNumber.
     * Unlike the old sequential approach, days may be generated out of order,
     * so we search generatedDays for the closest preceding entries.
     */
    private getRecentHistory(dayNumber: number): RecentDay[] {
        // Collect all generated day numbers before this day
        const prior = [...this.generatedDays.keys()]
            .filter(d => d < dayNumber)
            .sort((a, b) => b - a) // descending — most recent first
            .slice(0, this.config.historyWindow);

        // Return in chronological order (ascending)
        return prior.reverse().map(d => {
            const date = computeCalendarDate(this.persona.epoch, d);
            return {
                dayNumber: d,
                calendarDate: formatDate(date),
                dayOfWeek: getDayOfWeek(date),
                content: this.generatedDays.get(d)!,
            };
        });
    }

    /**
     * Insert or update a day in the recent-days window (used for arc summary
     * extraction). Maintains chronological order.
     */
    private insertRecentDay(dayNumber: number, calendarDate: string, dayOfWeek: string, content: string): void {
        const idx = this.recentDays.findIndex(r => r.dayNumber === dayNumber);
        if (idx >= 0) {
            this.recentDays[idx] = { dayNumber, calendarDate, dayOfWeek, content };
        } else {
            this.recentDays.push({ dayNumber, calendarDate, dayOfWeek, content });
            this.recentDays.sort((a, b) => a.dayNumber - b.dayNumber);
            // Trim to keep only the last N entries
            while (this.recentDays.length > this.config.historyWindow * 2) {
                this.recentDays.shift();
            }
        }
    }

    private trackTokens(dayNumber: number, input: number, output: number): void {
        const existing = this.dayTokens.get(dayNumber);
        if (existing) {
            existing.input += input;
            existing.output += output;
        } else {
            this.dayTokens.set(dayNumber, { input, output });
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
 * Load arc definitions from an arcs file inside the persona directory.
 *
 * Default filename is `arcs.yaml` (the 1000-day canonical story). Variant
 * filenames follow the convention `arcs-<NNN>d.yaml` (e.g.,
 * `arcs-180d.yaml` for a 180-day story); these label the file by its
 * intended corpus duration. Memory-dir and Q&A-dir derivation off the
 * filename is the responsibility of callers (see `deriveSiblingDir`).
 */
export async function loadArcs(personaDir: string, filename: string = 'arcs.yaml'): Promise<ArcDefinition[]> {
    const raw = await readFile(join(personaDir, filename), 'utf-8');
    const data = YAML.parse(raw) as ArcsFile;
    return data.arcs;
}

/**
 * Derive a sibling directory name from an arcs filename.
 *
 * Convention: arcs files are `arcs.yaml` (default) or `arcs-<suffix>.yaml`
 * (e.g., `arcs-180d.yaml`). Memory and Q&A directories share the same
 * suffix so a 180-day story's outputs land alongside it without colliding
 * with the 1000-day story.
 *
 *   deriveSiblingDir('arcs.yaml',       'memories') -> 'memories'
 *   deriveSiblingDir('arcs-180d.yaml',  'memories') -> 'memories-180d'
 *   deriveSiblingDir('arcs-30d.yaml',   'qa')       -> 'qa-30d'
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
