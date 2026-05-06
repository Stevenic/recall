/**
 * Dataset loading — reads persona memory files and Q&A pairs from disk.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import type { DayMetadata, QAPair, TimeRangeKey } from './types.js';
import { TIME_RANGES } from './types.js';
import { deriveSiblingDir } from './generator.js';

// ---------------------------------------------------------------------------
// Persona dataset on disk
// ---------------------------------------------------------------------------

export interface PersonaDataset {
    personaId: string;
    /** Ordered memory days (index 0 = day 1) */
    days: DayEntry[];
    /** All Q&A pairs for this persona */
    qaPairs: QAPair[];
}

export interface DayEntry {
    dayNumber: number;
    content: string;
    metadata: DayMetadata;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load a persona dataset from the standard directory layout. The default
 * arcs file is `arcs-1000d.yaml`; pair memory and Q&A dirs are derived
 * from that filename's suffix (see `deriveSiblingDir`):
 *
 *   <dataDir>/<personaId>/persona.yaml
 *   <dataDir>/<personaId>/arcs-1000d.yaml
 *   <dataDir>/<personaId>/memories-1000d/day-NNNN.md
 *   <dataDir>/<personaId>/qa-1000d/questions.yaml
 *
 * To load a variant (e.g., the 180-day story), pass `arcsFile`:
 *   loadPersona(dataDir, personaId, 'arcs-180d.yaml')
 *   → reads memories-180d/, qa-180d/
 */
export async function loadPersona(
    dataDir: string,
    personaId: string,
    arcsFile: string = 'arcs-1000d.yaml',
): Promise<PersonaDataset> {
    const personaDir = join(dataDir, personaId);

    // Load arc info for day metadata
    const arcsRaw = await readFile(join(personaDir, arcsFile), 'utf-8');
    const arcsData = YAML.parse(arcsRaw) as ArcFile;

    // Load persona.yaml for epoch date
    const personaRaw = await readFile(join(personaDir, 'persona.yaml'), 'utf-8');
    const personaData = YAML.parse(personaRaw) as PersonaFile;
    const epoch = new Date(personaData.epoch ?? '2024-01-01');

    // Derive sibling dirs from the arcs filename suffix
    const memoriesDirName = deriveSiblingDir(arcsFile, 'memories');
    const qaDirName = deriveSiblingDir(arcsFile, 'qa');

    // Load memory days
    const memoriesDir = join(personaDir, memoriesDirName);
    const files = await readdir(memoriesDir);
    const dayFiles = files
        .filter(f => /^day-\d{4}\.md$/.test(f))
        .sort();

    const days: DayEntry[] = [];
    for (const file of dayFiles) {
        const dayNumber = parseInt(file.replace('day-', '').replace('.md', ''), 10);
        const content = await readFile(join(memoriesDir, file), 'utf-8');
        const date = new Date(epoch);
        date.setDate(date.getDate() + dayNumber - 1);

        const activeArcs = getActiveArcs(arcsData, dayNumber);

        days.push({
            dayNumber,
            content,
            metadata: {
                dayNumber,
                date: date.toISOString().split('T')[0],
                personaId,
                activeArcs,
            },
        });
    }

    // Load Q&A pairs
    const qaRaw = await readFile(join(personaDir, qaDirName, 'questions.yaml'), 'utf-8');
    const qaData = YAML.parse(qaRaw) as QAFile[];
    const qaPairs: QAPair[] = qaData.map(q => ({
        id: q.id,
        question: q.question,
        answer: q.answer,
        category: q.category,
        difficulty: q.difficulty,
        relevantDays: q.relevant_days,
        requiresSynthesis: q.requires_synthesis ?? false,
    }));

    return { personaId, days, qaPairs };
}

/**
 * Filter Q&A pairs to only those answerable within a given time range.
 * A pair is included if ALL of its relevant_days fall within the cutoff.
 */
export function filterQAByRange(pairs: QAPair[], range: TimeRangeKey): QAPair[] {
    const cutoff = TIME_RANGES[range];
    return pairs.filter(qa => qa.relevantDays.every(d => d <= cutoff));
}

/**
 * List available persona IDs in a data directory.
 */
export async function listPersonas(dataDir: string): Promise<string[]> {
    const entries = await readdir(dataDir, { withFileTypes: true });
    return entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ArcFile {
    arcs: Array<{
        id: string;
        startDay: number;
        endDay: number;
    }>;
}

interface PersonaFile {
    id: string;
    name: string;
    epoch?: string;
}

interface QAFile {
    id: string;
    question: string;
    answer: string;
    category: QAPair['category'];
    difficulty: QAPair['difficulty'];
    relevant_days: number[];
    requires_synthesis?: boolean;
}

function getActiveArcs(arcsData: ArcFile, dayNumber: number): string[] {
    return arcsData.arcs
        .filter(a => dayNumber >= a.startDay && dayNumber <= a.endDay)
        .map(a => a.id);
}
