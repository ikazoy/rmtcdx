export type TimelineFollowMode = "following" | "detached";

export function nextTimelineFollowMode({
  currentMode,
  pinnedToBottom,
  scrollDelta,
  isProgrammaticScroll
}: {
  currentMode: TimelineFollowMode;
  pinnedToBottom: boolean;
  scrollDelta: number;
  isProgrammaticScroll: boolean;
}): TimelineFollowMode {
  if (isProgrammaticScroll) {
    return currentMode;
  }

  if (scrollDelta < -1) {
    return "detached";
  }

  if (pinnedToBottom && scrollDelta > 1) {
    return "following";
  }

  return currentMode;
}

export function shouldAutoScrollTimelineUpdate({
  followMode,
  pendingScrollToBottom,
  contentExpanded
}: {
  followMode: TimelineFollowMode;
  pendingScrollToBottom: boolean;
  contentExpanded: boolean;
}) {
  if (pendingScrollToBottom) {
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
