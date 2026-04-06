---
name: Vectra 0.14.0 FileStorage adoption
description: As of vectra 0.14.0, FileStorage/FileDetails/ListFilesFilter/LocalFileStorage/VirtualFileStorage are re-exported from vectra
type: project
---

Vectra 0.14.0 exports a full `FileStorage` abstraction with `FileDetails`, `ListFilesFilter`, `LocalFileStorage`, and `VirtualFileStorage`. We now re-export these from vectra instead of maintaining our own.

**Key differences from our prior custom interface:**
- `ListFilesFilter` is a string union (`'files' | 'folders' | 'all'`) not an object with `extensions`/`recursive` fields
- `FileDetails` has `{ name, path, isFolder, fileType? }` instead of our old `{ name, path, size, isDirectory, modifiedAt }`
- Extension filtering (e.g. `.md` files) is now done post-query in callers like `MemoryFiles`

**Why:** vectra 0.14.0 added the storage abstractions the spec originally expected. Aligning removes ~200 lines of custom code.

**How to apply:** All storage types come from `vectra` via `packages/core/src/interfaces/storage.ts`. `LocalFileStorage` and `VirtualFileStorage` are thin re-exports from `packages/core/src/defaults/`. No custom implementations remain.
