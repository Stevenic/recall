/**
 * Types for the Day Generator pipeline — Pass 1 of persona memory generation.
 *
 * See specs/day-generator.md for the full specification.
 */

// ---------------------------------------------------------------------------
// Persona Definition (loaded from persona.yaml)
// ---------------------------------------------------------------------------

export interface PersonaDefinition {
    id: string;
    name: string;
    epoch: string;
    role: string;
    domain: string;
    company: string;
    team_size: number;
    profile: string;
    communication_style: string;
    projects?: ProjectRef[];
}

export interface ProjectRef {
    id: string;
    name: string;
    description: string;
}

// ---------------------------------------------------------------------------
// Arc Definition (loaded from arcs.yaml)
// ---------------------------------------------------------------------------

export type ArcType = 'project' | 'incident' | 'decision' | 'learning' | 'relationship' | 'correction';
export type ArcPhase = 'early' | 'mid' | 'late' | 'concluding';

export interface ArcDefinition {
    id: string;
    type: ArcType;
    title: string;
    description: string;
    startDay: number;
    endDay: number;

    /** Key events that MUST appear on specific days. */
    directives?: ArcDirective[];

    // Correction arc fields
    wrongDay?: number;
    correctedDay?: number;
    wrongBelief?: string;
    correctedBelief?: string;
}

export interface ArcDirective {
    day: number;
    event: string;
}

// ---------------------------------------------------------------------------
// Day Generation Context (computed per call)
// ---------------------------------------------------------------------------

export interface ActiveArc {
    id: string;
    type: ArcType;
    title: string;
    description: string;
    phase: ArcPhase;
    dayInArc: number;
    arcLength: number;
}

export type DensityHint = 'quiet' | 'normal' | 'busy' | 'dense';

export interface Directive {
    arc: string;
    event: string;
}

export type CorrectionPhase = 'wrong_belief' | 'correction_day' | 'post_correction';

export interface CorrectionState {
    arc: string;
    phase: CorrectionPhase;
    belief: string;
    correctedBelief?: string;
}

export interface ArcSummary {
    id: string;
    summary: string;
    /** Running log of one-line deltas appended after each day. */
    runningLog: string[];
}

export interface DayContext {
    dayNumber: number;
    calendarDate: string;
    dayOfWeek: string;
    densityHint: DensityHint;
    activeArcs: ActiveArc[];
    directives: Directive[];
    correctionStates: CorrectionState[];
    arcSummaries: ArcSummary[];
    recentHistory: RecentDay[];
}

export interface RecentDay {
    dayNumber: number;
    calendarDate: string;
    dayOfWeek: string;
    content: string;
}

// ---------------------------------------------------------------------------
// Generator Model Interface
// ---------------------------------------------------------------------------

export interface GeneratorModel {
    /** Generate a completion given a system prompt and user message. */
    complete(systemPrompt: string, userMessage: string, options?: GeneratorModelOptions): Promise<GeneratorModelResult>;
}

export interface GeneratorModelOptions {
    maxTokens?: number;
    temperature?: number;
}

export interface GeneratorModelResult {
    text: string;
    inputTokens?: number;
    outputTokens?: number;
}

// ---------------------------------------------------------------------------
// Generator Configuration
// ---------------------------------------------------------------------------

export interface GeneratorConfig {
    /** Number of recent days to include as history context. Default: 3. */
    historyWindow?: number;
    /** Temperature for day generation. Default: 0.7. */
    temperature?: number;
    /** Max output tokens per day. Default: 2000. */
    maxTokens?: number;
    /** Compress arc summaries every N days. Default: 10. */
    summaryCompressInterval?: number;
    /** Temperature for arc summary compression. Default: 0.2. */
    summaryTemperature?: number;
    /** Starting day number (for resuming). Default: 1. */
    startDay?: number;
    /** Ending day number. Default: 1000. */
    endDay?: number;
    /** Callback after each day is generated. */
    onDay?: (dayNumber: number, content: string) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Generator Output
// ---------------------------------------------------------------------------

export interface GeneratedDay {
    dayNumber: number;
    calendarDate: string;
    content: string;
    inputTokens?: number;
    outputTokens?: number;
}

export interface GenerationResult {
    personaId: string;
    days: GeneratedDay[];
    totalInputTokens: number;
    totalOutputTokens: number;
}

// ---------------------------------------------------------------------------
// Persona Creator Types
// ---------------------------------------------------------------------------

export interface PersonaCreatorConfig {
    /** Temperature for persona generation. Default: 0.7. */
    temperature?: number;
    /** Max output tokens for persona generation. Default: 4000. */
    maxTokens?: number;
    /** Epoch date for the persona timeline. Default: '2024-01-01'. */
    epoch?: string;
}

export interface CreatedPersona {
    persona: PersonaDefinition;
    arcs: ArcDefinition[];
    totalInputTokens: number;
    totalOutputTokens: number;
}

// ---------------------------------------------------------------------------
// Conversation Generator Types (Pass 2)
// ---------------------------------------------------------------------------

export interface ConversationTurn {
    role: 'user' | 'assistant';
    content: string;
}

export interface GeneratedConversation {
    dayNumber: number;
    calendarDate: string;
    turns: ConversationTurn[];
    inputTokens?: number;
    outputTokens?: number;
}

export interface ConversationGeneratorConfig {
    /** Temperature for conversation generation. Default: 0.7. */
    temperature?: number;
    /** Max output tokens per conversation. Default: 4000. */
    maxTokens?: number;
    /** Starting day number. Default: 1. */
    startDay?: number;
    /** Ending day number. Default: 1000. */
    endDay?: number;
    /** Callback after each conversation is generated. */
    onConversation?: (dayNumber: number, content: string) => void | Promise<void>;
}

export interface ConversationGenerationResult {
    personaId: string;
    conversations: GeneratedConversation[];
    totalInputTokens: number;
    totalOutputTokens: number;
}
