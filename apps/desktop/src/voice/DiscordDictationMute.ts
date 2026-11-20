import type { Element } from "@crowecawcaw/xa11y";
import * as Effect from "effect/Effect";
import voiceLabels from "./discordVoiceLabels.json" with { type: "json" };

type VoiceControl = Pick<Element, "name" | "role" | "checked" | "enabled" | "linkUrl" | "press">;
interface DiscordPanel {
  readonly read: () => Promise<readonly VoiceControl[]>;
  readonly waitForMute: (name: string, checked: "on" | "off") => Promise<void>;
}

const labels = Object.values(voiceLabels);
const muteNames = new Set(labels.map((label) => label.mute));
const deafenNames = new Set(labels.map((label) => label.deafen));
const disconnectNames = new Set(
  labels.flatMap((label) => [label.disconnect, label.disconnectQuietly]),
);
const panels = Object.keys(voiceLabels)
  .map((name) => `[name=${JSON.stringify(name)}]`)
  .join(",");

export async function findDiscordVoiceControls(
  platform: NodeJS.Platform,
): Promise<DiscordPanel | null> {
  const { App } = await import("@crowecawcaw/xa11y");
  const discord = await App.find((app) => /^discord(?:\.exe)?$/i.test(app.name), {
    timeout: 0,
  }).catch(() => null);
  if (!discord) return null;
  if (platform === "darwin") await discord.enableWebAccessibility({ timeout: 1_000 });
  const panel = discord.locator(panels);
  const controls = panel.descendant("*");
  return {
    read: () => controls.elements(),
    waitForMute: (name, checked) =>
      panel
        .descendant(`[name=${JSON.stringify(name)}]`)
        .waitUntil((mic) => mic?.checked === checked, { timeout: 1_000 }),
  };
}

function voiceState(controls: readonly VoiceControl[]) {
  const switches = controls.filter((control) => control.checked !== null);
  const microphones = switches.filter((control) => muteNames.has(control.name ?? ""));
  const headphones = switches.filter((control) => deafenNames.has(control.name ?? ""));
  return {
    microphone: microphones.length === 1 ? microphones[0] : undefined,
    deafened: headphones.length === 1 ? headphones[0]?.checked : undefined,
    connected: controls.some(
      (control) => control.role === "button" && disconnectNames.has(control.name ?? ""),
    ),
    channel: controls.find(
      (control) =>
        control.role === "link" && /\/channels\/(?:@me|\d+)\/\d+\/?$/.test(control.linkUrl ?? ""),
    )?.linkUrl,
  };
}

// Only reads may time out. A late native press must finish before its matching restore.
function readWithinDeadline<A>(read: () => Promise<A>) {
  return Effect.runPromise(
    Effect.promise(() => read().catch(() => undefined)).pipe(
      Effect.timeout("2 seconds"),
      Effect.orElseSucceed(() => undefined),
    ),
  );
}

export function makeDiscordDictationMute(findControls: () => Promise<DiscordPanel | null>) {
  let recording = false;
  let transition = Promise.resolve(true);
  let restore: { panel: DiscordPanel; channel: string | null | undefined } | undefined;
  let generation = 0;

  return (active: boolean) => {
    if (recording === active) return transition;
    recording = active;
    const current = ++generation;
    transition = transition
      .then(async () => {
        if (active) {
          if (generation !== current) return true;
          const found = await readWithinDeadline(async () => {
            const panel = await findControls();
            return panel && { panel, controls: await panel.read() };
          });
          if (generation !== current || found === null) return true;
          if (!found?.controls.length) return false;
          const { connected, deafened, microphone, channel } = voiceState(found.controls);
          if (!connected || deafened === "on" || microphone?.checked === "on") return true;
          if (deafened !== "off" || !microphone?.enabled || microphone.checked !== "off")
            return false;
          await microphone.press();
          restore = { panel: found.panel, channel };
          await found.panel.waitForMute(microphone.name!, "on");
        } else if (restore) {
          const { panel, channel } = restore;
          restore = undefined;
          const controls = await readWithinDeadline(panel.read);
          if (!controls?.length) return false;
          const state = voiceState(controls);
          if (state.deafened === "on" || state.microphone?.checked === "off") return true;
          if (state.connected && channel && channel !== state.channel) return false;
          if (
            state.deafened !== "off" ||
            !state.microphone?.enabled ||
            state.microphone.checked !== "on"
          )
            return false;
          await state.microphone.press();
          await panel.waitForMute(state.microphone.name!, "off");
        }
        return true;
      })
      .catch(() => false);
    return transition;
  };
}
