import { create } from "zustand";
import type { LiveActivity } from "../../../../packages/shared-types/src/index";

type MobilePane = "sidebar" | "chat";
type WsState = "connecting" | "connected" | "reconnecting";

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
};

export const useUiStore = create<UiState>((set) => ({
  selectedRepoId: null,
  selectedSessionId: null,
  mobilePane: "sidebar",
  sidebarVisible: true,
  wsState: "connecting",
  backendBanner: null,
  streaming: {},
  activities: {},
  collapsedRepos: new Set(),
  setSelectedRepoId: (selectedRepoId) => set({ selectedRepoId }),
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
      return { collapsedRepos: next };
    })
}));
