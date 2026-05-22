import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadProfile, applyProfileEnv, resolveProfilePath } from '../src/profile.js';
describe('loadProfile', () => {
    let tmp;
    beforeEach(async () => {
        tmp = await mkdtemp(path.join(tmpdir(), 'profile-test-'));
        return async () => {
            await rm(tmp, { recursive: true, force: true });
        };
    });
    it('parses a full profile and resolves profilePath/profileDir', async () => {
        const file = path.join(tmp, 'profile.yaml');
        await writeFile(file, `persona:
  id: executive-assistant
  dir: ./personas/executive-assistant
  arcs: arcs-180d.yaml
env:
  file: ./.env
models:
  generation: openai:gpt-4o-mini
  judge: openai:gpt-4.1-mini
harness:
  adapter: ./adapter.js
  factory: createOpenClawAdapter
  config:
    embeddingProvider: openai
    maxSearchResults: 15
run:
  ranges: [30d, 90d, 6mo]
  seed: 42
  timeout: 30000
  parallelism: 1
generate:
  days: 180
  temperature: 0.7
  maxTokens: 2000
  historyWindow: 3
`, 'utf8');
        const p = await loadProfile(file);
        expect(p.profilePath).toBe(path.resolve(file));
        expect(p.profileDir).toBe(path.resolve(tmp));
        expect(p.persona).toEqual({
            id: 'executive-assistant',
            dir: './personas/executive-assistant',
            arcs: 'arcs-180d.yaml',
        });
        expect(p.env).toEqual({ file: './.env' });
        expect(p.models).toEqual({
            generation: 'openai:gpt-4o-mini',
            judge: 'openai:gpt-4.1-mini',
        });
        expect(p.harness).toEqual({
            adapter: './adapter.js',
            factory: 'createOpenClawAdapter',
            config: { embeddingProvider: 'openai', maxSearchResults: 15 },
        });
        expect(p.run).toEqual({
            ranges: [
                { label: '30d', days: 30 },
                { label: '90d', days: 90 },
                { label: '6mo', days: 180 },
            ],
            seed: 42,
            timeout: 30000,
            parallelism: 1,
        });
        expect(p.generate).toEqual({ days: 180, temperature: 0.7, maxTokens: 2000, historyWindow: 3 });
    });
    it('accepts a sparse profile with only what the caller cares about', async () => {
        const file = path.join(tmp, 'sparse.yaml');
        await writeFile(file, `harness:\n  adapter: ./a.js\n`, 'utf8');
        const p = await loadProfile(file);
        expect(p.harness?.adapter).toBe('./a.js');
        expect(p.persona).toBeUndefined();
        expect(p.run).toBeUndefined();
    });
    it('rejects a non-mapping top level', async () => {
        const file = path.join(tmp, 'bad.yaml');
        await writeFile(file, '- one\n- two\n', 'utf8');
        await expect(loadProfile(file)).rejects.toThrow(/mapping at the top level/);
    });
    it('rejects unknown range keys', async () => {
        const file = path.join(tmp, 'bad-range.yaml');
        await writeFile(file, 'run:\n  ranges: [30d, weekly]\n', 'utf8');
        await expect(loadProfile(file)).rejects.toThrow(/invalid entry "weekly"/);
    });
    it('accepts numeric and mixed range entries', async () => {
        const file = path.join(tmp, 'ranges-mixed.yaml');
        await writeFile(file, 'run:\n  ranges: [6, 12d, 30d, 6mo]\n', 'utf8');
        const p = await loadProfile(file);
        expect(p.run?.ranges).toEqual([
            { label: '6d', days: 6 },
            { label: '12d', days: 12 },
            { label: '30d', days: 30 },
            { label: '6mo', days: 180 },
        ]);
    });
    it('expands a {start, end, step} arithmetic-progression spec', async () => {
        const file = path.join(tmp, 'ranges-step.yaml');
        await writeFile(file, 'run:\n  ranges:\n    start: 6\n    end: 30\n    step: 6\n', 'utf8');
        const p = await loadProfile(file);
        expect(p.run?.ranges).toEqual([
            { label: '6d', days: 6 },
            { label: '12d', days: 12 },
            { label: '18d', days: 18 },
            { label: '24d', days: 24 },
            { label: '30d', days: 30 },
        ]);
    });
    it('rejects non-string model specs', async () => {
        const file = path.join(tmp, 'bad-model.yaml');
        await writeFile(file, 'models:\n  generation: 42\n', 'utf8');
        await expect(loadProfile(file)).rejects.toThrow(/must be a string/);
    });
    it('rejects an unparseable file', async () => {
        const file = path.join(tmp, 'broken.yaml');
        await writeFile(file, 'persona:\n  id: x\n bad-indent\n', 'utf8');
        await expect(loadProfile(file)).rejects.toThrow(/parse profile YAML/);
    });
});
describe('resolveProfilePath', () => {
    it('returns absolute paths unchanged', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'pp-'));
        try {
            const file = path.join(tmp, 'p.yaml');
            await writeFile(file, 'harness:\n  adapter: x\n', 'utf8');
            const p = await loadProfile(file);
            const abs = path.resolve('/tmp/foo');
            expect(resolveProfilePath(p, abs)).toBe(abs);
        }
        finally {
            await rm(tmp, { recursive: true, force: true });
        }
    });
    it('resolves relative paths against the profile dir, not CWD', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'pp-'));
        try {
            const file = path.join(tmp, 'p.yaml');
            await writeFile(file, 'harness:\n  adapter: x\n', 'utf8');
            const p = await loadProfile(file);
            expect(resolveProfilePath(p, './sub/x')).toBe(path.resolve(tmp, 'sub/x'));
        }
        finally {
            await rm(tmp, { recursive: true, force: true });
        }
    });
});
describe('applyProfileEnv', () => {
    it('loads env vars from the profile-relative .env path', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'env-'));
        try {
            await writeFile(path.join(tmp, '.env'), 'PROFILE_TEST_VAR=hello\n', 'utf8');
            const file = path.join(tmp, 'profile.yaml');
            await writeFile(file, 'env:\n  file: ./.env\n', 'utf8');
            delete process.env.PROFILE_TEST_VAR;
            const p = await loadProfile(file);
            applyProfileEnv(p);
            expect(process.env.PROFILE_TEST_VAR).toBe('hello');
        }
        finally {
            delete process.env.PROFILE_TEST_VAR;
            await rm(tmp, { recursive: true, force: true });
        }
    });
    it('is a no-op when env.file is absent', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'env-'));
        try {
            const file = path.join(tmp, 'profile.yaml');
            await writeFile(file, 'persona:\n  id: x\n', 'utf8');
            const p = await loadProfile(file);
            // Just shouldn't throw.
            applyProfileEnv(p);
        }
        finally {
            await rm(tmp, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=profile.test.js.map