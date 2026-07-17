import test from "node:test";
import assert from "node:assert/strict";

import { applyEdit, buildEditPreview, formatLineNumberedRead, compressToolResult } from "../src/modules/agent-format.ts";

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

test("applyEdit replaces a unique occurrence", () => {
  const r = applyEdit("const a = 1;\nconst b = 2;\n", "const b = 2;", "const b = 3;", false);
  assert.equal(r.content, "const a = 1;\nconst b = 3;\n");
  assert.equal(r.occurrences, 1);
});

test("applyEdit throws when old_string is missing, with guidance", () => {
  assert.throws(
    () => applyEdit("hello\n", "goodbye", "x", false),
    /not found[\s\S]*Re-read the file[\s\S]*line-number/i,
  );
});

test("applyEdit throws when ambiguous and replace_all is false", () => {
  assert.throws(
    () => applyEdit("a\na\n", "a", "b", false),
    /matches 2 times[\s\S]*(surrounding|unique|replace_all)/i,
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
  assert.match(out, /file continues: 10 total lines[\s\S]*offset=5/);
});

test("formatLineNumberedRead clamps out-of-range offset", () => {
  const out = formatLineNumberedRead("a\nb", 99, 5);
  assert.match(out, /2→b/);
});

test("buildEditPreview shows numbered context around the new text", () => {
  const content = "l1\nl2\nl3\nNEW\nl5\nl6\nl7\nl8\n";
  const preview = buildEditPreview(content, "NEW");
  assert.match(preview, /4→NEW/);
  assert.match(preview, /1→l1/);
  assert.match(preview, /7→l7/);
  assert.doesNotMatch(preview, /8→l8/);
});
