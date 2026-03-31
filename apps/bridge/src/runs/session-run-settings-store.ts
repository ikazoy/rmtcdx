import fs from "node:fs";
import path from "node:path";

import type {
  CodexApprovalPolicyPreset,
  CodexRunSettings,
  CodexSandboxPreset,
  CodexServiceTier
} from "@codex-remote/shared-types";

const APPROVAL_POLICY_VALUES = new Set<CodexApprovalPolicyPreset>(["untrusted", "on-failure", "on-request", "never"]);
const SANDBOX_VALUES = new Set<CodexSandboxPreset>(["read-only", "workspace-write", "danger-full-access"]);
const SERVICE_TIER_VALUES = new Set<CodexServiceTier>(["fast", "flex"]);

type StoredSessionRunSettingsState = {
  version: 1;
  sessions: Record<string, CodexRunSettings>;
};

export function normalizeCodexRunSettings(settings: CodexRunSettings | null | undefined): CodexRunSettings | null {
  if (!settings) {
    return null;
  }

  const approvalPolicy =
    settings.approvalPolicy && APPROVAL_POLICY_VALUES.has(settings.approvalPolicy) ? settings.approvalPolicy : null;
  const sandbox = settings.sandbox && SANDBOX_VALUES.has(settings.sandbox) ? settings.sandbox : null;
  const rawModel = typeof settings.model === "string" ? settings.model.trim() : "";
  const model = rawModel || null;
  const serviceTier =
    model && settings.serviceTier && SERVICE_TIER_VALUES.has(settings.serviceTier) ? settings.serviceTier : null;

  return {
    approvalPolicy,
    sandbox,
    serviceTier,
    model
  };
}

export function resolveEffectiveCodexRunSettings(settings: CodexRunSettings | null | undefined): CodexRunSettings {
  const normalized = normalizeCodexRunSettings(settings);

  return {
    approvalPolicy: normalized?.approvalPolicy ?? "on-request",
    sandbox: normalized?.sandbox ?? "workspace-write",
    serviceTier: normalized?.serviceTier ?? null,
    model: normalized?.model ?? null
  };
}

export class SessionRunSettingsStore {
  private readonly settingsBySession = new Map<string, CodexRunSettings>();

  constructor(private readonly filePath: string) {
    for (const [sessionId, settings] of Object.entries(this.readState().sessions)) {
      const normalized = resolveEffectiveCodexRunSettings(settings);
      this.settingsBySession.set(sessionId, normalized);
    }
  }

  get(sessionId: string) {
    return this.settingsBySession.get(sessionId) ?? null;
  }

  set(sessionId: string, settings: CodexRunSettings | null | undefined) {
    if (!sessionId) {
      return;
    }

    this.settingsBySession.set(sessionId, resolveEffectiveCodexRunSettings(settings));
    this.persistState();
  }

  private readState(): StoredSessionRunSettingsState {
    if (!fs.existsSync(this.filePath)) {
      return {
        version: 1,
        sessions: {}
      };
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoredSessionRunSettingsState> | null;
      if (!parsed || typeof parsed !== "object" || typeof parsed.sessions !== "object" || !parsed.sessions) {
        return {
          version: 1,
          sessions: {}
        };
      }

      const sessions: Record<string, CodexRunSettings> = {};
      for (const [sessionId, settings] of Object.entries(parsed.sessions)) {
        const normalized = normalizeCodexRunSettings(settings);
        if (normalized) {
          sessions[sessionId] = normalized;
        }
      }

      return {
        version: 1,
        sessions
      };
    } catch {
      return {
        version: 1,
        sessions: {}
      };
    }
  }

  private persistState() {
    const state: StoredSessionRunSettingsState = {
      version: 1,
      sessions: Object.fromEntries(this.settingsBySession.entries())
    };

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, this.filePath);
  }
}
