import assert from "node:assert/strict";
import test from "node:test";

import { RealtimeGateway } from "../../src/realtime/realtime-gateway";

type EventHandler = (value?: unknown) => void;

class MockSocket {
  readyState = 1;
  readonly sent: string[] = [];
  private readonly listeners = new Map<"message" | "close" | "error", EventHandler[]>();

  send(payload: string) {
    this.sent.push(payload);
  }

  on(event: "message" | "close" | "error", listener: EventHandler) {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
  }

  emit(event: "message" | "close" | "error", value?: unknown) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(value);
    }
  }
}

test("realtime gateway tracks focused sessions per socket", () => {
  const gateway = new RealtimeGateway(() => {});
  const socket = new MockSocket();

  gateway.register(socket, "mock");

  assert.equal(gateway.getConnectionCount(), 1);
  assert.equal(gateway.hasFocusedSessionViewer("thread-1"), false);

  socket.emit("message", JSON.stringify({ type: "session.focus", sessionId: "thread-1" }));
  assert.equal(gateway.hasFocusedSessionViewer("thread-1"), true);

  socket.emit("message", JSON.stringify({ type: "session.focus", sessionId: null }));
  assert.equal(gateway.hasFocusedSessionViewer("thread-1"), false);

  socket.emit("message", JSON.stringify({ type: "session.focus", sessionId: "thread-2" }));
  assert.equal(gateway.hasFocusedSessionViewer("thread-1"), false);
  assert.equal(gateway.hasFocusedSessionViewer("thread-2"), true);

  socket.emit("close");
  assert.equal(gateway.getConnectionCount(), 0);
  assert.equal(gateway.hasFocusedSessionViewer("thread-2"), false);
});
