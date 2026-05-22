import { describe, it, expect } from 'vitest';
import { buildSessionSystemPrompt, buildSessionUserMessage, SessionDayGenerator, } from '../src/generator.js';
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const sessionPersona = {
    id: 'test-ea',
    name: 'Jordan',
    role: 'AI executive assistant',
    domain: 'tech company',
    team_size: 8,
    profile: 'Anticipatory, discreet operator.',
    communication_style: 'Warm, concise, third-person.',
    principal: { name: 'Jamie Park', role: 'CFO' },
    cast: [
        { name: 'Daniel Kim', role: 'CEO', kind: 'human' },
        { name: '@meeting-prep', role: 'meeting brief skill', kind: 'agent' },
    ],
    sessions: [
        { id: 'principal', kind: '1to1', participants: ['Jamie Park'] },
        {
            id: 'project-condor',
            kind: 'group',
            participants: ['Jamie Park', 'Daniel Kim'],
            isolated: true,
            sensitive_topics: [
                'Condor target identity',
                'Condor walkaway price',
            ],
        },
        { id: 'family', kind: 'group', participants: ['Jamie Park', 'Alex'], isolated: true },
    ],
    sharedKnowledge: ['Mosaic Systems is an NYSE-listed mid-cap tech company.'],
};
const sessionArcs = [
    {
        id: 'project-condor',
        type: 'project',
        title: 'Project Condor — bolt-on acquisition',
        description: 'M&A workstream, isolated to project-condor session.',
        startDay: 1,
        endDay: 50,
        primarySession: 'project-condor',
        referencedSessions: ['principal'],
    },
    {
        id: 'relationship-jamie',
        type: 'relationship',
        title: 'Trust evolution with Jamie',
        description: 'Jordan-Jamie 1:1 thread.',
        startDay: 1,
        endDay: 100,
        primarySession: 'principal',
    },
    {
        id: 'relationship-family',
        type: 'relationship',
        title: 'Family calendar coordination',
        description: 'Household scheduling.',
        startDay: 1,
        endDay: 100,
        primarySession: 'family',
    },
];
// ---------------------------------------------------------------------------
// buildSessionSystemPrompt
// ---------------------------------------------------------------------------
describe('buildSessionSystemPrompt', () => {
    it('declares the focus session prominently and includes its shape', () => {
        const prompt = buildSessionSystemPrompt(sessionPersona, 'project-condor');
        expect(prompt).toContain('# FOCUS SESSION (for this call)');
        expect(prompt).toContain('- id: project-condor');
        expect(prompt).toContain('- kind: group, isolated');
        expect(prompt).toContain('Condor target identity');
        expect(prompt).toContain('Condor walkaway price');
    });
    it('renders the full sessions catalog so the model knows the landscape', () => {
        const prompt = buildSessionSystemPrompt(sessionPersona, 'principal');
        expect(prompt).toContain('# Sessions catalog');
        expect(prompt).toContain('- principal (1to1)');
        expect(prompt).toContain('- project-condor (group, isolated)');
        expect(prompt).toContain('- family (group, isolated)');
    });
    it('instructs the model NOT to emit frontmatter or a session H1', () => {
        const prompt = buildSessionSystemPrompt(sessionPersona, 'principal');
        expect(prompt).toContain('Do NOT emit frontmatter');
        expect(prompt).toContain('Output begins with the first `###` topic header');
    });
    it('adds isolation-specific guidance for isolated focus sessions', () => {
        const prompt = buildSessionSystemPrompt(sessionPersona, 'project-condor');
        expect(prompt).toContain('This session is ISOLATED');
        expect(prompt).toContain('Be concrete about sensitive topics');
    });
    it('omits isolation guidance for non-isolated focus sessions', () => {
        const prompt = buildSessionSystemPrompt(sessionPersona, 'principal');
        expect(prompt).not.toContain('This session is ISOLATED');
    });
    it('does not surface session lifecycle day ranges in the prompt (structural only)', () => {
        // Lifecycle is enforced before the prompt is built — exposing day numbers
        // here would bleed corpus-bookkeeping language into generated memories.
        const prompt = buildSessionSystemPrompt(sessionPersona, 'project-condor', [{ id: 'project-condor', firstDay: 5, lastDay: 30 }]);
        expect(prompt).not.toContain('lifecycle: day');
        expect(prompt).not.toContain('day 5');
        expect(prompt).not.toContain('day 30');
    });
    it('handles a focus session id not declared in the persona (defensive)', () => {
        const prompt = buildSessionSystemPrompt(sessionPersona, 'unknown-session');
        expect(prompt).toContain('- id: unknown-session');
        expect(prompt).toContain('no detailed shape declared in persona');
    });
});
// ---------------------------------------------------------------------------
// buildSessionUserMessage
// ---------------------------------------------------------------------------
describe('buildSessionUserMessage', () => {
    const day = 5;
    const date = '2026-01-05';
    const dow = 'Monday';
    function makeActiveArcs() {
        return [
            {
                id: 'project-condor',
                type: 'project',
                title: 'Project Condor — bolt-on acquisition',
                description: 'M&A workstream',
                phase: 'early',
                dayInArc: 5,
                arcLength: 50,
                primarySession: 'project-condor',
                referencedSessions: ['principal'],
                echoToday: true,
            },
            {
                id: 'relationship-jamie',
                type: 'relationship',
                title: 'Trust with Jamie',
                description: 'Ongoing 1:1.',
                phase: 'mid',
                dayInArc: 5,
                arcLength: 100,
                primarySession: 'principal',
            },
            {
                id: 'relationship-family',
                type: 'relationship',
                title: 'Family',
                description: 'Household.',
                phase: 'mid',
                dayInArc: 5,
                arcLength: 100,
                primarySession: 'family',
            },
        ];
    }
    it('includes only arcs whose primarySession matches the focus', () => {
        const arcs = makeActiveArcs();
        const msg = buildSessionUserMessage(day, date, dow, 'normal', 'project-condor', arcs, [], [], []);
        expect(msg).toContain('id: project-condor');
        // relationship-jamie primary is principal; relationship-family primary is family.
        // Neither references project-condor, so neither should appear in the project-condor user message.
        expect(msg).not.toContain('id: relationship-jamie');
        expect(msg).not.toContain('id: relationship-family');
    });
    it('includes echoing arcs as brief touchpoints in the referenced session', () => {
        const arcs = makeActiveArcs();
        // project-condor references principal and echoToday=true → should echo into principal
        const msg = buildSessionUserMessage(day, date, dow, 'normal', 'principal', arcs, [], [], []);
        expect(msg).toContain('Arcs primarily based in OTHER sessions but echoing here today');
        expect(msg).toContain('id: project-condor');
        expect(msg).toContain('primary_session: project-condor');
    });
    it('does not include echoing arcs when echoToday is false', () => {
        const arcs = makeActiveArcs();
        arcs[0].echoToday = false;
        const msg = buildSessionUserMessage(day, date, dow, 'normal', 'principal', arcs, [], [], []);
        // project-condor primary=project-condor, no echo today → must not appear in principal message
        expect(msg).not.toContain('id: project-condor');
    });
    it('filters directives to arcs in this session only (no cross-session leakage)', () => {
        const arcs = makeActiveArcs();
        const directives = [
            { arc: 'project-condor', event: 'NDA signed' },
            { arc: 'relationship-family', event: 'Tess parent-teacher conference' },
        ];
        const msg = buildSessionUserMessage(day, date, dow, 'normal', 'project-condor', arcs, directives, [], []);
        expect(msg).toContain('NDA signed');
        // family directive must NOT appear in project-condor user message
        expect(msg).not.toContain('Tess parent-teacher conference');
    });
    it('includes per-session recent history (and only that session history)', () => {
        const history = [
            { dayNumber: 4, calendarDate: '2026-01-04', dayOfWeek: 'Sunday', content: '### Topic\nFamily ski trip planning' },
        ];
        const msg = buildSessionUserMessage(day, date, dow, 'normal', 'family', makeActiveArcs(), [], [], history);
        expect(msg).toContain('Recent days for THIS session');
        expect(msg).toContain('Family ski trip planning');
    });
    it('falls back to a quiet-day instruction when no arcs touch this session', () => {
        const arcs = [];
        const msg = buildSessionUserMessage(day, date, dow, 'quiet', 'principal', arcs, [], [], []);
        expect(msg).toContain('No active arcs for this session today');
    });
});
// ---------------------------------------------------------------------------
// SessionDayGenerator
// ---------------------------------------------------------------------------
class RecordingModel {
    responder;
    calls = [];
    constructor(responder) {
        this.responder = responder;
    }
    async complete(systemPrompt, userMessage, options) {
        this.calls.push({ systemPrompt, userMessage, options });
        return this.responder(systemPrompt, userMessage);
    }
}
function focusSessionFromPrompt(systemPrompt) {
    const m = systemPrompt.match(/# FOCUS SESSION \(for this call\)\n- id: (.+)/);
    return m ? m[1].trim() : null;
}
describe('SessionDayGenerator', () => {
    it('fires one call per active session per day and assembles the day file', async () => {
        const model = new RecordingModel(() => ({ text: '### Topic\nBody.' }));
        const onDayCalls = [];
        const gen = new SessionDayGenerator(sessionPersona, sessionArcs, model, {
            startDay: 1,
            endDay: 1,
            epoch: '2026-01-01',
            onDay: (day, content, kind) => { onDayCalls.push({ day, content, kind }); },
        });
        const result = await gen.generateAll();
        // Day 1 has principal + project-condor + family active. project-condor's start-day
        // touchpoint also echoes into principal — but principal already gets its own call.
        const focusSessions = model.calls.map(c => focusSessionFromPrompt(c.systemPrompt));
        expect(focusSessions).toContain('principal');
        expect(focusSessions).toContain('project-condor');
        expect(focusSessions).toContain('family');
        expect(focusSessions.length).toBe(3);
        // Assembled day file: frontmatter + one H1 per active session
        expect(onDayCalls).toHaveLength(1);
        expect(onDayCalls[0].kind).toBe('day');
        expect(onDayCalls[0].content).toMatch(/^---\ntype: daily\n---/);
        expect(onDayCalls[0].content).toContain('# session: principal');
        expect(onDayCalls[0].content).toContain('# session: project-condor');
        expect(onDayCalls[0].content).toContain('# session: family');
        expect(result.days).toHaveLength(1);
    });
    it('isolates per-session history — each session prompt mentions only its own focus id in the history block', async () => {
        const model = new RecordingModel(() => ({ text: '### Topic\nDistinct content.' }));
        const gen = new SessionDayGenerator(sessionPersona, sessionArcs, model, {
            startDay: 1,
            endDay: 2,
            epoch: '2026-01-01',
        });
        await gen.generateAll();
        const day2Calls = model.calls.slice(model.calls.length / 2);
        for (const call of day2Calls) {
            const focus = focusSessionFromPrompt(call.systemPrompt);
            if (!focus)
                continue;
            const historySection = call.userMessage.match(/Recent days for THIS session[\s\S]*$/);
            if (!historySection)
                continue;
            // The history label should reference the focus session, not other sessions
            expect(historySection[0]).toContain(focus);
        }
    });
    it('continues the day if some sessions fail; assembled file omits failed sessions', async () => {
        const model = new RecordingModel((sys) => {
            const focus = focusSessionFromPrompt(sys);
            if (focus !== 'principal') {
                throw new Error(`mock failure for ${focus}`);
            }
            return { text: '### Topic\nPrincipal content.' };
        });
        const onDayCalls = [];
        const gen = new SessionDayGenerator(sessionPersona, sessionArcs, model, {
            startDay: 1,
            endDay: 1,
            epoch: '2026-01-01',
            onDay: (day, content) => { onDayCalls.push({ day, content }); },
        });
        await gen.generateAll();
        expect(onDayCalls).toHaveLength(1);
        expect(onDayCalls[0].content).toContain('# session: principal');
        expect(onDayCalls[0].content).not.toContain('# session: project-condor');
        expect(onDayCalls[0].content).not.toContain('# session: family');
    });
    it('strips stray frontmatter or session H1 the model emits', async () => {
        const model = new RecordingModel((sys) => {
            const focus = focusSessionFromPrompt(sys);
            return {
                text: `---\ntype: daily\n---\n\n# session: ${focus}\n\n### Topic\nBody.`,
            };
        });
        const onDayCalls = [];
        const gen = new SessionDayGenerator(sessionPersona, sessionArcs, model, {
            startDay: 1, endDay: 1, epoch: '2026-01-01',
            onDay: (_d, content) => { onDayCalls.push({ content }); },
        });
        await gen.generateAll();
        // Each session H1 appears exactly once (assembler emits; cleaner strips body duplicates)
        const principalH1Count = (onDayCalls[0].content.match(/^# session: principal$/gm) ?? []).length;
        const condorH1Count = (onDayCalls[0].content.match(/^# session: project-condor$/gm) ?? []).length;
        expect(principalH1Count).toBe(1);
        expect(condorH1Count).toBe(1);
        const fmCount = (onDayCalls[0].content.match(/^---\ntype: daily\n---$/gm) ?? []).length;
        expect(fmCount).toBe(1);
    });
    it('tracks token usage per day across session calls', async () => {
        const model = new RecordingModel(() => ({
            text: '### Topic\nBody.',
            inputTokens: 100,
            outputTokens: 50,
        }));
        const gen = new SessionDayGenerator(sessionPersona, sessionArcs, model, {
            startDay: 1, endDay: 1, epoch: '2026-01-01',
        });
        const result = await gen.generateAll();
        // Day 1 has 3 active sessions × (100 in + 50 out) = 300 in, 150 out
        expect(result.days).toHaveLength(1);
        expect(result.days[0].inputTokens).toBe(300);
        expect(result.days[0].outputTokens).toBe(150);
        expect(result.totalInputTokens).toBe(300);
        expect(result.totalOutputTokens).toBe(150);
    });
    it('uses the story-level epoch override when provided', async () => {
        const model = new RecordingModel(() => ({ text: '### Topic\nBody.' }));
        const gen = new SessionDayGenerator(sessionPersona, sessionArcs, model, {
            startDay: 1, endDay: 1,
            epoch: '2027-06-15',
        });
        const result = await gen.generateAll();
        expect(result.days[0].calendarDate).toBe('2027-06-15');
    });
});
//# sourceMappingURL=session-generator.test.js.map