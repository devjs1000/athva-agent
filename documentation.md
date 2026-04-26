---
author: anand pandit
created_at: 2026-04-04T08:29:52Z
updated_at: 2026-04-04T08:29:52Z
status: active
---

# Documentation

## Architecture Overview

Athva Agent is a Tauri desktop application with a vanilla TypeScript frontend and a Rust backend command layer.

- Frontend entry point: `src/main.ts`
- Frontend responsibilities:
  - page orchestration
  - module composition
  - editor/chat/source-control/terminal UI behavior
  - direct AI provider HTTP calls from the renderer
- Backend responsibilities:
  - recent project persistence
  - settings persistence
  - filesystem operations
  - recursive file search
  - git command execution
  - platform-specific reveal-in-explorer behavior

## Module Descriptions

### Frontend Modules

- `src/main.ts`: bootstraps the workspace, wires page state, and connects modules together.
- `src/modules/editor.ts`: Ace editor wrapper with tabs, autosave, formatting, linting, minimap support, HTML/JSX/TSX Emmet expansion, delayed TypeScript hover info, AI completion hooks, and the custom completion surface wiring.
- `src/modules/custom-autocomplete.ts`: custom completion popup and inline preview layer that reuses Ace completers while filtering member-access contexts to relevant object/property completions.
- `src/modules/file-explorer.ts`: renders project trees and integrates the file context menu.
- `src/modules/settings.ts`: defines app settings types/defaults and binds the settings UI, including persisted workspace action placements across titlebar, side rails, and status bar zones.
- `src/modules/chatbot.ts`: manages chat sessions and provider API calls, including rolling agent-history compaction and capped project/session context to keep token use stable.
- `src/modules/chat-store.ts`: stores chat sessions in IndexedDB.
- `src/modules/quick-open.ts`: keyboard-driven file search overlay.
- `src/modules/source-control.ts`: git UI for stage/unstage/discard/diff/commit and AI commit messages.
- `src/modules/terminal.ts`: xterm-based command runner with command history and basic shell conveniences.
- `src/modules/script-runner.ts`: lists package scripts plus built-in run options such as Live Server, and executes them through the terminal.
- `src/modules/snippets-panel.ts`: renders the snippets sidebar, supports custom snippet authoring, and inserts snippets with live tabstops.
- `src/modules/snippet-store.ts`: merges built-in, global, and project snippets, persists custom snippets, and exposes custom snippet autocomplete data with explicit JSX/TSX category matching.
- `src/modules/ai-completer.ts`: selected-code actions and typing-triggered, cursor-anchored idle AI suggestions.
- `src/modules/exports-tracker.ts`: indexes project exports, powers custom auto-imports, resolves definitions/hover quick-info via TypeScript, and suggests installed package names plus object members in relevant contexts.
- `src/modules/quality-core.ts`: reusable static-analysis engine that parses JS/TS files, computes naming/import/complexity/quality/type/architecture/dependency/security metrics, and returns a JSON quality report. The quality config supports per-category naming expectations for files, functions, variables, classes, and constants in addition to complexity and length thresholds.
- `src/modules/quality-panel.ts`: workspace-side quality dashboard that scans the current project, runs the quality engine in a worker, renders actionable findings, provides a guided project-level config flow saved to `.athva/quality-panel.json`, includes score/severity charts, and supports click-through navigation from section cards into detailed issue sections.
- `src/modules/extensions-panel.ts`: presents Installed, Recommended, and Search tabs for Visual Studio Marketplace extensions, shows a detail view for the selected extension, and installs or uninstalls global VSIX packages for Athva.
- `src/modules/ts-lint.ts`: TypeScript worker bridge for editor diagnostics.

### Backend Modules

- `src-tauri/src/lib.rs`: all Tauri commands and application startup.
- `src-tauri/src/main.rs`: thin executable entry that delegates to `athva_agent_lib::run()`.

## Data Flow

### Workspace Initialization

1. `DOMContentLoaded` in `src/main.ts`
2. Load persisted settings via `load_settings`
3. Construct editor, explorer, chat, git, terminal, script runner, and quick-open modules
4. Render recent projects via `get_projects`

### Project Opening

1. User selects a directory from the welcome page
2. Frontend calls `add_project(path)`
3. Frontend sets current project state
4. Explorer loads the root directory
5. Quick-open, git status, source control, terminal, and script runner all receive the project path
6. Quality Panel can scan the opened workspace on demand without executing project code
7. Workspace action buttons are rendered into their saved IDE positions across the titlebar, side rails, and status bar and can be repositioned individually

### File Editing

1. Explorer or quick-open selects a file
2. Editor calls `read_file`
3. Content opens in an Ace tab
4. On change, the editor updates tab state and autosaves via `write_file`
5. TypeScript-family files run worker-based diagnostics

### Chat

1. Chat messages are stored in `chat-store`
2. Frontend reads AI settings from the settings module
3. Provider calls are made directly from the renderer using `fetch`
4. Responses are streamed for supported providers and appended to the active session

### Source Control

1. Source control panel polls changed files every 5 seconds while visible
2. Frontend requests git state through Tauri commands
3. User actions call git stage/unstage/discard/commit commands
4. Diff views are rendered in the frontend from backend-returned text

## API Contracts

### Tauri Commands

- `get_projects() -> ProjectsStore`
- `add_project(path: String) -> Project`
- `remove_project(path: String) -> ()`
- `check_path_exists(path: String) -> bool`
- `read_dir(path: String) -> Result<Vec<FileEntry>, String>`
- `read_file(path: String) -> Result<String, String>`
- `write_file(path: String, content: String) -> Result<(), String>`
- `create_file(path: String) -> Result<(), String>`
- `create_dir(path: String) -> Result<(), String>`
- `rename_path(old_path: String, new_path: String) -> Result<(), String>`
- `delete_path(path: String) -> Result<(), String>`
- `reveal_in_explorer(path: String) -> Result<(), String>`
- `search_files(root: String, query: String, max_results: usize) -> Vec<FileEntry>`
- `git_status(path: String) -> GitStatus`
- `git_sync(path: String) -> Result<String, String>`
- `git_pull(path: String) -> Result<String, String>`
- `git_push(path: String) -> Result<String, String>`
- `git_changed_files(path: String) -> Result<Vec<GitFileChange>, String>`
- `git_stage(path: String, file: String) -> Result<String, String>`
- `git_unstage(path: String, file: String) -> Result<String, String>`
- `git_stage_all(path: String) -> Result<String, String>`
- `git_unstage_all(path: String) -> Result<String, String>`
- `git_discard_file(path: String, file: String) -> Result<String, String>`
- `git_commit(path: String, message: String) -> Result<String, String>`
- `git_diff_stat(path: String) -> Result<String, String>`
- `git_diff_file(path: String, file: String, staged: bool) -> Result<String, String>`
- `load_settings(app: tauri::AppHandle) -> String`
- `save_settings(app: tauri::AppHandle, settings: String) -> Result<(), String>`
- `search_vscode_extensions(query: String, limit: usize) -> Result<Vec<MarketplaceExtension>, String>`
- `list_installed_vscode_extensions(project_path: String) -> Result<Vec<InstalledExtension>, String>`: currently ignores `project_path` and reads the global Athva extension store
- `install_vscode_extension(project_path: String, publisher: String, extension_name: String, version: String, download_url: Option<String>) -> Result<InstalledExtension, String>`: currently ignores `project_path` and installs into the global Athva extension store
- `uninstall_vscode_extension(identifier: String) -> Result<(), String>`

## Reusable Components Overview

Primary reusable logic is tracked in `memory.md`. The current high-value reusable modules are:

- editor workspace
- settings system
- project store
- source control panel
- terminal panel
- quick open
- file explorer
- chatbot and chat-store
- script runner
- snippets panel
- snippet store
- AI completer
- exports tracker
- custom autocomplete
- quality analysis engine

## Setup Instructions

### Prerequisites

- Node.js compatible with the installed Vite/Tauri toolchain
- Rust toolchain for Tauri native builds
- Tauri system prerequisites for the current operating system

### Install And Run

```bash
pnpm install
pnpm tauri dev
```

### Frontend-Only Build

```bash
pnpm build
```

### Quality Report CLI

```bash
pnpm quality:analyze <project-path> --output /tmp/quality-report.json
```

Optional custom config:

```bash
pnpm quality:analyze <project-path> --config /path/to/quality-config.json --output /tmp/quality-report.json
```

## Environment Requirements

- The app currently stores recent projects and settings through the Tauri app config directory.
- Chat and AI-assisted git messaging require a provider API key configured in the app settings.
- Network access is only required for provider API calls; core editing and local project workflows are local.
- The terminal and git features depend on the host environment having the relevant binaries available.
- VS Code marketplace search/install also depend on host tooling: `curl` plus `unzip` on macOS/Linux, or PowerShell archive extraction on Windows.

## Known Implementation Constraints

- The terminal uses spawned shell commands, not a true PTY session.
- AI provider requests originate in the frontend, so API keys are present in renderer-managed settings.
- Quick-open relies on recursive search from the backend and excludes common heavy directories such as `node_modules`, `dist`, `target`, `.git`, `build`, and `__pycache__`.
- Downloaded VS Code extensions are stored in Athva's global app data directory, but Athva does not host or execute VS Code extensions at runtime.
- Workspace action placement is configured in-app via per-button move menus and persisted in settings rather than project files, and placements attach to real IDE chrome regions instead of floating overlays.
- The repository README is still minimal and does not yet replace this file as authoritative technical documentation.
