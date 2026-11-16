import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const LIMITS = Array.from({ length: 11 }, (_, limit) => limit);
const limitLabel = (limit: number) => (limit === 0 ? "Off" : String(limit));

export function LaterRecheckSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const limit = settings.laterRecheckLimit;
  return (
    <SettingsRow
      serverScoped
      settingKeys={["laterRecheckLimit"]}
      {...searchableSetting("later-recheck-limit")}
      description="An agent can schedule its own re-check and run it later without you. After this many in a row with no news, it must report what it found. Off stops agent re-checks; yours still work."
      resetAction={
        limit !== DEFAULT_SERVER_SETTINGS.laterRecheckLimit ? (
          <SettingResetButton
            label="unattended re-checks"
            onClick={() =>
              updateSettings({ laterRecheckLimit: DEFAULT_SERVER_SETTINGS.laterRecheckLimit })
            }
          />
        ) : null
      }
      control={
        <Select
          value={String(limit)}
          onValueChange={(value) => {
            const next = Number(value);
            if (LIMITS.includes(next)) updateSettings({ laterRecheckLimit: next });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-24" aria-label="Unattended re-checks">
            <SelectValue>{limitLabel(limit)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {LIMITS.map((value) => (
              <SelectItem hideIndicator key={value} value={String(value)}>
                {limitLabel(value)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
