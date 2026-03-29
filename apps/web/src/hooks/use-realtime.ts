import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { ServerWsEvent } from "../../../../packages/shared-types/src/index";
import { queryKeys } from "../app/query";
import { useUiStore } from "../store/ui-store";

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

export function useRealtime() {
  const queryClient = useQueryClient();
  const setWsState = useUiStore((state) => state.setWsState);
  const appendStreaming = useUiStore((state) => state.appendStreaming);
  const clearStreaming = useUiStore((state) => state.clearStreaming);
  const upsertActivity = useUiStore((state) => state.upsertActivity);
  const appendActivityOutput = useUiStore((state) => state.appendActivityOutput);
  const removeActivity = useUiStore((state) => state.removeActivity);
  const clearActivities = useUiStore((state) => state.clearActivities);
  const setBackendBanner = useUiStore((state) => state.setBackendBanner);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let attempts = 0;

    const connect = () => {
      setWsState(attempts === 0 ? "connecting" : "reconnecting");
      socket = new WebSocket(wsUrl());

      socket.addEventListener("open", () => {
        attempts = 0;
        setWsState("connected");
      });

      socket.addEventListener("message", (message) => {
        const event = JSON.parse(message.data) as ServerWsEvent;
        switch (event.type) {
          case "repos.updated":
            queryClient.setQueryData(queryKeys.repos, { repos: event.repos });
            return;
          case "sessions.updated":
            void queryClient.invalidateQueries({ queryKey: ["sessions"] });
            void queryClient.invalidateQueries({ queryKey: queryKeys.session(event.session.id) });
            return;
          case "session.updated":
            queryClient.setQueryData(queryKeys.session(event.detail.session.id), event.detail);
            void queryClient.invalidateQueries({ queryKey: ["sessions"] });
            return;
          case "message.delta":
            appendStreaming(event.sessionId, event.text);
            return;
          case "message.final":
            clearStreaming(event.sessionId);
            void queryClient.invalidateQueries({ queryKey: queryKeys.messages(event.sessionId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.session(event.sessionId) });
            void queryClient.invalidateQueries({ queryKey: ["sessions"] });
            return;
          case "activity.started":
            upsertActivity(event.activity);
            return;
          case "activity.updated":
            appendActivityOutput(event.sessionId, event.itemId, event.delta, event.updatedAt);
            return;
          case "activity.completed":
            removeActivity(event.sessionId, event.itemId);
            return;
          case "run.started":
          case "run.completed":
          case "run.error":
          case "run.interrupted":
            clearActivities(event.run.sessionId);
            void queryClient.invalidateQueries({ queryKey: queryKeys.session(event.run.sessionId) });
            void queryClient.invalidateQueries({ queryKey: ["sessions"] });
            return;
          case "backend.degraded":
            setBackendBanner(event.reason);
            return;
          case "hello":
          case "notification.unread":
          case "pong":
            return;
        }
      });

      socket.addEventListener("close", () => {
        setWsState("reconnecting");
        attempts += 1;
        reconnectTimer = window.setTimeout(connect, Math.min(6000, 700 * attempts));
      });

      socket.addEventListener("error", () => {
        socket?.close();
      });
    };

    connect();

    return () => {
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, [
    appendActivityOutput,
    appendStreaming,
    clearActivities,
    clearStreaming,
    queryClient,
    removeActivity,
    setBackendBanner,
    setWsState,
    upsertActivity
  ]);
}
