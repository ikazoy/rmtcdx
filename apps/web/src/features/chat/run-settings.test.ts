import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RUN_SETTINGS,
  equalRunSettings,
  equalThreadBoundRunSettings,
  extractThreadBoundRunSettings,
  pickRunSettings,
  runSettingsForRequest
} from "./run-settings";

test("pickRunSettings restores model/service tier from the session while keeping approval/sandbox client-owned", () => {
  const resolved = pickRunSettings({
    isDraftSession: false,
    sessionOverride: null,
    authoritativeRunSettings: {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      serviceTier: null,
      model: "gpt-5.4"
    },
    userDefaultRunSettings: {
      approvalPolicy: "on-failure",
      sandbox: "read-only",
      serviceTier: null,
      model: "gpt-5.4-mini"
    }
  });

  assert.deepEqual(resolved, {
    approvalPolicy: "on-failure",
    sandbox: "read-only",
    serviceTier: null,
    model: "gpt-5.4"
  });
});

test("pickRunSettings uses the user default for new draft threads when no override exists", () => {
  const resolved = pickRunSettings({
    isDraftSession: true,
    sessionOverride: null,
    authoritativeRunSettings: null,
    userDefaultRunSettings: {
      approvalPolicy: "on-failure",
      sandbox: "read-only",
      serviceTier: null,
      model: "gpt-5.4-mini"
    }
  });

  assert.deepEqual(resolved, {
    approvalPolicy: "on-failure",
    sandbox: "read-only",
    serviceTier: null,
    model: "gpt-5.4-mini"
  });
});

test("pickRunSettings falls back to the hard defaults when no other source is available", () => {
  assert.deepEqual(
    pickRunSettings({
      isDraftSession: true,
      sessionOverride: null,
      authoritativeRunSettings: null,
      userDefaultRunSettings: null
    }),
    DEFAULT_RUN_SETTINGS
  );
});

test("extractThreadBoundRunSettings keeps only the model selection that can be restored per thread", () => {
  assert.deepEqual(
    extractThreadBoundRunSettings({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      serviceTier: "fast",
      model: "gpt-5.4"
    }),
    {
      approvalPolicy: null,
      sandbox: null,
      serviceTier: "fast",
      model: "gpt-5.4"
    }
  );
  assert.equal(
    extractThreadBoundRunSettings({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      serviceTier: "fast",
      model: null
    }),
    null
  );
});

test("equalThreadBoundRunSettings ignores approval and sandbox drift", () => {
  assert.equal(
    equalThreadBoundRunSettings(
      {
        approvalPolicy: null,
        sandbox: null,
        serviceTier: "fast",
        model: "gpt-5.4"
      },
      {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        serviceTier: "fast",
        model: "gpt-5.4"
      }
    ),
    true
  );
});

test("runSettingsForRequest clears service tier when no model is selected", () => {
  assert.deepEqual(
    runSettingsForRequest({
      approvalPolicy: "never",
      sandbox: "workspace-write",
      serviceTier: "fast",
      model: "   "
    }),
    {
      approvalPolicy: "never",
      sandbox: "workspace-write",
      serviceTier: null,
      model: null
    }
  );
});

test("equalRunSettings compares normalized values", () => {
  assert.equal(
    equalRunSettings(
      {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        serviceTier: "fast",
        model: "gpt-5.4"
      },
      {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        serviceTier: "fast",
        model: " gpt-5.4 "
      }
    ),
    true
  );
});
