import { DesktopDictationWarningSchema } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  findDiscordVoiceControls,
  makeDiscordDictationMute,
} from "../../voice/DiscordDictationMute.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_DICTATION_RECORDING_CHANNEL } from "../channels.ts";

export const installDictation = Effect.fn("desktop.ipc.installDictation")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const platform = yield* HostProcess.Platform;
  const setRecording = makeDiscordDictationMute(() => findDiscordVoiceControls(platform));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* HostProcess.Environment;
  let showedPermissionHint = false;
  let contents: Electron.WebContents | undefined;

  const release = () => {
    contents?.removeListener("did-navigate", release);
    contents?.removeListener("render-process-gone", release);
    contents?.removeListener("destroyed", release);
    contents = undefined;
    return setRecording(false);
  };
  const warnIfFailed = Effect.fnUntraced(function* (failure: string | null) {
    if (failure === null) return null;
    yield* Effect.logWarning(`Discord dictation mute: ${failure}`);
    return "check-discord" as const;
  });
  yield* Effect.addFinalizer(() => Effect.asVoid(Effect.promise(release)));
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_DICTATION_RECORDING_CHANNEL,
      payload: Schema.Boolean,
      result: Schema.NullOr(DesktopDictationWarningSchema),
      handler: Effect.fn("desktop.ipc.setDictationRecording")(function* (active, event) {
        if (!active) return yield* warnIfFailed(yield* Effect.promise(release));
        if (!event) return null;
        if (
          platform === "darwin" &&
          !Electron.systemPreferences.isTrustedAccessibilityClient(false)
        ) {
          if (showedPermissionHint) return null;
          // Discord's local RPC socket lets us show the permission hint only when Discord is running.
          const socket = path.join(env.TMPDIR || "/tmp", "discord-ipc-0");
          const running = yield* fs.stat(socket).pipe(
            Effect.map((info) => info.type === "Socket"),
            Effect.orElseSucceed(() => false),
          );
          if (!running) return null;
          showedPermissionHint = true;
          return "accessibility-required" as const;
        }
        if (!contents) {
          contents = Electron.webContents.fromId(event.sender.id);
          if (!contents || contents.isDestroyed()) return null;
          contents.once("did-navigate", release);
          contents.once("render-process-gone", release);
          contents.once("destroyed", release);
        }
        return yield* warnIfFailed(yield* Effect.promise(() => setRecording(true)));
      }),
    }),
  );
});
