---
author: anand pandit
created_at: 2026-04-04T08:29:52Z
updated_at: 2026-04-04T08:29:52Z
status: active
---

# Definition

## Purpose

Athva Agent is a desktop developer workspace built with Tauri and vanilla TypeScript. It combines project navigation, file editing, AI-assisted coding, chat, source control, quick-open, and an embedded terminal in a single local-first application shell.

## Product Vision

- Provide a focused coding workspace for local project work.
- Keep the interface lightweight and modular rather than framework-heavy.
- Expose AI assistance inside the editor and chat without requiring a separate browser workflow.
- Preserve direct access to the local filesystem and git workflows through Tauri commands.

## Current Boundaries

- The app is a desktop client, not a hosted SaaS product.
- AI requests are sent directly from the frontend to provider APIs using user-supplied API keys.
- The Rust backend currently acts as a local command and filesystem bridge, not an AI proxy service.
- Source control support is git-focused and limited to the commands exposed in `src-tauri/src/lib.rs`.
- The terminal is command-execution based and is not a full PTY implementation.
- Project creation currently means selecting an existing directory path; repository scaffolding is not implemented.

## In Scope Today

- Recent project management
- File explorer and file editing
- Editor formatting and lint assistance
- Quick-open file search
- Embedded chat sessions with multiple providers
- Inline AI editing and suggestion actions
- Git status, staging, diff, commit, pull, push, sync
- Embedded terminal command execution
- Script runner based on `package.json` scripts
- Local settings persistence

## Out of Scope Until Explicitly Added

- Multi-user collaboration
- Cloud sync
- Server-side AI orchestration
- Full terminal emulation with long-lived PTY sessions
- Background indexing service beyond the current recursive quick-open search
- Automatic project scaffolding beyond opening a folder path

## Non-Negotiable Operating Principles

- DRY
- KISS
- No implementation without full understanding
- No task completion without verification
- No scope drift without user confirmation
- Do not modify stable working code for trivial stylistic reasons
- Documentation must reflect the current system state
