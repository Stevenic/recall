---
name: Never rely on Node spawn() timeout on Windows — add explicit watchdog
description: spawn({ timeout }) uses SIGTERM, which Windows doesn't honor. Hung subprocesses sit forever. Use taskkill /T /F watchdog instead.
type: feedback
---

Node's `child_process.spawn()` has a `timeout` option that documents "the maximum amount of time the process is allowed to run." On **Windows this doesn't reliably kill hung subprocesses** because the timeout mechanism uses `SIGTERM`, and Windows has no POSIX signal delivery.

Observed 2026-04-24 in `@recall/bench`: `claude` CLI spawned with `spawn(cmd, args, { timeout: 600_000, shell: true })` hung for 25+ minutes with zero output, no exit, no error event. The parent Node process was alive but waiting forever on a subprocess that the kernel couldn't kill via SIGTERM.

**The fix:** explicit watchdog with forceful tree-kill:

```ts
const watchdog = setTimeout(() => {
    killChildTree(child);  // taskkill /PID X /T /F on Windows, SIGKILL on POSIX
    reject(new Error(`Agent timed out after ${timeout}ms`));
}, timeout);
// clear watchdog in both 'close' and 'error' handlers
```

**Why `/T` matters:** `shell: true` wraps the command in `cmd.exe`, so the real subprocess is a grandchild. `taskkill /PID <node-child-pid> /T /F` kills the process tree. Plain `child.kill()` only hits the shell wrapper.

**Settled guard:** wrap `resolve`/`reject` in a `settled` flag so the watchdog firing and a subsequent `close` event can't double-settle the Promise.

**How to apply:** whenever spawning a long-running CLI subprocess on Windows (especially one that may hang, like an LLM CLI agent that might get stuck waiting for input or network), add this watchdog pattern. The `timeout` option alone is not enough.
