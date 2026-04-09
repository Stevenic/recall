import { describe, it, expect } from "vitest";
import {
    extractTemporalReference,
    extractAllTemporalReferences,
    temporalAffinity,
    extractDateFromUri,
} from "../src/temporal.js";

describe("extractTemporalReference", () => {
    const now = new Date(2026, 3, 8); // April 8, 2026

    it("extracts explicit year", () => {
        const ref = extractTemporalReference("What happened in 2019?", now);
        expect(ref).not.toBeNull();
        expect(ref!.getFullYear()).toBe(2019);
    });

    it("extracts year-month (named)", () => {
        const ref = extractTemporalReference("What did we do in March 2024?", now);
        expect(ref).not.toBeNull();
        expect(ref!.getFullYear()).toBe(2024);
        expect(ref!.getMonth()).toBe(2); // March = 2
    });

    it("extracts full date (named)", () => {
        const ref = extractTemporalReference("Remember April 8, 2026?", now);
        expect(ref).not.toBeNull();
        expect(ref!.getFullYear()).toBe(2026);
        expect(ref!.getMonth()).toBe(3);
        expect(ref!.getDate()).toBe(8);
    });

    it("extracts ISO date", () => {
        const ref = extractTemporalReference("Check entry 2026-04-08", now);
        expect(ref).not.toBeNull();
        expect(ref!.getFullYear()).toBe(2026);
    });

    it("extracts relative 'last week'", () => {
        const ref = extractTemporalReference("What happened last week?", now);
        expect(ref).not.toBeNull();
        const diffDays = Math.abs(ref!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
        expect(diffDays).toBeCloseTo(7, 0);
    });

    it("extracts relative 'N months ago'", () => {
        const ref = extractTemporalReference("What happened 3 months ago?", now);
        expect(ref).not.toBeNull();
        expect(ref!.getMonth()).toBe(0); // January
    });

    it("extracts quarter", () => {
        const ref = extractTemporalReference("Results from Q3 2024", now);
        expect(ref).not.toBeNull();
        expect(ref!.getFullYear()).toBe(2024);
        // Q3 midpoint: month index 7 (August)
        expect(ref!.getMonth()).toBe(7);
    });

    it("extracts 'yesterday'", () => {
        const ref = extractTemporalReference("What did I do yesterday?", now);
        expect(ref).not.toBeNull();
        expect(ref!.getDate()).toBe(7);
    });

    it("returns null for no temporal reference", () => {
        const ref = extractTemporalReference("Tell me about the auth service", now);
        expect(ref).toBeNull();
    });

    it("picks most specific when multiple references exist", () => {
        const ref = extractTemporalReference("In 2024, specifically March 2024", now);
        expect(ref).not.toBeNull();
        // Year-month (specificity 3) > year (specificity 1)
        expect(ref!.getMonth()).toBe(2); // March
    });
});

describe("extractAllTemporalReferences", () => {
    it("extracts multiple references", () => {
        const refs = extractAllTemporalReferences("From 2019 through March 2024");
        expect(refs.length).toBeGreaterThanOrEqual(2);
    });
});

describe("temporalAffinity", () => {
    it("returns 1.0 when dates match", () => {
        const d = new Date(2026, 3, 8);
        expect(temporalAffinity(d, d)).toBeCloseTo(1.0, 5);
    });

    it("decays with distance", () => {
        const ref = new Date(2026, 3, 8);
        const near = new Date(2026, 3, 10); // 2 days away
        const far = new Date(2026, 5, 8); // ~60 days away

        const nearScore = temporalAffinity(near, ref, 30);
        const farScore = temporalAffinity(far, ref, 30);
        expect(nearScore).toBeGreaterThan(farScore);
        expect(nearScore).toBeGreaterThan(0.9);
        expect(farScore).toBeGreaterThan(0);
    });

    it("never returns zero", () => {
        const ref = new Date(2026, 3, 8);
        const ancient = new Date(2016, 3, 8); // 10 years ago
        expect(temporalAffinity(ancient, ref, 30)).toBeGreaterThan(0);
    });
});

describe("extractDateFromUri", () => {
    it("extracts daily date", () => {
        const d = extractDateFromUri("memory/2026-04-08.md");
        expect(d).not.toBeNull();
        expect(d!.getFullYear()).toBe(2026);
        expect(d!.getMonth()).toBe(3);
        expect(d!.getDate()).toBe(8);
    });

    it("extracts weekly date", () => {
        const d = extractDateFromUri("weekly/2026-W15");
        expect(d).not.toBeNull();
        expect(d!.getFullYear()).toBe(2026);
    });

    it("extracts monthly date", () => {
        const d = extractDateFromUri("monthly/2026-04");
        expect(d).not.toBeNull();
        expect(d!.getFullYear()).toBe(2026);
        expect(d!.getMonth()).toBe(3);
    });

    it("returns null for non-date URIs", () => {
        expect(extractDateFromUri("WISDOM.md")).toBeNull();
    });
});
