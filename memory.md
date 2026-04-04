---
author: anand pandit
created_at: 2026-04-04T08:29:52Z
updated_at: 2026-04-04T08:29:52Z
status: active
---

# Memory

## Purpose

This file is the reusable code registry for the current implementation. Entries should describe modules that are worth reusing instead of duplicating.

## Reusable Modules

### Project Store

- paths:
  - `src/store/projects.ts`
  - `src-tauri/src/lib.rs`
- responsibility: recent-project persistence and project path validation
- reuse_when:
  - loading recent projects
  - adding or removing a project
  - checking whether a path exists before frontend actions
- key_contracts:
  - `getProjects()`
  - `addProject(path)`
  - `removeProject(path)`
  - `checkPathExists(path)`
- last_analyzed_at: 2026-04-04T08:29:52Z

### Editor Workspace

- path: `src/modules/editor.ts`
- responsibility: Ace editor lifecycle, open tabs, autosave, formatting, lint integration, minimap integration, AI completion wiring
- reuse_when:
  - opening files from explorer or quick-open
  - applying editor settings
  - formatting supported files
  - enabling inline AI suggestions
- notable_dependencies:
  - `src/modules/ts-lint.ts`
  - `src/modules/minimap.ts`
  - `src/modules/ai-completer.ts`
- last_analyzed_at: 2026-04-04T08:29:52Z

### File Explorer

- path: `src/modules/file-explorer.ts`
- responsibility: recursive directory rendering, active file highlighting, context menu integration, targeted directory refresh
- reuse_when:
  - displaying project trees
  - refreshing a changed directory after file operations
- last_analyzed_at: 2026-04-04T08:29:52Z

### Settings System

- path: `src/modules/settings.ts`
- responsibility: app settings schema, defaults, persistence bridge, UI binding
- reuse_when:
  - adding new settings
  - reading AI provider configuration
  - reading agent access flags
- backend_contracts:
  - `load_settings`
  - `save_settings`
- last_analyzed_at: 2026-04-04T08:29:52Z

### Chat Session Persistence

- path: `src/modules/chat-store.ts`
- responsibility: IndexedDB persistence for chat sessions
- reuse_when:
  - storing new AI chat conversations
  - listing prior sessions
  - deleting session history
- last_analyzed_at: 2026-04-04T08:29:52Z

### Chatbot Client

- path: `src/modules/chatbot.ts`
- responsibility: chat UI, session switching, streaming/non-streaming provider calls, message rendering
- reuse_when:
  - adding a new provider
  - adjusting session behavior
  - reusing provider request patterns for other AI surfaces
- last_analyzed_at: 2026-04-04T08:29:52Z

### Source Control Panel

- paths:
  - `src/modules/source-control.ts`
  - `src-tauri/src/lib.rs`
- responsibility: git file status, staging, unstaging, discard, diff view, commit, AI commit message generation
- reuse_when:
  - exposing git actions in the UI
  - summarizing changed files
  - generating commit message prompts
- last_analyzed_at: 2026-04-04T08:29:52Z

### Terminal Panel

- path: `src/modules/terminal.ts`
- responsibility: xterm-based command console with command spawning, history, `cd`, `clear`, `exit`, and script execution handoff
- reuse_when:
  - executing project commands from UI
  - building features that need terminal visibility
- caution:
  - implementation is command-based via `sh -c`, not a true PTY
- last_analyzed_at: 2026-04-04T08:29:52Z

### Quick Open

- paths:
  - `src/modules/quick-open.ts`
  - `src-tauri/src/lib.rs`
- responsibility: recursive file search and keyboard-driven file opening
- reuse_when:
  - fast file navigation
  - search overlays that depend on file-path result lists
- last_analyzed_at: 2026-04-04T08:29:52Z

### Script Runner

- path: `src/modules/script-runner.ts`
- responsibility: read `package.json` scripts, infer package manager from lockfiles, run selected scripts through the terminal panel
- reuse_when:
  - surfacing project scripts without duplicating package-manager detection
- last_analyzed_at: 2026-04-04T08:29:52Z

### AI Completer

- path: `src/modules/ai-completer.ts`
- responsibility: idle-triggered suggestions, selected-code actions, editor-to-chat handoff
- reuse_when:
  - inline AI actions
  - contextual code transformations
  - sending selected code into the chat workflow
- last_analyzed_at: 2026-04-04T08:29:52Z

## Update Rule

Add a new entry when logic becomes reusable across features or when an existing reusable module changes materially.
