import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionRunSettingsStore } from "../../src/runs/session-run-settings-store";

test("session run settings store persists normalized effective settings", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rmtcdx-run-settings-"));
  const filePath = path.join(tempDir, "run-settings.json");

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const store = new SessionRunSettingsStore(filePath);
  store.set("thread-1", {
    approvalPolicy: null,
    sandbox: null,
    serviceTier: "fast",
    model: " gpt-5.4 "
  });

  const restored = new SessionRunSettingsStore(filePath);

  assert.deepEqual(restored.get("thread-1"), {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    serviceTier: "fast",
    model: "gpt-5.4"
  });
});
