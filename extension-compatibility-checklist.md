# Extension Compatibility Checklist

Current baseline: 2026-05-07

Legend:
- `[x]` implemented in Athva today
- `[~]` partial or limited support
- `[ ]` not implemented

This file describes current code-level support in Athva. It is intentionally conservative: items stay unchecked unless the implementation is explicit in the current repository.

## Core Extension Host

- `[~]` VS Code extension API layer
- `[ ]` Open VSX registry support
- `[~]` VSIX manual installation
- `[ ]` Extension enable/disable
- `[ ]` Workspace-specific extensions
- `[x]` Global extensions
- `[ ]` Hot reload extension activation
- `[ ]` Sandboxed extension runtime
- `[~]` Extension crash isolation
- `[ ]` Extension dependency resolution
- `[~]` Extension host process monitoring
- `[~]` Multiple extension host support
- `[ ]` Web extension compatibility
- `[ ]` Native node module compatibility
- `[ ]` Extension permission system

## Language Support

### Language Servers (LSP)

- `[ ]` Full LSP protocol support
- `[ ]` Incremental sync
- `[ ]` Semantic tokens
- `[ ]` Inlay hints
- `[~]` Hover providers
- `[ ]` Code actions
- `[ ]` Rename symbol
- `[ ]` Find references
- `[ ]` Go to definition
- `[ ]` Go to implementation
- `[x]` Signature help
- `[~]` Diagnostics
- `[ ]` Workspace symbols
- `[ ]` Document symbols
- `[ ]` Folding ranges
- `[x]` Formatting support
- `[ ]` Range formatting
- `[ ]` Code lens
- `[ ]` Call hierarchy
- `[ ]` Type hierarchy
- `[ ]` Notebook support

### Debug Adapter Protocol

- `[ ]` DAP support
- `[ ]` Breakpoints
- `[ ]` Conditional breakpoints
- `[ ]` Logpoints
- `[ ]` Watch expressions
- `[ ]` Variable inspection
- `[ ]` Stack traces
- `[ ]` Multi-thread debugging
- `[ ]` Remote debugging
- `[ ]` Attach mode
- `[ ]` Debug console
- `[ ]` Inline values

## Editor APIs

### Text Editor

- `[ ]` Decorations API
- `[x]` Inline completions
- `[x]` Ghost text
- `[x]` Snippet API
- `[ ]` Multi cursor APIs
- `[~]` Diff editor APIs
- `[x]` Minimap APIs
- `[ ]` Folding APIs
- `[ ]` Sticky scroll support
- `[ ]` Peek view APIs
- `[ ]` Breadcrumb APIs
- `[ ]` Selection APIs
- `[x]` Undo/redo integration
- `[ ]` Workspace edit APIs

### Monaco Compatibility

- `[ ]` Monaco extension bridge
- `[ ]` Monaco commands support
- `[x]` Monaco themes support
- `[x]` Monaco tokenization support
- `[ ]` Monaco semantic highlighting
- `[ ]` TextMate grammar support
- `[ ]` Tree-sitter support
- `[ ]` Bracket pair colorization

## AI Extension Compatibility

### AI APIs

- `[x]` Inline AI completions
- `[x]` AI chat panel integration
- `[~]` Context sharing APIs
- `[~]` Embedding support
- `[x]` Streaming responses
- `[x]` Tool calling support
- `[~]` Agent mode APIs
- `[x]` File context APIs
- `[~]` Terminal context APIs
- `[x]` Git context APIs
- `[~]` Diagnostics context APIs
- `[~]` Multi-file edit APIs

### Compatibility Targets

- `[ ]` GitHub Copilot compatibility
- `[ ]` Continue.dev compatibility
- `[ ]` Cline compatibility
- `[ ]` Roo Code compatibility
- `[ ]` Claude Code integration
- `[ ]` Cursor-style APIs
- `[ ]` OpenAI extension support

## Terminal Compatibility

### Terminal APIs

- `[x]` Integrated terminal API
- `[ ]` Pseudo terminal support
- `[~]` Shell integration
- `[x]` Terminal link providers
- `[ ]` Terminal decorations
- `[ ]` Persistent sessions
- `[ ]` Split terminals
- `[~]` Background tasks
- `[x]` ANSI color support
- `[ ]` PTY compatibility

### Shell Support

- `[ ]` Bash
- `[x]` Zsh
- `[ ]` Fish
- `[ ]` PowerShell
- `[ ]` CMD
- `[ ]` Nushell

## Git & SCM Compatibility

### Source Control APIs

- `[ ]` SCM provider APIs
- `[ ]` Git decorations
- `[ ]` Inline blame
- `[x]` Diff APIs
- `[x]` Commit APIs
- `[x]` Branch APIs
- `[~]` Merge conflict APIs
- `[ ]` Git hooks support
- `[x]` Staging APIs
- `[ ]` Multi repo support
- `[ ]` Large repo optimization

### Compatibility Targets

- `[ ]` GitLens compatibility
- `[ ]` Git Graph compatibility
- `[ ]` Conventional commits extensions
- `[ ]` GitHub Pull Request extension

## UI Extension Compatibility

### Panels & Views

- `[~]` Activity bar APIs
- `[~]` Sidebar APIs
- `[ ]` Bottom panel APIs
- `[~]` Webview APIs
- `[ ]` Custom editors
- `[~]` Tree view APIs
- `[ ]` Status bar APIs
- `[x]` Notification APIs
- `[~]` Progress APIs
- `[ ]` Welcome page APIs
- `[ ]` Walkthrough APIs

### Webview Support

- `[ ]` iframe isolation
- `[ ]` CSP support
- `[ ]` Message bridge
- `[ ]` Theme sync
- `[ ]` Persistent state
- `[ ]` Webview lifecycle management

## Theme Compatibility

### Themes

- `[x]` VS Code themes
- `[x]` JSON theme parsing
- `[~]` Semantic highlighting
- `[x]` Dynamic theme switching
- `[x]` Icon themes
- `[x]` File icon themes
- `[ ]` Product icon themes
- `[ ]` Custom font support

### Compatibility Targets

- `[ ]` Dracula
- `[ ]` One Dark Pro
- `[ ]` Catppuccin
- `[ ]` Tokyo Night
- `[ ]` Material Theme
- `[ ]` GitHub Theme

## Keybinding Compatibility

### Keyboard APIs

- `[ ]` VS Code keybinding JSON support
- `[ ]` Chord shortcuts
- `[ ]` Context-aware shortcuts
- `[ ]` Vim mode support
- `[ ]` Emacs mode support
- `[ ]` Custom keyboard layouts
- `[~]` Command palette integration

### Compatibility Targets

- `[ ]` VSCodeVim
- `[ ]` IdeaVim-like behavior
- `[ ]` Emacs extensions

## File System Compatibility

### File APIs

- `[~]` Workspace FS APIs
- `[ ]` Virtual filesystem support
- `[ ]` Remote filesystem support
- `[~]` Watcher APIs
- `[ ]` Symlink support
- `[ ]` Large file optimization
- `[x]` Binary file handling

### Remote Development

- `[ ]` SSH remote support
- `[ ]` Docker remote support
- `[ ]` WSL support
- `[ ]` Container workspaces
- `[ ]` Cloud workspace support

## Build & Task System

### Task APIs

- `[ ]` Task runner APIs
- `[~]` Background task support
- `[ ]` Problem matcher support
- `[ ]` Compound tasks
- `[ ]` Custom task providers
- `[ ]` Workspace tasks
- `[~]` Auto detected tasks

## Performance & Stability

### Performance

- `[~]` Lazy extension loading
- `[ ]` Extension startup profiling
- `[~]` Memory isolation
- `[ ]` Extension CPU throttling
- `[~]` Large workspace optimization
- `[ ]` Incremental indexing
- `[~]` Smart caching

### Stability

- `[ ]` Crash recovery
- `[ ]` Safe mode
- `[ ]` Extension watchdog
- `[~]` Corrupted extension recovery
- `[ ]` Workspace recovery
- `[ ]` Auto backup

## Security

### Security Features

- `[ ]` Workspace trust
- `[ ]` Extension permission prompts
- `[ ]` Restricted mode
- `[ ]` Sandboxed execution
- `[ ]` Secure secret storage
- `[ ]` Credential manager integration
- `[~]` File access restrictions

## Advanced Features

### Advanced IDE Features

- `[ ]` Multi-root workspaces
- `[ ]` Workspace profiles
- `[ ]` Settings sync
- `[ ]` Extension sync
- `[ ]` Live collaboration
- `[ ]` Pair programming
- `[ ]` Voice commands
- `[x]` AI-assisted refactoring
- `[x]` AI code review APIs
- `[x]` AI-generated fixes

## Marketplace Compatibility

### Marketplace

- `[ ]` OpenVSX integration
- `[x]` VS Marketplace compatibility layer
- `[x]` Extension ratings
- `[ ]` Auto updates
- `[ ]` Dependency auto install
- `[ ]` Signed extensions
- `[ ]` Verified publishers

## High Priority Extensions To Test

### Must Work

- `[ ]` Prettier
- `[ ]` ESLint
- `[ ]` GitLens
- `[ ]` Docker
- `[ ]` Tailwind CSS
- `[ ]` Prisma
- `[ ]` Thunder Client
- `[ ]` REST Client
- `[ ]` Code Spell Checker
- `[ ]` Path Intellisense
- `[ ]` npm Intellisense
- `[ ]` Error Lens
- `[ ]` Better Comments
- `[ ]` TODO Tree
- `[ ]` Live Server

### AI Extensions

- `[ ]` GitHub Copilot
- `[ ]` Continue
- `[ ]` Cline
- `[ ]` Roo Code
- `[ ]` CodeGPT
- `[ ]` Tabnine
- `[ ]` Supermaven

### Language Extensions

- `[ ]` TypeScript
- `[ ]` Python
- `[ ]` Rust Analyzer
- `[ ]` Go
- `[ ]` Java
- `[ ]` C/C++
- `[ ]` PHP Intelephense
- `[ ]` Kotlin
- `[ ]` Dart/Flutter

## Enterprise-Level Compatibility Goals

- `[ ]` 90% VS Code extension compatibility
- `[ ]` Zero-config extension installs
- `[ ]` Sub-100ms extension activation
- `[ ]` Massive monorepo stability
- `[ ]` Multi-million file indexing
- `[ ]` AI-native extension APIs
- `[ ]` Sandboxed untrusted extensions
- `[ ]` Native GPU rendering
- `[ ]` Full offline support
- `[ ]` Deterministic extension execution
- `[ ]` Cross-platform parity
- `[ ]` Mobile/tablet future support

## Notes

- Athva currently installs extensions into a global app data store and imports a narrow subset of VSIX contributions: color themes, file icon themes, snippets, command metadata, view metadata, and some tree-view runtime behavior.
- Athva is a Tauri-based desktop app with embedded webviews and a bridged extension host, so Codex splash/loading failures should be triaged as Tauri webview or app-server compatibility issues first, not as Electron-only behavior.
- Athva does not currently provide a full VS Code extension host, LSP client, DAP client, webview container, workspace trust model, or extension permission model.
- The unchecked extension target lists above are intentionally left as test backlog items, not negative judgments about individual extensions.
