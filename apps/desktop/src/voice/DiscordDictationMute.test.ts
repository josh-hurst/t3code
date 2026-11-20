import { expect, it, vi } from "vite-plus/test";
import { makeDiscordDictationMute } from "./DiscordDictationMute.ts";

function discordCall(initiallyMuted = false) {
  let muted = initiallyMuted;
  const mic = {
    name: "Mute",
    role: "check_box",
    get checked() {
      return muted ? ("on" as const) : ("off" as const);
    },
    enabled: true,
    linkUrl: null as string | null,
    press: vi.fn(async () => {
      muted = !muted;
    }),
  };
  const headphones = { ...mic, name: "Deafen", checked: "off" as "off" | "on" };
  const disconnect = { ...mic, name: "Disconnect", role: "button", checked: null };
  const channel = {
    ...mic,
    role: "link",
    name: "Voice channel",
    checked: null,
    linkUrl: "https://discord.com/channels/1/2",
  };
  const controls = [mic, headphones, channel, disconnect];
  const panel = {
    read: async () => controls,
    waitForMute: async (_name: string, checked: "on" | "off") => {
      expect(mic.checked).toBe(checked);
    },
  };
  const setRecording = makeDiscordDictationMute(async () => panel);
  return { setRecording, controls, mic, headphones, channel, panel };
}

it("restores only a mute acquired in an active call", async () => {
  const call = discordCall();
  await call.setRecording(true);
  await call.setRecording(true);
  expect(call.mic.checked).toBe("on");
  await call.setRecording(false);
  await call.setRecording(false);
  expect(call.mic.checked).toBe("off");
  expect(call.mic.press).toHaveBeenCalledTimes(2);

  for (const state of ["already muted", "disconnected", "deafened", "ambiguous controls"]) {
    const call = discordCall(state === "already muted");
    if (state === "disconnected") call.controls.pop();
    if (state === "deafened") call.headphones.checked = "on";
    if (state === "ambiguous controls") call.controls.push(call.mic);
    await call.setRecording(true);
    await call.setRecording(false);
    expect(call.mic.press, state).not.toHaveBeenCalled();
  }
});

it("preserves a manual unmute or deafen during recording", async () => {
  const call = discordCall();
  await call.setRecording(true);
  await call.mic.press();
  await call.setRecording(false);
  expect(call.mic.checked).toBe("off");

  await call.setRecording(true);
  call.headphones.checked = "on";
  await call.setRecording(false);
  expect(call.mic.checked).toBe("on");

  const moved = discordCall();
  await moved.setRecording(true);
  moved.channel.linkUrl = "https://discord.com/channels/1/3";
  expect(await moved.setRecording(false)).toBe(false);
  expect(moved.mic.checked).toBe("on");
});

it("discards a late lookup and restores an in-flight mute before the next recording", async () => {
  const call = discordCall();
  const looking = Promise.withResolvers<void>();
  const lookup = Promise.withResolvers<void>();
  const setRecording = makeDiscordDictationMute(async () => {
    looking.resolve();
    await lookup.promise;
    return call.panel;
  });
  const start = setRecording(true);
  await looking.promise;
  const cancel = setRecording(false);
  lookup.resolve();
  await Promise.all([start, cancel]);
  expect(call.mic.press).not.toHaveBeenCalled();

  const pressing = Promise.withResolvers<void>();
  const applied = Promise.withResolvers<void>();
  const press = call.mic.press.getMockImplementation()!;
  call.mic.press.mockImplementationOnce(async () => {
    pressing.resolve();
    await applied.promise;
    await press();
  });
  const first = setRecording(true);
  await pressing.promise;
  const finish = setRecording(false);
  const second = setRecording(true);
  applied.resolve();
  await Promise.all([first, finish, second]);
  expect(call.mic.checked).toBe("on");
  await setRecording(false);
  expect(call.mic.checked).toBe("off");
  expect(call.mic.press).toHaveBeenCalledTimes(4);
});
