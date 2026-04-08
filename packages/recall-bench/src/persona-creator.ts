/**
 * Persona Creator — generates persona definitions and story arcs from a prompt.
 *
 * Given a free-text description of a persona, uses an LLM to produce:
 *   1. A PersonaDefinition (persona.yaml)
 *   2. A set of ArcDefinitions (arcs.yaml)
 *
 * The generated arcs follow the same constraints as hand-authored ones:
 *   - Max 4 concurrent arcs at any point
 *   - Mix of arc types (project, incident, decision, learning, relationship, correction)
 *   - Correction arcs include wrongDay/correctedDay/wrongBelief/correctedBelief
 *   - Directives for key events
 *   - Quiet periods (vacations, breaks)
 */

import YAML from 'yaml';
import type {
    ArcDefinition,
    CreatedPersona,
    GeneratorModel,
    PersonaCreatorConfig,
    PersonaDefinition,
} from './generator-types.js';

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const PERSONA_SYSTEM_PROMPT = `You are an expert at creating realistic synthetic personas for benchmarking AI memory systems. You produce structured YAML output that defines a persona and their story arcs spanning 1,000 days.

Your output must be valid YAML only — no markdown fences, no commentary.`;

function buildPersonaPrompt(userPrompt: string, epoch: string): string {
    return `Create a detailed persona definition based on the following description:

${userPrompt}

Output a YAML document with exactly these fields:
- id: a short hyphenated identifier (e.g., "backend-eng-saas")
- name: a realistic full name
- epoch: "${epoch}"
- role: job title
- domain: area of expertise / industry
- company: employer name
- team_size: number of direct collaborators
- profile: multi-line string describing background, experience, expertise (3-5 sentences)
- communication_style: multi-line string describing how this person writes and communicates (2-3 sentences)
- projects: array of 3-5 project references, each with id, name, description

Make the persona feel authentic — specific details, realistic career trajectory, concrete domain knowledge. The persona should be someone whose daily work generates interesting, varied memory entries over 1,000 days.

Output ONLY the YAML. No markdown fences, no explanation.`;
}

function buildArcsPrompt(persona: PersonaDefinition): string {
    return `Create story arcs for a 1,000-day benchmark persona. The arcs define the narrative events that will drive daily memory log generation.

Persona:
  id: ${persona.id}
  name: ${persona.name}
  role: ${persona.role}
  domain: ${persona.domain}
  company: ${persona.company}
  team_size: ${persona.team_size}
  profile: |
    ${persona.profile.trim().split('\n').join('\n    ')}
  projects:
${(persona.projects ?? []).map(p => `    - ${p.name}: ${p.description}`).join('\n')}

Requirements:
1. Create 15-22 arcs spanning days 1-1000
2. Arc types must include ALL of: project (5+), incident (2+), decision (3+), learning (2+), relationship (2+), correction (4+)
3. Maximum 4 arcs active concurrently at any point
4. Include 1-2 quiet periods (vacations/breaks) of 10-15 days where no arcs are active
5. Each correction arc MUST have: wrongDay, correctedDay, wrongBelief, correctedBelief
6. At least 5 arcs should have directives (key events on specific days)
7. Arcs should cross-reference each other in descriptions where logical
8. Arc lengths should vary: incidents 3-30 days, decisions 10-60 days, projects 50-400 days, learning 30-250 days

Output format — a YAML document with a single top-level key "arcs" containing an array. Each arc has:
- id: short hyphenated identifier
- type: one of project, incident, decision, learning, relationship, correction
- title: human-readable title (quoted)
- description: multi-line string explaining context and connections to other arcs
- startDay: number (1-1000)
- endDay: number (1-1000, > startDay)
- directives: (optional) array of { day: number, event: "string" } for key plot points
- wrongDay: (correction arcs only) day the wrong belief is introduced
- correctedDay: (correction arcs only) day the correction happens
- wrongBelief: (correction arcs only) the incorrect belief as a quoted string
- correctedBelief: (correction arcs only) the correct belief as a quoted string

Ensure the arcs create a balanced set of scenarios that stress all benchmark dimensions:
- Factual recall (specific names, numbers, versions)
- Temporal reasoning (event ordering, date-based queries)
- Decision tracking (choices, rationale, reversals)
- Contradiction resolution (wrong beliefs corrected)
- Cross-reference (connections between arcs)
- Recency bias resistance (early details that matter later)
- Synthesis (patterns across arcs)
- Negative recall (things explicitly NOT done or rejected)

Output ONLY the YAML. No markdown fences, no explanation.`;
}

// ---------------------------------------------------------------------------
// PersonaCreator
// ---------------------------------------------------------------------------

export class PersonaCreator {
    private model: GeneratorModel;
    private config: Required<PersonaCreatorConfig>;

    constructor(model: GeneratorModel, config: PersonaCreatorConfig = {}) {
        this.model = model;
        this.config = {
            temperature: config.temperature ?? 0.7,
            maxTokens: config.maxTokens ?? 4000,
            epoch: config.epoch ?? '2024-01-01',
        };
    }

    /**
     * Create a complete persona (definition + arcs) from a free-text prompt.
     */
    async create(prompt: string): Promise<CreatedPersona> {
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        // Step 1: Generate persona definition
        const personaResult = await this.model.complete(
            PERSONA_SYSTEM_PROMPT,
            buildPersonaPrompt(prompt, this.config.epoch),
            { maxTokens: this.config.maxTokens, temperature: this.config.temperature },
        );
        totalInputTokens += personaResult.inputTokens ?? 0;
        totalOutputTokens += personaResult.outputTokens ?? 0;

        const persona = parsePersonaYaml(personaResult.text, this.config.epoch);

        // Step 2: Generate arcs
        const arcsResult = await this.model.complete(
            PERSONA_SYSTEM_PROMPT,
            buildArcsPrompt(persona),
            { maxTokens: this.config.maxTokens * 2, temperature: this.config.temperature },
        );
        totalInputTokens += arcsResult.inputTokens ?? 0;
        totalOutputTokens += arcsResult.outputTokens ?? 0;

        const arcs = parseArcsYaml(arcsResult.text);

        return { persona, arcs, totalInputTokens, totalOutputTokens };
    }

    /**
     * Generate only arcs for an existing persona definition.
     */
    async createArcs(persona: PersonaDefinition): Promise<{ arcs: ArcDefinition[]; inputTokens: number; outputTokens: number }> {
        const result = await this.model.complete(
            PERSONA_SYSTEM_PROMPT,
            buildArcsPrompt(persona),
            { maxTokens: this.config.maxTokens * 2, temperature: this.config.temperature },
        );

        const arcs = parseArcsYaml(result.text);
        return { arcs, inputTokens: result.inputTokens ?? 0, outputTokens: result.outputTokens ?? 0 };
    }
}

// ---------------------------------------------------------------------------
// YAML Parsing Helpers
// ---------------------------------------------------------------------------

/**
 * Strip markdown code fences if the LLM wraps output in them.
 */
function stripFences(text: string): string {
    return text.replace(/^```(?:ya?ml)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

/**
 * Parse LLM output as a PersonaDefinition, filling in defaults where needed.
 */
export function parsePersonaYaml(text: string, epoch: string): PersonaDefinition {
    const raw = YAML.parse(stripFences(text)) as Record<string, unknown>;

    return {
        id: String(raw.id ?? 'generated-persona'),
        name: String(raw.name ?? 'Unknown'),
        epoch: String(raw.epoch ?? epoch),
        role: String(raw.role ?? 'Professional'),
        domain: String(raw.domain ?? 'General'),
        company: String(raw.company ?? 'Acme Corp'),
        team_size: Number(raw.team_size ?? 5),
        profile: String(raw.profile ?? ''),
        communication_style: String(raw.communication_style ?? ''),
        projects: Array.isArray(raw.projects)
            ? raw.projects.map((p: Record<string, unknown>) => ({
                id: String(p.id ?? ''),
                name: String(p.name ?? ''),
                description: String(p.description ?? ''),
            }))
            : undefined,
    };
}

/**
 * Parse LLM output as an array of ArcDefinitions.
 */
export function parseArcsYaml(text: string): ArcDefinition[] {
    const raw = YAML.parse(stripFences(text)) as Record<string, unknown>;
    const arcsRaw = Array.isArray(raw.arcs) ? raw.arcs : Array.isArray(raw) ? raw : [];

    return arcsRaw.map((a: Record<string, unknown>) => {
        const arc: ArcDefinition = {
            id: String(a.id ?? ''),
            type: String(a.type ?? 'project') as ArcDefinition['type'],
            title: String(a.title ?? ''),
            description: String(a.description ?? ''),
            startDay: Number(a.startDay ?? 1),
            endDay: Number(a.endDay ?? 100),
        };

        if (Array.isArray(a.directives)) {
            arc.directives = a.directives.map((d: Record<string, unknown>) => ({
                day: Number(d.day),
                event: String(d.event ?? ''),
            }));
        }

        if (a.type === 'correction') {
            if (a.wrongDay != null) arc.wrongDay = Number(a.wrongDay);
            if (a.correctedDay != null) arc.correctedDay = Number(a.correctedDay);
            if (a.wrongBelief != null) arc.wrongBelief = String(a.wrongBelief);
            if (a.correctedBelief != null) arc.correctedBelief = String(a.correctedBelief);
        }

        return arc;
    });
}

// ---------------------------------------------------------------------------
// Serialization Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a PersonaDefinition to YAML string (for writing persona.yaml).
 */
export function serializePersonaYaml(persona: PersonaDefinition): string {
    return YAML.stringify(persona, { lineWidth: 100 });
}

/**
 * Serialize arc definitions to YAML string (for writing arcs.yaml).
 */
export function serializeArcsYaml(arcs: ArcDefinition[]): string {
    return YAML.stringify({ arcs }, { lineWidth: 100 });
}
