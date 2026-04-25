---
name: Never use bare parseInt/parseFloat as Commander coercers
description: Commander.js calls coercers as fn(value, previousValue), so parseInt("1", 1) returns NaN. Wrap them.
type: feedback
---

Never pass `parseInt` or `parseFloat` directly as a Commander.js option coercer:

```ts
// WRONG — silently produces NaN on first invocation
.option('--start <n>', 'desc', parseInt, 1)
```

Commander invokes coercer as `(value, previousValue)`. `parseInt("1", 1)` treats `1` as the radix (invalid radix < 2) → returns `NaN`. The default value `1` is passed as previousValue, not the result.

Always wrap:

```ts
const parseIntArg = (v: string) => parseInt(v, 10);
const parseFloatArg = (v: string) => parseFloat(v);

.option('--start <n>', 'desc', parseIntArg, 1)
```

**Why:** Discovered 2026-04-24 in `@recall/bench` — `recall-bench generate --start 1 --end 30` produced 0 days, exit 0, no error. `NaN` survived `?? default` guards (NaN is not nullish) and silently killed downstream filters (`endDay >= NaN` is always false).

**How to apply:** When defining any Commander option with numeric coercion, use a wrapped function. Audit any new CLI commands for this pattern. The `??` default guard is NOT a backstop — it does not catch NaN.
