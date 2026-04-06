# TypeScript Monorepo Playbook

A comprehensive guide for coding agents to scaffold, configure, and ship a TypeScript monorepo with best-practice tooling, documentation, CI/CD, and AI-agent discoverability.

> **How to use this playbook:** Work through each section in order. Where a section says *"Ask the developer,"* pause and collect the answer before proceeding — the response will shape later steps. Sections marked *"Skip if not applicable"* can be omitted based on interview answers.

> **Relationship to the single-package playbook:** This playbook extends the [TypeScript Library Playbook](https://github.com/Stevenic/vectra/blob/main/TYPESCRIPT-LIBRARY-PLAYBOOK.md) to cover monorepo-specific concerns: workspace configuration, cross-package references, coordinated builds, and multi-package publishing. Where a topic is identical (e.g., ESLint rule sets, test writing patterns, security policy content), this playbook references the single-package version rather than duplicating it.

---

## Table of Contents

1. [Developer Interview](#1-developer-interview)
2. [Repository Scaffold](#2-repository-scaffold)
3. [Root Package Manifest](#3-root-package-manifest)
4. [Package Manifests](#4-package-manifests)
5. [TypeScript Configuration](#5-typescript-configuration)
6. [Source Code Layout](#6-source-code-layout)
7. [Linting](#7-linting)
8. [Testing](#8-testing)
9. [Build Pipeline](#9-build-pipeline)
10. [Git Configuration](#10-git-configuration)
11. [README & Badges](#11-readme--badges)
12. [Contributing & Community Files](#12-contributing--community-files)
13. [Security Policy (`SECURITY.md`)](#13-security-policy)
14. [GitHub Issue Templates](#14-github-issue-templates)
15. [Dependency Management (`dependabot.yml`)](#15-dependency-management)
16. [Developer Documentation (GitHub Pages)](#16-developer-documentation-github-pages)
17. [Samples / Examples](#17-samples--examples)
18. [CI/CD Workflows (GitHub Actions)](#18-cicd-workflows-github-actions)
19. [Agent Ready (`llms.txt`)](#19-agent-ready-llmstxt)
20. [Agent Configuration Files](#20-agent-configuration-files)
21. [Publishing to npm](#21-publishing-to-npm)
22. [Post-Setup Checklist](#22-post-setup-checklist)

---

## 1. Developer Interview

Before generating any files, gather the following from the developer. Use sensible defaults where the developer defers.

### Required

| Question | Example Answer | Used In |
|----------|---------------|---------|
| What is the monorepo name? | `my-project` | Root package.json, README |
| One-line description? | "A fast widget toolkit" | Root README, llms.txt |
| Author name and email? | `Jane Doe <jane@example.com>` | All package.json files, LICENSE |
| License? | `MIT` | All package.json files, LICENSE |
| GitHub repo URL? | `https://github.com/jane/my-project` | package.json files, badges, docs |
| Minimum Node.js version? | `>=20.x` | engines, CI matrix, .nvmrc |

### Monorepo-Specific

| Question | Default | Notes |
|----------|---------|-------|
| Package manager? | `npm` workspaces | Also supports `yarn` (v1/berry) or `pnpm` |
| Initial packages? | `["core"]` | List of package directory names under `packages/` |
| npm scope? | None | If set (e.g., `@my-org`), all packages use `@my-org/<name>` |
| Does any package include a CLI? | No | If yes, sets up `bin/` entry in that package |
| Module system? | ESM (`"type": "module"`) | Also supports CJS or dual |
| Does the repo need browser support? | No | If yes, adds browser entry points and webpack config |

### Optional (defaults shown)

| Question | Default | Notes |
|----------|---------|-------|
| Test framework preference? | `vitest` | Also supports `mocha` + `sinon` or `jest` |
| Coverage service? | Coveralls | Also supports Codecov |
| Does the repo need a docs site? | Yes (GitHub Pages + Jekyll) | Can skip if not needed |
| Want `llms.txt` for AI agent discoverability? | Yes | Creates Agent Ready badge + file |
| Code samples directory? | Yes (`samples/`) | Runnable example projects |

---

## 2. Repository Scaffold

Create the following directory structure. Adjust based on interview answers.

```
<repo-name>/
├── packages/
│   ├── core/                         # Primary package
│   │   ├── src/
│   │   │   ├── index.ts              # Barrel export
│   │   │   ├── types.ts              # Shared type definitions
│   │   │   └── internals/
│   │   │       └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── <package-b>/                  # Additional packages follow same pattern
│   │   ├── src/
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── cli/                          # CLI package (if applicable)
│       ├── src/
│       │   ├── index.ts
│       │   └── cli.ts                # CLI entry point
│       ├── package.json
│       └── tsconfig.json
├── docs/                             # Jekyll documentation site
│   ├── _config.yml
│   ├── Gemfile
│   ├── .gitignore
│   ├── index.md
│   ├── getting-started.md
│   ├── api-reference.md
│   └── changelog.md
├── samples/                          # Runnable example projects
│   ├── README.md
│   └── quickstart/
│       └── example.ts
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── feature_request.yml
│   │   ├── question.yml
│   │   └── config.yml
│   ├── copilot-instructions.md
│   ├── dependabot.yml
│   └── workflows/
│       ├── ci.yml
│       └── docs.yml
├── SECURITY.md
├── CHANGELOG.md
├── package.json                      # Root — workspaces, shared scripts
├── tsconfig.json                     # Root — shared compiler options
├── tsconfig.build.json               # Build-only config with project references
├── .nvmrc
├── eslint.config.mjs                 # Shared ESLint config (root)
├── .gitignore
├── LICENSE
├── README.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── llms.txt
├── CLAUDE.md
├── AGENTS.md
├── .cursorrules
└── .windsurfrules
```

### Key structural decisions

- **`packages/` directory** — All publishable packages live here. The root `package.json` points workspaces at `packages/*`.
- **One tsconfig per package** — Each package has its own `tsconfig.json` that extends the root config. This enables incremental builds and project references.
- **Shared config at root** — ESLint, root tsconfig, and workspace scripts live at the repo root. Packages inherit, not duplicate.
- **CLI as a separate package** — If the repo has a CLI, it gets its own package under `packages/cli/` that depends on `packages/core/`. This keeps the library importable without CLI dependencies.

---

## 3. Root Package Manifest

Create the root `package.json`. This file is **never published** — it exists only to configure workspaces and hold shared scripts.

```jsonc
{
  "name": "<repo-name>-monorepo",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces",
    "clean": "npm run clean --workspaces",
    "lint": "npm run lint --workspaces",
    "test": "npm test --workspaces",
    "test:watch": "npm run test:watch --workspaces"
  },
  "engines": {
    "node": ">=<min-node-version>"
  }
}
```

### Package manager variants

**npm workspaces (default):**
```jsonc
{
  "workspaces": ["packages/*"]
}
// Scripts: npm run build --workspaces
// Install: npm install
// CI: npm ci
```

**Yarn v1 workspaces:**
```jsonc
{
  "workspaces": ["packages/*"]
}
// Scripts: yarn workspaces run build
// Install: yarn install
// CI: yarn --frozen-lockfile
```

**pnpm workspaces:**
Create `pnpm-workspace.yaml` at root:
```yaml
packages:
  - 'packages/*'
```
```
// Scripts: pnpm -r run build
// Install: pnpm install
// CI: pnpm install --frozen-lockfile
```

### Key decisions

- **`private: true`** — The root must never be published. This is a safety guard.
- **Workspace scripts use `--workspaces`** (npm) to run across all packages. Order follows dependency topology automatically.
- **No `devDependencies` at root** unless truly shared (e.g., a monorepo orchestrator). Prefer per-package devDependencies to keep each package self-contained.
- **`engines`** at root enforces the Node version for the entire repo. Each package should also declare its own `engines` for npm consumers.

---

## 4. Package Manifests

Each package under `packages/` gets its own `package.json`. Replace placeholders with interview answers.

### Library package (`packages/core/package.json`)

```jsonc
{
  "name": "<scope>/<package-name>",    // or just "<package-name>" if no scope
  "version": "0.1.0",
  "description": "<one-line description>",
  "type": "module",                     // ESM by default
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },

  "files": [
    "dist/",
    "src/"                              // Include source for sourcemap debugging
  ],

  "scripts": {
    "build": "tsc",
    "clean": "rimraf dist",
    "lint": "eslint src/ --fix",
    "test": "vitest run",
    "test:watch": "vitest",
    "prepublishOnly": "npm run clean && npm run build && npm run test"
  },

  "dependencies": {},
  "devDependencies": {
    "@types/node": "^22.0.0",
    "eslint": "^9.0.0",
    "rimraf": "^6.0.0",
    "typescript": "^5.8.0",
    "vitest": "^2.0.0"
  },

  "engines": { "node": ">=<min-node-version>" },
  "license": "MIT",

  "repository": {
    "type": "git",
    "url": "git+<github-url>.git",
    "directory": "packages/core"         // Points npm to the right subdirectory
  }
}
```

### CLI package (`packages/cli/package.json`) — if applicable

```jsonc
{
  "name": "<scope>/<cli-name>",
  "version": "0.1.0",
  "description": "CLI for <project-name>",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "<cli-name>": "./dist/cli.js"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },

  "files": [
    "dist/",
    "src/"
  ],

  "scripts": {
    "build": "tsc",
    "clean": "rimraf dist",
    "lint": "eslint src/ --fix",
    "test": "vitest run",
    "test:watch": "vitest",
    "prepublishOnly": "npm run clean && npm run build && npm run test"
  },

  "dependencies": {
    "<scope>/<core-package>": "workspace:*",  // Cross-package dependency
    "commander": "^12.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "eslint": "^9.0.0",
    "rimraf": "^6.0.0",
    "typescript": "^5.8.0",
    "vitest": "^2.0.0"
  },

  "engines": { "node": ">=<min-node-version>" },
  "license": "MIT",

  "repository": {
    "type": "git",
    "url": "git+<github-url>.git",
    "directory": "packages/cli"
  }
}
```

### Cross-package dependencies

Use the workspace protocol to reference sibling packages:

| Package Manager | Syntax | Resolves to |
|----------------|--------|-------------|
| npm workspaces | `"*"` or `"workspace:*"` | Local package (symlink) |
| Yarn v1 | `"*"` | Local package (symlink) |
| pnpm | `"workspace:*"` | Local package (symlink) |

**Important:** When publishing, the workspace protocol is automatically replaced with the actual version number. `"workspace:*"` becomes `"^0.1.0"` (or whatever the resolved version is).

### Key decisions

- **`"type": "module"`** — ESM is the default for new packages. If CJS is needed, omit this field and use `"module": "commonjs"` in tsconfig.
- **`"repository.directory"`** — Critical for monorepos. Tells npm which subdirectory contains this package's source.
- **`files` field** — Each package controls what ships to npm independently. Always include `dist/` and `src/`.
- **`prepublishOnly`** — Runs per-package before `npm publish`. Ensures each package is individually publishable.
- **devDependencies per package** — Each package declares its own dev dependencies. This keeps packages self-contained and avoids phantom dependencies.

---

## 5. TypeScript Configuration

### Root tsconfig (`tsconfig.json`)

Shared compiler options that all packages inherit:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  }
}
```

### Build config (`tsconfig.build.json`) — optional

If you want a single command to build all packages in dependency order:

```json
{
  "files": [],
  "references": [
    { "path": "packages/core" },
    { "path": "packages/cli" }
  ]
}
```

Then `tsc -b tsconfig.build.json` builds everything in topological order. This is useful for CI but not required — workspace scripts (`npm run build --workspaces`) achieve the same result.

### Per-package tsconfig (`packages/core/tsconfig.json`)

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Per-package tsconfig with project references (`packages/cli/tsconfig.json`)

When a package depends on another package in the monorepo:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"],
  "references": [
    { "path": "../core" }
  ]
}
```

### Node version file (`.nvmrc`)

```
22
```

**This must match `engines.node` in the root package.json and the CI matrix.**

### Key decisions

- **`composite: true`** at root enables project references and incremental builds across the monorepo.
- **`module: "NodeNext"` + `moduleResolution: "NodeNext"`** — The correct pairing for ESM packages targeting Node.js. Use `"commonjs"` + `"node"` for CJS packages.
- **`extends`** — Each package inherits shared options and only overrides `outDir`/`rootDir`. Never duplicate compiler options across packages.
- **Project references** — Only add `"references"` when a package directly imports from another package in the monorepo. Don't add transitive references.
- **`skipLibCheck: true`** — Speeds up compilation by skipping third-party `.d.ts` validation. Essential in monorepos with many packages.

---

## 6. Source Code Layout

### Per-package layout

Each package follows the same internal structure as a single-package library:

```
packages/<name>/
├── src/
│   ├── index.ts              # Barrel export
│   ├── types.ts              # Package-specific types
│   ├── MyClass.ts
│   ├── MyClass.spec.ts       # Colocated test
│   └── internals/
│       └── index.ts          # Private utilities (not exported)
├── dist/                     # Compiled output (gitignored)
├── package.json
└── tsconfig.json
```

### Barrel exports (`src/index.ts`)

```ts
export * from './types.js';
export * from './MyClass.js';
// Add exports as you build features
```

**Note the `.js` extensions** — required when `"type": "module"` is set. TypeScript resolves `.js` imports to the corresponding `.ts` files during compilation.

### Cross-package imports

Packages import from each other using the **package name**, not relative paths:

```ts
// In packages/cli/src/commands/search.ts
import { MemoryService } from '<scope>/<core-package>';  // NOT '../../../core/src'
```

This works because workspace symlinks resolve the package name to the local source.

### Colocation pattern

Place tests alongside source files using the `.spec.ts` suffix:

```
src/
├── MyClass.ts
├── MyClass.spec.ts
├── utils/
│   ├── index.ts
│   ├── helpers.ts
│   └── helpers.spec.ts
└── internals/
    └── index.ts              # Private utilities, excluded from barrel export
```

### CLI entry point (if applicable)

In the CLI package, create `src/cli.ts`:

```ts
#!/usr/bin/env node
import { Command } from 'commander';
import { version } from '../package.json' with { type: 'json' };

const program = new Command()
  .name('<cli-name>')
  .version(version)
  .description('<description>');

// Add commands...

program.parse();
```

Ensure `package.json` has `"bin": { "<cli-name>": "./dist/cli.js" }` and that the compiled output preserves the shebang.

---

## 7. Linting

### Shared config at root (`eslint.config.mjs`)

```js
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: [
      '**/dist/',
      '**/lib/',
      '**/node_modules/',
      'samples/',
      '**/coverage/',
    ],
  },
  {
    files: ['packages/*/src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,             // Auto-discovers per-package tsconfigs
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      'no-var': 'error',
      'prefer-const': 'warn',
      'eqeqeq': ['warn', 'always', { null: 'ignore' }],
      'no-debugger': 'error',
    },
  },
  {
    // Relaxed rules for test files
    files: ['packages/*/src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
```

### Per-package lint scripts

Each package's `package.json` has:

```jsonc
"scripts": {
  "lint": "eslint src/ --fix"
}
```

ESLint resolves the root config automatically via config file lookup. No per-package eslint config needed unless a package has unique rules.

### Key decisions

- **`projectService: true`** — Replaces the older `project` array syntax. Automatically discovers the correct tsconfig for each file. Essential for monorepos where each package has its own tsconfig.
- **Single root config** — Avoids config drift between packages. Override per-package only when genuinely needed.
- **`ignores` uses `**/dist/`** — Glob pattern catches dist directories at any depth in the monorepo.

---

## 8. Testing

### Framework: Vitest (recommended for monorepos)

Vitest is the recommended test framework for TypeScript monorepos because:
- Native ESM support — no transpilation hacks
- Per-package configs that inherit from a root config
- Watch mode understands workspace dependencies
- Compatible with Jest's API (easy migration)

### Root vitest config (optional)

If you want shared test settings, create `vitest.config.ts` at root:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.spec.ts',
        '**/index.ts',
        '**/internals/**',
      ],
    },
  },
});
```

### Per-package test execution

Each package runs tests independently via its own script:

```jsonc
// packages/core/package.json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest"
}
```

Run all tests from root:

```bash
npm test --workspaces
```

### Mocha alternative

If using mocha + sinon instead of vitest:

```jsonc
// Per-package scripts
"test": "npm-run-all build test:mocha",
"test:mocha": "nyc ts-mocha -p tsconfig.json src/**/*.spec.ts"
```

Add `.nycrc` per package (or at root if identical):

```json
{
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "**/*.spec.ts", "**/*.d.ts", "**/index.ts"],
  "reporter": ["html", "lcov", "text"],
  "all": true,
  "cache": true
}
```

### Writing tests

```ts
import { describe, it, expect } from 'vitest';
import { MyClass } from './MyClass.js';

describe('MyClass', () => {
  it('should do the thing', () => {
    const result = new MyClass().doThing();
    expect(result).toBe('expected');
  });
});
```

### Cross-package test dependencies

If a test in `packages/cli` needs to exercise `packages/core`, import it by package name — not relative path. The workspace symlink ensures you're testing the actual published interface:

```ts
import { MemoryService } from '<scope>/<core-package>';
```

---

## 9. Build Pipeline

### Standard build

Each package compiles independently:

```bash
# Single package
cd packages/core && npm run build

# All packages (from root)
npm run build --workspaces
```

npm workspaces automatically builds packages in topological order (dependencies first).

### Project references build (alternative)

If using `tsconfig.build.json` with project references:

```bash
tsc -b tsconfig.build.json
```

This is faster for incremental builds because TypeScript tracks cross-package dependencies and only recompiles what changed.

### Post-build file copying

If a package includes non-TypeScript assets:

```jsonc
// In package scripts
"build": "tsc && shx cp -r src/templates dist/templates"
```

Use `shx` for cross-platform shell commands.

### Browser bundle (if applicable)

Add webpack config to the specific package that needs browser support, not at root. See the single-package playbook Section 8 for webpack configuration details.

### Clean build

```jsonc
// Root package.json
"clean": "npm run clean --workspaces"

// Per-package
"clean": "rimraf dist"
```

---

## 10. Git Configuration

### `.gitignore`

```gitignore
# Dependencies
node_modules/

# Build output
dist/
lib/
*.tsbuildinfo

# Coverage
coverage/
.lcov
.nyc_output/

# Environment
.env
.env.*

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Lock files (uncomment the ones you DON'T use)
# package-lock.json
# yarn.lock
# pnpm-lock.yaml
```

### Key monorepo considerations

- **Single `.gitignore` at root** covers all packages. No per-package `.gitignore` needed unless a package has unique ignore patterns (e.g., `docs/.gitignore` for Jekyll artifacts).
- **`dist/` not `lib/`** — ESM monorepos typically use `dist/` as the output directory. Both are gitignored for safety.
- **Lock file** — Commit exactly one lock file matching your package manager. The others should be gitignored.

---

## 11. README & Badges

### Root README

The root README is the project's landing page. It should explain the monorepo structure and link to individual packages.

### Badge row

```markdown
# <Project Name>

[![Build](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/<repo>/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/<owner>/<repo>/badge.svg?branch=main)](https://coveralls.io/github/<owner>/<repo>?branch=main)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Agent Ready](https://img.shields.io/badge/Agent-Ready-blue.svg)](#agent-ready)
```

Add per-package npm badges only if the packages are published:

```markdown
[![npm: @scope/core](https://img.shields.io/npm/v/@scope/core.svg)](https://www.npmjs.com/package/@scope/core)
[![npm: @scope/cli](https://img.shields.io/npm/v/@scope/cli.svg)](https://www.npmjs.com/package/@scope/cli)
```

### README structure

```markdown
# <Project Name>

<badges>

<one-paragraph description>

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [`@scope/core`](./packages/core) | Core library | [![npm](https://img.shields.io/npm/v/@scope/core)](https://npmjs.com/package/@scope/core) |
| [`@scope/cli`](./packages/cli) | CLI tool | [![npm](https://img.shields.io/npm/v/@scope/cli)](https://npmjs.com/package/@scope/cli) |

## Quick Start

\`\`\`sh
npm install @scope/core
\`\`\`

\`\`\`ts
// Minimal working example (under 10 lines)
\`\`\`

## Development

\`\`\`sh
git clone <github-url>
cd <repo-name>
npm install
npm run build
npm test
\`\`\`

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](<docs-url>/getting-started) | Installation, setup, first example |
| [API Reference](<docs-url>/api-reference) | Full API documentation |
| [Changelog](<docs-url>/changelog) | Version history and migration guides |

## Agent Ready

This project includes an [`llms.txt`](llms.txt) file — a structured guide that helps
AI coding agents understand the library's API, types, and usage patterns. Point your
agent at this file to enable accurate code generation.

## License

MIT

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
```

### Per-package READMEs

Each package should have its own `README.md` with:
- Package-specific description and badges
- Install command for that specific package
- Quick example
- Link to full docs
- API summary

These READMEs are what npm displays on the package page.

---

## 12. Contributing & Community Files

Identical to the single-package playbook (Section 11), with these monorepo additions to `CONTRIBUTING.md`:

### Additional sections for monorepo

```markdown
## Monorepo Structure

This project uses npm workspaces. All packages live under `packages/`:

| Directory | Package | Description |
|-----------|---------|-------------|
| `packages/core` | `@scope/core` | Core library |
| `packages/cli` | `@scope/cli` | CLI tool |

## Adding a New Package

1. Create a new directory under `packages/`
2. Add `package.json` with `"name"`, `"version"`, and standard scripts
3. Add `tsconfig.json` extending the root config
4. If the package depends on another workspace package, add it to `dependencies` with `"workspace:*"`
5. Run `npm install` from the root to update the workspace symlinks

## Cross-Package Changes

When modifying a package's public API, check for consumers in other packages:

\`\`\`bash
# Find all imports of a package
grep -r "from '@scope/core'" packages/*/src/
\`\`\`

Build and test all packages before submitting:

\`\`\`bash
npm run build --workspaces
npm test --workspaces
\`\`\`
```

---

## 13. Security Policy

Identical to the single-package playbook (Section 12). Use the same `SECURITY.md` template at the repo root.

---

## 14. GitHub Issue Templates

Identical to the single-package playbook (Section 13), with one addition to the bug report template:

```yaml
  - type: dropdown
    id: package
    attributes:
      label: Affected package
      options:
        - "@scope/core"
        - "@scope/cli"
        - "Multiple packages"
        - "Not sure"
    validations:
      required: true
```

This helps triage bugs to the correct package.

---

## 15. Dependency Management

### `.github/dependabot.yml`

Monorepos need a Dependabot entry **per package directory**:

```yaml
version: 2
updates:
  # Root dependencies (if any)
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
    open-pull-requests-limit: 5
    labels:
      - "dependencies"

  # packages/core
  - package-ecosystem: "npm"
    directory: "/packages/core"
    schedule:
      interval: "weekly"
      day: "monday"
    open-pull-requests-limit: 10
    labels:
      - "dependencies"
      - "pkg:core"
    ignore:
      - dependency-name: "typescript"
        update-types: ["version-update:semver-major"]

  # packages/cli
  - package-ecosystem: "npm"
    directory: "/packages/cli"
    schedule:
      interval: "weekly"
      day: "monday"
    open-pull-requests-limit: 10
    labels:
      - "dependencies"
      - "pkg:cli"
    ignore:
      - dependency-name: "typescript"
        update-types: ["version-update:semver-major"]

  # GitHub Actions
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
    open-pull-requests-limit: 5
    labels:
      - "dependencies"
      - "ci"
```

### Key differences from single-package

- **One entry per package directory** — Dependabot doesn't understand workspaces natively. Each `packages/<name>` needs its own entry.
- **Package-specific labels** (`pkg:core`, `pkg:cli`) — Makes it easy to filter and batch PRs by package.
- **Root entry** — Needed if you have devDependencies at the root level.
- **When adding a new package**, remember to add a corresponding Dependabot entry.

---

## 16. Developer Documentation (GitHub Pages)

Identical to the single-package playbook (Section 15). The docs site covers the entire monorepo — individual packages don't get separate doc sites.

For the API reference page, organize by package:

```markdown
---
title: API Reference
layout: default
nav_order: 4
---

# API Reference

## @scope/core

### Classes
- `MemoryService` — ...
- `MemoryFiles` — ...

### Interfaces
- `MemoryServiceConfig` — ...

---

## @scope/cli

### Commands
- `recall search <query>` — ...
- `recall compact` — ...
```

---

## 17. Samples / Examples

Same structure as the single-package playbook (Section 16). Samples live at the repo root under `samples/` and reference published package names:

```ts
// samples/quickstart/example.ts
import { MemoryService } from '@scope/core';

const service = new MemoryService({ /* config */ });
// ...
```

### Running samples locally

Samples should work with the local workspace packages. Add a `tsconfig.json` to the samples directory if needed:

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "."
  },
  "include": ["./**/*.ts"]
}
```

Or use `tsx` for direct execution:

```bash
npx tsx samples/quickstart/example.ts
```

---

## 18. CI/CD Workflows (GitHub Actions)

### CI Workflow (`.github/workflows/ci.yml`)

```yaml
name: CI

on:
  push:
    branches: [main]
    paths-ignore:
      - 'docs/**'
      - '*.md'
  pull_request:
    branches: [main]
    paths-ignore:
      - 'docs/**'
      - '*.md'

permissions:
  contents: read

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [22]
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Lint all packages
        run: npm run lint --workspaces

      - name: Build all packages
        run: npm run build --workspaces

      - name: Test all packages
        run: npm test --workspaces

      # Coveralls
      - name: Upload coverage to Coveralls
        if: matrix.node-version == 22
        uses: coverallsapp/github-action@v2
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          file: packages/core/coverage/lcov.info
          # For multiple packages, use flag-name and parallel mode:
          # flag-name: core
          # parallel: true
```

### Multi-package coverage (Coveralls parallel mode)

If multiple packages generate coverage, use parallel uploads:

```yaml
      - name: Upload core coverage
        uses: coverallsapp/github-action@v2
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          file: packages/core/coverage/lcov.info
          flag-name: core
          parallel: true

      - name: Upload cli coverage
        uses: coverallsapp/github-action@v2
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          file: packages/cli/coverage/lcov.info
          flag-name: cli
          parallel: true

      - name: Finalize coverage
        uses: coverallsapp/github-action@v2
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          parallel-finished: true
```

### Key CI differences from single-package

- **`npm ci`** at root installs all workspace dependencies in one step.
- **`--workspaces`** flag runs scripts across all packages in dependency order.
- **Coverage per package** — Each package generates its own coverage report. Use parallel mode to merge them.
- **Single job** is usually sufficient. Split into per-package jobs only if build times become a bottleneck.

### Docs Workflow

Identical to the single-package playbook (Section 17). The docs workflow deploys from `docs/` regardless of monorepo structure.

### Release workflow

See [Section 21: Publishing to npm](#21-publishing-to-npm) for monorepo-specific release strategies.

---

## 19. Agent Ready (`llms.txt`)

Same format as the single-package playbook (Section 18), but cover all packages:

```markdown
# <Project Name>

> <Description of the overall project and its packages.>

## Packages

- `@scope/core` — Core library for <purpose>
- `@scope/cli` — CLI tool for <purpose>

## Installation

\`\`\`sh
npm install @scope/core
\`\`\`

## Key Exports (@scope/core)

- `ClassName` — What it does
- `InterfaceName` — What it models
- `functionName(args)` — What it returns

## Key Exports (@scope/cli)

- CLI commands listed here

## Quick Start

<Minimal code example>

## API Patterns

<Main patterns across packages>
```

### Tips for monorepo `llms.txt`

- **Organize by package** — Group exports under package headings so agents know which import to use.
- **Show cross-package usage** — If the common pattern involves importing from multiple packages, show that.
- **Keep it under 15KB** — If the monorepo is large, focus on the primary package and link to per-package docs for the rest.

---

## 20. Agent Configuration Files

Identical to the single-package playbook (Section 19), with updated project structure:

### Monorepo-specific content template

```markdown
# <Project Name>

<one-line description>

## Project Structure

This is a monorepo using npm workspaces.

- `packages/core/` — Core library (`@scope/core`)
- `packages/cli/` — CLI tool (`@scope/cli`)
- `docs/` — Jekyll documentation site (GitHub Pages)
- `samples/` — Runnable example projects

Each package has its own `package.json`, `tsconfig.json`, and `src/` directory.

## Development Commands

All commands run from the repo root:

- `npm install` — Install all workspace dependencies
- `npm run build --workspaces` — Build all packages
- `npm test --workspaces` — Test all packages
- `npm run lint --workspaces` — Lint all packages

Per-package (from within a package directory):

- `npm run build` — Build this package
- `npm test` — Test this package
- `npm run lint` — Lint this package

## Code Conventions

- ESM (`"type": "module"`) — use `.js` extensions in imports
- TypeScript strict mode — no `any` unless unavoidable
- Tests colocated with source: `src/foo.spec.ts` tests `src/foo.ts`
- Barrel exports through `src/index.ts` — every public API must be re-exported here
- Internal utilities in `src/internals/` — not exported from the package
- Cross-package imports use the package name, not relative paths

## Testing

- Framework: vitest
- Coverage: v8 — reports to Coveralls
- Run `npm test` in a package directory for fast iteration

## CI

- GitHub Actions on push/PR to `main`
- Pipeline: install → lint → build → test → coverage upload
- Node 22 on ubuntu-latest
- All packages build and test in a single CI job

## Before Submitting a PR

- Run `npm run lint --workspaces` and fix any errors
- Run `npm test --workspaces` and ensure all tests pass
- Update `llms.txt` if you changed public API surface
- Update `CHANGELOG.md` with a summary of changes
```

Create all agent config files as described in the single-package playbook (Section 19): `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `.cursorrules`, `.windsurfrules`.

---

## 21. Publishing to npm

### Strategy: Independent versioning

Each package is versioned and published independently. This is the simplest approach and works well for most monorepos.

### Pre-publish checklist (per package)

1. **Version bumped** in the package's `package.json`
2. **Cross-package dependency versions updated** if the dependency's API changed
3. **Changelog updated** with new version entry
4. **All tests pass** — `npm test --workspaces` (not just the package being published)
5. **Dry run clean** — `npm publish --dry-run` from the package directory shows only intended files
6. **No secrets in package** — check that `.env`, credentials, and test fixtures are excluded

### Manual publish

```bash
# From the package directory
cd packages/core

# Bump version
npm version patch  # or minor, major

# Verify package contents
npm publish --dry-run

# Publish
npm publish

# Push version tag
cd ../..
git push --follow-tags
```

### Coordinated publish (multiple packages)

When releasing packages that depend on each other, publish in dependency order:

```bash
# 1. Publish the dependency first
cd packages/core
npm version minor
npm publish

# 2. Update the dependent package's dependency version
cd ../cli
# Update package.json: "@scope/core": "^<new-version>"
npm version minor
npm publish

# 3. Commit and push
cd ../..
git add -A
git commit -m "release: @scope/core@x.y.z, @scope/cli@x.y.z"
git push --follow-tags
```

### Automated publish (via GitHub Actions)

```yaml
name: Publish to npm

on:
  release:
    types: [published]

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
          cache: npm
      - run: npm ci
      - run: npm run build --workspaces
      - run: npm test --workspaces

      # Publish only packages with changed versions
      - name: Publish packages
        run: |
          for dir in packages/*/; do
            pkg_name=$(node -p "require('./$dir/package.json').name")
            pkg_version=$(node -p "require('./$dir/package.json').version")
            published=$(npm view "$pkg_name" version 2>/dev/null || echo "")
            if [ "$pkg_version" != "$published" ]; then
              echo "Publishing $pkg_name@$pkg_version"
              cd "$dir"
              npm publish
              cd ../..
            else
              echo "Skipping $pkg_name@$pkg_version (already published)"
            fi
          done
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### Tooling alternatives

For larger monorepos, consider dedicated versioning tools:

- **[Changesets](https://github.com/changesets/changesets)** — PR-based changelog and versioning. Contributors add changeset files describing their changes; a release PR aggregates them.
- **[Lerna](https://lerna.js.org/)** — Mature monorepo publish tool. Handles version bumping, changelog generation, and coordinated publishing.
- **[nx release](https://nx.dev/features/manage-releases)** — If already using Nx for build orchestration.

For most projects starting out, manual publishing (or the simple automated workflow above) is sufficient. Adopt tooling when the manual process becomes error-prone.

---

## 22. Post-Setup Checklist

### Immediate (before first commit)

- [ ] Run `npm install` to generate `package-lock.json` and workspace symlinks
- [ ] Run `npm run build --workspaces` to verify TypeScript compiles across all packages
- [ ] Run `npm run lint --workspaces` to verify ESLint config works
- [ ] Run `npm test --workspaces` to verify test framework works
- [ ] Verify cross-package imports resolve correctly (build `cli` after `core`)
- [ ] Review `.gitignore` — ensure no secrets or build artifacts will be committed

### Before first release

- [ ] Enable GitHub Pages: **Settings > Pages > Source: "GitHub Actions"**
- [ ] Add Coveralls: connect repo at [coveralls.io](https://coveralls.io)
  - Or add `CODECOV_TOKEN` secret if using Codecov
- [ ] Add `NPM_TOKEN` secret if using automated npm publishing
- [ ] Verify `SECURITY.md` has correct contact info
- [ ] Verify issue templates render correctly on GitHub
- [ ] Verify agent config files are created (`CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `.cursorrules`, `.windsurfrules`)
- [ ] Write at minimum: root README, per-package READMEs, Getting Started doc, one sample, `llms.txt`
- [ ] Create initial `CHANGELOG.md` at root with the first version entry
- [ ] Run `npm publish --dry-run` in each package directory and verify contents
- [ ] Push to GitHub and verify CI workflow runs green

### When adding a new package

- [ ] Create `packages/<name>/` with `package.json`, `tsconfig.json`, and `src/index.ts`
- [ ] Add workspace dependency references if the new package depends on existing packages
- [ ] Add a Dependabot entry in `.github/dependabot.yml` for the new package directory
- [ ] Add the package to the root README packages table
- [ ] Add the package to `llms.txt` key exports
- [ ] Add the package to the bug report issue template dropdown
- [ ] Update agent config files with the new package
- [ ] Run `npm install` from root to link the new workspace

### Ongoing maintenance

- [ ] Keep `llms.txt` in sync with public API changes across all packages
- [ ] Keep agent config files in sync when dev workflow changes
- [ ] Update `CHANGELOG.md` with each release
- [ ] Update supported versions in `SECURITY.md` after major/minor releases
- [ ] Review and merge Dependabot PRs — check that cross-package dependency updates don't break siblings
- [ ] Monitor test coverage per package — don't let it silently regress
- [ ] Periodically verify that workspace symlinks are healthy (`npm ls --workspaces`)
