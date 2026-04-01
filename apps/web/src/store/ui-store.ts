import { create } from "zustand";
import type { CodexRunSettings, LiveActivity } from "@codex-remote/shared-types";
import {
  equalRunSettings,
  equalThreadBoundRunSettings,
  extractThreadBoundRunSettings,
  normalizeRunSettings
} from "../features/chat/run-settings";

type WsState = "connecting" | "connected" | "reconnecting";
export type RepoSelectionSource = "restored" | "user" | "system";

const SELECTED_REPO_STORAGE_KEY = "codex-remote-selected-repo-id";
const COLLAPSED_REPOS_STORAGE_KEY = "codex-remote-collapsed-repos";
const USER_DEFAULT_RUN_SETTINGS_STORAGE_KEY = "codex-remote-user-default-run-settings";
const EMPTY_STREAMING_TEXT = "";

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

function readStoredLastRunSettings() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored =
      window.localStorage.getItem(USER_DEFAULT_RUN_SETTINGS_STORAGE_KEY)
      ?? window.localStorage.getItem("codex-remote-last-run-settings");
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
    window.localStorage.removeItem(USER_DEFAULT_RUN_SETTINGS_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(USER_DEFAULT_RUN_SETTINGS_STORAGE_KEY, JSON.stringify(runSettings));
}

function scheduleNextUiFlush(callback: () => void) {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    const frameId = window.requestAnimationFrame(() => {
      callback();
    });

    return () => window.cancelAnimationFrame(frameId);
  }

  const timeoutId = globalThis.setTimeout(() => {
    callback();
  }, 0);

  return () => globalThis.clearTimeout(timeoutId);
}

export function streamingTextForSessionIds(streaming: Record<string, string>, sessionIds: Iterable<string>) {
  for (const sessionId of sessionIds) {
    const text = streaming[sessionId];
    if (text) {
      return text;
    }
  }

  return EMPTY_STREAMING_TEXT;
}

export function hasStreamingTextForSessionIds(streaming: Record<string, string>, sessionIds: Iterable<string>) {
  return streamingTextForSessionIds(streaming, sessionIds).length > 0;
}

export function activityMapForSessionIds(
  activities: Record<string, Record<string, LiveActivity>>,
  sessionIds: Iterable<string>
) {
  for (const sessionId of sessionIds) {
    const activityMap = activities[sessionId];
    if (activityMap && Object.keys(activityMap).length > 0) {
      return activityMap;
    }
  }

  return null;
}

export function hasActivitiesForSessionIds(
  activities: Record<string, Record<string, LiveActivity>>,
  sessionIds: Iterable<string>
) {
  return activityMapForSessionIds(activities, sessionIds) !== null;
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
  runSettingsOverridesBySession: Record<string, CodexRunSettings>;
  userDefaultRunSettings: CodexRunSettings | null;
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
  syncRunSettingsForSession: (sessionId: string, settings: CodexRunSettings | null) => void;
  setRunSettingsForSession: (sessionId: string, settings: CodexRunSettings) => void;
  resetRunSettingsForSession: (sessionId: string) => void;
  consumeRunSettingsForSession: (
    sourceSessionId: string,
    targetSessionId: string,
    fallbackSettings?: CodexRunSettings
  ) => void;
};

export const useUiStore = create<UiState>((set) => {
  const queuedStreamingBySession = new Map<string, string[]>();
  let cancelStreamingFlush: (() => void) | null = null;

  const flushQueuedStreaming = () => {
    cancelStreamingFlush = null;

    if (queuedStreamingBySession.size === 0) {
      return;
    }

    const queuedEntries = [...queuedStreamingBySession.entries()].map(([sessionId, chunks]) => [sessionId, chunks.join("")] as const);
    queuedStreamingBySession.clear();

    set((state) => {
      const nextStreaming = { ...state.streaming };
      let changed = false;

      for (const [sessionId, text] of queuedEntries) {
        if (!text) {
          continue;
        }

        nextStreaming[sessionId] = `${nextStreaming[sessionId] ?? ""}${text}`;
        changed = true;
      }

      return changed ? { streaming: nextStreaming } : state;
    });
  };

  const scheduleStreamingFlush = () => {
    if (cancelStreamingFlush) {
      return;
    }

    cancelStreamingFlush = scheduleNextUiFlush(flushQueuedStreaming);
  };

  const discardQueuedStreaming = (sessionId: string) => {
    queuedStreamingBySession.delete(sessionId);

    if (cancelStreamingFlush && queuedStreamingBySession.size === 0) {
      cancelStreamingFlush();
      cancelStreamingFlush = null;
    }
  };

  return ({
    selectedRepoId: readStoredSelectedRepoId(),
    selectedRepoSource: readStoredSelectedRepoId() ? "restored" : "system",
    sidebarVisible: true,
    wsState: "connecting",
    backendBanner: null,
    streaming: {},
    activities: {},
    collapsedRepoKeys: readStoredCollapsedRepoKeys(),
    runSettingsOverridesBySession: {},
    userDefaultRunSettings: readStoredLastRunSettings(),
    setSelectedRepoId: (selectedRepoId, source = "user") => {
      persistSelectedRepoId(selectedRepoId);
      set({ selectedRepoId, selectedRepoSource: source });
    },
    setSidebarVisible: (sidebarVisible) => set({ sidebarVisible }),
    toggleSidebarVisible: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
    setWsState: (wsState) => set({ wsState }),
    setBackendBanner: (backendBanner) => set({ backendBanner }),
    appendStreaming: (sessionId, text) => {
      if (!sessionId || !text) {
        return;
      }

      const queuedChunks = queuedStreamingBySession.get(sessionId);
      if (queuedChunks) {
        queuedChunks.push(text);
      } else {
        queuedStreamingBySession.set(sessionId, [text]);
      }

      scheduleStreamingFlush();
    },
    clearStreaming: (sessionId) =>
      set((state) => {
        discardQueuedStreaming(sessionId);
        if (!(sessionId in state.streaming)) {
          return state;
        }

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
  syncRunSettingsForSession: (sessionId, settings) =>
    set((state) => {
      const current = state.runSettingsOverridesBySession[sessionId];
      if (!sessionId || !current) {
        return state;
      }

      const matchesStoredSessionSettings =
        equalRunSettings(current, settings)
        || (
          current.approvalPolicy == null
          && current.sandbox == null
          && equalThreadBoundRunSettings(current, settings)
        );
      if (!matchesStoredSessionSettings) {
        return state;
      }

      const runSettingsOverridesBySession = { ...state.runSettingsOverridesBySession };
      delete runSettingsOverridesBySession[sessionId];
      return { runSettingsOverridesBySession };
    }),
  setRunSettingsForSession: (sessionId, settings) =>
    set((state) => {
      if (!sessionId) {
        return state;
      }
      const nextSettings = normalizeRunSettings(settings);
      if (!nextSettings) {
        return state;
      }
      const runSettingsOverridesBySession = {
        ...state.runSettingsOverridesBySession,
        [sessionId]: nextSettings
      };
      persistLastRunSettings(nextSettings);
      return {
        runSettingsOverridesBySession,
        userDefaultRunSettings: nextSettings
      };
    }),
  resetRunSettingsForSession: (sessionId) =>
    set((state) => {
      if (!sessionId || !state.runSettingsOverridesBySession[sessionId]) {
        return state;
      }
      const runSettingsOverridesBySession = { ...state.runSettingsOverridesBySession };
      delete runSettingsOverridesBySession[sessionId];
      return { runSettingsOverridesBySession };
    }),
  consumeRunSettingsForSession: (sourceSessionId, targetSessionId, fallbackSettings) =>
    set((state) => {
      if (!sourceSessionId || !targetSessionId) {
        return state;
      }

      const source = state.runSettingsOverridesBySession[sourceSessionId] ?? normalizeRunSettings(fallbackSettings);
      const runSettingsOverridesBySession = {
        ...state.runSettingsOverridesBySession
      };

      delete runSettingsOverridesBySession[sourceSessionId];

      const threadBoundSettings = extractThreadBoundRunSettings(source);
      if (threadBoundSettings) {
        runSettingsOverridesBySession[targetSessionId] = threadBoundSettings;
      } else {
        delete runSettingsOverridesBySession[targetSessionId];
      }

      return {
        runSettingsOverridesBySession
      };
    })
  });
});
