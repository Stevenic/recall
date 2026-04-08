import { describe, it, expect } from 'vitest';
import {
    computePhase,
    computeDensity,
    getActiveArcs,
    getDirectives,
    getCorrectionStates,
    computeCalendarDate,
    formatDate,
    getDayOfWeek,
    buildSystemPrompt,
    buildUserMessage,
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

// ---------------------------------------------------------------------------
// DayGenerator integration
// ---------------------------------------------------------------------------

describe('DayGenerator', () => {
    it('generates days sequentially and tracks state', async () => {
        let callCount = 0;
        const model: GeneratorModel = {
            async complete(sys, user) {
                callCount++;
                return {
                    text: `---\ntype: daily\nday: ${callCount}\n---\n\n# Day ${callCount}\n\nWorked on auth migration today.`,
                    inputTokens: 200,
                    outputTokens: 100,
                };
            },
        };

        const generator = new DayGenerator(testPersona, testArcs, model, {
            startDay: 1,
            endDay: 5,
        });

        const result = await generator.generateAll();

        expect(result.personaId).toBe('test-persona');
        expect(result.days).toHaveLength(5);
        expect(result.totalInputTokens).toBe(1000); // 5 * 200
        expect(result.totalOutputTokens).toBe(500);  // 5 * 100
        expect(callCount).toBe(5);
    });

    it('builds context with recent history window', async () => {
        const contexts: DayContext[] = [];
        const model: GeneratorModel = {
            async complete() {
                return { text: 'Day content.', inputTokens: 50, outputTokens: 20 };
            },
        };

        const generator = new DayGenerator(testPersona, testArcs, model, {
            startDay: 1,
            endDay: 5,
            historyWindow: 2,
        });

        // Generate days and capture context for the last one
        for (let d = 1; d <= 5; d++) {
            const ctx = generator.buildDayContext(d);
            contexts.push(ctx);
            await generator.generateDay(d);
        }

        // Day 1: no history
        expect(contexts[0].recentHistory).toHaveLength(0);
        // Day 3: 2 days of history (window = 2)
        expect(contexts[2].recentHistory).toHaveLength(2);
        // Day 5: still 2 (window capped)
        expect(contexts[4].recentHistory).toHaveLength(2);
        expect(contexts[4].recentHistory[0].dayNumber).toBe(3);
        expect(contexts[4].recentHistory[1].dayNumber).toBe(4);
    });

    it('calls onDay callback for each generated day', async () => {
        const generated: Array<{ day: number; content: string }> = [];
        const model = createMockModel('Some content.');

        const generator = new DayGenerator(testPersona, testArcs, model, {
            startDay: 1,
            endDay: 3,
            onDay: async (dayNumber, content) => {
                generated.push({ day: dayNumber, content });
            },
        });

        await generator.generateAll();

        expect(generated).toHaveLength(3);
        expect(generated[0].day).toBe(1);
        expect(generated[2].day).toBe(3);
    });
});
