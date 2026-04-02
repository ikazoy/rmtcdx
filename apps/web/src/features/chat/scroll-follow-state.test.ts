import assert from "node:assert/strict";
import test from "node:test";

import {
  nextTimelineFollowMode,
  shouldAutoScrollTimelineUpdate,
  timelineContentExpanded
} from "./scroll-follow-state";

test("nextTimelineFollowMode does not detach on non-programmatic upward movement alone", () => {
  assert.equal(
    nextTimelineFollowMode({
      currentMode: "following",
      pinnedToBottom: false,
      scrollDelta: -12,
      isProgrammaticScroll: false
    }),
    "following"
  );
});

test("nextTimelineFollowMode resumes following whenever the timeline is still pinned", () => {
  assert.equal(
    nextTimelineFollowMode({
      currentMode: "detached",
      pinnedToBottom: true,
      scrollDelta: -6,
      isProgrammaticScroll: false
    }),
    "following"
  );
});

test("nextTimelineFollowMode resumes following when the user scrolls back to the bottom", () => {
  assert.equal(
    nextTimelineFollowMode({
      currentMode: "detached",
      pinnedToBottom: true,
      scrollDelta: 24,
      isProgrammaticScroll: false
    }),
    "following"
  );
});

test("nextTimelineFollowMode keeps detached mode on programmatic movement while still away from bottom", () => {
  assert.equal(
    nextTimelineFollowMode({
      currentMode: "detached",
      pinnedToBottom: false,
      scrollDelta: 40,
      isProgrammaticScroll: true
    }),
    "detached"
  );
});

test("shouldAutoScrollTimelineUpdate requires follow mode unless a jump is pending", () => {
  assert.equal(
    shouldAutoScrollTimelineUpdate({
      followMode: "following",
      pinnedToBottom: false,
      pendingScrollToBottom: false,
      contentExpanded: true
    }),
    true
  );

  assert.equal(
    shouldAutoScrollTimelineUpdate({
      followMode: "following",
      pinnedToBottom: false,
      pendingScrollToBottom: false,
      contentExpanded: false
    }),
    false
  );

  assert.equal(
    shouldAutoScrollTimelineUpdate({
      followMode: "detached",
      pinnedToBottom: false,
      pendingScrollToBottom: false,
      contentExpanded: true
    }),
    false
  );

  assert.equal(
    shouldAutoScrollTimelineUpdate({
      followMode: "detached",
      pinnedToBottom: false,
      pendingScrollToBottom: true,
      contentExpanded: false
    }),
    true
  );

  assert.equal(
    shouldAutoScrollTimelineUpdate({
      followMode: "detached",
      pinnedToBottom: true,
      pendingScrollToBottom: false,
      contentExpanded: false
    }),
    true
  );
});

test("timelineContentExpanded only flips when the end offset grows past tolerance", () => {
  assert.equal(timelineContentExpanded(120, 120), false);
  assert.equal(timelineContentExpanded(120, 121), false);
  assert.equal(timelineContentExpanded(120, 123), true);
});
