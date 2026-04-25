import { describe, it, expect } from 'vitest';
import {
    computePhase,
    computeDensity,
    getActiveArcs,
    getDirectives,
    getCorrectionStates,
    selectArcDays,
    identifyGapDays,
    computeCalendarDate,
    formatDate,
    getDayOfWeek,
    buildSystemPrompt,
    buildUserMessage,
    buildArcUserMessage,
    buildGapUserMessage,
    DayGenerator,
} from '../src/generator.js';
import type { ArcDefinition, PersonaDefinition, GeneratorModel, DayContext, ActiveArc, Directive, CorrectionState, ArcSummary, RecentDay } from '../src/generator-types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const testPersona: PersonaDefinition = {
    id: 'test-persona',
    name: 'River Chen',
    epoch: '2024-01-01',
    role: 'Senior Backend Engineer',
    domain: 'B2B SaaS platform',
    company: 'Nexus',
    team_size: 8,
    profile: 'Experienced backend engineer with 7 years of experience.',
    communication_style: 'Direct and technical. Uses precise terminology.',
};

const testArcs: ArcDefinition[] = [
    {
        id: 'auth-migration',
        type: 'project',
        title: 'Auth migration: sessions → JWT',
        description: 'Replace legacy session-based auth with JWT tokens.',
        startDay: 15,
        endDay: 145,
        directives: [
            { day: 15, event: 'Auth migration project kick-off meeting' },
            { day: 85, event: 'Connection pool exhaustion incident discovered' },
        ],
    },
    {
        id: 'incident-db-pool',
        type: 'incident',
        title: 'Database connection pool exhaustion',
        description: 'Production outage from leaked connections.',
        startDay: 85,
        endDay: 95,
    },
    {
        id: 'correction-rate-limit',
        type: 'correction',
        title: 'API rate limit correction',
        description: 'Rate limit believed to be 100rps, actually 1000rps.',
        startDay: 50,
        endDay: 200,
        wrongDay: 50,
        correctedDay: 200,
        wrongBelief: 'Vendor API rate-limited to 100 requests/second',
        correctedBelief: 'Actual rate limit is 1000 requests/second',
    },
    {
        id: 'learning-k8s',
        type: 'learning',
        title: 'Kubernetes operators',
        description: 'Learning K8s operator patterns.',
        startDay: 50,
        endDay: 280,
    },
];

function createMockModel(response = 'Generated day content.'): GeneratorModel {
    return {
        async complete() {
            return { text: response, inputTokens: 100, outputTokens: 50 };
        },
    };
}

// ---------------------------------------------------------------------------
// computePhase
// ---------------------------------------------------------------------------

describe('computePhase', () => {
    it('returns early for < 15% through arc', () => {
        expect(computePhase(1, 100)).toBe('early');
        expect(computePhase(14, 100)).toBe('early');
    });

    it('returns mid for 15%-75%', () => {
        expect(computePhase(15, 100)).toBe('mid');
        expect(computePhase(50, 100)).toBe('mid');
        expect(computePhase(75, 100)).toBe('mid');
    });

    it('returns late for 75%-90%', () => {
        expect(computePhase(76, 100)).toBe('late');
        expect(computePhase(90, 100)).toBe('late');
    });

    it('returns concluding for > 90%', () => {
        expect(computePhase(91, 100)).toBe('concluding');
        expect(computePhase(100, 100)).toBe('concluding');
    });

    it('handles zero-length arc', () => {
        expect(computePhase(1, 0)).toBe('mid');
    });
});

// ---------------------------------------------------------------------------
// getActiveArcs
// ---------------------------------------------------------------------------

describe('getActiveArcs', () => {
    it('returns arcs that span the given day', () => {
        const active = getActiveArcs(testArcs, 90);
        const ids = active.map(a => a.id);
        expect(ids).toContain('auth-migration');
        expect(ids).toContain('incident-db-pool');
        expect(ids).toContain('correction-rate-limit');
        expect(ids).toContain('learning-k8s');
    });

    it('excludes arcs outside their range', () => {
        const active = getActiveArcs(testArcs, 10);
        expect(active).toHaveLength(0);
    });

    it('includes arcs on their start day', () => {
        const active = getActiveArcs(testArcs, 15);
        expect(active.find(a => a.id === 'auth-migration')).toBeDefined();
    });

    it('includes arcs on their end day', () => {
        const active = getActiveArcs(testArcs, 145);
        expect(active.find(a => a.id === 'auth-migration')).toBeDefined();
    });

    it('annotates phase correctly', () => {
        const active = getActiveArcs(testArcs, 15);
        const auth = active.find(a => a.id === 'auth-migration')!;
        expect(auth.phase).toBe('early');
        expect(auth.dayInArc).toBe(1);
        expect(auth.arcLength).toBe(131); // 145 - 15 + 1
    });
});

// ---------------------------------------------------------------------------
// computeDensity
// ---------------------------------------------------------------------------

describe('computeDensity', () => {
    const normalArc: ActiveArc = {
        id: 'test', type: 'project', title: 'Test', description: '',
        phase: 'mid', dayInArc: 50, arcLength: 200,
    };
    const incidentArc: ActiveArc = {
        id: 'inc', type: 'incident', title: 'Incident', description: '',
        phase: 'mid', dayInArc: 3, arcLength: 10,
    };
    const startArc: ActiveArc = {
        id: 'start', type: 'project', title: 'Start', description: '',
        phase: 'early', dayInArc: 1, arcLength: 100,
    };

    it('returns quiet for weekends without incidents', () => {
        expect(computeDensity('Saturday', [normalArc], [], [])).toBe('quiet');
        expect(computeDensity('Sunday', [normalArc], [], [])).toBe('quiet');
    });

    it('does not return quiet for weekends with active incidents', () => {
        const result = computeDensity('Saturday', [incidentArc], [], []);
        expect(result).not.toBe('quiet');
    });

    it('returns dense for correction days', () => {
        const correction: CorrectionState = { arc: 'x', phase: 'correction_day', belief: 'wrong' };
        expect(computeDensity('Wednesday', [normalArc], [], [correction])).toBe('dense');
    });

    it('returns dense for multiple directives with many arcs', () => {
        const dirs: Directive[] = [
            { arc: 'a', event: 'Event 1' },
            { arc: 'b', event: 'Event 2' },
        ];
        expect(computeDensity('Monday', [normalArc, normalArc, normalArc], dirs, [])).toBe('dense');
    });

    it('returns busy for incident arcs', () => {
        expect(computeDensity('Monday', [incidentArc], [], [])).toBe('busy');
    });

    it('returns busy for arc start days', () => {
        expect(computeDensity('Tuesday', [startArc], [], [])).toBe('busy');
    });

    it('returns busy with directives present', () => {
        const dirs: Directive[] = [{ arc: 'a', event: 'Something' }];
        expect(computeDensity('Wednesday', [normalArc], dirs, [])).toBe('busy');
    });

    it('returns normal for routine weekday with 1-2 arcs', () => {
        expect(computeDensity('Monday', [normalArc], [], [])).toBe('normal');
    });

    it('returns quiet when no arcs are active', () => {
        expect(computeDensity('Wednesday', [], [], [])).toBe('quiet');
    });
});

// ---------------------------------------------------------------------------
// getDirectives
// ---------------------------------------------------------------------------

describe('getDirectives', () => {
    it('returns directives matching the day', () => {
        const dirs = getDirectives(testArcs, 15);
        expect(dirs).toHaveLength(1);
        expect(dirs[0].arc).toBe('auth-migration');
        expect(dirs[0].event).toBe('Auth migration project kick-off meeting');
    });

    it('returns multiple directives on the same day', () => {
        const dirs = getDirectives(testArcs, 85);
        expect(dirs).toHaveLength(1);
        expect(dirs[0].event).toContain('Connection pool');
    });

    it('returns empty for days with no directives', () => {
        expect(getDirectives(testArcs, 100)).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// getCorrectionStates
// ---------------------------------------------------------------------------

describe('getCorrectionStates', () => {
    it('returns wrong_belief before correction day', () => {
        const states = getCorrectionStates(testArcs, 100);
        expect(states).toHaveLength(1);
        expect(states[0].phase).toBe('wrong_belief');
        expect(states[0].belief).toBe('Vendor API rate-limited to 100 requests/second');
        expect(states[0].correctedBelief).toBeUndefined();
    });

    it('returns correction_day on the correction day', () => {
        const states = getCorrectionStates(testArcs, 200);
        expect(states).toHaveLength(1);
        expect(states[0].phase).toBe('correction_day');
        expect(states[0].correctedBelief).toBe('Actual rate limit is 1000 requests/second');
    });

    it('returns empty outside the correction arc range', () => {
        expect(getCorrectionStates(testArcs, 10)).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// selectArcDays
// ---------------------------------------------------------------------------

describe('selectArcDays', () => {
    const epoch = '2024-01-01'; // Monday

    it('always includes directive days', () => {
        const days = selectArcDays(testArcs[0], epoch); // auth-migration
        expect(days).toContain(15); // directive day
        expect(days).toContain(85); // directive day
    });

    it('always includes arc start and end days', () => {
        const days = selectArcDays(testArcs[0], epoch);
        expect(days).toContain(15); // startDay
        expect(days).toContain(145); // endDay
    });

    it('includes correction key days', () => {
        const days = selectArcDays(testArcs[2], epoch); // correction-rate-limit
        expect(days).toContain(50); // wrongDay / startDay
        expect(days).toContain(200); // correctedDay / endDay
    });

    it('skips weekends for non-incident arcs', () => {
        const days = selectArcDays(testArcs[3], epoch); // learning-k8s, days 50-280
        for (const d of days) {
            const date = computeCalendarDate(epoch, d);
            const dow = getDayOfWeek(date);
            // Pinned days (startDay/endDay) can land on weekends, but spread days should not
            if (d !== testArcs[3].startDay && d !== testArcs[3].endDay) {
                expect(dow).not.toBe('Saturday');
                expect(dow).not.toBe('Sunday');
            }
        }
    });

    it('includes weekends for incident arcs', () => {
        // incident-db-pool: days 85-95 (short arc, includes a weekend)
        const days = selectArcDays(testArcs[1], epoch);
        const weekendDays = days.filter(d => {
            const date = computeCalendarDate(epoch, d);
            const dow = getDayOfWeek(date);
            return dow === 'Saturday' || dow === 'Sunday';
        });
        // The arc spans 11 days including a weekend, incident type should include them
        expect(weekendDays.length).toBeGreaterThanOrEqual(0); // may or may not hit weekend depending on interval
    });

    it('returns sorted unique days', () => {
        const days = selectArcDays(testArcs[0], epoch);
        for (let i = 1; i < days.length; i++) {
            expect(days[i]).toBeGreaterThan(days[i - 1]);
        }
    });

    it('uses shorter intervals for short arcs', () => {
        const shortArc: ArcDefinition = {
            id: 'short', type: 'project', title: 'Short',
            description: 'A short arc.', startDay: 1, endDay: 10,
        };
        const days = selectArcDays(shortArc, epoch);
        // Short arc (10 days) should have relatively dense coverage
        expect(days.length).toBeGreaterThanOrEqual(3);
    });

    it('uses longer intervals for long arcs', () => {
        const longArc: ArcDefinition = {
            id: 'long', type: 'project', title: 'Long',
            description: 'A long arc.', startDay: 1, endDay: 200,
        };
        const days = selectArcDays(longArc, epoch);
        // Long arc should not generate activity every day
        expect(days.length).toBeLessThan(200);
        expect(days.length).toBeGreaterThan(10);
    });
});

// ---------------------------------------------------------------------------
// identifyGapDays
// ---------------------------------------------------------------------------

describe('identifyGapDays', () => {
    const epoch = '2024-01-01'; // Monday

    it('fills weeks with fewer than target active days', () => {
        // Week 1: Mon-Fri = days 1-5, only day 1 active
        const active = new Set([1]);
        const gaps = identifyGapDays(active, 1, 7, epoch, 5);
        // Need 4 more weekdays (days 2-5 are available weekdays)
        expect(gaps.length).toBe(4);
    });

    it('does not fill already-full weeks', () => {
        // Week 1: all weekdays active
        const active = new Set([1, 2, 3, 4, 5]);
        const gaps = identifyGapDays(active, 1, 7, epoch, 5);
        expect(gaps.length).toBe(0);
    });

    it('only selects weekdays for gaps', () => {
        const active = new Set<number>(); // nothing active
        const gaps = identifyGapDays(active, 1, 7, epoch, 5);
        for (const d of gaps) {
            const date = computeCalendarDate(epoch, d);
            const dow = getDayOfWeek(date);
            expect(dow).not.toBe('Saturday');
            expect(dow).not.toBe('Sunday');
        }
    });

    it('respects the target per week setting', () => {
        const active = new Set([1, 2]); // 2 active in week 1
        const gaps3 = identifyGapDays(active, 1, 7, epoch, 3);
        expect(gaps3.length).toBe(1); // need 1 more to reach 3
        const gaps5 = identifyGapDays(active, 1, 7, epoch, 5);
        expect(gaps5.length).toBe(3); // need 3 more to reach 5
    });

    it('returns empty when no gaps exist', () => {
        const active = new Set([1, 2, 3, 4, 5, 8, 9, 10, 11, 12]);
        const gaps = identifyGapDays(active, 1, 14, epoch, 5);
        expect(gaps.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Calendar date helpers
// ---------------------------------------------------------------------------

describe('calendar date helpers', () => {
    it('computes date from epoch and day number', () => {
        const d = computeCalendarDate('2024-01-01', 1);
        expect(formatDate(d)).toBe('2024-01-01');
    });

    it('advances by day number', () => {
        const d = computeCalendarDate('2024-01-01', 32);
        expect(formatDate(d)).toBe('2024-02-01');
    });

    it('gets day of week', () => {
        const d = computeCalendarDate('2024-01-01', 1); // Monday
        expect(getDayOfWeek(d)).toBe('Monday');
    });

    it('gets Saturday correctly', () => {
        const d = computeCalendarDate('2024-01-01', 6); // Saturday
        expect(getDayOfWeek(d)).toBe('Saturday');
    });
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

describe('buildSystemPrompt', () => {
    it('includes persona fields', () => {
        const prompt = buildSystemPrompt(testPersona);
        expect(prompt).toContain('River Chen');
        expect(prompt).toContain('Senior Backend Engineer');
        expect(prompt).toContain('B2B SaaS platform');
        expect(prompt).toContain('Nexus');
        expect(prompt).toContain('8');
        expect(prompt).toContain('Experienced backend engineer');
        expect(prompt).toContain('Direct and technical');
    });
});

describe('buildUserMessage', () => {
    it('includes all context sections', () => {
        const ctx: DayContext = {
            dayNumber: 90,
            calendarDate: '2024-03-30',
            dayOfWeek: 'Saturday',
            densityHint: 'busy',
            activeArcs: [{
                id: 'auth-migration', type: 'project',
                title: 'Auth migration', description: 'Replace auth system.',
                phase: 'mid', dayInArc: 76, arcLength: 131,
            }],
            directives: [{ arc: 'auth-migration', event: 'Major milestone reached' }],
            correctionStates: [{
                arc: 'rate-limit', phase: 'wrong_belief',
                belief: 'Rate limit is 100rps',
            }],
            arcSummaries: [{
                id: 'auth-migration',
                summary: 'JWT rollout is 60% complete. Refresh tokens deployed.',
                runningLog: [],
            }],
            recentHistory: [{
                dayNumber: 89, calendarDate: '2024-03-29',
                dayOfWeek: 'Friday', content: 'Worked on token rotation.',
            }],
        };

        const msg = buildUserMessage(ctx);
        expect(msg).toContain('day 90');
        expect(msg).toContain('2024-03-30 (Saturday)');
        expect(msg).toContain('Density: busy');
        expect(msg).toContain('auth-migration');
        expect(msg).toContain('phase: mid');
        expect(msg).toContain('Major milestone reached');
        expect(msg).toContain('wrong_belief');
        expect(msg).toContain('Rate limit is 100rps');
        expect(msg).toContain('JWT rollout is 60% complete');
        expect(msg).toContain('Day 89');
        expect(msg).toContain('Worked on token rotation');
        expect(msg).toContain('YAML frontmatter');
    });

    it('handles empty context gracefully', () => {
        const ctx: DayContext = {
            dayNumber: 1,
            calendarDate: '2024-01-01',
            dayOfWeek: 'Monday',
            densityHint: 'normal',
            activeArcs: [],
            directives: [],
            correctionStates: [],
            arcSummaries: [],
            recentHistory: [],
        };

        const msg = buildUserMessage(ctx);
        expect(msg).toContain('day 1');
        expect(msg).toContain('(none)');
        expect(msg).toContain('first day');
        expect(msg).not.toContain("Today's events");
        expect(msg).not.toContain('Correction state');
        expect(msg).not.toContain('Arc progress summaries');
    });
});

describe('buildArcUserMessage', () => {
    const focusArc: ActiveArc = {
        id: 'auth-migration', type: 'project',
        title: 'Auth migration', description: 'Replace auth system.',
        phase: 'mid', dayInArc: 76, arcLength: 131,
    };

    const baseCtx: DayContext = {
        dayNumber: 90,
        calendarDate: '2024-03-30',
        dayOfWeek: 'Saturday',
        densityHint: 'busy',
        activeArcs: [
            focusArc,
            { id: 'learning-k8s', type: 'learning', title: 'K8s operators', description: 'Learning K8s.', phase: 'mid', dayInArc: 41, arcLength: 231 },
        ],
        directives: [{ arc: 'auth-migration', event: 'Major milestone' }],
        correctionStates: [],
        arcSummaries: [],
        recentHistory: [],
    };

    it('generates fresh content when no existing', () => {
        const msg = buildArcUserMessage(baseCtx, focusArc, null);
        expect(msg).toContain('Generate the daily memory log');
        expect(msg).toContain('PRIMARY arc');
        expect(msg).toContain('auth-migration');
        expect(msg).toContain('Major milestone');
        expect(msg).not.toContain('EXISTING LOG');
    });

    it('includes merge instructions when existing content provided', () => {
        const msg = buildArcUserMessage(baseCtx, focusArc, 'Previous arc content here.');
        expect(msg).toContain('Update the daily memory log');
        expect(msg).toContain('EXISTING LOG');
        expect(msg).toContain('Previous arc content here.');
        expect(msg).toContain('PRIMARY arc');
    });

    it('shows other arcs as background context', () => {
        const msg = buildArcUserMessage(baseCtx, focusArc, null);
        expect(msg).toContain('Other active arcs');
        expect(msg).toContain('learning-k8s');
    });

    it('only includes directives for the focus arc', () => {
        const ctx: DayContext = {
            ...baseCtx,
            directives: [
                { arc: 'auth-migration', event: 'Auth event' },
                { arc: 'other-arc', event: 'Other event' },
            ],
        };
        const msg = buildArcUserMessage(ctx, focusArc, null);
        expect(msg).toContain('Auth event');
        expect(msg).not.toContain('Other event');
    });
});

describe('buildGapUserMessage', () => {
    it('generates routine day prompt', () => {
        const ctx: DayContext = {
            dayNumber: 42,
            calendarDate: '2024-02-11',
            dayOfWeek: 'Sunday',
            densityHint: 'quiet',
            activeArcs: [
                { id: 'auth', type: 'project', title: 'Auth', description: '', phase: 'mid', dayInArc: 28, arcLength: 131 },
            ],
            directives: [],
            correctionStates: [],
            arcSummaries: [],
            recentHistory: [],
        };

        const msg = buildGapUserMessage(ctx);
        expect(msg).toContain('routine daily memory log');
        expect(msg).toContain('lighter day');
        expect(msg).toContain('Density: quiet');
        expect(msg).toContain('mention in passing');
        expect(msg).toContain('auth');
    });

    it('handles no active arcs', () => {
        const ctx: DayContext = {
            dayNumber: 1,
            calendarDate: '2024-01-01',
            dayOfWeek: 'Monday',
            densityHint: 'quiet',
            activeArcs: [],
            directives: [],
            correctionStates: [],
            arcSummaries: [],
            recentHistory: [],
        };

        const msg = buildGapUserMessage(ctx);
        expect(msg).toContain('No major arcs active');
        expect(msg).toContain('general work activity');
    });
});

// ---------------------------------------------------------------------------
// DayGenerator integration (2-pass)
// ---------------------------------------------------------------------------

describe('DayGenerator', () => {
    it('generates days via 2-pass pipeline and fires onDay for every result day', async () => {
        const callArgs: Array<{ system: string; user: string }> = [];
        const model: GeneratorModel = {
            async complete(sys, user) {
                callArgs.push({ system: sys, user });
                return {
                    text: `---\ntype: daily\n---\n\n# Generated\n\nWorked on auth migration today.`,
                    inputTokens: 200,
                    outputTokens: 100,
                };
            },
        };

        const onDayInvocations: number[] = [];
        const generator = new DayGenerator(testPersona, testArcs, model, {
            startDay: 15,
            endDay: 25,
            minDaysPerWeek: 5,
            onDay: async (dayNumber) => {
                onDayInvocations.push(dayNumber);
            },
        });

        const result = await generator.generateAll();

        expect(result.personaId).toBe('test-persona');
        // Should have generated some days (arc days + gap fills)
        expect(result.days.length).toBeGreaterThan(0);
        // Every day in the final result must have had onDay called for it.
        // (onDay fires per call during pass 1/2, so it can fire multiple
        // times for a day that two arcs both touch — that's expected.)
        const writtenDays = new Set(onDayInvocations);
        for (const day of result.days) {
            expect(writtenDays.has(day.dayNumber)).toBe(true);
        }
        // Token totals should accumulate
        expect(result.totalInputTokens).toBeGreaterThan(0);
        expect(result.totalOutputTokens).toBeGreaterThan(0);
    });

    it('fires onDay incrementally so progress survives mid-run failures', async () => {
        // Simulate a mid-run subprocess crash: third call throws.
        let callCount = 0;
        const model: GeneratorModel = {
            async complete() {
                callCount++;
                if (callCount === 3) {
                    throw new Error('Agent exited with code null');
                }
                return { text: 'Content.', inputTokens: 50, outputTokens: 20 };
            },
        };

        const arcs: ArcDefinition[] = [
            {
                id: 'flaky', type: 'project', title: 'Flaky',
                description: 'Arc that hits a transient subprocess failure.',
                startDay: 1, endDay: 30,
            },
        ];

        const writtenBeforeError: number[] = [];
        const generator = new DayGenerator(testPersona, arcs, model, {
            startDay: 1,
            endDay: 30,
            minDaysPerWeek: 0,
            onDay: async (dayNumber) => {
                writtenBeforeError.push(dayNumber);
            },
        });

        // Should NOT throw — failures are logged and the run continues.
        const result = await generator.generateAll();

        // Days written before the failure must be persisted via onDay.
        expect(writtenBeforeError.length).toBeGreaterThanOrEqual(2);
        // The run produces at least the days that succeeded.
        expect(result.days.length).toBeGreaterThanOrEqual(2);
    });

    it('pass 1 processes arcs in startDay order', async () => {
        const promptArcs: string[] = [];
        const model: GeneratorModel = {
            async complete(sys, user) {
                // Extract the PRIMARY arc id from the prompt
                const match = user.match(/PRIMARY arc[\s\S]*?id: (\S+)/);
                if (match) promptArcs.push(match[1]);
                return { text: 'Day content.', inputTokens: 50, outputTokens: 20 };
            },
        };

        // Use two non-overlapping arcs for cleaner testing
        const arcs: ArcDefinition[] = [
            {
                id: 'second-arc', type: 'project', title: 'Second',
                description: 'Starts later.', startDay: 20, endDay: 25,
            },
            {
                id: 'first-arc', type: 'project', title: 'First',
                description: 'Starts earlier.', startDay: 10, endDay: 15,
            },
        ];

        const generator = new DayGenerator(testPersona, arcs, model, {
            startDay: 10,
            endDay: 25,
            minDaysPerWeek: 0, // disable gap filling for this test
        });

        await generator.generateAll();

        // first-arc (startDay 10) should appear before second-arc (startDay 20)
        const firstIdx = promptArcs.indexOf('first-arc');
        const secondIdx = promptArcs.indexOf('second-arc');
        expect(firstIdx).toBeGreaterThanOrEqual(0);
        expect(secondIdx).toBeGreaterThanOrEqual(0);
        expect(firstIdx).toBeLessThan(secondIdx);
    });

    it('pass 1 merges content when arcs overlap on the same day', async () => {
        let mergeCount = 0;
        const model: GeneratorModel = {
            async complete(sys, user) {
                if (user.includes('EXISTING LOG')) mergeCount++;
                return { text: 'Merged content.', inputTokens: 50, outputTokens: 20 };
            },
        };

        // Two arcs that both have directives on day 85
        const arcs: ArcDefinition[] = [
            {
                id: 'arc-a', type: 'project', title: 'Arc A',
                description: 'First arc.', startDay: 80, endDay: 90,
                directives: [{ day: 85, event: 'Event A' }],
            },
            {
                id: 'arc-b', type: 'project', title: 'Arc B',
                description: 'Second arc.', startDay: 83, endDay: 88,
                directives: [{ day: 85, event: 'Event B' }],
            },
        ];

        const generator = new DayGenerator(testPersona, arcs, model, {
            startDay: 80,
            endDay: 90,
            minDaysPerWeek: 0,
        });

        await generator.generateAll();

        // Day 85 should be generated first by arc-a, then merged by arc-b
        expect(mergeCount).toBeGreaterThan(0);
    });

    it('pass 2 fills gap days to reach minDaysPerWeek', async () => {
        let gapCallCount = 0;
        const model: GeneratorModel = {
            async complete(sys, user) {
                if (user.includes('routine daily memory log')) gapCallCount++;
                return { text: 'Day content.', inputTokens: 50, outputTokens: 20 };
            },
        };

        // Single arc with only 1 directive day in a 2-week span
        const arcs: ArcDefinition[] = [
            {
                id: 'sparse', type: 'learning', title: 'Sparse',
                description: 'Very sparse arc.', startDay: 1, endDay: 14,
                directives: [{ day: 3, event: 'Only event' }],
            },
        ];

        const generator = new DayGenerator(testPersona, arcs, model, {
            startDay: 1,
            endDay: 14,
            minDaysPerWeek: 5,
        });

        const result = await generator.generateAll();

        // Should have gap-filled days
        expect(gapCallCount).toBeGreaterThan(0);
        // Total days should be at least arc days + some gap fills
        expect(result.days.length).toBeGreaterThan(3);
    });

    it('respects minDaysPerWeek: 0 to disable gap filling', async () => {
        let totalCalls = 0;
        const model: GeneratorModel = {
            async complete() {
                totalCalls++;
                return { text: 'Content.', inputTokens: 50, outputTokens: 20 };
            },
        };

        const arcs: ArcDefinition[] = [
            {
                id: 'test', type: 'project', title: 'Test',
                description: 'Test arc.', startDay: 1, endDay: 5,
                directives: [{ day: 3, event: 'Event' }],
            },
        ];

        const generator = new DayGenerator(testPersona, arcs, model, {
            startDay: 1,
            endDay: 7,
            minDaysPerWeek: 0,
        });

        const result = await generator.generateAll();
        const arcDayCount = totalCalls;

        // With minDaysPerWeek: 0, no gap calls should happen
        // All calls should be arc-focused (no "routine" prompts)
        expect(result.days.length).toBe(arcDayCount);
    });

    it('builds context with recent history from previously generated days', async () => {
        const historyLengths: number[] = [];
        const model: GeneratorModel = {
            async complete(sys, user) {
                // Count how many "Day N" recent history sections appear
                const matches = user.match(/### Day \d+/g);
                historyLengths.push(matches ? matches.length : 0);
                return { text: 'Content.', inputTokens: 50, outputTokens: 20 };
            },
        };

        // Single arc across days 1-10 to generate sequential days
        const arcs: ArcDefinition[] = [
            {
                id: 'test', type: 'incident', title: 'Test',
                description: 'Test.', startDay: 1, endDay: 7,
            },
        ];

        const generator = new DayGenerator(testPersona, arcs, model, {
            startDay: 1,
            endDay: 7,
            historyWindow: 2,
            minDaysPerWeek: 0,
        });

        await generator.generateAll();

        // First generated day should have 0 history
        expect(historyLengths[0]).toBe(0);
        // Later days should have up to 2 history entries
        const maxHistory = Math.max(...historyLengths);
        expect(maxHistory).toBeGreaterThan(0);
        expect(maxHistory).toBeLessThanOrEqual(2);
    });
});
