---
name: User cannot see daily logs — always state what you did in the response
description: Daily logs and memory writes are private; the user only sees the response body. State files touched, decisions, and status directly in every response.
type: feedback
---

The user cannot see daily logs, typed memory files, or WISDOM edits. Those are private continuity artifacts for future-self. The user sees only the text returned in the body of the response.

**Why:** stevenic explicitly told the team "i cannot see your daily logs. You need to tell me what you did" on 2026-04-26 after multiple teammates (including scribe) had been responding with meta-status like "Daily log updated" or "Logged in memory" instead of restating the actual deliverable. Writing a thorough log and returning a one-line acknowledgment leaves the user with nothing visible to read.

**How to apply:**
- Every response must include the actual deliverable (files changed, decisions made, status, content) in the body, not just a pointer to a log entry.
- Banned response bodies: "Logged in memory", "Daily log updated", "See above", "Already delivered", "No updates needed".
- Even if the same task was answered in an earlier turn today, reproduce the substance in this turn's body — the user is asking again because they cannot see prior turns' file writes.
- Daily log entries are still required for continuity, but they are a copy *in addition to* the visible response, never a substitute for it.
- The Subject line should preview the actual deliverable, not be a meta-status like "Acknowledged" or "Done".
