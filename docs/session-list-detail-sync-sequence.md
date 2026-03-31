# Session List / Detail Sync Sequence

このメモは、一覧 poll に連動して selected session の detail を background refetch する現在の挙動を前提にしたシーケンス整理です。

## Scope

- Thread list を開く
- Thread detail を開く
- Message を送信する
- Assistant message が終わる

`messages` query の細かい改善はまだ含めません。ここでは current behavior を固定します。

## Components

- Browser / Router
- React App
- TanStack Query
- Zustand
- `bridge` REST API
- `bridge` WebSocket
- `bridge` `RunService`
- `codex app-server`

## Protocol Boundaries

- Browser -> `bridge`: HTTP REST
- Browser <-> `bridge`: WebSocket
- `bridge` <-> `codex app-server`: JSON-RPC over stdio

## Browser State

- Route state
  - `selectedSessionId`
- Query state
  - `sessionsQuery`
  - `sessionDetailQuery`
  - `messagesQuery`
  - `pendingCodexRequestsQuery`
- UI store state
  - `streaming[sessionId]`
  - `activities[sessionId]`
  - `optimisticMessage`
  - `pendingThread`
  - `pendingResponseSessionId`
  - `pendingInterruptRun`

## Notes

- `sessionsQuery` は viewport や selected thread の有無に関係なく有効で、10 秒 interval で poll します。
- mobile で detail を開いている間も、thread list の更新は裏で走ります。
- selected session の polled summary が loaded detail より先に進んだら、`sessionDetailQuery` を background refetch します。
- `message.delta` は正式履歴ではなく、一時的に `streaming[sessionId]` に蓄積して表示します。
- `message.final` 後に `messagesQuery` と `sessionDetailQuery` を invalidate して、正式履歴へ置き換えます。

## Sequence

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Browser as Browser / Router
    participant UI as React App
    participant Query as TanStack Query
    participant Store as Zustand
    participant REST as bridge REST API
    participant WS as bridge WebSocket
    participant Run as bridge RunService
    participant Codex as codex app-server\\nstdio JSON-RPC

    Note over Browser,Store: Browser state\\nselectedSessionId\\nsessionsQuery / sessionDetailQuery / messagesQuery\\nstreaming[sessionId] / activities[sessionId]\\noptimisticMessage / pendingThread / pendingResponseSessionId

    rect rgb(245,245,245)
        User->>Browser: Open thread list
        UI->>Query: useQuery(sessions)
        Query->>REST: GET /api/sessions
        REST-->>Query: SessionSummary[]
        Query-->>UI: sessionsQuery.data
        UI->>UI: build visibleSessions
        Note over Query: sessionsQuery keeps polling every 10s
    end

    rect rgb(240,248,255)
        User->>Browser: Open thread detail
        Browser->>UI: selectedSessionId update
        UI->>Query: useQuery(session detail)
        UI->>Query: useQuery(messages)
        UI->>Query: useQuery(pending requests)
        Query->>REST: GET /api/sessions/:id
        REST-->>Query: SessionDetail
        Query->>REST: GET /api/sessions/:id/messages
        REST-->>Query: MessagesResponse
        Query-->>UI: detail + messages
        UI->>UI: merge detail with selectedPolledSessionSummary

        Query->>REST: GET /api/sessions (poll)
        REST-->>Query: updated SessionSummary[]
        Query-->>UI: selectedPolledSessionSummary update
        UI->>UI: compare summary sync key vs detail sync key
        alt summary is ahead of detail
            UI->>Query: invalidate session detail
            Query->>REST: GET /api/sessions/:id
            REST-->>Query: fresh SessionDetail
            Query-->>UI: detail refresh
        else summary matches detail
            UI->>UI: keep current detail cache
        end
    end

    rect rgb(245,255,245)
        User->>Browser: Send message
        UI->>Store: set optimisticMessage
        UI->>Store: set pendingThread
        UI->>Store: set pendingResponseSessionId
        UI->>Query: startRun mutation
        Query->>REST: POST /api/runs
        REST->>Run: start()
        Run->>Codex: thread/resume + run/start\\nJSON-RPC over stdio
        Codex-->>Run: run started
        REST-->>Query: RunResponse
        Query-->>UI: mutation success
        UI->>Store: update pendingInterruptRun
        UI->>Query: invalidate sessions + session + messages
    end

    rect rgb(255,248,240)
        Codex-->>Run: item/agentMessage/delta
        Run-->>WS: message.delta
        WS-->>Browser: WebSocket message.delta
        Browser->>Store: append streaming[sessionId]
        UI->>UI: render temporary assistant bubble

        Codex-->>Run: item/completed(agentMessage)
        Codex-->>Run: turn/completed or turn/interrupted or turn/failed
        Run-->>WS: message.final + run terminal event
        WS-->>Browser: WebSocket message.final / run.*
        Browser->>Store: clear streaming[sessionId]
        Browser->>Store: clear activities[sessionId]
        Browser->>Query: invalidate messages + session + sessions + pending requests
        Query->>REST: GET /api/sessions/:id/messages
        Query->>REST: GET /api/sessions/:id
        Query->>REST: GET /api/sessions
        REST-->>Query: fresh history/detail/list
        Query-->>UI: render committed history
    end
```
