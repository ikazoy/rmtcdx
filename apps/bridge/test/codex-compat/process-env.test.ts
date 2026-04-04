import assert from "node:assert/strict";
import test from "node:test";

import { createCodexProcessEnv } from "../../src/codex/process-env";

test("createCodexProcessEnv preserves the original environment when no home override is provided", () => {
  const baseEnv = {
    HOME: "/Users/original",
    PATH: "/usr/bin"
  };

  assert.deepEqual(createCodexProcessEnv(baseEnv), baseEnv);
});

test("createCodexProcessEnv overrides HOME on posix platforms", () => {
  const env = createCodexProcessEnv(
    {
      HOME: "/Users/original",
      PATH: "/usr/bin"
    },
    {
      codexHomeDir: "/Users/shared-codex",
      platform: "darwin"
    }
  );

  assert.equal(env.HOME, "/Users/shared-codex");
  assert.equal(env.PATH, "/usr/bin");
});

test("createCodexProcessEnv overrides HOME and user profile fields on windows", () => {
  const env = createCodexProcessEnv(
    {
      HOME: "C:\\Users\\Original",
      USERPROFILE: "C:\\Users\\Original",
      PATH: "C:\\Windows\\System32"
    },
    {
      codexHomeDir: "D:\\Profiles\\SharedCodex",
      platform: "win32"
    }
  );

  assert.equal(env.HOME, "D:\\Profiles\\SharedCodex");
  assert.equal(env.USERPROFILE, "D:\\Profiles\\SharedCodex");
  assert.equal(env.HOMEDRIVE, "D:");
  assert.equal(env.HOMEPATH, "\\Profiles\\SharedCodex");
  assert.equal(env.PATH, "C:\\Windows\\System32");
});
