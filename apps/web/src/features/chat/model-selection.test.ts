import assert from "node:assert/strict";
import test from "node:test";

import type { CodexAvailableModel } from "@codex-remote/shared-types";

import {
  buildModelSelectionState,
  findModelSelectionOption,
  shouldShowCustomModelInput
} from "./model-selection";

function createModel(overrides: Partial<CodexAvailableModel>): CodexAvailableModel {
  return {
    id: overrides.id ?? "model-id",
    model: overrides.model ?? "gpt-5.4",
    displayName: overrides.displayName ?? "GPT-5.4",
    description: overrides.description ?? "Frontier model.",
    hidden: overrides.hidden ?? false,
    supportedReasoningEfforts: overrides.supportedReasoningEfforts ?? [
      { reasoningEffort: "medium", description: "Balanced default." }
    ],
    defaultReasoningEffort: overrides.defaultReasoningEffort ?? "medium",
    inputModalities: overrides.inputModalities ?? ["text"],
    supportsPersonality: overrides.supportsPersonality ?? true,
    isDefault: overrides.isDefault ?? false
  };
}

test("buildModelSelectionState keeps default and pinned current default distinct without a `Fixed` suffix", () => {
  const currentDefault = createModel({
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "Frontier default model.",
    isDefault: true
  });
  const mini = createModel({
    id: "gpt-5.4-mini",
    model: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    description: "Smaller model."
  });

  const state = buildModelSelectionState([currentDefault, mini]);
  const pinnedCurrentDefault = state.modelSelectionOptions.find(
    (option) => option.model === "gpt-5.4" && option.serviceTier === null
  );

  assert.equal(state.defaultModelLabel, "Default (GPT-5.4)");
  assert.match(state.defaultModelDescription, /Currently GPT-5\.4\./);
  assert.match(state.defaultModelDescription, /Follow the backend default model\./);
  assert.equal(pinnedCurrentDefault?.label, "GPT-5.4");
  assert.doesNotMatch(pinnedCurrentDefault?.label ?? "", /Fixed/);
  assert.match(pinnedCurrentDefault?.description ?? "", /Pin to GPT-5\.4/);
  assert.match(pinnedCurrentDefault?.note ?? "", /Pins runs to GPT-5\.4/);
});

test("buildModelSelectionState follows whichever model the backend marks as default", () => {
  const nextDefault = createModel({
    id: "o4",
    model: "o4",
    displayName: "o4",
    description: "New default model.",
    isDefault: true
  });
  const previousDefault = createModel({
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "Previous model."
  });

  const state = buildModelSelectionState([nextDefault, previousDefault]);
  const pinnedNextDefault = state.modelSelectionOptions.find((option) => option.model === "o4" && option.serviceTier === null);

  assert.equal(state.defaultModelLabel, "Default (o4)");
  assert.match(state.defaultModelDescription, /Currently o4\./);
  assert.equal(pinnedNextDefault?.label, "o4");
  assert.match(pinnedNextDefault?.description ?? "", /Pin to o4/);
});

test("findModelSelectionOption matches the exact preset or tiered model entry", () => {
  const state = buildModelSelectionState([
    createModel({
      id: "gpt-5.4",
      model: "gpt-5.4",
      displayName: "GPT-5.4",
      description: "Frontier default model.",
      isDefault: true
    }),
    createModel({
      id: "gpt-5.4-mini",
      model: "gpt-5.4-mini",
      displayName: "GPT-5.4 Mini",
      description: "Smaller model."
    })
  ]);

  assert.equal(findModelSelectionOption(state.modelSelectionOptions, "gpt-5.4-mini", null)?.value, "gpt-5.4-mini");
  assert.equal(findModelSelectionOption(state.modelSelectionOptions, "gpt-5.4", "fast")?.value, "gpt-5.4::fast");
  assert.equal(findModelSelectionOption(state.modelSelectionOptions, "gpt-5.4", "flex"), null);
});

test("shouldShowCustomModelInput only falls back to custom while loading or for unmatched model ids", () => {
  const state = buildModelSelectionState([
    createModel({
      id: "gpt-5.4",
      model: "gpt-5.4",
      displayName: "GPT-5.4",
      description: "Frontier default model.",
      isDefault: true
    }),
    createModel({
      id: "gpt-5.4-mini",
      model: "gpt-5.4-mini",
      displayName: "GPT-5.4 Mini",
      description: "Smaller model."
    })
  ]);
  const miniOption = state.modelSelectionOptions.find(
    (option) => option.model === "gpt-5.4-mini" && option.serviceTier === null
  ) ?? null;

  assert.equal(
    shouldShowCustomModelInput({
      showModelPicker: false,
      selectedModel: "gpt-5.4-mini",
      selectedServiceTier: null,
      matchedModelSelectionOption: miniOption,
      isManualCustomModelSelection: false
    }),
    true
  );

  assert.equal(
    shouldShowCustomModelInput({
      showModelPicker: true,
      selectedModel: "gpt-5.4-mini",
      selectedServiceTier: null,
      matchedModelSelectionOption: miniOption,
      isManualCustomModelSelection: false
    }),
    false
  );

  assert.equal(
    shouldShowCustomModelInput({
      showModelPicker: true,
      selectedModel: "",
      selectedServiceTier: null,
      matchedModelSelectionOption: null,
      isManualCustomModelSelection: true
    }),
    true
  );
});
