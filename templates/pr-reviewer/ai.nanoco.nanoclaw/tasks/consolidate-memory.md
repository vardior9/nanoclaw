---
schedule: "17 6 * * *"
---
Consolidate the PR-review memory inbox.

You are the single writer for curated memory; PR sessions only ever append to `memory/inbox/`. Read every file under `memory/inbox/` (if the directory is empty or missing, reply DONE and stop — no messages, no other action).

For each inbox note:
- Generic review lesson → merge into the appropriate curated file under `memory/` (create one per theme, one concept per file, per `memory/system/definition.md`). Skip anything PR-specific — GitHub is the audit trail.
- Durable repo fact (conventions, layout, build quirks) → merge into `memory/repos/<owner>__<repo>.md`.
- Duplicate or already-curated → drop it.

Rewrite for concision as you merge; a lesson that contradicts an existing one replaces it with the newer insight. Update `memory/index.md` so every curated file is findable. Delete each inbox file once processed. Reply with one line: how many notes processed, merged, dropped.
