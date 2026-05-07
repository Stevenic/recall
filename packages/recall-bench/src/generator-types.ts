/**
 * Types for the Day Generator pipeline — Pass 1 of persona memory generation.
 *
 * See specs/day-generator.md for the full specification.
 */

// ---------------------------------------------------------------------------
// Persona Definition (loaded from persona.yaml)
// ---------------------------------------------------------------------------

/**
 * The AI agent persona whose daily memory logs are being generated.
 *
 * The persona IS the AI agent — its `name` and `role` describe the agent
 * (a computer program), not the human it serves. The `principal` field
 * names that human, and `cast` lists the other humans + AI agents the
 * persona interacts with day-to-day.
 *
 * Both `company` and `institution` are accepted for the affiliation field;
 * either may be present. `principal` and `cast` are optional but strongly
 * recommended — without them the prompts fall back to a generic team frame.
 */
export interface PersonaDefinition {
    id: string;
    name: string;
    /**
     * Calendar anchor — when day 1 of the story happens in real-world time.
     * As of v0.6 this lives in the arcs file (`epoch:` at the top) so different
     * stories for the same persona can anchor differently. Kept on
     * PersonaDefinition as an optional fallback for legacy persona files
     * that haven't migrated.
     */
    epoch?: string;
    role: string;
    domain: string;
    company?: string;
    institution?: string;
    team_size: number;
    profile: string;
    communication_style: string;
    projects?: ProjectRef[];
    principal?: PrincipalRef;
    cast?: CastMember[];
    sessions?: SessionDef[];
    sharedKnowledge?: string[];
}

export interface ProjectRef {
    id: string;
    name: string;
    description: string;
}

export interface PrincipalRef {
    name: string;
    role: string;
    profile?: string;
}

export interface CastMember {
    name: string;
    role: string;
    kind?: 'human' | 'agent';
}

/**
 * A conversation context the agent participates in. Sessions partition every
 * daily memory log; a day's content is rendered under one `# session: <id>`
 * H1 per session that had activity. See specs/recall-bench.md §2.6 / §2.7
 * and specs/day-generator.md §3.1.1.
 *
 * Reserved slug: `principal` is the principal-agent 1:1 session (kind = 1to1).
 * All other slugs are persona-defined.
 */
export interface SessionDef {
    id: string;
    kind: '1to1' | 'group';
    participants: string[];
    isolated?: boolean;
    shared?: boolean;
    firstDay?: number;
    lastDay?: number;
    sensitive_topics?: string[];
}

// ---------------------------------------------------------------------------
// Arc Definition (loaded from arcs-<NNN>d.yaml; default arcs-1000d.yaml)
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

    /**
     * Session affinity — see specs/recall-bench.md §2.3.1 and §2.7.
     * `primarySession` names the session where the arc primarily unfolds;
     * the day-generator emits the arc's deep content under that session's H1.
     * `referencedSessions[]` lists sessions that get attributable echoes
     * at natural touchpoints (sprint boundaries, decision moments).
     * For arcs whose `primarySession` is itself isolated, sensitive content
     * must NOT appear in `referencedSessions` unless explicitly authorized.
     */
    primarySession?: string;
    referencedSessions?: string[];
    /** Cast members involved (informational only). */
    participants?: string[];

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

/**
 * Story-level override for a session's lifecycle. Lives in the arcs file,
 * not the persona file — different stories anchor differently in time and
 * activate sensitive sessions on different schedules. Sessions not listed
 * in the story keep their persona-declared shape with no lifecycle bound
 * (always-on within the corpus).
 */
export interface SessionLifecycle {
    id: string;
    firstDay?: number;
    lastDay?: number;
}

/**
 * The loaded shape of an arcs file. Returned by `loadArcs`. Carries the
 * arcs themselves plus story-level metadata that varies across corpora
 * for the same persona — epoch (calendar anchor) and per-session
 * lifecycle overrides.
 */
export interface LoadedStory {
    arcs: ArcDefinition[];
    epoch?: string;
    sessions?: SessionLifecycle[];
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
    /**
     * Session affinity surfaced from the arc definition (see ArcDefinition).
     * The day-generator uses these to route content under the correct
     * `# session: <id>` H1 and to emit echoes only at natural touchpoints.
     */
    primarySession?: string;
    referencedSessions?: string[];
    /**
     * Set true only on touchpoint days — sprint boundaries, decision
     * moments, arc start, arc end, explicit `directives[].day` entries.
     * On these days the generator emits brief attributable echoes under
     * each `referencedSessions` H1; otherwise echoes are suppressed.
     * See specs/recall-bench.md §3.3.
     */
    echoToday?: boolean;
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
    /**
     * Session IDs that should emit `# session: <id>` H1s in today's log.
     * Computed from active arcs' `primarySession` plus any
     * `referencedSessions` of arcs whose `echoToday` is true. Ordered with
     * `principal` first, then group sessions in persona declaration order.
     * Optional for backwards compatibility with v0.2 personas (no sessions).
     */
    activeSessions?: string[];
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
    /** Max output tokens per session call. Default: 2000. */
    maxTokens?: number;
    /** Starting day number (for resuming). Default: 1. */
    startDay?: number;
    /** Ending day number. Default: 1000. */
    endDay?: number;
    /**
     * Calendar anchor — overrides PersonaDefinition.epoch. Set this from
     * the loaded story file's `epoch` so the same persona can drive
     * different stories with different real-world start dates.
     */
    epoch?: string;
    /**
     * Per-session lifecycle overrides for this story (from the loaded arcs
     * file's top-level `sessions:` block). Merged with persona-declared
     * sessions at prompt-build time.
     */
    sessionLifecycles?: SessionLifecycle[];
    /** Callback after each day is fully assembled. `kind` is always `'day'` in v0.7+. */
    onDay?: (dayNumber: number, content: string, kind: GeneratedDayKind) => void | Promise<void>;
}

/**
 * The kind of day produced. v0.7+ uses per-session generation and
 * always emits `'day'` (one onDay call per assembled day file). The
 * earlier `'arc' | 'gap'` distinction is gone.
 */
export type GeneratedDayKind = 'day';

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
