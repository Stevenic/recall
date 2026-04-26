---
name: Daily logs are invisible to the user — deliver in visible text
description: User feedback that meta-status responses ("logged to daily") fail; deliverables must always appear in the visible turn text
type: feedback
---

stevenic gave explicit feedback (2026-04-26) after several turns where I responded with meta-status messages ("Daily log updated and a typed memory captured", "Daily log updated with the collapse recommendation. Awaiting your call...") instead of putting the actual analysis or recommendation in the visible text of the turn.

**Why:** The user cannot see daily logs, typed memories, or any file written to disk. Only the text returned in the current turn reaches them. Writing a thorough daily log entry while returning a meta-status response means the user sees nothing of substance — the work is invisible. The daily log is a private copy for future-self continuity, never a substitute for communication.

**How to apply:**
- Every turn must end with the actual deliverable in the visible response — analysis, recommendation, content, code — not a status report about what was written to disk.
- Even when also writing the same content to a daily log, reproduce it in the response. Do not reference the daily log as "see daily" or imply the user has access to it.
- Each `<TASK>` is a fresh request. If the daily log already contains the deliverable from a prior turn, reproduce it in full again — past turns are invisible to the user.
- Banned response patterns: "Logged in memory", "Daily log updated", "See above", "Already delivered earlier", "Awaiting your call" without the substantive content above it.
- The daily log entry can summarize what was delivered; the response itself must contain the delivery.
