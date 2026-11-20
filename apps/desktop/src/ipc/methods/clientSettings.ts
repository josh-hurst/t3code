import { ClientSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import { setWindowGlass } from "../../window/windowGlass.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CLIENT_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(ClientSettingsSchema),
  handler: Effect.fn("desktop.ipc.clientSettings.get")(function* () {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    return Option.getOrNull(yield* clientSettings.get);
  }),
});

export const setClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CLIENT_SETTINGS_CHANNEL,
  payload: ClientSettingsSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.clientSettings.set")(function* (settings, event) {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    const snapShot = yield* DesktopSnapShot.DesktopSnapShot;
    const previous = yield* clientSettings.get.pipe(
      Effect.orElseSucceed(() => Option.none<typeof settings>()),
    );
    yield* clientSettings.set(settings);
    yield* snapShot.configure(settings);
    if (
      Option.match(previous, {
        onNone: () => settings.windowGlassEnabled,
        onSome: (current) => current.windowGlassEnabled !== settings.windowGlassEnabled,
      })
    ) {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      const shouldUseDarkColors = yield* (yield* ElectronTheme.ElectronTheme).shouldUseDarkColors;
      const main = yield* (yield* ElectronWindow.ElectronWindow).main;
      if (Option.isSome(main)) {
        setWindowGlass(
          main.value,
          settings.windowGlassEnabled,
          environment.platform,
          shouldUseDarkColors,
        );
      }
    }
    // Each window keeps its own copy; the writer already has these, and a refresh could race it.
    for (const window of Electron.BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && window.webContents.id !== event?.sender.id) {
        window.webContents.send(IpcChannels.CLIENT_SETTINGS_CHANGED_CHANNEL);
      }
    }
  }),
});
