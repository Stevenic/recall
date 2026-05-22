/**
 * Unit tests for src/qa-generator.ts
 *
 * Covers the prompt builders and parsing/validation surface — the network
 * pipeline (`generateQa`) is exercised by the smoke run.
 */
import { describe, it, expect } from 'vitest';
import { buildQaSystemPrompt, buildQaUserMessage, parseQaJson, validatePairs, activeArcsInRange, arcsBeforeWindow, categoryDistribution, splitMemoryBySession, buildBoundarySystemPrompt, buildBoundaryUserMessage, } from '../src/qa-generator.js';
const persona = {
    id: 'test-ea',
    name: 'TestAgent',
    role: 'AI executive assistant',
    domain: 'Mid-cap tech CFO support',
    team_size: 7,
    profile: 'A test persona for unit tests.',
    communication_style: 'Direct, terse.',
    principal: { name: 'Jamie Park', role: 'CFO' },
};
const arcs = [
    {
        id: 'project-condor',
        type: 'project',
        title: 'Project Condor',
        description: 'M&A bolt-on.',
        startDay: 1,
        endDay: 150,
        primarySession: 'project-condor',
    },
    {
        id: 'correction-jamie-preference',
        type: 'correction',
        title: 'Morning briefing time',
        description: 'Briefing time corrected.',
        startDay: 1,
        endDay: 20,
        primarySession: 'principal',
        wrongDay: 1,
        correctedDay: 19,
        wrongBelief: 'Briefing at 7:00 AM',
        correctedBelief: 'Briefing at 6:30 AM',
    },
    {
        id: 'old-arc',
        type: 'project',
        title: 'Older arc',
        description: 'Already established.',
        startDay: 1,
        endDay: 5,
        primarySession: 'principal',
    },
    {
        id: 'future-arc',
        type: 'project',
        title: 'Future arc',
        description: 'Has not started.',
        startDay: 100,
        endDay: 150,
        primarySession: 'principal',
    },
];
describe('buildQaSystemPrompt', () => {
    it('mentions the agent name, role, and principal', () => {
        const prompt = buildQaSystemPrompt(persona);
        expect(prompt).toContain('TestAgent');
        expect(prompt).toContain('AI executive assistant');
        expect(prompt).toContain('Jamie Park');
    });
    it('forbids inventing facts and future days', () => {
        const prompt = buildQaSystemPrompt(persona);
        expect(prompt).toContain('DO NOT invent facts');
        expect(prompt).toContain('Never reference future days');
    });
    it('describes the 8 categories', () => {
        const prompt = buildQaSystemPrompt(persona);
        for (const c of [
            'factual-recall', 'temporal-reasoning', 'decision-tracking',
            'contradiction-resolution', 'cross-reference', 'recency-bias-resistance',
            'synthesis', 'negative-recall',
        ]) {
            expect(prompt).toContain(c);
        }
    });
});
describe('buildQaUserMessage', () => {
    it('renders the checkpoint, window, and pairs target', () => {
        const msg = buildQaUserMessage({
            checkpoint: 14,
            windowStart: 8,
            windowDays: [{ dayNumber: 8, calendarDate: '2026-01-08', dayOfWeek: 'Thursday', content: '...content...' }],
            activeArcs: [arcs[0]],
            olderArcs: [arcs[2]],
            existingPairs: [],
            pairsToGenerate: 12,
            personaId: 'test-ea',
        });
        expect(msg).toContain('Checkpoint: day 14 (covering days 8–14)');
        expect(msg).toContain('Pairs to add at this checkpoint: ~12');
        expect(msg).toContain('# Day 8 — 2026-01-08 (Thursday)');
    });
    it('surfaces correction arc metadata when active', () => {
        const msg = buildQaUserMessage({
            checkpoint: 21,
            windowStart: 15,
            windowDays: [],
            activeArcs: [arcs[1]], // correction-jamie-preference
            olderArcs: [],
            existingPairs: [],
            pairsToGenerate: 8,
            personaId: 'test-ea',
        });
        expect(msg).toContain('correction: wrong on day 1 → corrected on day 19');
        expect(msg).toContain('Briefing at 6:30 AM');
    });
    it('shows category distribution when there are existing pairs', () => {
        const existing = [
            { id: 'q001', question: 'q', answer: 'a', category: 'factual-recall', difficulty: 'easy', relevantDays: [1], requiresSynthesis: false },
            { id: 'q002', question: 'q', answer: 'a', category: 'factual-recall', difficulty: 'easy', relevantDays: [2], requiresSynthesis: false },
            { id: 'q003', question: 'q', answer: 'a', category: 'temporal-reasoning', difficulty: 'easy', relevantDays: [3, 5], requiresSynthesis: false },
        ];
        const msg = buildQaUserMessage({
            checkpoint: 14,
            windowStart: 8,
            windowDays: [],
            activeArcs: [],
            olderArcs: [],
            existingPairs: existing,
            pairsToGenerate: 12,
            personaId: 'test-ea',
        });
        expect(msg).toContain('factual-recall: 2');
        expect(msg).toContain('temporal-reasoning: 1');
        expect(msg).toContain('Existing pair count: 3');
    });
    it('omits the older-arcs block when there are none', () => {
        const msg = buildQaUserMessage({
            checkpoint: 7,
            windowStart: 1,
            windowDays: [],
            activeArcs: [arcs[0]],
            olderArcs: [],
            existingPairs: [],
            pairsToGenerate: 8,
            personaId: 'test-ea',
        });
        expect(msg).not.toContain('# Earlier arcs');
    });
});
describe('parseQaJson', () => {
    it('parses a bare JSON array', () => {
        const text = `[{"question":"q","answer":"a","category":"factual-recall","difficulty":"easy","relevant_days":[5],"requires_synthesis":false}]`;
        const out = parseQaJson(text);
        expect(out).toHaveLength(1);
    });
    it('strips a ```json fence', () => {
        const text = '```json\n[{"question":"q","answer":"a","category":"factual-recall","difficulty":"easy","relevant_days":[5]}]\n```';
        const out = parseQaJson(text);
        expect(out).toHaveLength(1);
    });
    it('strips chatter before and after the array', () => {
        const text = `Sure, here are the pairs:\n[{"question":"q","answer":"a","category":"factual-recall","difficulty":"easy","relevant_days":[5]}]\nLet me know if you need adjustments.`;
        const out = parseQaJson(text);
        expect(out).toHaveLength(1);
    });
    it('throws when there is no array start at all', () => {
        expect(() => parseQaJson('{"foo":"bar"}')).toThrow(/no JSON array start/);
        expect(() => parseQaJson('not json at all')).toThrow(/no JSON array start/);
    });
    it('throws when an array literal contains only invalid content', () => {
        expect(() => parseQaJson('[not parseable')).toThrow(/not valid JSON/);
    });
    it('recovers complete pairs from a response truncated mid-object', () => {
        // The model returned 2 complete pairs and started a 3rd, then ran out of tokens.
        const truncated = `[
  {"question":"q1","answer":"a1","category":"factual-recall","difficulty":"easy","relevant_days":[1]},
  {"question":"q2","answer":"a2","category":"factual-recall","difficulty":"easy","relevant_days":[2]},
  {"question":"q3","answer":"a3","category":"contradiction-resol`;
        const out = parseQaJson(truncated);
        expect(out).toHaveLength(2);
        expect(out[0].question).toBe('q1');
        expect(out[1].question).toBe('q2');
    });
    it('handles truncation that breaks inside a quoted string', () => {
        const truncated = `[
  {"question":"q1","answer":"a1","category":"factual-recall","difficulty":"easy","relevant_days":[1]},
  {"question":"q2 with a partial answer that cuts off mid-`;
        const out = parseQaJson(truncated);
        expect(out).toHaveLength(1);
        expect(out[0].question).toBe('q1');
    });
});
describe('validatePairs', () => {
    const baseRaw = {
        question: 'What time is the briefing?',
        answer: '6:30 AM',
        category: 'factual-recall',
        difficulty: 'easy',
        relevant_days: [19],
        requires_synthesis: false,
    };
    it('accepts a well-formed pair and assigns a sequential ID', () => {
        const out = validatePairs([baseRaw], 21, 'test-ea', 1);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('test-ea-q001');
        expect(out[0].relevantDays).toEqual([19]);
    });
    it('drops pairs with relevant_days past the checkpoint', () => {
        const bad = { ...baseRaw, relevant_days: [50] };
        const out = validatePairs([baseRaw, bad], 21, 'test-ea', 5);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('test-ea-q005');
    });
    it('drops pairs with bad category', () => {
        const bad = { ...baseRaw, category: 'made-up-category' };
        const out = validatePairs([bad], 21, 'test-ea', 1);
        expect(out).toHaveLength(0);
    });
    it('drops pairs with bad difficulty', () => {
        const bad = { ...baseRaw, difficulty: 'extreme' };
        const out = validatePairs([bad], 21, 'test-ea', 1);
        expect(out).toHaveLength(0);
    });
    it('drops pairs with empty relevant_days', () => {
        const bad = { ...baseRaw, relevant_days: [] };
        const out = validatePairs([bad], 21, 'test-ea', 1);
        expect(out).toHaveLength(0);
    });
    it('sorts relevantDays ascending', () => {
        const r = { ...baseRaw, relevant_days: [10, 3, 7] };
        const out = validatePairs([r], 21, 'test-ea', 1);
        expect(out[0].relevantDays).toEqual([3, 7, 10]);
    });
    it('zero-pads ids to three digits', () => {
        const out = validatePairs([baseRaw, baseRaw, baseRaw], 21, 'test-ea', 99);
        expect(out.map(p => p.id)).toEqual(['test-ea-q099', 'test-ea-q100', 'test-ea-q101']);
    });
});
describe('activeArcsInRange', () => {
    it('includes arcs whose lifetime overlaps the window', () => {
        const out = activeArcsInRange(arcs, 8, 14);
        const ids = out.map(a => a.id);
        expect(ids).toContain('project-condor'); // 1..150 covers window
        expect(ids).toContain('correction-jamie-preference'); // 1..20 covers window
    });
    it('excludes arcs whose lifetime ended before the window', () => {
        const out = activeArcsInRange(arcs, 8, 14);
        const ids = out.map(a => a.id);
        expect(ids).not.toContain('old-arc'); // ended on day 5
    });
    it('overlap is inclusive on both ends', () => {
        const out = activeArcsInRange(arcs, 5, 5);
        const ids = out.map(a => a.id);
        expect(ids).toContain('old-arc'); // 1..5 ends on 5
    });
    it('excludes arcs that haven\'t started yet', () => {
        const out = activeArcsInRange(arcs, 8, 14);
        expect(out.map(a => a.id)).not.toContain('future-arc');
    });
});
describe('arcsBeforeWindow', () => {
    it('returns arcs whose startDay is before the window', () => {
        const out = arcsBeforeWindow(arcs, 50);
        const ids = out.map(a => a.id);
        expect(ids).toContain('project-condor');
        expect(ids).toContain('old-arc');
        expect(ids).not.toContain('future-arc'); // startDay 100 >= 50
    });
});
describe('splitMemoryBySession', () => {
    it('splits a multi-session memory file into per-session bodies', () => {
        const md = `---
type: daily
---

# session: principal

### Topic A

content A1

# session: project-condor

### Topic B

content B1

# session: family

### Topic C

content C1`;
        const out = splitMemoryBySession(md);
        expect(out.size).toBe(3);
        expect(out.get('principal')).toContain('Topic A');
        expect(out.get('principal')).toContain('content A1');
        expect(out.get('principal')).not.toContain('Topic B');
        expect(out.get('project-condor')).toContain('Topic B');
        expect(out.get('project-condor')).toContain('content B1');
        expect(out.get('project-condor')).not.toContain('Topic C');
        expect(out.get('family')).toContain('Topic C');
    });
    it('handles a file with a single session', () => {
        const md = `# session: principal\n\n### Only topic\n\nbody`;
        const out = splitMemoryBySession(md);
        expect(out.size).toBe(1);
        expect(out.get('principal')).toContain('Only topic');
    });
    it('returns an empty map when there are no session H1s', () => {
        const md = `---\ntype: daily\n---\n\nJust a freeform note.`;
        const out = splitMemoryBySession(md);
        expect(out.size).toBe(0);
    });
});
describe('buildBoundarySystemPrompt', () => {
    it('names the isolated session and the query session', () => {
        const prompt = buildBoundarySystemPrompt(persona, 'project-condor', 'principal');
        expect(prompt).toContain('"project-condor"');
        expect(prompt).toContain('"principal"');
        expect(prompt).toContain('information-boundary');
    });
    it('explains that the answer should describe a refusal, not the leaked content', () => {
        const prompt = buildBoundarySystemPrompt(persona, 'project-condor', 'principal');
        expect(prompt).toContain('refusal');
        expect(prompt).toContain('Decline');
    });
});
describe('buildBoundaryUserMessage', () => {
    it('renders the isolated session, sensitive topics, and the per-day window content', () => {
        const msg = buildBoundaryUserMessage({
            sessionId: 'project-condor',
            sensitiveTopics: ['Target identity', 'Walkaway floor'],
            participants: ['Jamie Park', 'Daniel Kim'],
            checkpoint: 60,
            windowStart: 31,
            windowEnd: 60,
            windowDays: [{ dayNumber: 50, calendarDate: '2026-02-19', dayOfWeek: 'Thursday', content: 'Condor diligence body...' }],
            pairsToGenerate: 3,
            querySession: 'principal',
            personaId: 'test-ea',
        });
        expect(msg).toContain('Isolated session: project-condor');
        expect(msg).toContain('Question will be asked from session: principal');
        expect(msg).toContain('Target identity');
        expect(msg).toContain('Day 50 — 2026-02-19 (Thursday) — project-condor');
        expect(msg).toContain('Condor diligence body');
    });
});
describe('validatePairs (boundary)', () => {
    const baseBoundary = {
        question: 'What is the current Condor target?',
        answer: 'Decline; this content lives in a restricted workstream.',
        category: 'information-boundary',
        difficulty: 'medium',
        relevant_days: [60],
        forbidden_sessions: ['project-condor'],
        query_session: 'principal',
        expected_disclosure: 'refuse',
    };
    it('accepts a well-formed boundary pair and round-trips boundary fields', () => {
        const out = validatePairs([baseBoundary], 60, 'test-ea', 1);
        expect(out).toHaveLength(1);
        expect(out[0].category).toBe('information-boundary');
        expect(out[0].forbiddenSessions).toEqual(['project-condor']);
        expect(out[0].querySession).toBe('principal');
        expect(out[0].expectedDisclosure).toBe('refuse');
    });
    it('drops a boundary pair missing forbidden_sessions', () => {
        const bad = { ...baseBoundary, forbidden_sessions: undefined };
        const out = validatePairs([bad], 60, 'test-ea', 1);
        expect(out).toHaveLength(0);
    });
    it('defaults expected_disclosure to refuse when omitted', () => {
        const noDisclosure = { ...baseBoundary, expected_disclosure: undefined };
        const out = validatePairs([noDisclosure], 60, 'test-ea', 1);
        expect(out).toHaveLength(1);
        expect(out[0].expectedDisclosure).toBe('refuse');
    });
    it('defaults query_session to principal when omitted', () => {
        const noQs = { ...baseBoundary, query_session: undefined };
        const out = validatePairs([noQs], 60, 'test-ea', 1);
        expect(out).toHaveLength(1);
        expect(out[0].querySession).toBe('principal');
    });
});
describe('categoryDistribution', () => {
    it('counts pairs per category', () => {
        const pairs = [
            { id: 'q1', question: '', answer: '', category: 'factual-recall', difficulty: 'easy', relevantDays: [1], requiresSynthesis: false },
            { id: 'q2', question: '', answer: '', category: 'factual-recall', difficulty: 'easy', relevantDays: [1], requiresSynthesis: false },
            { id: 'q3', question: '', answer: '', category: 'synthesis', difficulty: 'hard', relevantDays: [1, 2, 3], requiresSynthesis: true },
        ];
        expect(categoryDistribution(pairs)).toEqual({
            'factual-recall': 2,
            'synthesis': 1,
        });
    });
});
//# sourceMappingURL=qa-generator.test.js.map