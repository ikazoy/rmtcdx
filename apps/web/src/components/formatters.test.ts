import assert from "node:assert/strict";
import test from "node:test";
import { formatCompactTimeUntil } from "./formatters";

test("formatCompactTimeUntil returns compact days and hours for future resets", () => {
  const now = Date.parse("2026-04-03T12:00:00Z");

  assert.equal(formatCompactTimeUntil("2026-04-06T14:00:00Z", now), "3d 2h");
});

test("formatCompactTimeUntil respects timezone offsets in ISO strings", () => {
  const now = Date.parse("2026-04-03T23:00:00Z");

  assert.equal(formatCompactTimeUntil("2026-04-03T17:30:00-07:00", now), "1h 30m");
});

test("formatCompactTimeUntil returns now for elapsed resets", () => {
  const now = Date.parse("2026-04-03T12:00:00Z");

  assert.equal(formatCompactTimeUntil("2026-04-03T11:59:59Z", now), "now");
});

test("formatCompactTimeUntil returns null for invalid dates", () => {
  assert.equal(formatCompactTimeUntil("not-a-date", Date.now()), null);
});
