# UI Responsiveness Principles

This document defines the core principles for keeping the Codex Remote UI
feeling fast and responsive. Every user-initiated action should produce
**immediate visual feedback** — even before the server responds.

---

## 1. Optimistic Navigation

**Principle**: User clicks on navigation elements (session rows, "New session"
button) must update the URL / active view **synchronously** in the same event
handler tick. Never gate a navigation behind a network request or
`startTransition`.

**Pattern**:
- Set `selectedSessionId` and `mobilePane` directly via Zustand — no
  `startTransition` wrapper for urgent user-initiated navigations.
- Show a skeleton / placeholder for the target pane while data loads.

## 2. Skeleton-First Loading

**Principle**: When data is not yet available for a view the user navigated to,
render a lightweight **skeleton placeholder** that mirrors the final layout.
Never show a blank screen or an empty-state message while a query is in flight.

**Pattern**:
- ChatPane renders a skeleton header + skeleton timeline rows when
  `sessionDetailQuery` is loading but `selectedSessionId` is set.
- Skeletons use CSS `pulse` animation for a polished feel.

## 3. Optimistic Input Reflection

**Principle**: After the user submits a form or message, **immediately** reflect
the input in the UI. Clear the composer, show the user's message in the
timeline, and display a "thinking" indicator — all before the API call resolves.

**Pattern**:
- Clear the composer textarea and attached images **before** `await onSubmit()`.
- Set the optimistic user message **before** starting the file-to-dataURL
  conversion and API call.
- Use blob URLs for instant image previews; convert to data URLs in the
  background for the actual request.

## 4. Fire-and-Forget Mutations

**Principle**: After a mutation succeeds, **do not** block the UI on cache
invalidation. Invalidate queries in parallel and without awaiting the result
when the optimistic state is already correct.

**Pattern**:
- Use `Promise.all` for independent `queryClient.invalidateQueries` calls.
- Use `void` (fire-and-forget) when the UI already reflects the correct state
  via optimistic data and the invalidation is only for eventual consistency.

## 5. Prefetch on Intent

**Principle**: Anticipate user intent and **prefetch** data before the user
commits to an action. Hovering a session row is a strong signal that the user
is about to click it.

**Pattern**:
- `queryClient.prefetchQuery` for session detail and messages when the user
  hovers (`onMouseEnter`) a session row in the sidebar.
- Use a short `staleTime` (e.g., 30 seconds) so prefetched data is reused on
  click without an extra request.

## 6. Non-Blocking Transitions

**Principle**: Reserve `startTransition` for **low-priority** derived state
updates (e.g., filtering a large list via `useDeferredValue`). Never use it
for direct user navigation actions — those must be synchronous.

**Pattern**:
- `selectSession`, `onCreateSession`: update Zustand state directly.
- `setSearch` with `useDeferredValue`: appropriate use of transition for
  debounced filtering.

---

## Checklist for New Features

When adding a new interactive feature, verify:

- [ ] Does the user see feedback within **one frame** (~16 ms) of their action?
- [ ] Is there a skeleton/placeholder for any async data the view depends on?
- [ ] Are form inputs cleared optimistically before the API call?
- [ ] Are cache invalidations parallelized and non-blocking where possible?
- [ ] Is data prefetched on hover for likely next navigations?
