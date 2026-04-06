---
name: Recall service — Pipeline goals
description: DevOps work items derived from the memory-service spec (specs/memory-service.md)
type: project
---

Work items for the recall agent memory service, extracted from specs/memory-service.md.

## MVP (v0.1) — CI/CD Foundation

- [ ] **Monorepo workspace setup** — Root `package.json` with workspaces config for `packages/core` (Beacon's primary ownership; Pipeline owns scripts section)
- [x] **CI workflow: build + test** — `.github/workflows/ci.yml` — Node 20+22 matrix, build → typecheck → lint → test, plus security audit job
- [x] **CI workflow: PR checks** — Same workflow triggers on `pull_request` to main
- [x] **paths-ignore for metadata** — `.teammates/**`, `specs/**`, `docs/**`, `*.md`, `LICENSE` excluded from CI triggers
- [x] **Dockerfile** — Multi-stage build: build stage with full deps, slim runtime with only production deps + dist
- [x] **npm publish workflow** — `.github/workflows/publish.yml` — Triggered on `v*` tags, concurrency group with `cancel-in-progress: false`, npm provenance

## v0.2 — Plugin Packages + Bindings

- [ ] **CI matrix for plugin packages** — Extend build/test workflow to cover `storage-sqlite`, `embeddings-openai`, `model-openai`, `model-anthropic`
- [ ] **Publish workflow for plugin packages** — Per-package publish on tag, scoped to `@stevenic/*`
- [ ] **Python binding CI** — Lint, test, and publish for `bindings/python` (pyproject.toml)
- [ ] **Go binding CI** — Test and publish for `bindings/go`

## v0.3 — Extended Bindings

- [ ] **Rust binding CI** — Cargo test + publish for `bindings/rust`
- [ ] **C# binding CI** — dotnet test + NuGet publish for `bindings/csharp`

**Why:** The spec defines a monorepo with pluggable packages and multi-language bindings. Each phase adds new packages that need CI coverage, build validation, and publish automation.

**How to apply:** When Beacon starts implementing packages, corresponding CI must be added in the same phase. New packages must be added to all CI matrix jobs (build, test, lint, typecheck, publish).
