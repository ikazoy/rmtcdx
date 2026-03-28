import type { ClientWsEvent, Repository, Run, ServerWsEvent, SessionDetail, SessionSummary } from "../../../../packages/shared-types/src/index";

type SocketLike = {
  readyState: number;
  send: (payload: string) => void;
  on: (event: "message" | "close" | "error", listener: (value?: unknown) => void) => void;
};

const OPEN = 1;

export class RealtimeGateway {
  private readonly sockets = new Set<SocketLike>();

  constructor(private readonly onClientEvent: (event: ClientWsEvent) => void) {}

  register(socket: SocketLike, mode: "real" | "mock") {
    this.sockets.add(socket);
    this.send(socket, { type: "hello", mode });

    socket.on("message", (value) => {
      const text = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
      if (!text) {
        return;
      }

      try {
        const event = JSON.parse(text) as ClientWsEvent;
        if (event.type === "ping" || event.type === "session.read") {
          this.onClientEvent(event);
        }
      } catch {
        this.send(socket, { type: "backend.degraded", reason: "Malformed client WebSocket payload" });
      }
    });

    const cleanup = () => this.sockets.delete(socket);
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  }

  getConnectionCount() {
    return this.sockets.size;
  }

  broadcastRepos(repos: Repository[]) {
    this.broadcast({ type: "repos.updated", repos });
  }

  broadcastSession(summary: SessionSummary) {
    this.broadcast({ type: "sessions.updated", session: summary });
    this.broadcast({
      type: "notification.unread",
      sessionId: summary.id,
      unreadCount: summary.unreadCount,
      hasUnreadCompletion: summary.hasUnreadCompletion,
      hasUnreadError: summary.hasUnreadError
    });
  }

  broadcastSessionDetail(detail: SessionDetail) {
    this.broadcast({ type: "session.updated", detail });
  }

  broadcastRun(eventType: ServerWsEvent["type"], run: Run) {
    if (
      eventType === "run.started" ||
      eventType === "run.completed" ||
      eventType === "run.error" ||
      eventType === "run.interrupted"
    ) {
      this.broadcast({ type: eventType, run });
    }
  }

  broadcastMessageDelta(sessionId: string, runId: string, text: string) {
    this.broadcast({ type: "message.delta", sessionId, runId, text });
  }

  broadcastMessageFinal(sessionId: string, runId: string, message: SessionDetail["session"] extends never ? never : { id: string; sessionId: string; role: "assistant"; text: string; createdAt: string }) {
    this.broadcast({ type: "message.final", sessionId, runId, message });
  }

  broadcastBackendDegraded(reason: string) {
    this.broadcast({ type: "backend.degraded", reason });
  }

  broadcastPong() {
    this.broadcast({ type: "pong", ts: new Date().toISOString() });
  }

  private broadcast(event: ServerWsEvent) {
    for (const socket of this.sockets) {
      this.send(socket, event);
    }
  }

  private send(socket: SocketLike, event: ServerWsEvent) {
    if (socket.readyState !== OPEN) {
      return;
    }
    socket.send(JSON.stringify(event));
  }
}
