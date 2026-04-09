import { describe, it, expect } from "vitest";
import {
    countDecisionMarkers,
    computeSalienceWeights,
} from "../src/salience.js";

describe("countDecisionMarkers", () => {
    it("detects 'decided to' pattern", () => {
        expect(countDecisionMarkers("We decided to use Redis")).toBe(1);
    });

    it("detects 'switched to' pattern", () => {
        expect(countDecisionMarkers("Switched to PostgreSQL")).toBe(1);
    });

    it("detects 'chose X over Y' pattern", () => {
        expect(countDecisionMarkers("Chose Redis over Memcached")).toBe(1);
    });

    it("detects multiple markers", () => {
        const text = "Decided to refactor. Going with the new API. Opted for TypeScript.";
        expect(countDecisionMarkers(text)).toBe(3);
    });

    it("returns 0 for no markers", () => {
        expect(countDecisionMarkers("Quiet day, reviewed PRs")).toBe(0);
    });
});

describe("computeSalienceWeights", () => {
    it("returns single entry with weight 1.0", async () => {
        const result = await computeSalienceWeights([
            { uri: "memory/2026-04-08.md", text: "Some content" },
        ]);
        expect(result["memory/2026-04-08.md"]).toBe(1.0);
    });

    it("returns empty for empty input", async () => {
        const result = await computeSalienceWeights([]);
        expect(Object.keys(result)).toHaveLength(0);
    });

    it("weights sum to approximately 1.0", async () => {
        const result = await computeSalienceWeights([
            {
                uri: "memory/2026-04-07.md",
                text: "Quiet day. Reviewed some PRs.",
            },
            {
                uri: "memory/2026-04-08.md",
                text: "Major day. Decided to switch to PostgreSQL from MySQL. Chose Redis for caching over Memcached. Discussed architecture with Jordan and Alex. Deployed auth-service v2.0. Fixed ECONNREFUSED error in the connection pool. Ticket #4821 resolved.",
            },
        ]);

        const total = Object.values(result).reduce((s, v) => s + v, 0);
        expect(total).toBeCloseTo(1.0, 2);
    });

    it("gives higher weight to substantive entries", async () => {
        const result = await computeSalienceWeights([
            {
                uri: "memory/day1.md",
                text: "Quiet day.",
            },
            {
                uri: "memory/day2.md",
                text: "Decided to migrate to PostgreSQL. Chose the connection pooling approach over direct connections. Switched to a new CI pipeline using GitHub Actions. Discussed the refactor plan with the team including Alex and Jordan. Fixed HTTP 500 errors in the auth service. ECONNREFUSED bug traced to Docker networking. Ticket #9001 closed.",
            },
        ]);

        expect(result["memory/day2.md"]).toBeGreaterThan(result["memory/day1.md"]);
    });
});
