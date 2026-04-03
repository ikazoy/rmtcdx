import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  fileSelectionLineRange,
  formatFileSelectionSuffix,
  normalizeFileSelection,
  parseLocalFileHref
} from "./file-links";

describe("parseLocalFileHref", () => {
  test("parses GitHub-style line fragments", () => {
    assert.deepEqual(parseLocalFileHref("apps/bridge/src/app.ts#L427-L430"), {
      path: "apps/bridge/src/app.ts",
      selection: {
        startLine: 427,
        endLine: 430,
        startColumn: null,
        endColumn: null
      }
    });
  });

  test("parses line and column suffixes", () => {
    assert.deepEqual(parseLocalFileHref("./analyze_bedrock_costs.py:844:12"), {
      path: "./analyze_bedrock_costs.py",
      selection: {
        startLine: 844,
        endLine: null,
        startColumn: 12,
        endColumn: null
      }
    });
  });

  test("parses file URLs", () => {
    assert.deepEqual(parseLocalFileHref("file:///tmp/example.ts#L18"), {
      path: "/tmp/example.ts",
      selection: {
        startLine: 18,
        endLine: null,
        startColumn: null,
        endColumn: null
      }
    });
  });

  test("rejects web URLs", () => {
    assert.equal(parseLocalFileHref("https://developers.openai.com/codex/app-server"), null);
  });
});

describe("file selection helpers", () => {
  test("normalizes inverted line ranges", () => {
    assert.deepEqual(
      normalizeFileSelection({
        startLine: 10,
        endLine: 8,
        startColumn: 4,
        endColumn: 6
      }),
      {
        startLine: 10,
        endLine: null,
        startColumn: 4,
        endColumn: 6
      }
    );
  });

  test("formats selection suffixes", () => {
    assert.equal(
      formatFileSelectionSuffix({
        startLine: 18,
        endLine: 20,
        startColumn: 3,
        endColumn: 7
      }),
      "#L18C3-L20C7"
    );
  });

  test("builds a line-only range for highlighting", () => {
    assert.deepEqual(
      fileSelectionLineRange({
        startLine: 21,
        startColumn: 4,
        endColumn: 10
      }),
      {
        startLine: 21,
        endLine: 21
      }
    );
  });
});
