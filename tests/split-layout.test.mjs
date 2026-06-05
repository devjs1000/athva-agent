import test from "node:test";
import assert from "node:assert/strict";

import {
  clampSplitLeftWidth,
  computeSplitLeftWidthFromPointer,
} from "../src/modules/split-layout.ts";

test("computeSplitLeftWidthFromPointer clamps pointer position within split bounds", () => {
  assert.equal(computeSplitLeftWidthFromPointer(0, 1000, -200), 20);
  assert.equal(computeSplitLeftWidthFromPointer(0, 1000, 500), 50);
  assert.equal(computeSplitLeftWidthFromPointer(0, 1000, 1200), 80);
});

test("computeSplitLeftWidthFromPointer falls back when container width is invalid", () => {
  assert.equal(computeSplitLeftWidthFromPointer(120, 0, 450, 42), 42);
  assert.equal(computeSplitLeftWidthFromPointer(120, Number.NaN, 450, 38), 38);
});

test("clampSplitLeftWidth keeps editor panes away from blanking widths", () => {
  assert.equal(clampSplitLeftWidth(5), 20);
  assert.equal(clampSplitLeftWidth(50), 50);
  assert.equal(clampSplitLeftWidth(95), 80);
  assert.equal(clampSplitLeftWidth(Number.NaN), 50);
});
