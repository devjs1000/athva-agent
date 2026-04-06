---
author: system
created_at: 2026-04-07T00:00:00Z
updated_at: 2026-04-07T00:00:00Z
status: active
---

# Learnings

Session knowledge and mistake-prevention rules accumulated during development.

## LEARN-2026-04-07-001

- context: Execution protocol bootstrap
- lesson: All protocol files (symbol_index.json, dependency.json, patterns.json, todo.json) must exist before execution begins. Missing governance files block deterministic operation.
- rule: Check for protocol files at session start. Rebuild any that are missing or stale.
