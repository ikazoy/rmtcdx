import type { CodexAvailableModel, CodexServiceTier } from "@codex-remote/shared-types";

export const DEFAULT_MODEL_OPTION = "__default";
export const CUSTOM_MODEL_OPTION = "__custom";

// `model/list` does not currently advertise supported service tiers, so keep the UI
// conservative and only expose the known fast-tier preset.
const FAST_TIER_MODEL = "gpt-5.4";

export type ModelSelectionOption = {
  value: string;
  label: string;
  description: string;
  model: string | null;
  serviceTier: CodexServiceTier | null;
  note: string;
};

export type BuiltModelSelectionState = {
  defaultModel: CodexAvailableModel | null;
  defaultModelLabel: string;
  defaultModelDescription: string;
  defaultModelNote: string;
  modelSelectionOptions: ModelSelectionOption[];
};

export function modelSelectionOptionValue(model: string, serviceTier: CodexServiceTier | null) {
  return serviceTier ? `${model}::${serviceTier}` : model;
}

export function findModelSelectionOption(
  options: ModelSelectionOption[],
  model: string,
  serviceTier: CodexServiceTier | null
) {
  return options.find((option) => option.model === model && option.serviceTier === serviceTier) ?? null;
}

export function buildModelSelectionState(availableModels: CodexAvailableModel[]): BuiltModelSelectionState {
  const defaultModel = availableModels.find((model) => model.isDefault) ?? null;
  const modelSelectionOptions = availableModels.flatMap((model) => {
    const pinsCurrentDefault = defaultModel?.id === model.id;
    const options: ModelSelectionOption[] = [
      {
        value: modelSelectionOptionValue(model.model, null),
        label: model.displayName,
        description: pinsCurrentDefault
          ? `Pin to ${model.displayName} instead of following backend default changes.`
          : model.description,
        model: model.model,
        serviceTier: null,
        note: pinsCurrentDefault
          ? `${model.description} Pins runs to ${model.displayName} instead of following the backend default. Default reasoning: ${model.defaultReasoningEffort}.`
          : `${model.description} Default reasoning: ${model.defaultReasoningEffort}.`
      }
    ];

    if (model.model === FAST_TIER_MODEL) {
      options.push({
        value: modelSelectionOptionValue(model.model, "fast"),
        label: `${model.displayName} Fast`,
        description: `Use the fast service tier with ${model.displayName}.`,
        model: model.model,
        serviceTier: "fast",
        note: `${model.description} Uses the fast service tier. Default reasoning: ${model.defaultReasoningEffort}.`
      });
    }

    return options;
  });

  const defaultModelLabel = defaultModel ? `Default (${defaultModel.displayName})` : "Default";
  const defaultModelDescription = defaultModel
    ? `Currently ${defaultModel.displayName}. Follow the backend default model.`
    : "Follow the backend default model.";
  const defaultModelNote = defaultModel
    ? `${defaultModel.description} Uses the backend default model selection for the next run.`
    : "Use the backend default model selection for the next run.";

  return {
    defaultModel,
    defaultModelLabel,
    defaultModelDescription,
    defaultModelNote,
    modelSelectionOptions
  };
}

export function shouldShowCustomModelInput(params: {
  showModelPicker: boolean;
  selectedModel: string;
  selectedServiceTier: CodexServiceTier | null;
  matchedModelSelectionOption: ModelSelectionOption | null;
  isManualCustomModelSelection: boolean;
}) {
  return !params.showModelPicker
    || params.isManualCustomModelSelection
    || Boolean((params.selectedModel || params.selectedServiceTier) && !params.matchedModelSelectionOption);
}
