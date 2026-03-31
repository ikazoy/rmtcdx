import { create } from "zustand";
import type { CodexRunSettings, LiveActivity } from "@codex-remote/shared-types";

type WsState = "connecting" | "connected" | "reconnecting";
export type RepoSelectionSource = "restored" | "user" | "system";

const SELECTED_REPO_STORAGE_KEY = "codex-remote-selected-repo-id";
const COLLAPSED_REPOS_STORAGE_KEY = "codex-remote-collapsed-repos";
const RUN_SETTINGS_STORAGE_KEY = "codex-remote-run-settings";
const LAST_RUN_SETTINGS_STORAGE_KEY = "codex-remote-last-run-settings";
const APPROVAL_POLICY_VALUES = new Set(["untrusted", "on-failure", "on-request", "never"]);
const SANDBOX_VALUES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const SERVICE_TIER_VALUES = new Set(["fast", "flex"]);
const EMPTY_RUN_SETTINGS: CodexRunSettings = {
  approvalPolicy: null,
  sandbox: null,
  serviceTier: null,
  model: null
};

function readStoredSelectedRepoId() {
  if (typeof window === "undefined") {
    return null;
  }

  const stored = window.localStorage.getItem(SELECTED_REPO_STORAGE_KEY)?.trim();
  return stored ? stored : null;
}

function persistSelectedRepoId(repoId: string | null) {
  if (typeof window === "undefined") {
    return;
  }

  if (repoId) {
    window.localStorage.setItem(SELECTED_REPO_STORAGE_KEY, repoId);
    return;
  }

  window.localStorage.removeItem(SELECTED_REPO_STORAGE_KEY);
}

function readStoredCollapsedRepoKeys() {
  if (typeof window === "undefined") {
    return new Set<string>();
  }

  try {
    const stored = window.localStorage.getItem(COLLAPSED_REPOS_STORAGE_KEY);
    if (!stored) {
      return new Set<string>();
    }

    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return new Set<string>();
    }

    return new Set(parsed.filter((value): value is string => typeof value === "string" && value.length > 0));
  } catch {
    return new Set<string>();
  }
}

function persistCollapsedRepoKeys(repoKeys: Set<string>) {
  if (typeof window === "undefined") {
    return;
  }

  if (repoKeys.size === 0) {
    window.localStorage.removeItem(COLLAPSED_REPOS_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(COLLAPSED_REPOS_STORAGE_KEY, JSON.stringify([...repoKeys].sort()));
}

function normalizeRunSettings(value: unknown): CodexRunSettings | null {
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
  const serviceTier =
    typeof payload.serviceTier === "string" && SERVICE_TIER_VALUES.has(payload.serviceTier)
      ? (payload.serviceTier as CodexRunSettings["serviceTier"])
      : null;
  const model = typeof payload.model === "string" ? payload.model : null;

  return {
    approvalPolicy,
    sandbox,
    serviceTier,
    model
  };
}

function readStoredRunSettingsBySession() {
  if (typeof window === "undefined") {
    return {} as Record<string, CodexRunSettings>;
  }

  try {
    const stored = window.localStorage.getItem(RUN_SETTINGS_STORAGE_KEY);
    if (!stored) {
      return {} as Record<string, CodexRunSettings>;
    }

    const parsed = JSON.parse(stored) as Record<string, unknown>;
    const next: Record<string, CodexRunSettings> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (!sessionId) {
        continue;
      }
      const settings = normalizeRunSettings(value);
      if (settings) {
        next[sessionId] = settings;
      }
    }
    return next;
  } catch {
    return {} as Record<string, CodexRunSettings>;
  }
}

function persistRunSettingsBySession(runSettingsBySession: Record<string, CodexRunSettings>) {
  if (typeof window === "undefined") {
    return;
  }

  if (Object.keys(runSettingsBySession).length === 0) {
    window.localStorage.removeItem(RUN_SETTINGS_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(RUN_SETTINGS_STORAGE_KEY, JSON.stringify(runSettingsBySession));
}

function readStoredLastRunSettings() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored = window.localStorage.getItem(LAST_RUN_SETTINGS_STORAGE_KEY);
    if (!stored) {
      return null;
    }

    return normalizeRunSettings(JSON.parse(stored));
  } catch {
    return null;
  }
}

function persistLastRunSettings(runSettings: CodexRunSettings | null) {
  if (typeof window === "undefined") {
    return;
  }

  if (!runSettings) {
    window.localStorage.removeItem(LAST_RUN_SETTINGS_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(LAST_RUN_SETTINGS_STORAGE_KEY, JSON.stringify(runSettings));
}

type UiState = {
  selectedRepoId: string | null;
  selectedRepoSource: RepoSelectionSource;
  sidebarVisible: boolean;
  wsState: WsState;
  backendBanner: string | null;
  streaming: Record<string, string>;
  activities: Record<string, Record<string, LiveActivity>>;
  collapsedRepoKeys: Set<string>;
  runSettingsBySession: Record<string, CodexRunSettings>;
  lastRunSettings: CodexRunSettings | null;
  setSelectedRepoId: (repoId: string | null, source?: RepoSelectionSource) => void;
  setSidebarVisible: (visible: boolean) => void;
  toggleSidebarVisible: () => void;
  setWsState: (state: WsState) => void;
  setBackendBanner: (text: string | null) => void;
  appendStreaming: (sessionId: string, text: string) => void;
  clearStreaming: (sessionId: string) => void;
  upsertActivity: (activity: LiveActivity) => void;
  appendActivityOutput: (sessionId: string, itemId: string, delta: string, updatedAt: string) => void;
  removeActivity: (sessionId: string, itemId: string) => void;
  clearActivities: (sessionId: string) => void;
  toggleRepoCollapsed: (repoKey: string) => void;
  collapseRepos: (repoKeys: string[]) => void;
  expandRepos: (repoKeys: string[]) => void;
  initializeRunSettingsForSession: (sessionId: string) => void;
  setRunSettingsForSession: (sessionId: string, settings: CodexRunSettings) => void;
  resetRunSettingsForSession: (sessionId: string) => void;
  copyRunSettings: (sourceSessionId: string, targetSessionId: string) => void;
};

export const useUiStore = create<UiState>((set) => ({
  selectedRepoId: readStoredSelectedRepoId(),
  selectedRepoSource: readStoredSelectedRepoId() ? "restored" : "system",
  sidebarVisible: true,
  wsState: "connecting",
  backendBanner: null,
  streaming: {},
  activities: {},
  collapsedRepoKeys: readStoredCollapsedRepoKeys(),
  runSettingsBySession: readStoredRunSettingsBySession(),
  lastRunSettings: readStoredLastRunSettings(),
  setSelectedRepoId: (selectedRepoId, source = "user") => {
    persistSelectedRepoId(selectedRepoId);
    set({ selectedRepoId, selectedRepoSource: source });
  },
  setSidebarVisible: (sidebarVisible) => set({ sidebarVisible }),
  toggleSidebarVisible: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  setWsState: (wsState) => set({ wsState }),
  setBackendBanner: (backendBanner) => set({ backendBanner }),
  appendStreaming: (sessionId, text) =>
    set((state) => ({
      streaming: {
        ...state.streaming,
        [sessionId]: `${state.streaming[sessionId] ?? ""}${text}`
      }
    })),
  clearStreaming: (sessionId) =>
    set((state) => {
      const next = { ...state.streaming };
      delete next[sessionId];
      return { streaming: next };
    }),
  upsertActivity: (activity) =>
    set((state) => ({
      activities: {
        ...state.activities,
        [activity.sessionId]: {
          ...(state.activities[activity.sessionId] ?? {}),
          [activity.itemId]: activity
        }
      }
    })),
  appendActivityOutput: (sessionId, itemId, delta, updatedAt) =>
    set((state) => {
      const sessionActivities = state.activities[sessionId];
      const activity = sessionActivities?.[itemId];
      if (!activity) {
        return state;
      }

      return {
        activities: {
          ...state.activities,
          [sessionId]: {
            ...sessionActivities,
            [itemId]: {
              ...activity,
              output: `${activity.output}${delta}`.slice(-4000),
              updatedAt
            }
          }
        }
      };
    }),
  removeActivity: (sessionId, itemId) =>
    set((state) => {
      const sessionActivities = state.activities[sessionId];
      if (!sessionActivities?.[itemId]) {
        return state;
      }

      const nextSessionActivities = { ...sessionActivities };
      delete nextSessionActivities[itemId];

      const nextActivities = { ...state.activities };
      if (Object.keys(nextSessionActivities).length === 0) {
        delete nextActivities[sessionId];
      } else {
        nextActivities[sessionId] = nextSessionActivities;
      }

      return { activities: nextActivities };
    }),
  clearActivities: (sessionId) =>
    set((state) => {
      if (!state.activities[sessionId]) {
        return state;
      }
      const nextActivities = { ...state.activities };
      delete nextActivities[sessionId];
      return { activities: nextActivities };
    }),
  toggleRepoCollapsed: (repoKey) =>
    set((state) => {
      const next = new Set(state.collapsedRepoKeys);
      if (next.has(repoKey)) {
        next.delete(repoKey);
      } else {
        next.add(repoKey);
      }
      persistCollapsedRepoKeys(next);
      return { collapsedRepoKeys: next };
    }),
  collapseRepos: (repoKeys) =>
    set((state) => {
      const next = new Set(state.collapsedRepoKeys);
      for (const repoKey of repoKeys) {
        if (repoKey) {
          next.add(repoKey);
        }
      }
      persistCollapsedRepoKeys(next);
      return { collapsedRepoKeys: next };
    }),
  expandRepos: (repoKeys) =>
    set((state) => {
      const next = new Set(state.collapsedRepoKeys);
      for (const repoKey of repoKeys) {
        next.delete(repoKey);
      }
      persistCollapsedRepoKeys(next);
      return { collapsedRepoKeys: next };
    }),
  initializeRunSettingsForSession: (sessionId) =>
    set((state) => {
      if (!sessionId || state.runSettingsBySession[sessionId] || !state.lastRunSettings) {
        return state;
      }

      const nextSettings = normalizeRunSettings(state.lastRunSettings) ?? EMPTY_RUN_SETTINGS;
      const runSettingsBySession = {
        ...state.runSettingsBySession,
        [sessionId]: nextSettings
      };
      persistRunSettingsBySession(runSettingsBySession);
      return { runSettingsBySession };
    }),
  setRunSettingsForSession: (sessionId, settings) =>
    set((state) => {
      if (!sessionId) {
        return state;
      }
      const nextSettings = normalizeRunSettings(settings) ?? EMPTY_RUN_SETTINGS;
      const runSettingsBySession = {
        ...state.runSettingsBySession,
        [sessionId]: nextSettings
      };
      persistRunSettingsBySession(runSettingsBySession);
      persistLastRunSettings(nextSettings);
      return {
        runSettingsBySession,
        lastRunSettings: nextSettings
      };
    }),
  resetRunSettingsForSession: (sessionId) =>
    set((state) => {
      if (!sessionId || !state.runSettingsBySession[sessionId]) {
        return state;
      }
      const runSettingsBySession = { ...state.runSettingsBySession };
      delete runSettingsBySession[sessionId];
      persistRunSettingsBySession(runSettingsBySession);
      return { runSettingsBySession };
    }),
  copyRunSettings: (sourceSessionId, targetSessionId) =>
    set((state) => {
      const source = state.runSettingsBySession[sourceSessionId];
      if (!source || !targetSessionId) {
        return state;
      }
      const runSettingsBySession = {
        ...state.runSettingsBySession,
        [targetSessionId]: source
      };
      persistRunSettingsBySession(runSettingsBySession);
      persistLastRunSettings(source);
      return {
        runSettingsBySession,
        lastRunSettings: source
      };
    })
}));
