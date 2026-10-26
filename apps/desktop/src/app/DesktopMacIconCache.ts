import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

// The Dock and Finder keep showing the previous version's icon after an update replaces the bundle.
const { logInfo, logWarning } = makeComponentLogger("desktop-mac-icon-cache");

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export class DesktopMacIconCache extends Context.Service<
  DesktopMacIconCache,
  {
    readonly refreshAfterInstall: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopMacIconCache") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const bundlePath = environment.path.resolve(environment.resourcesPath, "..", "..");
  const markerPath = environment.path.join(environment.stateDir, "icon-cache-version");

  const run = (command: string, args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, args, {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            forceKillAfter: "1 second",
          }),
        );
        return yield* handle.exitCode.pipe(Effect.timeout("10 seconds"));
      }),
    );

  const refreshAfterInstall = Effect.gen(function* () {
    if (environment.platform !== "darwin" || !environment.isPackaged) return;
    const lastVersion = yield* fileSystem
      .readFileString(markerPath)
      .pipe(Effect.orElseSucceed(() => ""));
    if (lastVersion.trim() === environment.appVersion) return;

    const now = yield* Clock.currentTimeMillis;
    yield* fileSystem.utimes(bundlePath, now, now);
    const lsregisterExit = yield* run(LSREGISTER, ["-f", bundlePath]);
    // The Dock holds icons in memory; restarting it is the only way to drop the stale one.
    const dockExit = yield* run("/usr/bin/killall", ["Dock"]);
    yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
    yield* fileSystem.writeFileString(markerPath, environment.appVersion);
    yield* logInfo("refreshed icon cache after install", {
      version: environment.appVersion,
      lsregisterExit,
      dockExit,
    });
  }).pipe(
    Effect.catch((error) =>
      logWarning("icon cache refresh failed", { bundlePath, message: String(error) }),
    ),
    Effect.withSpan("desktop.macIconCache.refreshAfterInstall"),
  );

  return DesktopMacIconCache.of({ refreshAfterInstall });
});

export const layer = Layer.effect(DesktopMacIconCache, make);
