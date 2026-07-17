# Claude Code-style Agent Loop — Design Spec

**Date:** 2026-07-18
**Scope:** Tier 1 core-loop quality overhaul of the Athva chat agent.
**Out of scope:** subagents, plan mode, slash commands/skills, checkpointing (future projects).

## Problem

The agent mangles edits (full-file overwrites only), loses context (file reads compressed to 1,400 chars in `compressToolResult`, session compaction at 4K tokens), wanders on multi-step tasks (no todo tracking), and runs on a one-sentence system prompt.

## Goals

1. Reliable, targeted file edits that self-correct on failure.
2. The model sees enough of a file to work on it, without blowing context.
3. Multi-step tasks tracked visibly and completed.
4. Behavior guided by a structured system prompt.

## Changes

### 1. `edit_file` tool

New tool in `NATIVE_AGENT_TOOLS` (`src/config/chatbot.ts`) and `executeTool` (`src/modules/chat-tool-executor.ts`).

Schema:
- `path` (string, required)
- `old_string` (string, required) — exact text to replace
- `new_string` (string, required)
- `replace_all` (string enum "true"/"false", optional, default "false")

Executor logic:
1. Requires `fileWrite` access; blocked-path checks same as `write_file`.
2. Read file via `read_file` invoke.
3. Count occurrences of `old_string`:
   - 0 → throw `Error("old_string not found in <path>. Re-read the file and copy the text exactly, without line-number prefixes.")`
   - >1 and not `replace_all` → throw `Error("old_string matches N times in <path>. Include more surrounding lines to make it unique, or set replace_all.")`
4. Replace, write via `write_file` invoke, call `ctx.onFileChanged(path)`.
5. Return a short unified-diff-style confirmation (± a few context lines) so the model can verify without re-reading.

`write_file` description updated: "Create a NEW file or fully replace one. For changes to existing files use edit_file."

### 2. Line-numbered `read_file` with offset/limit

- `read_file` schema gains optional `offset` (1-based start line, string-typed number) and `limit` (line count).
- Output format: `spaces + lineNo + "→" + line` (tab/arrow style), default window 800 lines from `offset` (default 1).
- If file continues past the window, append `…[file continues: N total lines. Call read_file with offset=<next> to continue.]`
- `batch_read` keeps plain output but its per-batch budget rises to 24,000 chars.
- System prompt instructs the model to strip the `lineNo→` prefix when constructing `old_string`.

### 3. Result-compression rebalance (`compressToolResult`)

| Tool | Old cap | New cap |
|------|---------|---------|
| read_file / batch_read | 1,400 chars | 12,000 chars, cut on line boundary, hint to use `offset` |
| run_command | 1,400 | 4,000 (head 2,500 + tail 1,500) |
| git_diff | 1,400 | 6,000 |
| search_content | 18 lines | 40 lines |
| search_files | 12 lines | 30 lines |
| list_dir | 24 lines | 50 lines |
| edit_file | — | pass through (already small) |
| default | 1,400 | 3,000 |

Constants in `src/config/chatbot.ts`:
- `AGENT_COMPACT_THRESHOLD_TOKENS`: 4,000 → 40,000
- `AGENT_KEEP_RECENT_MESSAGES`: 4 → 8
- `MAX_TURNS` (in `chatbot.ts`): 30 → 50

### 4. `todo_write` tool + loop discipline

Schema: `todos` — array of objects `{ content: string, status: "pending" | "in_progress" | "completed" }`. Each call replaces the whole list. Requires extending the `NativeToolDef` property type to allow object-items arrays (`items` may carry a nested `properties`/`required`). Provider adapters (`toAnthropicTools`, `toOpenAITools`) pass schemas through unchanged, so no adapter work.

- Available regardless of access flags (like `ask_user`).
- Executor stores the list on the session (`session.todos`) and returns a compact confirmation ("Todos updated: 1 done, 1 in progress, 3 pending").
- Chat panel renders the current list as a checklist card pinned above the input (reuse `todo-panel` styles where they fit); updates in place on each call.

Loop hardening in `runAgentLoop` (`src/modules/chatbot.ts`):
- Track consecutive turns where every tool call failed; after 3, abort with "Repeated tool failures — stopping. Last error: …".
- Tool errors continue to be returned as tool results (existing behavior), but error text is passed uncompressed so the corrective messages from `edit_file` survive.

### 5. System prompt rewrite

Replace `CHAT_SYSTEM_PROMPT` with a structured ~60-line prompt covering:
- Identity: Athva, an agentic coding assistant operating in the user's project.
- Workflow: understand the task → search (`search_content`/`search_files`) before reading; read only what's needed with offset/limit → for 3+ step tasks call `todo_write` first and keep exactly one item `in_progress` → make changes with `edit_file` (never rewrite whole files that exist) → verify with `run_command` (build/tests) after edits.
- Edit rules: `old_string` must match file text exactly; strip line-number prefixes; on failure, re-read and retry rather than falling back to `write_file`.
- Output rules: concise; reference `file:line`; report failures honestly; don't restate the request; ask the user (`ask_user`) only when genuinely blocked.

The `[Project Context]` and memory injection blocks remain appended as today.

## Not changing

Provider adapters and streaming (`streamAgentTurn`), permission/access model, session storage format (additive `todos` field only), legacy `chat-tool-parser` fallback for non-native providers (it inherits new tools automatically via `AGENT_TOOLS` mapping; `edit_file` multi-line args may be unreliable there — acceptable, native path is primary).

## Testing

- Unit tests (existing `tests/` setup) for: `edit_file` executor (found / not-found / ambiguous / replace_all), line-numbered read windowing, `compressToolResult` new caps, todo store round-trip.
- Manual smoke: multi-step task in a sample project — verify todos render, edits land, failed edit self-corrects, session survives past old 4K compaction point.

## Risks

- Small/local models may follow the richer prompt poorly — caps and error messages are designed to still guide them mechanically.
- Larger result caps raise token usage per turn; offset/limit and search-first prompt rules are the counterweight.
