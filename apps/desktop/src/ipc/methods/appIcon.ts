import { DesktopAppIconSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopAppIcon from "../../app/DesktopAppIcon.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getAppIcon = makeIpcMethod({
  channel: IpcChannels.GET_APP_ICON_CHANNEL,
  payload: Schema.Void,
  result: DesktopAppIconSchema,
  handler: Effect.fn("desktop.ipc.appIcon.get")(function* () {
    return yield* (yield* DesktopAppIcon.DesktopAppIcon).get;
  }),
});

export const setAppIcon = makeIpcMethod({
  channel: IpcChannels.SET_APP_ICON_CHANNEL,
  payload: DesktopAppIconSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appIcon.set")(function* (icon) {
    yield* (yield* DesktopAppIcon.DesktopAppIcon).set(icon);
  }),
});
