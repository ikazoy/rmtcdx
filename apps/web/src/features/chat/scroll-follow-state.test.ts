import assert from "node:assert/strict";
import test from "node:test";

import {
  nextTimelineFollowMode,
  shouldAutoScrollTimelineUpdate,
  timelineContentExpanded
} from "./scroll-follow-state";

test("nextTimelineFollowMode detaches on user upward scroll", () => {
  assert.equal(
    nextTimelineFollowMode({
      currentMode: "following",
      pinnedToBottom: false,
      scrollDelta: -12,
      isProgrammaticScroll: false
    }),
    "detached"
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

test("nextTimelineFollowMode ignores programmatic scroll movement", () => {
  assert.equal(
    nextTimelineFollowMode({
      currentMode: "detached",
      pinnedToBottom: true,
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
      pendingScrollToBottom: false,
      contentExpanded: true
    }),
    true
  );

  assert.equal(
    shouldAutoScrollTimelineUpdate({
      followMode: "following",
      pendingScrollToBottom: false,
      contentExpanded: false
    }),
    false
  );

  assert.equal(
    shouldAutoScrollTimelineUpdate({
      followMode: "detached",
      pendingScrollToBottom: false,
      contentExpanded: true
    }),
    false
  );

  assert.equal(
    shouldAutoScrollTimelineUpdate({
      followMode: "detached",
      pendingScrollToBottom: true,
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
