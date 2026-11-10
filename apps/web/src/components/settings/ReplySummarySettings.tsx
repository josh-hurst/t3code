import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Equal from "effect/Equal";

import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { toastManager } from "../ui/toast";
import { ScopedSwitch } from "./ScopedSwitch";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
} from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function ReplySummarySettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, connectedEnvironments, target } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const mixedEnabled = useScopedSettingsMixed(["threadReplySummariesEnabled"]);
  const mixedModel = useScopedSettingsMixed(["threadReplySummaryModelSelection"]);
  const providersByEnvironment = useEnvironmentProviders();
  const textGenerationProviders = (
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS
  ).filter((provider) => provider.supportsTextGeneration !== false);
  const instanceEntries = providerInstanceEntriesFor(
    textGenerationProviders,
    settings,
    target?.projectId ?? null,
  );
  const selection = resolveAppModelSelectionState(
    { ...settings, textGenerationModelSelection: settings.threadReplySummaryModelSelection },
    textGenerationProviders,
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    selection.instanceId,
    selection.model,
  );
  const modelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const isModelDirty = !Equal.equals(
    settings.threadReplySummaryModelSelection,
    DEFAULT_UNIFIED_SETTINGS.threadReplySummaryModelSelection,
  );

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["threadReplySummariesEnabled"]}
        {...searchableSetting("reply-summaries")}
        description="Rows that show the latest message show a few-word summary of the agent's reply instead. Each new reply costs one short generation."
        control={
          <ScopedSwitch
            settingKeys={["threadReplySummariesEnabled"]}
            checked={settings.threadReplySummariesEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ threadReplySummariesEnabled: Boolean(checked) })
            }
            aria-label="Summarize latest reply"
          />
        }
      />
      {settings.threadReplySummariesEnabled || mixedEnabled ? (
        <SettingsRow
          serverScoped
          settingKeys={["threadReplySummaryModelSelection"]}
          {...searchableSetting("reply-summary-model")}
          description="Model that writes reply summaries. A fast, cheap model is enough."
          resetAction={
            isModelDirty ? (
              <SettingResetButton
                label="reply summary model"
                onClick={() =>
                  updateSettings({
                    threadReplySummaryModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.threadReplySummaryModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            connectedEnvironments.length === 0 ? (
              <span className="text-sm text-muted-foreground">
                Connect an environment to choose its reply summary model.
              </span>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  environmentId={environmentId}
                  activeInstanceId={selection.instanceId}
                  model={selection.model}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  triggerAriaLabel="Reply summary model"
                  {...(mixedModel ? { triggerLabel: "Mixed" } : {})}
                  getModelDisabledReason={modelDisabledReason}
                  onInstanceModelChange={(instanceId, model) => {
                    const reason = modelDisabledReason(instanceId, model);
                    if (reason) {
                      toastManager.add({
                        type: "error",
                        title: "Reply summary model not saved",
                        description: reason,
                      });
                      return;
                    }
                    updateSettings({
                      threadReplySummaryModelSelection: createModelSelection(instanceId, model),
                    });
                  }}
                />
                {instanceEntry && !mixedModel ? (
                  <TraitsPicker
                    provider={instanceEntry.driverKind}
                    models={instanceEntry.models}
                    model={selection.model}
                    modelOptions={selection.options ?? []}
                    allowPromptInjectedEffort={false}
                    includePlanAgent={selectsPlanAgent(selection.options)}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onModelOptionsChange={(options) =>
                      updateSettings({
                        threadReplySummaryModelSelection: createModelSelection(
                          selection.instanceId,
                          selection.model,
                          options,
                        ),
                      })
                    }
                  />
                ) : null}
              </div>
            )
          }
        />
      ) : null}
    </>
  );
}
