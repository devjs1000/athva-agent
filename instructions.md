---
author: anand pandit
created_at: 2026-04-04T08:29:52Z
updated_at: 2026-04-04T08:29:52Z
status: active
---

# Instructions

## Purpose

This file defines coding standards, architectural expectations, and modification rules for the Athva Agent repository.

## Core Standards

- Prefer simple implementations over abstract frameworks unless complexity is justified.
- Reuse existing modules before adding new ones.
- Understand the full call path before changing behavior.
- Verify behavior after changes; do not claim completion without evidence.
- Keep documentation synchronized with architecture and reusable logic.

## Code Modification Policy

- Do not alter trivial stylistic elements in stable code.
- Only modify existing code when required for functionality, architecture, bug fixing, or explicit user request.
- Refactoring must provide measurable clarity, reuse, or architectural improvement.
- Do not rewrite working code only to satisfy a naming or style preference.

### Trivial Changes To Ignore

- Single vs double quotes
- Semicolon addition or removal
- Whitespace-only formatting
- Cosmetic import reordering

## Naming Conventions For New Code

- Files: `kebab-case`
- Functions: `snake_case`
- Classes: `PascalCase`
- Components: `PascalCase`
- Folders: `PascalCase`

## Legacy Compatibility Rule

The current codebase predates some of the naming rules above and contains stable camelCase functions and lowercase folders such as `src/modules`. Preserve existing stable structures unless a functional change requires touching them. Apply these conventions to new code and new modules going forward.

## Architecture Practices

- Keep feature logic in focused modules under `src/modules` unless a clearer structure is introduced intentionally.
- Keep Tauri command definitions in Rust as the boundary for filesystem, git, and local OS integrations.
- Keep frontend modules responsible for DOM orchestration, state transitions, and provider API calls.
- Prefer explicit data contracts between TypeScript and Tauri commands.
- Register reusable logic in `memory.md` when it becomes a durable project primitive.

## Planning Requirements

Before substantial implementation, capture:

- Problem understanding
- Constraints
- Architecture approach
- Reusable components to use or extend
- Files to modify or create

## Refinement Sequence

- Architect review
- Designer review
- Developer review

For simple tasks these can be performed by a single agent mentally, but the checkpoints still apply.

## Documentation Rules

- Update `documentation.md` whenever architecture, command surfaces, reusable logic, setup steps, or behavior changes.
- Do not leave outdated notes behind after implementation.
- If a reusable module is introduced or materially changed, update `memory.md`.

## Verification Rules

A task cannot be marked complete if any of the following fail:

- Matches requirements
- No missing implementation
- No false completion
- No scope drift
- No unnecessary complexity
- No duplication of reusable logic
- No trivial stylistic churn
- Documentation updated when needed
- No outdated documentation remains
