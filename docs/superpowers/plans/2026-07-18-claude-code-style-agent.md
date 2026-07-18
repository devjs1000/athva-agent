# Claude Code-style Agent Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Athva chat agent edit files reliably, see enough context, and finish multi-step tasks — per spec `docs/superpowers/specs/2026-07-18-claude-code-style-agent-design.md`.

**Architecture:** Pure string logic (edit application, line-numbered reads, result compression) lives in a new dependency-free module `src/modules/agent-format.ts` so it is unit-testable under `node --test` (Tauri `invoke` cannot run in node). `chat-tool-executor.ts` wires those helpers to Tauri IO. `config/chatbot.ts` gains tool schemas and a new system prompt. `chatbot.ts` gains loop hardening and a todo card.

**Tech Stack:** TypeScript, Tauri 2 (`invoke`), node:test (`.mjs` tests importing `.ts` directly, as in `tests/split-layout.test.mjs`).

## Global Constraints

- Tests run with: `node --test tests/<file>.test.mjs` (if the runner rejects TS imports, add `--experimental-strip-types` — match whatever makes the two existing tests pass).
- Typecheck with: `npx tsc --noEmit` (repo has no test script; `build` runs `tsc` first).
- Git: stage specific files only; never `git add .`; no force push; no `--no-verify`.
- `ToolCall.args` is `Record<string, string>` — native providers may still deliver arrays/objects at runtime, so executors must handle `unknown` defensively (see existing `batch_read`).
- New tool names exactly: `edit_file`, `todo_write`. Existing names must not change.
- Do not touch: provider adapters/streaming, permission model semantics, `chat-tool-parser.ts`, session storage besides the additive `todos` field.

---

### Task 1: Pure edit logic — `applyEdit` + `buildEditPreview`

**Files:**
- Create: `src/modules/agent-format.ts`
- Test: `tests/agent-format.test.mjs`

**Interfaces:**
- Produces: `applyEdit(content: string, oldString: string, newString: string, replaceAll: boolean): { content: string; occurrences: number }` — throws `Error` on 0 matches or on >1 match when `replaceAll` is false. `buildEditPreview(updatedContent: string, newString: string, contextLines?: number): string` — line-numbered snippet of the first occurrence of `newString` ±3 lines (whole file numbered if `newString` empty/not found).

- [ ] **Step 1: Write the failing tests**

```js
// tests/agent-format.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { applyEdit, buildEditPreview } from "../src/modules/agent-format.ts";

test("applyEdit replaces a unique occurrence", () => {
  const r = applyEdit("const a = 1;\nconst b = 2;\n", "const b = 2;", "const b = 3;", false);
  assert.equal(r.content, "const a = 1;\nconst b = 3;\n");
  assert.equal(r.occurrences, 1);
});

test("applyEdit throws when old_string is missing, with guidance", () => {
  assert.throws(
    () => applyEdit("hello\n", "goodbye", "x", false),
    /not found.*Re-read the file.*line-number/is,
  );
});

test("applyEdit throws when ambiguous and replace_all is false", () => {
  assert.throws(
    () => applyEdit("a\na\n", "a", "b", false),
    /matches 2 times.*surrounding|unique|replace_all/is,
  );
});

test("applyEdit replaces all occurrences when replace_all is true", () => {
  const r = applyEdit("a\na\n", "a", "b", true);
  assert.equal(r.content, "b\nb\n");
  assert.equal(r.occurrences, 2);
});

test("applyEdit rejects identical old and new strings", () => {
  assert.throws(() => applyEdit("a\n", "a", "a", false), /identical/i);
});

test("buildEditPreview shows numbered context around the new text", () => {
  const content = "l1\nl2\nl3\nNEW\nl5\nl6\nl7\nl8\n";
  const preview = buildEditPreview(content, "NEW");
  assert.match(preview, /4→NEW/);
  assert.match(preview, /1→l1/);
  assert.match(preview, /7→l7/);
  assert.doesNotMatch(preview, /8→l8/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/agent-format.test.mjs`
Expected: FAIL — cannot find module `../src/modules/agent-format.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// src/modules/agent-format.ts
// Pure string helpers for the agent loop: edit application, line-numbered
// reads, and tool-result compression. No Tauri/DOM imports — unit-testable.

export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { content: string; occurrences: number } {
  if (oldString === newString) {
    throw new Error("old_string and new_string are identical — nothing to change.");
  }
  if (!oldString) {
    throw new Error("old_string must not be empty. To create a file, use write_file.");
  }
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) {
    throw new Error(
      "old_string not found in the file. Re-read the file and copy the text exactly — without line-number prefixes — including whitespace.",
    );
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `old_string matches ${occurrences} times. Include more surrounding lines to make it unique, or set replace_all to "true".`,
    );
  }
  const updated = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);
  return { content: updated, occurrences };
}

export function buildEditPreview(updatedContent: string, newString: string, contextLines = 3): string {
  const lines = updatedContent.split("\n");
  let start = 0;
  let end = lines.length;
  if (newString) {
    const idx = updatedContent.indexOf(newString);
    if (idx !== -1) {
      const startLine = updatedContent.slice(0, idx).split("\n").length - 1;
      const newLineCount = newString.split("\n").length;
      start = Math.max(0, startLine - contextLines);
      end = Math.min(lines.length, startLine + newLineCount + contextLines);
    }
  }
  return lines
    .slice(start, end)
    .map((line, i) => `${String(start + i + 1).padStart(5)}→${line}`)
    .join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agent-format.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` — expected: no errors.

```bash
git add src/modules/agent-format.ts tests/agent-format.test.mjs
git commit -m "feat: add pure edit-application helpers for agent edit_file tool"
```

---

### Task 2: Line-numbered read formatting

**Files:**
- Modify: `src/modules/agent-format.ts`
- Test: `tests/agent-format.test.mjs`

**Interfaces:**
- Produces: `formatLineNumberedRead(content: string, offset?: number, limit?: number): string` — `offset` is a 1-based start line (default 1), `limit` defaults to 800 lines. Output lines are `${lineNo.padStart(5)}→${text}`. If the file extends past the window, appends `…[file continues: N total lines. Call read_file with offset=<end+1> to continue.]`.

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-format.test.mjs` (add `formatLineNumberedRead` to the import):

```js
test("formatLineNumberedRead numbers lines from 1 by default", () => {
  const out = formatLineNumberedRead("a\nb\nc");
  assert.equal(out, "    1→a\n    2→b\n    3→c");
});

test("formatLineNumberedRead windows with offset and limit and adds continuation hint", () => {
  const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
  const out = formatLineNumberedRead(content, 3, 2);
  assert.match(out, /3→line3/);
  assert.match(out, /4→line4/);
  assert.doesNotMatch(out, /5→line5/);
  assert.match(out, /file continues: 10 total lines.*offset=5/);
});

test("formatLineNumberedRead clamps out-of-range offset", () => {
  const out = formatLineNumberedRead("a\nb", 99, 5);
  assert.match(out, /2→b/);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test tests/agent-format.test.mjs`
Expected: 3 new FAILs (`formatLineNumberedRead` not exported).

- [ ] **Step 3: Implement**

Append to `src/modules/agent-format.ts`:

```ts
export const READ_DEFAULT_LIMIT_LINES = 800;

export function formatLineNumberedRead(content: string, offset = 1, limit = READ_DEFAULT_LIMIT_LINES): string {
  const lines = content.split("\n");
  const total = lines.length;
  const start = Math.min(Math.max(1, Math.floor(offset) || 1), total);
  const count = Math.max(1, Math.floor(limit) || READ_DEFAULT_LIMIT_LINES);
  const end = Math.min(total, start + count - 1);
  const body = lines
    .slice(start - 1, end)
    .map((line, i) => `${String(start + i).padStart(5)}→${line}`)
    .join("\n");
  if (end < total) {
    return `${body}\n…[file continues: ${total} total lines. Call read_file with offset=${end + 1} to continue.]`;
  }
  return body;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agent-format.test.mjs`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/agent-format.ts tests/agent-format.test.mjs
git commit -m "feat: add line-numbered windowed read formatting"
```

---

### Task 3: Move and rebalance `compressToolResult`

**Files:**
- Modify: `src/modules/agent-format.ts` (add function), `src/modules/chat-tool-executor.ts:37-94` (delete the old implementation, re-export from agent-format), `src/modules/chatbot.ts` (import unchanged — it imports `compressToolResult` from `chat-tool-executor`; the re-export keeps that working)
- Test: `tests/agent-format.test.mjs`

**Interfaces:**
- Produces: `compressToolResult(toolName: string, result: string): string` — same signature as today, new caps: read_file/batch_read 12,000 chars (line-boundary cut + offset hint); run_command 4,000 (head 2,500 + tail 1,500); git_diff 6,000; search_content 40 lines; search_files 30 lines; list_dir 50 lines; edit_file/write_file/delete_path/make_plan/todo_write pass through; default 3,000.

- [ ] **Step 1: Add failing tests**

Append to `tests/agent-format.test.mjs` (import `compressToolResult`):

```js
test("compressToolResult passes reads under 12000 chars through", () => {
  const content = "x".repeat(11000);
  assert.equal(compressToolResult("read_file", content), `[read_file] ${content}`);
});

test("compressToolResult truncates big reads on a line boundary with offset hint", () => {
  const content = Array.from({ length: 2000 }, (_, i) => `line-${i}-padding-padding`).join("\n");
  const out = compressToolResult("read_file", content);
  assert.ok(out.length < 12400);
  assert.match(out, /truncated: 2000 total lines/);
  assert.match(out, /offset/);
});

test("compressToolResult keeps head and tail of long command output", () => {
  const content = "HEAD" + "x".repeat(6000) + "TAIL";
  const out = compressToolResult("run_command", content);
  assert.match(out, /^\[run_command\] HEAD/);
  assert.match(out, /TAIL$/);
  assert.ok(out.length < 4300);
});

test("compressToolResult passes edit_file results through unchanged", () => {
  const r = "Edited src/x.ts (1 replacement).\n    1→a";
  assert.equal(compressToolResult("edit_file", r), `[edit_file] ${r}`);
});

test("compressToolResult keeps 40 search_content lines", () => {
  const content = Array.from({ length: 60 }, (_, i) => `m${i}`).join("\n");
  const out = compressToolResult("search_content", content);
  assert.match(out, /m39/);
  assert.doesNotMatch(out, /m40\b/);
  assert.match(out, /20 more matches omitted/);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test tests/agent-format.test.mjs`
Expected: new FAILs (`compressToolResult` not exported from agent-format).

- [ ] **Step 3: Implement in agent-format.ts**

Append to `src/modules/agent-format.ts`:

```ts
export function compressToolResult(toolName: string, result: string): string {
  switch (toolName) {
    case "read_file":
    case "batch_read": {
      const CAP = 12000;
      if (result.length <= CAP) return `[${toolName}] ${result}`;
      const lineCount = result.split("\n").length;
      const truncated = result.substring(0, CAP);
      const lastNewline = truncated.lastIndexOf("\n");
      const clean = lastNewline > CAP - 400 ? truncated.substring(0, lastNewline) : truncated;
      const shownLines = clean.split("\n").length;
      return `[${toolName}] ${clean}\n…[truncated: ${lineCount} total lines. Call read_file with offset=${shownLines + 1} for the rest, or search_content for targeted access.]`;
    }

    case "run_command": {
      const CAP = 4000;
      if (result.length <= CAP) return `[${toolName}] ${result}`;
      const head = result.substring(0, 2500);
      const tail = result.substring(result.length - 1500);
      return `[${toolName}] ${head}\n…[${result.length} chars total, showing head+tail]…\n${tail}`;
    }

    case "git_diff": {
      const CAP = 6000;
      if (result.length <= CAP) return `[${toolName}] ${result}`;
      return `[${toolName}] ${result.substring(0, CAP)}\n…[diff truncated: ${result.length} chars total]`;
    }

    case "search_content": {
      const lines = result.split("\n");
      if (lines.length <= 40) return `[${toolName}] ${result}`;
      return `[${toolName}] ${lines.slice(0, 40).join("\n")}\n…[${lines.length - 40} more matches omitted]`;
    }

    case "search_files": {
      const paths = result.split("\n");
      if (paths.length <= 30) return `[${toolName}] ${result}`;
      return `[${toolName}] ${paths.slice(0, 30).join("\n")}\n…[${paths.length - 30} more files omitted]`;
    }

    case "list_dir": {
      const entries = result.split("\n");
      if (entries.length <= 50) return `[${toolName}] ${result}`;
      return `[${toolName}] ${entries.slice(0, 50).join("\n")}\n…[${entries.length - 50} more entries omitted]`;
    }

    case "edit_file":
    case "write_file":
    case "delete_path":
    case "make_plan":
    case "todo_write":
      return `[${toolName}] ${result}`;

    default: {
      const CAP = 3000;
      if (result.length <= CAP) return `[${toolName}] ${result}`;
      return `[${toolName}] ${result.substring(0, CAP)}\n…[truncated]`;
    }
  }
}
```

In `src/modules/chat-tool-executor.ts`, delete the entire old `compressToolResult` (the block from the `// ── Tool Result Compression ──` comment through the end of that function, lines 37–94) and add near the top:

```ts
export { compressToolResult } from "./agent-format";
```

- [ ] **Step 4: Run tests + typecheck**

Run: `node --test tests/agent-format.test.mjs` — expected PASS (14 tests).
Run: `npx tsc --noEmit` — expected: no errors (chatbot.ts still resolves `compressToolResult` via the re-export).

- [ ] **Step 5: Commit**

```bash
git add src/modules/agent-format.ts src/modules/chat-tool-executor.ts tests/agent-format.test.mjs
git commit -m "feat: rebalance tool-result compression caps and move to pure module"
```

---

### Task 4: `edit_file` tool — schema + executor

**Files:**
- Modify: `src/config/chatbot.ts` (tool def after `write_file`; `getToolDefsForAccess`), `src/modules/chat-tool-executor.ts` (new case in `executeTool`), `src/modules/chatbot.ts:1133-1135` (approval list)

**Interfaces:**
- Consumes: `applyEdit`, `buildEditPreview` from Task 1.
- Produces: tool `edit_file` with args `path`, `old_string`, `new_string`, `replace_all?` (strings; `replace_all` is `"true"`/`"false"`). Success result: `Edited <path> (<n> replacement(s)).\n<preview>`.

- [ ] **Step 1: Add the tool definition**

In `src/config/chatbot.ts`, insert into `NATIVE_AGENT_TOOLS` directly after the `write_file` entry:

```ts
  {
    name: "edit_file",
    description:
      "Replace an exact string in an existing file. Preferred over write_file for all changes to existing files. old_string must match the file text exactly (copy it from read_file output WITHOUT the line-number prefixes) and must be unique unless replace_all is \"true\".",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or project-relative file path." },
        old_string: { type: "string", description: "Exact existing text to replace, without line-number prefixes." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "string", description: "Set to \"true\" to replace every occurrence.", enum: ["true", "false"] },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
```

Update `write_file`'s description to:

```ts
    description: "Create a NEW file, or fully replace one when a rewrite is unavoidable. For changes to existing files use edit_file instead.",
```

In `getToolDefsForAccess`, change the write line to:

```ts
    if (["write_file", "edit_file", "delete_path"].includes(t.name)) return access.fileWrite;
```

- [ ] **Step 2: Add the executor case**

In `src/modules/chat-tool-executor.ts`, import from agent-format:

```ts
import { applyEdit, buildEditPreview } from "./agent-format";
```

Insert into the `switch` in `executeTool`, after the `write_file` case:

```ts
    case "edit_file": {
      if (!access.fileWrite) throw new Error("File write permission denied");
      if (isBlockedPath(tc.args.path)) throw new Error(`Blocked: editing "${tc.args.path}" is not allowed`);
      const original = await invoke<string>("read_file", { path: tc.args.path });
      const replaceAll = String(tc.args.replace_all || "false") === "true";
      const edited = applyEdit(original, String(tc.args.old_string ?? ""), String(tc.args.new_string ?? ""), replaceAll);
      await invoke("write_file", { path: tc.args.path, content: edited.content });
      ctx.onFileChanged(tc.args.path);
      const preview = buildEditPreview(edited.content, String(tc.args.new_string ?? ""));
      return `Edited ${tc.args.path} (${edited.occurrences} replacement${edited.occurrences === 1 ? "" : "s"}).\n${preview}`;
    }
```

- [ ] **Step 3: Require approval like other mutating tools**

In `src/modules/chatbot.ts` (`executeToolCalls`, currently lines 1133–1135), change the condition to:

```ts
      const needsApproval = !access.autoApprove && (
        tc.name === "write_file" || tc.name === "edit_file" || tc.name === "delete_path" || tc.name === "run_command"
      );
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` — expected: no errors.
Run: `node --test tests/agent-format.test.mjs` — expected: still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/chatbot.ts src/modules/chat-tool-executor.ts src/modules/chatbot.ts
git commit -m "feat: add edit_file tool with exact-match replacement and self-correcting errors"
```

---

### Task 5: `read_file` offset/limit + line numbers; `batch_read` budget

**Files:**
- Modify: `src/config/chatbot.ts` (read_file schema), `src/modules/chat-tool-executor.ts` (read_file case at ~line 387, `MAX_BATCH_SIZE` in batch_read)

**Interfaces:**
- Consumes: `formatLineNumberedRead` from Task 2.
- Produces: `read_file` output is line-numbered (`    N→text`); optional string args `offset`, `limit`.

- [ ] **Step 1: Update the schema**

In `src/config/chatbot.ts`, replace the `read_file` entry's properties/description:

```ts
  {
    name: "read_file",
    description:
      "Read a file with line numbers (format: '    N→text'; strip that prefix when quoting text for edit_file). Reads up to 800 lines from offset. Use batch_read for 2+ files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or project-relative file path to read." },
        offset: { type: "string", description: "Optional 1-based start line (default 1)." },
        limit: { type: "string", description: "Optional max lines to read (default 800)." },
      },
      required: ["path"],
    },
  },
```

- [ ] **Step 2: Update the executor**

In `src/modules/chat-tool-executor.ts`, add `formatLineNumberedRead` to the agent-format import, then replace the body of the `read_file` case:

```ts
    case "read_file": {
      if (!access.fileRead) throw new Error("File read permission denied");
      if (isBlockedPath(tc.args.path)) throw new Error(`Blocked: reading "${tc.args.path}" is not allowed (heavy, sensitive, or binary file)`);
      const content = await invoke<string>("read_file", { path: tc.args.path });
      if (content.trim().length === 0) {
        return "(empty or whitespace-only file)";
      }
      const offset = Number(tc.args.offset) || 1;
      const limit = Number(tc.args.limit) || undefined;
      return formatLineNumberedRead(content, offset, limit);
    }
```

In the `batch_read` case, change `const MAX_BATCH_SIZE = 15000;` to `const MAX_BATCH_SIZE = 24000;`.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` — expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/config/chatbot.ts src/modules/chat-tool-executor.ts
git commit -m "feat: line-numbered windowed read_file with offset/limit"
```

---

### Task 6: `todo_write` tool + todo card UI

**Files:**
- Modify: `src/config/chatbot.ts` (schema type extension + tool def), `src/modules/chat-store.ts` (session field + TodoItem type), `src/modules/chat-tool-executor.ts` (executor case + ctx hook), `src/modules/chatbot.ts` (ctx wiring + card render), `src/styles.css` (card styles)

**Interfaces:**
- Produces: `TodoItem = { content: string; status: "pending" | "in_progress" | "completed" }` exported from `chat-store.ts`; `ChatSession.todos?: TodoItem[]`; `ToolExecContext.setTodos?: (todos: TodoItem[]) => void`; tool `todo_write` with arg `todos` (array of TodoItem).

- [ ] **Step 1: Extend the schema type and add the tool def**

In `src/config/chatbot.ts`, widen `NativeToolDef`'s property type so array items can be objects:

```ts
export interface NativeToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
      items?: {
        type: string;
        properties?: Record<string, { type: string; description: string; enum?: string[] }>;
        required?: string[];
      };
    }>;
    required: string[];
  };
}
```

Add to `NATIVE_AGENT_TOOLS` (before `ask_user`):

```ts
  {
    name: "todo_write",
    description:
      "Create or update the task todo list. Call this at the start of any task with 3+ steps, and again whenever a step's status changes. Each call REPLACES the whole list. Keep exactly one item in_progress.",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The complete todo list.",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Short imperative description of the step." },
              status: { type: "string", description: "Step status.", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
```

In `getToolDefsForAccess`, make it always available (same line as ask_user):

```ts
    if (t.name === "ask_user" || t.name === "todo_write") return true;
```

Note: the legacy `AGENT_TOOLS` mapping at the bottom of the file maps over `input_schema.properties` descriptions only — it compiles unchanged with the widened type.

- [ ] **Step 2: Add the type and session field**

In `src/modules/chat-store.ts`:

```ts
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}
```

and in `ChatSession` add:

```ts
  todos?: TodoItem[];
```

- [ ] **Step 3: Executor case + ctx hook**

In `src/modules/chat-tool-executor.ts`, add to imports: `import type { TodoItem } from "./chat-store";` and to `ToolExecContext`:

```ts
  setTodos?: (todos: TodoItem[]) => void;
```

Add the case in `executeTool` (before `default`):

```ts
    case "todo_write": {
      const raw = tc.args.todos as unknown;
      let parsed: unknown = raw;
      if (typeof raw === "string") {
        try { parsed = JSON.parse(raw); } catch { throw new Error("todo_write: todos must be a JSON array of {content, status} objects"); }
      }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error("todo_write: todos must be a non-empty array of {content, status} objects");
      }
      const todos: TodoItem[] = parsed.map((t) => {
        const item = t as { content?: unknown; status?: unknown };
        const content = String(item.content || "").trim();
        const status = String(item.status || "pending");
        if (!content) throw new Error("todo_write: every todo needs non-empty content");
        if (!["pending", "in_progress", "completed"].includes(status)) {
          throw new Error(`todo_write: invalid status "${status}" (use pending | in_progress | completed)`);
        }
        return { content, status: status as TodoItem["status"] };
      });
      ctx.setTodos?.(todos);
      const done = todos.filter((t) => t.status === "completed").length;
      const active = todos.filter((t) => t.status === "in_progress").length;
      return `Todos updated: ${done} done, ${active} in progress, ${todos.length - done - active} pending.`;
    }
```

- [ ] **Step 4: Wire ctx and render the card in chatbot.ts**

In `src/modules/chatbot.ts`, find the `toolExecCtx()` method (it builds the `ToolExecContext` passed at line 1151) and add:

```ts
      setTodos: (todos) => {
        this.session.todos = todos;
        this.renderTodoCard();
        void saveSession(this.session);
      },
```

Add the render method to the class (import `TodoItem` type if needed):

```ts
  private renderTodoCard() {
    let card = document.getElementById("chat-todo-card");
    const todos = this.session.todos || [];
    if (todos.length === 0) { card?.remove(); return; }
    if (!card) {
      card = document.createElement("div");
      card.id = "chat-todo-card";
      const inputWrap = this.inputEl.parentElement;
      if (inputWrap) inputWrap.insertAdjacentElement("beforebegin", card);
      else this.messagesEl.insertAdjacentElement("afterend", card);
    }
    const icon = (s: string) => (s === "completed" ? "☑" : s === "in_progress" ? "▸" : "☐");
    card.innerHTML = todos
      .map((t) => `<div class="chat-todo-item chat-todo-${t.status}">${icon(t.status)} ${escapeHtml(t.content)}</div>`)
      .join("");
  }
```

(If `escapeHtml` doesn't already exist in chatbot.ts's imports, add a local one:)

```ts
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
```

Call `this.renderTodoCard()` from wherever the session is switched/loaded (the method that calls `renderMessages()` after loading a session — search for `renderMessages();` call sites in session-load paths), and clear stale todos at the start of a fresh user task: in the method that pushes the user message before `runAgentLoop` (line ~755), add `this.session.todos = []; this.renderTodoCard();`.

Add to `src/styles.css`:

```css
#chat-todo-card {
  margin: 6px 10px;
  padding: 6px 10px;
  border: 1px solid var(--border-color, #3a3a3a);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.9;
}
.chat-todo-completed { opacity: 0.55; text-decoration: line-through; }
.chat-todo-in_progress { font-weight: 600; }
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` — expected: no errors.
Run: `node --test tests/agent-format.test.mjs tests/split-layout.test.mjs` — expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/chatbot.ts src/modules/chat-store.ts src/modules/chat-tool-executor.ts src/modules/chatbot.ts src/styles.css
git commit -m "feat: add todo_write tool with pinned checklist card"
```

---

### Task 7: Loop hardening + context constants

**Files:**
- Modify: `src/config/chatbot.ts:5-8` (constants), `src/modules/chatbot.ts` (`runAgentLoop` at 932–1044)

**Interfaces:**
- Consumes: existing `results` entries — a failed call is identifiable by `r.tc.status === "error"`.

- [ ] **Step 1: Update constants**

In `src/config/chatbot.ts`:

```ts
export const AGENT_COMPACT_THRESHOLD_TOKENS = 40000;
export const AGENT_KEEP_RECENT_MESSAGES = 8;
```

In `src/modules/chatbot.ts` (`runAgentLoop`), change `const MAX_TURNS = 30;` to `const MAX_TURNS = 50;`.

- [ ] **Step 2: Consecutive-failure guard + uncompressed errors**

In `runAgentLoop`, add before the `while` loop:

```ts
    let consecutiveFailedTurns = 0;
```

Replace the tool-result persistence block (currently lines 1006–1015) with:

```ts
        // Persist tool results (errors uncompressed so corrective guidance survives)
        for (const { tc, result, denied } of results) {
          const errored = tc.status === "error";
          const compressed = denied
            ? `[${tc.name}] Denied by user.`
            : errored
              ? `[${tc.name}] Error: ${result}`
              : compressToolResult(tc.name, result);
          this.session.messages.push({
            role: "tool",
            content: compressed,
            toolCallId: tc.id,
            toolName: tc.name,
          });
        }
```

After the existing `const allDenied = ...` line (1021), add:

```ts
        const allFailed = results.length > 0 && results.every((r) => r.tc.status === "error" || r.denied);
        consecutiveFailedTurns = allFailed ? consecutiveFailedTurns + 1 : 0;
        if (consecutiveFailedTurns >= 3) {
          const lastErr = results[results.length - 1]?.result || "unknown error";
          const msg = `Stopping: 3 consecutive turns of failed tool calls. Last error: ${lastErr}`;
          this.addDOMMessage("assistant", msg);
          this.session.messages.push({ role: "assistant", content: msg });
          break;
        }
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` — expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/config/chatbot.ts src/modules/chatbot.ts
git commit -m "feat: harden agent loop — failure guard, uncompressed errors, larger context budget"
```

---

### Task 8: System prompt rewrite

**Files:**
- Modify: `src/config/chatbot.ts:3` (`CHAT_SYSTEM_PROMPT`)

- [ ] **Step 1: Replace the prompt**

```ts
export const CHAT_SYSTEM_PROMPT = `You are Athva, an agentic coding assistant working inside the user's project. You complete tasks end-to-end: investigate, plan, edit, verify.

## Workflow
1. Understand the task. Search first: use search_content / search_files to locate relevant code instead of reading whole files or listing directories speculatively.
2. Read only what you need: read_file returns line-numbered output ("    N→text") and accepts offset/limit — use them for large files instead of re-reading from the top.
3. For any task with 3 or more steps, call todo_write FIRST with the full step list. Update it as you work. Keep exactly one item in_progress; mark items completed immediately when done.
4. Make changes with edit_file. Never rewrite an existing file with write_file when an edit would do; write_file is for new files only.
5. After changing code, verify: run the project's build, tests, or a quick command with run_command. Report the actual result.

## Editing rules
- old_string must match the file byte-for-byte. Copy it from read_file output and STRIP the line-number prefix ("    N→").
- If edit_file reports "not found" or "matches N times", re-read the exact region and retry with more surrounding context. Do NOT fall back to write_file.
- Preserve the file's existing indentation, naming, and style.

## Output rules
- Be concise. Lead with what you did or found; no restating the request, no narrating tool use.
- Reference code as path:line.
- Report failures honestly — if a command or test fails, show the error; never claim success without verification.
- Use ask_user only when genuinely blocked on a decision you cannot resolve from the project itself; batch questions into one call.`;
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` — expected: no errors.
Run: `node --test tests/agent-format.test.mjs tests/split-layout.test.mjs tests/vscode-shim-compatibility.test.mjs` — expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/config/chatbot.ts
git commit -m "feat: structured agentic system prompt with workflow and edit rules"
```

---

### Task 9: Manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Launch the app**

Run: `pnpm tauri dev` (or `pnpm dev` for browser-only UI checks).

- [ ] **Step 2: Exercise the loop**

In agent mode on a sample project, ask for a small multi-step change (e.g. "rename function X to Y across the project and add a doc comment"). Verify:
- A todo card appears above the input and updates as steps complete.
- Changes land via `edit_file` (approval prompt appears when autoApprove is off), not full-file writes.
- Deliberately induce an edit failure (edit a file, then ask for another change referencing stale text) — the agent re-reads and retries.
- Long file reads show line numbers and a continuation hint.

- [ ] **Step 3: Report results to the user before claiming completion**
