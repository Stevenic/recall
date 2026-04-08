import { describe, it, expect } from 'vitest';
import {
    PersonaCreator,
    parsePersonaYaml,
    parseArcsYaml,
    serializePersonaYaml,
    serializeArcsYaml,
} from '../src/persona-creator.js';
import type { GeneratorModel } from '../src/generator-types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const samplePersonaYaml = `id: devops-eng
name: Alex Torres
epoch: "2024-01-01"
role: Senior DevOps Engineer
domain: Cloud infrastructure and CI/CD
company: CloudScale Inc
team_size: 6
profile: |
  Alex has 8 years of experience in DevOps and cloud infrastructure.
  Specializes in Kubernetes, Terraform, and AWS.
communication_style: |
  Concise and action-oriented. Prefers runbooks over prose.
projects:
  - id: k8s-migration
    name: "Kubernetes migration"
    description: "Migrate legacy VMs to Kubernetes"
  - id: ci-pipeline
    name: "CI pipeline overhaul"
    description: "Rebuild CI/CD with GitHub Actions"`;

const sampleArcsYaml = `arcs:
  - id: k8s-migration
    type: project
    title: "Kubernetes cluster migration"
    description: "Migrate production workloads from EC2 to EKS."
    startDay: 10
    endDay: 200
    directives:
      - day: 10
        event: "Kick-off meeting for K8s migration"
      - day: 100
        event: "First production service migrated"
  - id: incident-dns
    type: incident
    title: "DNS resolution failure"
    description: "CoreDNS pods crash-looping after upgrade."
    startDay: 75
    endDay: 80
  - id: correction-memory
    type: correction
    title: "Container memory limits"
    description: "Wrong assumption about default memory limits."
    startDay: 50
    endDay: 150
    wrongDay: 50
    correctedDay: 120
    wrongBelief: "Default container memory limit is 256Mi"
    correctedBelief: "Default container memory limit is 512Mi"`;

function createMockModel(responses: string[]): GeneratorModel {
    let callIndex = 0;
    return {
        async complete() {
            const text = responses[callIndex] ?? 'id: fallback\nname: Fallback';
            callIndex++;
            return { text, inputTokens: 100, outputTokens: 50 };
        },
    };
}

// ---------------------------------------------------------------------------
// parsePersonaYaml
// ---------------------------------------------------------------------------

describe('parsePersonaYaml', () => {
    it('parses valid persona YAML', () => {
        const persona = parsePersonaYaml(samplePersonaYaml, '2024-01-01');
        expect(persona.id).toBe('devops-eng');
        expect(persona.name).toBe('Alex Torres');
        expect(persona.role).toBe('Senior DevOps Engineer');
        expect(persona.company).toBe('CloudScale Inc');
        expect(persona.team_size).toBe(6);
        expect(persona.projects).toHaveLength(2);
        expect(persona.projects![0].id).toBe('k8s-migration');
    });

    it('strips markdown fences', () => {
        const fenced = '```yaml\n' + samplePersonaYaml + '\n```';
        const persona = parsePersonaYaml(fenced, '2024-01-01');
        expect(persona.id).toBe('devops-eng');
    });

    it('provides defaults for missing fields', () => {
        const persona = parsePersonaYaml('id: minimal\nname: Test', '2025-06-01');
        expect(persona.epoch).toBe('2025-06-01');
        expect(persona.role).toBe('Professional');
        expect(persona.company).toBe('Acme Corp');
        expect(persona.team_size).toBe(5);
    });
});

// ---------------------------------------------------------------------------
// parseArcsYaml
// ---------------------------------------------------------------------------

describe('parseArcsYaml', () => {
    it('parses valid arcs YAML', () => {
        const arcs = parseArcsYaml(sampleArcsYaml);
        expect(arcs).toHaveLength(3);
        expect(arcs[0].id).toBe('k8s-migration');
        expect(arcs[0].type).toBe('project');
        expect(arcs[0].startDay).toBe(10);
        expect(arcs[0].endDay).toBe(200);
    });

    it('parses directives', () => {
        const arcs = parseArcsYaml(sampleArcsYaml);
        expect(arcs[0].directives).toHaveLength(2);
        expect(arcs[0].directives![0].day).toBe(10);
        expect(arcs[0].directives![0].event).toContain('Kick-off');
    });

    it('parses correction arc fields', () => {
        const arcs = parseArcsYaml(sampleArcsYaml);
        const correction = arcs.find(a => a.type === 'correction')!;
        expect(correction.wrongDay).toBe(50);
        expect(correction.correctedDay).toBe(120);
        expect(correction.wrongBelief).toContain('256Mi');
        expect(correction.correctedBelief).toContain('512Mi');
    });

    it('strips markdown fences', () => {
        const fenced = '```yaml\n' + sampleArcsYaml + '\n```';
        const arcs = parseArcsYaml(fenced);
        expect(arcs).toHaveLength(3);
    });

    it('handles non-correction arcs without correction fields', () => {
        const arcs = parseArcsYaml(sampleArcsYaml);
        const incident = arcs.find(a => a.type === 'incident')!;
        expect(incident.wrongDay).toBeUndefined();
        expect(incident.correctedDay).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Serialization round-trip
// ---------------------------------------------------------------------------

describe('serialization', () => {
    it('round-trips persona through YAML', () => {
        const original = parsePersonaYaml(samplePersonaYaml, '2024-01-01');
        const serialized = serializePersonaYaml(original);
        const parsed = parsePersonaYaml(serialized, '2024-01-01');
        expect(parsed.id).toBe(original.id);
        expect(parsed.name).toBe(original.name);
        expect(parsed.role).toBe(original.role);
    });

    it('round-trips arcs through YAML', () => {
        const original = parseArcsYaml(sampleArcsYaml);
        const serialized = serializeArcsYaml(original);
        const parsed = parseArcsYaml(serialized);
        expect(parsed).toHaveLength(original.length);
        expect(parsed[0].id).toBe(original[0].id);
        expect(parsed[2].wrongBelief).toBe(original[2].wrongBelief);
    });
});

// ---------------------------------------------------------------------------
// PersonaCreator
// ---------------------------------------------------------------------------

describe('PersonaCreator', () => {
    it('creates persona and arcs from a prompt', async () => {
        const model = createMockModel([samplePersonaYaml, sampleArcsYaml]);
        const creator = new PersonaCreator(model);
        const result = await creator.create('A DevOps engineer at a cloud company');

        expect(result.persona.id).toBe('devops-eng');
        expect(result.persona.name).toBe('Alex Torres');
        expect(result.arcs).toHaveLength(3);
        expect(result.totalInputTokens).toBe(200);
        expect(result.totalOutputTokens).toBe(100);
    });

    it('creates arcs only for an existing persona', async () => {
        const model = createMockModel([sampleArcsYaml]);
        const creator = new PersonaCreator(model);
        const persona = parsePersonaYaml(samplePersonaYaml, '2024-01-01');
        const result = await creator.createArcs(persona);

        expect(result.arcs).toHaveLength(3);
        expect(result.inputTokens).toBe(100);
        expect(result.outputTokens).toBe(50);
    });

    it('respects config options', async () => {
        const capturedOptions: Array<{ maxTokens?: number; temperature?: number }> = [];
        let callIdx = 0;
        const responses = [samplePersonaYaml, sampleArcsYaml];
        const model: GeneratorModel = {
            async complete(_sys, _msg, opts) {
                capturedOptions.push(opts ?? {});
                const text = responses[callIdx] ?? samplePersonaYaml;
                callIdx++;
                return { text, inputTokens: 10, outputTokens: 5 };
            },
        };

        const creator = new PersonaCreator(model, {
            temperature: 0.3,
            maxTokens: 2000,
            epoch: '2025-01-01',
        });

        await creator.create('test');
        // First call: persona generation with maxTokens
        expect(capturedOptions[0]?.temperature).toBe(0.3);
        expect(capturedOptions[0]?.maxTokens).toBe(2000);
        // Second call: arcs generation with maxTokens * 2
        expect(capturedOptions[1]?.temperature).toBe(0.3);
        expect(capturedOptions[1]?.maxTokens).toBe(4000);
    });
});
