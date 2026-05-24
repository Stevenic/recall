import { describe, it, expect } from "vitest";
import { withTemporalTag } from "../src/service.js";

describe("withTemporalTag", () => {
    it("prepends [as of YYYY-MM-DD] to content for an ISO date string", () => {
        const out = withTemporalTag("body content", "2026-04-15");
        expect(out).toBe("[as of 2026-04-15]\n\nbody content");
    });

    it("accepts a Date object", () => {
        const d = new Date("2026-03-15T12:00:00Z");
        const out = withTemporalTag("body", d);
        expect(out).toBe("[as of 2026-03-15]\n\nbody");
    });

    it("accepts a non-ISO date string and coerces to ISO", () => {
        const out = withTemporalTag("body", "March 15, 2026");
        expect(out).toMatch(/^\[as of 2026-03-15\]\n\nbody$/);
    });

    it("returns content unchanged when the date is invalid", () => {
        const out = withTemporalTag("body", "not a date");
        expect(out).toBe("body");
    });

    it("returns content unchanged when given an invalid Date object", () => {
        const out = withTemporalTag("body", new Date("not a date"));
        expect(out).toBe("body");
    });

    it("preserves the body verbatim — no escaping or trimming", () => {
        const body = "  # heading\n\nparagraph with **markdown**  ";
        const out = withTemporalTag(body, "2026-04-15");
        expect(out.endsWith(body)).toBe(true);
    });
});
