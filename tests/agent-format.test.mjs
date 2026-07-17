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

test("buildEditPreview shows numbered context around the new text", () => {
  const content = "l1\nl2\nl3\nNEW\nl5\nl6\nl7\nl8\n";
  const preview = buildEditPreview(content, "NEW");
  assert.match(preview, /4→NEW/);
  assert.match(preview, /1→l1/);
  assert.match(preview, /7→l7/);
  assert.doesNotMatch(preview, /8→l8/);
});
