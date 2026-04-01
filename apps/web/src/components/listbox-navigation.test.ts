import assert from "node:assert/strict";
import test from "node:test";
import { moveActiveItemKey, resolveActiveItemKey } from "./listbox-navigation";

const items = [{ key: "alpha" }, { key: "beta" }, { key: "gamma" }];

test("resolveActiveItemKey keeps the current key when it is still visible", () => {
  assert.equal(
    resolveActiveItemKey({
      items,
      currentKey: "beta",
      preferredKey: "alpha"
    }),
    "beta"
  );
});

test("resolveActiveItemKey falls back to the preferred key when the current key disappears", () => {
  assert.equal(
    resolveActiveItemKey({
      items,
      currentKey: "missing",
      preferredKey: "gamma"
    }),
    "gamma"
  );
});

test("moveActiveItemKey wraps forward from the last item", () => {
  assert.equal(
    moveActiveItemKey({
      items,
      currentKey: "gamma",
      delta: 1
    }),
    "alpha"
  );
});

test("moveActiveItemKey wraps backward from the first item", () => {
  assert.equal(
    moveActiveItemKey({
      items,
      currentKey: "alpha",
      delta: -1
    }),
    "gamma"
  );
});

test("moveActiveItemKey picks the first or last item when no item is active", () => {
  assert.equal(
    moveActiveItemKey({
      items,
      currentKey: null,
      delta: 1
    }),
    "alpha"
  );
  assert.equal(
    moveActiveItemKey({
      items,
      currentKey: null,
      delta: -1
    }),
    "gamma"
  );
});
