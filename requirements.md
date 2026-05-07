---
author: anand pandit
created_at: 2026-04-04T08:29:52Z
updated_at: 2026-04-04T08:29:52Z
status: active
---

# Requirements

## Tracking Rules

- Every task entry must include author, created_at, updated_at, status, scope, and verification.
- Timestamps must use ISO 8601 UTC format.
- Scope changes require explicit user confirmation before implementation.
- A task is not complete until verification is recorded.

## Task Ledger

### REQ-2026-04-04-001

- title: Bootstrap mandatory governance and documentation markdown files
- author: anand pandit
- created_at: 2026-04-04T08:29:52Z
- updated_at: 2026-04-04T08:29:52Z
- status: completed
- requested_by: user
- scope:
  - Create missing root-level `definition.md`, `requirements.md`, `instructions.md`, `memory.md`, `notes.md`, `mindset.md`, and `documentation.md`
  - Base content on the actual current repository state
  - Do not change application behavior or stable implementation code
- constraints:
  - No trivial stylistic churn in existing code
  - Documentation must match the implemented system
  - Use git-config author fallback because explicit user author name was not provided
- verification:
  - Required files created at repo root
  - Content cross-checked against `package.json`, `src/main.ts`, major frontend modules, and `src-tauri/src/lib.rs`
  - No application source files modified for this task

## Active Requirement Format

Use this template for future entries:

```md
### REQ-YYYY-MM-DD-XXX
- title:
- author:
- created_at:
- updated_at:
- status: pending | in_progress | blocked | completed
- requested_by:
- scope:
- constraints:
- reusable_components:
- files_to_modify_or_create:
- verification:
```

### REQ-2026-05-07-001

- title: Add a current-state extension compatibility checklist for Athva
- author: anand pandit
- created_at: 2026-05-07T00:00:00Z
- updated_at: 2026-05-07T00:00:00Z
- status: completed
- requested_by: user
- scope:
  - Capture the current extension and IDE compatibility baseline in a dedicated checklist document
  - Link the checklist from the main architecture documentation
  - Avoid changing application behavior or in-flight extension implementation code
- constraints:
  - Keep claims conservative and grounded in the current repository
  - Do not overstate unsupported VS Code runtime, LSP, DAP, or webview capabilities
- reusable_components:
  - Existing extension architecture in `src/modules/extensions-panel.ts`, `src/modules/vscode-extension-support.ts`, `src/modules/extension-runtime.ts`
  - Existing architecture summary in `documentation.md`
- files_to_modify_or_create:
  - `extension-compatibility-checklist.md`
  - `documentation.md`
  - `requirements.md`
  - `todo.json`
- verification:
  - Checklist created with explicit implemented, partial, and unsupported markers
  - Main documentation linked to the new checklist
  - No application source files modified for this task
