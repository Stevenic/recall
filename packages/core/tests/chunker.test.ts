import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "../src/chunker.js";

describe("chunkMarkdown", () => {
    it("keeps small documents as a single chunk", () => {
        const text = "# Title\n\nSome content here.";
        const chunks = chunkMarkdown(text);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].text).toBe(text);
    });

    it("splits on heading boundaries", () => {
        const text = [
            "# Section 1",
            "",
            "Content for section 1.",
            "",
            "# Section 2",
            "",
            "Content for section 2.",
        ].join("\n");
        const chunks = chunkMarkdown(text);
        expect(chunks).toHaveLength(2);
        expect(chunks[0].text).toContain("Section 1");
        expect(chunks[1].text).toContain("Section 2");
    });

    it("splits oversized sections by paragraph", () => {
        // Create a section that exceeds the token budget
        const longParagraph = "word ".repeat(200); // ~200 tokens
        const text = `# Title\n\n${longParagraph}\n\n${longParagraph}`;
        const chunks = chunkMarkdown(text, { maxTokens: 100 });
        expect(chunks.length).toBeGreaterThan(1);
    });

    it("preserves line number tracking", () => {
        const text = "# A\n\nLine 2\n\n# B\n\nLine 5";
        const chunks = chunkMarkdown(text);
        expect(chunks[0].startLine).toBe(0);
        expect(chunks[1].startLine).toBe(4);
    });

    it("handles empty input", () => {
        expect(chunkMarkdown("")).toHaveLength(0);
    });
});
