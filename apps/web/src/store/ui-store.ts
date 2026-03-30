import { create } from "zustand";
import type { CodexRunSettings, LiveActivity } from "@codex-remote/shared-types";

type WsState = "connecting" | "connected" | "reconnecting";

const SELECTED_REPO_STORAGE_KEY = "codex-remote-selected-repo-id";
const COLLAPSED_REPOS_STORAGE_KEY = "codex-remote-collapsed-repos";
const RUN_SETTINGS_STORAGE_KEY = "codex-remote-run-settings";
const APPROVAL_POLICY_VALUES = new Set(["untrusted", "on-failure", "on-request", "never"]);
const SANDBOX_VALUES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const SERVICE_TIER_VALUES = new Set(["fast", "flex"]);

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

function readStoredCollapsedRepos() {
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

function persistCollapsedRepos(repoNames: Set<string>) {
  if (typeof window === "undefined") {
    return;
  }

  if (repoNames.size === 0) {
    window.localStorage.removeItem(COLLAPSED_REPOS_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(COLLAPSED_REPOS_STORAGE_KEY, JSON.stringify([...repoNames].sort()));
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

type UiState = {
  selectedRepoId: string | null;
  sidebarVisible: boolean;
  wsState: WsState;
  backendBanner: string | null;
  streaming: Record<string, string>;
  activities: Record<string, Record<string, LiveActivity>>;
  collapsedRepos: Set<string>;
  runSettingsBySession: Record<string, CodexRunSettings>;
  setSelectedRepoId: (repoId: string | null) => void;
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
  toggleRepoCollapsed: (repoName: string) => void;
  collapseRepos: (repoNames: string[]) => void;
  expandRepos: (repoNames: string[]) => void;
  setRunSettingsForSession: (sessionId: string, settings: CodexRunSettings) => void;
  resetRunSettingsForSession: (sessionId: string) => void;
  copyRunSettings: (sourceSessionId: string, targetSessionId: string) => void;
};

export const useUiStore = create<UiState>((set) => ({
  selectedRepoId: readStoredSelectedRepoId(),
  sidebarVisible: true,
  wsState: "connecting",
  backendBanner: null,
  streaming: {},
  activities: {},
  collapsedRepos: readStoredCollapsedRepos(),
  runSettingsBySession: readStoredRunSettingsBySession(),
  setSelectedRepoId: (selectedRepoId) => {
    persistSelectedRepoId(selectedRepoId);
    set({ selectedRepoId });
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
  toggleRepoCollapsed: (repoName) =>
    set((state) => {
      const next = new Set(state.collapsedRepos);
      if (next.has(repoName)) {
        next.delete(repoName);
      } else {
        next.add(repoName);
      }
      persistCollapsedRepos(next);
      return { collapsedRepos: next };
    }),
  collapseRepos: (repoNames) =>
    set((state) => {
      const next = new Set(state.collapsedRepos);
      for (const repoName of repoNames) {
        if (repoName) {
          next.add(repoName);
        }
      }
      persistCollapsedRepos(next);
      return { collapsedRepos: next };
    }),
  expandRepos: (repoNames) =>
    set((state) => {
      const next = new Set(state.collapsedRepos);
      for (const repoName of repoNames) {
        next.delete(repoName);
      }
      persistCollapsedRepos(next);
      return { collapsedRepos: next };
    }),
  setRunSettingsForSession: (sessionId, settings) =>
    set((state) => {
      if (!sessionId) {
        return state;
      }
      const runSettingsBySession = {
        ...state.runSettingsBySession,
        [sessionId]: normalizeRunSettings(settings) ?? {
          approvalPolicy: null,
          sandbox: null,
          serviceTier: null,
          model: null
        }
      };
      persistRunSettingsBySession(runSettingsBySession);
      return { runSettingsBySession };
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
      return { runSettingsBySession };
    })
}));
