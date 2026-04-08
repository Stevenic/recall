# Pipeline - Wisdom

Distilled principles. Read this first every session (after SOUL.md).

Last compacted: 2026-04-07

---

## CI Pipeline Design

**Build before typecheck in monorepos**
`tsc --noEmit` fails if workspace packages haven't been built first — cross-package imports need `.d.ts` declarations to exist. Step order: install → build → typecheck → lint → test.

**Use `--workspaces --if-present` for future-proof CI**
New packages get CI coverage automatically. Never maintain a manual package matrix when npm workspace flags handle it.

**Metadata should not trigger CI**
Standard `paths-ignore` set: `.teammates/**`, `specs/**`, `docs/**`, `*.md`, `LICENSE`. CI minutes are for product changes, not coordination artifacts.

**Audit at high unless reality forces lower**
Default: `npm audit --audit-level=high`. Only relax for unfixable transitive issues, and treat the downgrade as temporary debt.

**Fail loud and early**
Builds, tests, and deploy checks should stop on the first meaningful problem with output that tells the developer what broke.

## Release & Deployment

**Serialize publish workflows**
Use a concurrency group with `cancel-in-progress: false`. A stale deploy is recoverable; a half-canceled release is broken state.

**Rollback is part of deploy**
A release process is incomplete if recovery depends on manual heroics or tribal knowledge.

**Multi-stage Docker builds for runtime images**
Build stage installs all deps and compiles; runtime stage copies only production deps + dist. Keeps images small, avoids shipping devDependencies or source.

## General Principles

**Automate the paved road**
The best workflow is the one contributors get by default. CI and release paths should remove judgment calls, not add them.

**Reproducibility matters**
Pin the environment where needed, document required tools, and avoid pipelines that depend on hidden machine state.

**Local verification beats workflow speculation**
CI changes are not done when they merely look correct. Run the real workspace commands locally against current repo state before declaring a workflow change complete.

**Repo-root paths matter in workflows**
CI steps start at the repository root unless a `working-directory` is set. Package-scoped logic should use explicit repo-root paths, not assume the package directory is current.

## Process

**Dirty worktrees require scope discipline**
Repos often have unrelated local edits in flight. DevOps work should stay tightly scoped to CI/CD files — never revert or "clean up" user-owned changes.

**Spec-driven CI planning**
When a new spec lands, extract all DevOps work items early — phased by the spec's own milestones. This prevents CI coverage from lagging behind feature development.

**Co-ownership should warn, not block**
Multiple teammates can legitimately share primary ownership of a file. Ownership checks should surface that as review context, but only fail on actual map corruption.
