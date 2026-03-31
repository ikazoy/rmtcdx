import type { CodexRunSettings } from "@codex-remote/shared-types";

const APPROVAL_POLICY_VALUES = new Set(["untrusted", "on-failure", "on-request", "never"]);
const SANDBOX_VALUES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const SERVICE_TIER_VALUES = new Set(["fast", "flex"]);

export type ResolvedRunSettings = {
  approvalPolicy: NonNullable<CodexRunSettings["approvalPolicy"]>;
  sandbox: NonNullable<CodexRunSettings["sandbox"]>;
  serviceTier: CodexRunSettings["serviceTier"];
  model: string;
};

export const DEFAULT_RUN_SETTINGS: ResolvedRunSettings = {
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
  serviceTier: null,
  model: ""
};

export function normalizeRunSettings(value: unknown): CodexRunSettings | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as {
    approvalPolicy?: unknown;
    sandbox?: unknown;
    serviceTier?: unknown;
    model?: unknown;
  };
  const approvalPolicy =
    typeof payload.approvalPolicy === "string" && APPROVAL_POLICY_VALUES.has(payload.approvalPolicy)
      ? (payload.approvalPolicy as CodexRunSettings["approvalPolicy"])
      : null;
  const sandbox =
    typeof payload.sandbox === "string" && SANDBOX_VALUES.has(payload.sandbox)
      ? (payload.sandbox as CodexRunSettings["sandbox"])
      : null;
  const rawModel = typeof payload.model === "string" ? payload.model.trim() : "";
  const model = rawModel || null;
  const serviceTier =
    model && typeof payload.serviceTier === "string" && SERVICE_TIER_VALUES.has(payload.serviceTier)
      ? (payload.serviceTier as CodexRunSettings["serviceTier"])
      : null;

  return {
    approvalPolicy,
    sandbox,
    serviceTier,
    model
  };
}

export function resolveRunSettings(settings: CodexRunSettings | undefined | null): ResolvedRunSettings {
  const normalized = normalizeRunSettings(settings);

  return {
    approvalPolicy: normalized?.approvalPolicy ?? DEFAULT_RUN_SETTINGS.approvalPolicy,
    sandbox: normalized?.sandbox ?? DEFAULT_RUN_SETTINGS.sandbox,
    serviceTier: normalized?.serviceTier ?? DEFAULT_RUN_SETTINGS.serviceTier,
    model: normalized?.model ?? DEFAULT_RUN_SETTINGS.model
  };
}

export function runSettingsForRequest(settings: CodexRunSettings | undefined | null): CodexRunSettings {
  const resolved = resolveRunSettings(settings);
  const model = resolved.model.trim();

  return {
    approvalPolicy: resolved.approvalPolicy,
    sandbox: resolved.sandbox,
    serviceTier: model ? (resolved.serviceTier ?? null) : null,
    model: model || null
  };
}

export function equalRunSettings(
  left: CodexRunSettings | undefined | null,
  right: CodexRunSettings | undefined | null
) {
  const normalizedLeft = normalizeRunSettings(left);
  const normalizedRight = normalizeRunSettings(right);

  return normalizedLeft?.approvalPolicy === normalizedRight?.approvalPolicy
    && normalizedLeft?.sandbox === normalizedRight?.sandbox
    && normalizedLeft?.serviceTier === normalizedRight?.serviceTier
    && normalizedLeft?.model === normalizedRight?.model;
}

// With the current app-server protocol, passive thread/read snapshots do not expose the
// latest per-thread approval/sandbox choice. Treat those as client-owned preferences and
// only carry forward the thread-bound model selection we can reliably preserve locally.
export function extractThreadBoundRunSettings(settings: CodexRunSettings | undefined | null) {
  const normalized = normalizeRunSettings(settings);
  if (!normalized?.model) {
    return null;
  }

  return {
    approvalPolicy: null,
    sandbox: null,
    serviceTier: normalized.serviceTier,
    model: normalized.model
  } satisfies CodexRunSettings;
}

export function equalThreadBoundRunSettings(
  left: CodexRunSettings | undefined | null,
  right: CodexRunSettings | undefined | null
) {
  const normalizedLeft = extractThreadBoundRunSettings(left);
  const normalizedRight = extractThreadBoundRunSettings(right);

  return normalizedLeft?.model === normalizedRight?.model
    && normalizedLeft?.serviceTier === normalizedRight?.serviceTier;
}

export function pickRunSettings(params: {
  isDraftSession: boolean;
  sessionOverride: CodexRunSettings | undefined | null;
  authoritativeRunSettings: CodexRunSettings | undefined | null;
  userDefaultRunSettings: CodexRunSettings | undefined | null;
}) {
  const sessionOverride = normalizeRunSettings(params.sessionOverride);
  const authoritativeRunSettings = normalizeRunSettings(params.authoritativeRunSettings);
  const userDefaultRunSettings = normalizeRunSettings(params.userDefaultRunSettings);
  const model =
    sessionOverride?.model
    ?? authoritativeRunSettings?.model
    ?? userDefaultRunSettings?.model
    ?? DEFAULT_RUN_SETTINGS.model;

  return {
    approvalPolicy: sessionOverride?.approvalPolicy ?? userDefaultRunSettings?.approvalPolicy ?? DEFAULT_RUN_SETTINGS.approvalPolicy,
    sandbox: sessionOverride?.sandbox ?? userDefaultRunSettings?.sandbox ?? DEFAULT_RUN_SETTINGS.sandbox,
    serviceTier: model
      ? sessionOverride?.serviceTier
        ?? authoritativeRunSettings?.serviceTier
        ?? userDefaultRunSettings?.serviceTier
        ?? DEFAULT_RUN_SETTINGS.serviceTier
      : null,
    model
  };
}
