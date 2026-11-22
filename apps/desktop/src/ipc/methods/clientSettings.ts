import { ClientSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import { applyLanguage } from "../../i18n/messages.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import * as DesktopMenuBarItem from "../../window/DesktopMenuBarItem.ts";
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
    const menuBarItem = yield* DesktopMenuBarItem.DesktopMenuBarItem;
    yield* clientSettings.set(settings);
    yield* snapShot.configure(settings);
    yield* menuBarItem.configure(settings);
    yield* applyLanguage(settings.language);
    // Each window keeps its own copy; the writer already has these, and a refresh could race it.
    for (const window of Electron.BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && window.webContents.id !== event?.sender.id) {
        window.webContents.send(IpcChannels.CLIENT_SETTINGS_CHANGED_CHANNEL);
      }
    }
  }),
});

// Window glass is fixed when a window is created; a live window that turns transparent keeps
// stale frames, so changing it relaunches the app.
export const relaunchForWindowGlass = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RELAUNCH_FOR_WINDOW_GLASS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.clientSettings.relaunchForWindowGlass")(function* () {
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    yield* lifecycle.relaunch("windowGlassEnabled");
  }),
});
