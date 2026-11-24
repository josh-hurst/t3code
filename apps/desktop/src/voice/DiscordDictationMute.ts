import type { Element } from "@crowecawcaw/xa11y";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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

// Only reads may time out, resolving undefined. A late native press must finish before its matching restore.
function readWithinDeadline<A>(read: () => Promise<A>) {
  return Effect.runPromise(
    Effect.promise(read).pipe(Effect.timeoutOption("2 seconds"), Effect.map(Option.getOrUndefined)),
  );
}

function describeControls(controls: readonly VoiceControl[]) {
  const voice = controls
    .filter((control) => muteNames.has(control.name ?? "") || deafenNames.has(control.name ?? ""))
    .map(
      (control) =>
        `${control.name} (${control.role}, checked ${control.checked}, enabled ${control.enabled})`,
    );
  return `${controls.length} controls; ${voice.join(", ") || "no mute or deafen control"}`;
}

/** Each call resolves to null, or to why Discord's mic could not be muted or restored. */
export function makeDiscordDictationMute(findControls: () => Promise<DiscordPanel | null>) {
  let recording = false;
  let transition = Promise.resolve<string | null>(null);
  let restore: { panel: DiscordPanel; channel: string | null | undefined } | undefined;
  let generation = 0;

  return (active: boolean) => {
    if (recording === active) return transition;
    recording = active;
    const current = ++generation;
    transition = transition
      .then(async () => {
        if (active) {
          if (generation !== current) return null;
          const found = await readWithinDeadline(async () => {
            const panel = await findControls();
            return panel && { panel, controls: await panel.read() };
          });
          if (generation !== current || found === null) return null;
          if (!found) return "reading Discord's voice panel timed out";
          if (!found.controls.length) return "Discord's voice panel was empty";
          const { connected, deafened, microphone, channel } = voiceState(found.controls);
          if (!connected || deafened === "on" || microphone?.checked === "on") return null;
          if (deafened !== "off" || !microphone?.enabled || microphone.checked !== "off")
            return `unexpected mute state: ${describeControls(found.controls)}`;
          await microphone.press();
          restore = { panel: found.panel, channel };
          await found.panel.waitForMute(microphone.name!, "on");
        } else if (restore) {
          const { panel, channel } = restore;
          restore = undefined;
          const controls = await readWithinDeadline(panel.read);
          if (!controls) return "reading Discord's voice panel timed out";
          if (!controls.length) return "Discord's voice panel was empty";
          const state = voiceState(controls);
          if (state.deafened === "on" || state.microphone?.checked === "off") return null;
          if (state.connected && channel && channel !== state.channel)
            return "moved to another voice channel";
          if (
            state.deafened !== "off" ||
            !state.microphone?.enabled ||
            state.microphone.checked !== "on"
          )
            return `unexpected mute state: ${describeControls(controls)}`;
          await state.microphone.press();
          await panel.waitForMute(state.microphone.name!, "off");
        }
        return null;
      })
      .catch(
        (error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    return transition;
  };
}
