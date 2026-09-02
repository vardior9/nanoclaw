---
schedule: '17 6 * * *'
script: |
  shopt -s nullglob
  notes=(/workspace/agent/memory/inbox/*.md)
  if (( ${#notes[@]} == 0 )); then
    printf '{"wakeAgent":false}\n'
  else
    printf '{"wakeAgent":true,"data":{"noteCount":%d}}\n' "${#notes[@]}"
  fi
---

Consolidate the PR-review memory inbox in a fresh model thread.

You are the single writer for curated memory; PR sessions only append to `memory/inbox/`. The pre-task gate wakes you only when notes exist. Process exactly the current inbox snapshot.

For each inbox note:

- Generic review lesson → merge into the appropriate curated file under `memory/` (create one per theme, one concept per file, per `memory/system/definition.md`). Skip anything PR-specific — GitHub is the audit trail.
- Durable repo fact (conventions, layout, build quirks) → merge into `memory/repos/<owner>__<repo>.md`.
- Duplicate, PR-specific, runtime-specific, or already-curated → drop it.

Rewrite for concision as you merge; a lesson that contradicts an existing one replaces it with the newer insight. Update `memory/index.md` so every curated file is findable. Delete each inbox file once processed. Finish with `<internal>processed=<n> merged=<n> dropped=<n></internal>` and no user-visible message.
