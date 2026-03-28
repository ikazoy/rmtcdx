import { create } from "zustand";

type MobilePane = "repos" | "sessions" | "chat";
type WsState = "connecting" | "connected" | "reconnecting";

type UiState = {
  selectedRepoId: string | null;
  selectedSessionId: string | null;
  mobilePane: MobilePane;
  wsState: WsState;
  backendBanner: string | null;
  streaming: Record<string, string>;
  setSelectedRepoId: (repoId: string | null) => void;
  setSelectedSessionId: (sessionId: string | null) => void;
  setMobilePane: (pane: MobilePane) => void;
  setWsState: (state: WsState) => void;
  setBackendBanner: (text: string | null) => void;
  appendStreaming: (sessionId: string, text: string) => void;
  clearStreaming: (sessionId: string) => void;
};

export const useUiStore = create<UiState>((set) => ({
  selectedRepoId: null,
  selectedSessionId: null,
  mobilePane: "sessions",
  wsState: "connecting",
  backendBanner: null,
  streaming: {},
  setSelectedRepoId: (selectedRepoId) => set({ selectedRepoId }),
  setSelectedSessionId: (selectedSessionId) => set({ selectedSessionId }),
  setMobilePane: (mobilePane) => set({ mobilePane }),
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
    })
}));
