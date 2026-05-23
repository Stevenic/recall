import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

/**
 * Aliases for OpenClaw's source layout — mirror what
 * `test/vitest/vitest.shared.config.ts` does, but only the subset our harness
 * actually needs. Lets vitest resolve `openclaw/plugin-sdk/...` and
 * `openclaw/extension-api` to the real `.ts` source files at the repo root.
 */
const openClawAliases = [
    {
        find: "openclaw/extension-api",
        replacement: path.join(repoRoot, "src", "extensionAPI.ts"),
    },
    {
        find: /^openclaw\/plugin-sdk\/(.+)$/,
        replacement: path.join(repoRoot, "src", "plugin-sdk", "$1.ts"),
    },
    {
        find: "openclaw/plugin-sdk",
        replacement: path.join(repoRoot, "src", "plugin-sdk", "index.ts"),
    },
];

export default defineConfig({
    resolve: {
        alias: openClawAliases,
    },
    test: {
        include: ["tests/**/*.test.ts"],
        environment: "node",
        testTimeout: 30_000,
    },
});
