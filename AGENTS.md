---
author: anand pandit
created_at: 2026-04-07T00:00:00Z
updated_at: 2026-04-07T00:00:00Z
status: active
---

# Execution Protocol — Athva Agent

## Core Model (Mandatory)

All operations MUST follow: **Plan → Batch → Compress → Execute → Output**

## 1. Planning (Mandatory — Every Task)

- Create a 5–10 step plan before any implementation
- Identify tools, files, and data size upfront
- Batch operations before execution
- No execution without a plan

## 2. Tool-First Approach

- Use tools instead of chat for data retrieval
- Never ask user for file content — read it
- No intermediate data exposure in output
- Use `symbol_index.json` for function-level jumps
- Use `dependency.json` to avoid rediscovery

## 3. Batch Operations

| Data Size | Strategy |
|-----------|----------|
| < 10KB | Batch read all at once |
| 10–50KB | Chunk into groups |
| > 50KB | Partial read — relevant sections only |

- Batch: reads, tool calls, updates
- Avoid sequential execution when parallel is possible

## 4. Compression Layer (Mandatory)

Before processing, compress all inputs into:

```json
{
  "goal": "",
  "key_points": [],
  "entities": [],
  "relevant_files": []
}
```

Use compressed context — never raw context.

## 5. Delta-Based Access

- Use `git diff` / hashing before reading files
- Read only changed sections
- Skip unchanged files entirely
- Check `symbol_index.json` hashes before re-indexing

## 6. Function-Level Access

- Use `symbol_index.json` to jump directly to functions
- Avoid full file reads — read specific line ranges
- Use grep for targeted symbol lookup

## 7. Cache System

- `symbol_index.json` stores file hash + extracted symbols
- Reuse cached data if file hash unchanged
- Rebuild only stale entries

## 8. Output Rules

Return ONLY:
- Final result
- Minimal explanation (1–2 lines)
- Diffs (not full code blocks)

Avoid:
- Summaries of what was read
- Intermediate state dumps
- Restating the user's request

## 9. Search Strategy

- Always use multi-query search (parallel grep/glob)
- Avoid broad, exploratory queries
- Prefer `symbol_index.json` lookup over file search

## 10. Context Limits

- Max 5–8 files per operation
- Max ~30–50KB active context
- Prefer minimal data — early exit at ≥80% confidence

## 11. Git Governance

Before ANY git action:
- Ask user for confirmation
- State reason + affected files
- Review diff first

Rules:
- No `git add .` or `git add -A`
- No force push
- No `--no-verify`
- Stage specific files only

## 12. Session Tracking

| File | Purpose |
|------|---------|
| `todo.json` | Current task tracking |
| `learnings.md` | Session knowledge + mistake prevention |
| `patterns.json` | Reusable execution patterns |
| `symbol_index.json` | Function/class index with file hashes |
| `dependency.json` | Package + internal dependency map |

## 13. Strictly Avoid

- Executing without a plan
- Full project reads
- Repeated reads of same file
- Unnecessary tool calls
- Exploratory/speculative access
- Reading files already in context

## 14. References

- [instructions.md](instructions.md) — Coding standards + modification policy
- [mindset.md](mindset.md) — Operating lessons
- [memory.md](memory.md) — Reusable logic registry
- [documentation.md](documentation.md) — Architecture docs
