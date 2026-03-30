import { create } from "zustand";
import type { LiveActivity } from "@codex-remote/shared-types";

type MobilePane = "sidebar" | "chat";
type WsState = "connecting" | "connected" | "reconnecting";

const SELECTED_REPO_STORAGE_KEY = "codex-remote-selected-repo-id";
const COLLAPSED_REPOS_STORAGE_KEY = "codex-remote-collapsed-repos";

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

type UiState = {
  selectedRepoId: string | null;
  selectedSessionId: string | null;
  mobilePane: MobilePane;
  sidebarVisible: boolean;
  wsState: WsState;
  backendBanner: string | null;
  streaming: Record<string, string>;
  activities: Record<string, Record<string, LiveActivity>>;
  collapsedRepos: Set<string>;
  setSelectedRepoId: (repoId: string | null) => void;
  setSelectedSessionId: (sessionId: string | null) => void;
  setMobilePane: (pane: MobilePane) => void;
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
};

export const useUiStore = create<UiState>((set) => ({
  selectedRepoId: readStoredSelectedRepoId(),
  selectedSessionId: null,
  mobilePane: "sidebar",
  sidebarVisible: true,
  wsState: "connecting",
  backendBanner: null,
  streaming: {},
  activities: {},
  collapsedRepos: readStoredCollapsedRepos(),
  setSelectedRepoId: (selectedRepoId) => {
    persistSelectedRepoId(selectedRepoId);
    set({ selectedRepoId });
  },
  setSelectedSessionId: (selectedSessionId) => set({ selectedSessionId }),
  setMobilePane: (mobilePane) => set({ mobilePane }),
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
    })
}));
