export type TimelineFollowMode = "following" | "detached";

export function nextTimelineFollowMode({
  currentMode,
  pinnedToBottom,
  scrollDelta: _scrollDelta,
  isProgrammaticScroll
}: {
  currentMode: TimelineFollowMode;
  pinnedToBottom: boolean;
  scrollDelta: number;
  isProgrammaticScroll: boolean;
}): TimelineFollowMode {
  if (pinnedToBottom) {
    return "following";
  }

  if (isProgrammaticScroll) {
    return currentMode;
  }

  return currentMode;
}

export function shouldAutoScrollTimelineUpdate({
  followMode,
  pinnedToBottom,
  pendingScrollToBottom,
  contentExpanded
}: {
  followMode: TimelineFollowMode;
  pinnedToBottom: boolean;
  pendingScrollToBottom: boolean;
  contentExpanded: boolean;
}) {
  if (pendingScrollToBottom) {
    return true;
  }

  if (pinnedToBottom) {
    return true;
  }

  if (followMode !== "following") {
    return false;
  }

  return contentExpanded;
}

export function timelineContentExpanded(previousEndOffset: number, nextEndOffset: number, tolerancePx = 1) {
  return nextEndOffset - previousEndOffset > tolerancePx;
}
