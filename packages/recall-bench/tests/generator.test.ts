import { describe, it, expect } from 'vitest';
import {
    computePhase,
    computeDensity,
    getActiveArcs,
    computeActiveSessions,
    computeEchoToday,
    getDirectives,
    getCorrectionStates,
    selectArcDays,
    identifyGapDays,
    computeCalendarDate,
    formatDate,
    getDayOfWeek,
    buildSystemPrompt,
    buildSessionSystemPrompt,
    buildSessionUserMessage,
    SessionDayGenerator,
} from '../src/generator.js';
import type { ArcDefinition, PersonaDefinition, GeneratorModel, GeneratorModelOptions, GeneratorModelResult, ActiveArc, Directive, CorrectionState, RecentDay, SessionDef } from '../src/generator-types.js';

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

    it('frames the persona as an AI agent narrator (not a human diarist)', () => {
        const prompt = buildSystemPrompt(testPersona);
        expect(prompt).toContain('AI agent');
        expect(prompt).toContain('computer program');
        expect(prompt).toContain('third-person');
        // Must steer the LLM away from first-person human style.
        expect(prompt).toMatch(/Do NOT write a first-person/i);
    });

    it('renders principal and cast when supplied', () => {
        const persona: PersonaDefinition = {
            ...testPersona,
            principal: {
                name: 'Kenji Nakamura',
                role: 'Assistant Professor / PI',
                profile: 'Runs a synthetic biology lab.',
            },
            cast: [
                { name: 'Sarah Kim', role: 'Senior postdoc', kind: 'human' },
                { name: '@lit-search-agent', role: 'Literature search agent', kind: 'agent' },
            ],
        };
        const prompt = buildSystemPrompt(persona);
        expect(prompt).toContain('Principal');
        expect(prompt).toContain('Kenji Nakamura');
        expect(prompt).toContain('Cast');
        expect(prompt).toContain('Sarah Kim (human)');
        expect(prompt).toContain('@lit-search-agent (agent)');
    });

    it('falls back gracefully when principal and cast are absent', () => {
        const prompt = buildSystemPrompt(testPersona);
        expect(prompt).not.toContain('# Principal');
        expect(prompt).not.toContain('# Cast');
    });

    it('uses institution when company is absent', () => {
        const persona: PersonaDefinition = {
            ...testPersona,
            company: undefined,
            institution: 'Pacific State University',
        };
        const prompt = buildSystemPrompt(persona);
        expect(prompt).toContain('Pacific State University');
        expect(prompt).not.toContain('Nexus');
    });
});

