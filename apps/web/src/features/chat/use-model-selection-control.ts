import { useState } from "react";

import type { CodexAvailableModel, CodexRunSettings } from "@codex-remote/shared-types";

import {
  DEFAULT_MODEL_OPTION,
  CUSTOM_MODEL_OPTION,
  buildModelSelectionState,
  findModelSelectionOption,
  shouldShowCustomModelInput
} from "./model-selection";
import type { ModelSelectionOption } from "./model-selection";
import type { ResolvedRunSettings } from "./run-settings";

type RunSettingsChangeHandler = (settings: CodexRunSettings) => void;

export type ModelSelectionControlState = {
  defaultModelLabel: string;
  defaultModelDescription: string;
  modelSelectionOptions: ModelSelectionOption[];
  modelSelectionValue: string;
  modelFieldNote: string;
  showModelPicker: boolean;
  showCustomModelInput: boolean;
  resetModelSelectionState: () => void;
  onModelSelectionChange: (value: string) => void;
  onCustomModelInputChange: (model: string) => void;
};

export function useModelSelectionControl({
  availableModels,
  runSettings,
  onRunSettingsChange
}: {
  availableModels: CodexAvailableModel[];
  runSettings: ResolvedRunSettings;
  onRunSettingsChange: RunSettingsChangeHandler;
}): ModelSelectionControlState {
  const [isManualCustomModelSelection, setIsManualCustomModelSelection] = useState(false);
  const selectedModel = typeof runSettings.model === "string" ? runSettings.model.trim() : "";
  const selectedServiceTier = runSettings.serviceTier ?? null;
  const modelSelectionState = buildModelSelectionState(availableModels);
  const matchedModelSelectionOption = findModelSelectionOption(
    modelSelectionState.modelSelectionOptions,
    selectedModel,
    selectedServiceTier
  );
  const showModelPicker = availableModels.length > 0;
  const showCustomModelInput = shouldShowCustomModelInput({
    showModelPicker,
    selectedModel,
    selectedServiceTier,
    matchedModelSelectionOption,
    isManualCustomModelSelection
  });
  const modelSelectionValue = showModelPicker
    ? showCustomModelInput
      ? CUSTOM_MODEL_OPTION
      : matchedModelSelectionOption?.value ?? DEFAULT_MODEL_OPTION
    : CUSTOM_MODEL_OPTION;
  const modelFieldNote = !showModelPicker
    ? "Model discovery is unavailable right now. Enter a model id directly."
    : showCustomModelInput
      ? "Use a custom model id when the model is not listed."
      : matchedModelSelectionOption
        ? matchedModelSelectionOption.note
        : modelSelectionState.defaultModelNote;

  function onModelSelectionChange(value: string) {
    if (value === DEFAULT_MODEL_OPTION) {
      setIsManualCustomModelSelection(false);
      onRunSettingsChange({
        ...runSettings,
        serviceTier: null,
        model: ""
      });
      return;
    }

    if (value === CUSTOM_MODEL_OPTION) {
      setIsManualCustomModelSelection(true);
      onRunSettingsChange({
        ...runSettings,
        serviceTier: null,
        model: matchedModelSelectionOption ? "" : selectedModel
      });
      return;
    }

    const selected = modelSelectionState.modelSelectionOptions.find((opt) => opt.value === value) ?? null;
    if (!selected) {
      return;
    }

    setIsManualCustomModelSelection(false);
    onRunSettingsChange({
      ...runSettings,
      serviceTier: selected.serviceTier,
      model: selected.model ?? ""
    });
  }

  function onCustomModelInputChange(model: string) {
    const trimmedModel = model.trim();
    const matchedKnownOption = trimmedModel
      ? findModelSelectionOption(modelSelectionState.modelSelectionOptions, trimmedModel, null)
      : null;

    onRunSettingsChange({
      ...runSettings,
      serviceTier: null,
      model
    });

    if (matchedKnownOption) {
      setIsManualCustomModelSelection(false);
    }
  }

  function resetModelSelectionState() {
    setIsManualCustomModelSelection(false);
  }

  return {
    defaultModelLabel: modelSelectionState.defaultModelLabel,
    defaultModelDescription: modelSelectionState.defaultModelDescription,
    modelSelectionOptions: modelSelectionState.modelSelectionOptions,
    modelSelectionValue,
    modelFieldNote,
    showModelPicker,
    showCustomModelInput,
    resetModelSelectionState,
    onModelSelectionChange,
    onCustomModelInputChange
  };
}
