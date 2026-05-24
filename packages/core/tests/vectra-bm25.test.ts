import { describe, it, expect } from "vitest";
import { VectraIndex } from "../src/defaults/vectra-index.js";
import type { EmbeddingsModel } from "vectra";
import type { QueryOptions } from "../src/interfaces/index.js";

/**
 * VectraIndex routes every query through Vectra's hybrid (semantic + BM25)
 * mode by default. These tests verify the wiring by spying on the
 * `LocalDocumentIndex.queryDocuments` call that `VectraIndex.query`
 * delegates to, without spinning up an embedding model or vector store.
 */

interface Spy {
    calls: Array<{ query: string; opts: Record<string, unknown> | undefined }>;
}

function makeSpiedIndex(spy: Spy): VectraIndex {
    const index = new VectraIndex({
        folderPath: "/tmp/never-touched",
        embeddings: {} as EmbeddingsModel,
    });
    // Replace the internal LocalDocumentIndex with a spy. The private field
    // doesn't have a public setter — this is intentionally invasive so the
    // test exercises the exact call path `query()` takes.
    (index as unknown as {
        _index: {
            queryDocuments: (q: string, o: unknown) => Promise<unknown[]>;
        };
    })._index = {
        async queryDocuments(query, opts) {
            spy.calls.push({
                query,
                opts: opts as Record<string, unknown> | undefined,
            });
            return [];
        },
    };
    return index;
}

describe("VectraIndex hybrid retrieval (BM25)", () => {
    it("defaults to isBm25: true on every query", async () => {
        const spy: Spy = { calls: [] };
        const index = makeSpiedIndex(spy);
        await index.query("anything");
        expect(spy.calls).toHaveLength(1);
        expect(spy.calls[0].opts).toMatchObject({ isBm25: true });
    });

    it("honors options.enableBM25 = false (pure vector)", async () => {
        const spy: Spy = { calls: [] };
        const index = makeSpiedIndex(spy);
        const opts: QueryOptions = { enableBM25: false };
        await index.query("anything", opts);
        expect(spy.calls[0].opts).toMatchObject({ isBm25: false });
    });

    it("explicit enableBM25: true is a no-op (default is already on)", async () => {
        const spy: Spy = { calls: [] };
        const index = makeSpiedIndex(spy);
        await index.query("anything", { enableBM25: true });
        expect(spy.calls[0].opts).toMatchObject({ isBm25: true });
    });

    it("passes maxDocuments, maxChunks, and filter through verbatim", async () => {
        const spy: Spy = { calls: [] };
        const index = makeSpiedIndex(spy);
        await index.query("foo", {
            maxResults: 7,
            maxChunks: 4,
            filter: { contentType: "wiki" },
        });
        const opts = spy.calls[0].opts;
        expect(opts?.maxDocuments).toBe(7);
        expect(opts?.maxChunks).toBe(28); // maxChunks * maxResults
        expect(opts?.filter).toEqual({ contentType: "wiki" });
        expect(opts?.isBm25).toBe(true);
    });
});
