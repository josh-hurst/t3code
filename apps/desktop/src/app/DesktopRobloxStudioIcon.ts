import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

// Roblox Studio updates replace its bundle, and with it the custom Dock icon built in
// ~/.local/share/roblox-studio-icon (see apply-studio-icon.sh there). Put the custom icon back.
const { logInfo, logWarning } = makeComponentLogger("desktop-roblox-studio-icon");

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
export const STUDIO_APP_PATH = "/Applications/RobloxStudio.app";
const ICON_FILES = ["Assets.car", "AppIcon.icns"] as const;
// Every custom build names its layers "glyph…"; Roblox's own catalog never does, so this
// tells the stock icon (worth backing up) apart from an older custom one (not worth it).
const CUSTOM_ICON_MARKER = "glyph";
// An update writes the bundle in bursts; act once it has been quiet this long.
const SETTLE = Duration.seconds(10);
// Catches an update whose writes the watchers missed.
const BACKSTOP = Duration.minutes(30);

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b);

export class DesktopRobloxStudioIcon extends Context.Service<
  DesktopRobloxStudioIcon,
  {
    /** Installs the custom icon if Studio currently has a different one. */
    readonly sync: Effect.Effect<void>;
    /** Syncs now, then again whenever Studio's bundle changes. */
    readonly register: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/app/DesktopRobloxStudioIcon") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { path } = environment;

  const iconHome = path.join(environment.homeDirectory, ".local", "share", "roblox-studio-icon");
  const customDir = path.join(iconHome, "build");
  const backupDir = path.join(iconHome, "original-backup");
  const resourcesDir = path.join(STUDIO_APP_PATH, "Contents", "Resources");

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

  const readIcons = (directory: string) =>
    Effect.forEach(ICON_FILES, (name) => fileSystem.readFile(path.join(directory, name)));

  const sync = Effect.gen(function* () {
    if (!(yield* fileSystem.exists(path.join(customDir, ICON_FILES[0])))) return;
    if (!(yield* fileSystem.exists(path.join(resourcesDir, ICON_FILES[0])))) return;

    const custom = yield* readIcons(customDir);
    const installed = yield* readIcons(resourcesDir);
    if (installed.every((bytes, index) => sameBytes(bytes, custom[index]!))) return;

    const installedIsStock = !Buffer.from(installed[0]!).includes(CUSTOM_ICON_MARKER);
    if (installedIsStock) {
      yield* fileSystem.makeDirectory(backupDir, { recursive: true });
      for (const name of ICON_FILES) {
        yield* fileSystem.copyFile(path.join(resourcesDir, name), path.join(backupDir, name));
      }
    }
    for (const name of ICON_FILES) {
      yield* fileSystem.copyFile(path.join(customDir, name), path.join(resourcesDir, name));
    }

    const nowSeconds = (yield* Clock.currentTimeMillis) / 1000;
    yield* fileSystem.utimes(STUDIO_APP_PATH, nowSeconds, nowSeconds);
    const lsregisterExit = yield* run(LSREGISTER, ["-f", STUDIO_APP_PATH]);
    // A running Studio keeps its launch-time icon until it is reopened; this covers the rest.
    const dockExit = yield* run("/usr/bin/killall", ["Dock"]);
    yield* logInfo("installed custom Roblox Studio icon", {
      backedUpStockIcon: installedIsStock,
      lsregisterExit,
      dockExit,
    });
  }).pipe(
    Effect.catch((error) =>
      logWarning("Roblox Studio icon sync failed", { message: String(error) }),
    ),
    Effect.withSpan("desktop.robloxStudioIcon.sync"),
  );

  const changesIn = (directory: string, matches: (name: string) => boolean = () => true) =>
    fileSystem.watch(directory).pipe(
      Stream.filter((event) => matches(event.path)),
      Stream.as(undefined),
      // A missing Studio install (NotFound) just leaves the other triggers.
      Stream.ignoreCause({ log: false }),
    );

  const register = Effect.gen(function* () {
    if (environment.platform !== "darwin" || !environment.isPackaged) return;
    const triggers = Stream.mergeAll(
      [
        // Emits immediately, so the first sync runs one settle period after launch.
        Stream.tick(BACKSTOP),
        // An update that swaps in a whole new bundle.
        changesIn("/Applications", (name) => name.startsWith("RobloxStudio")),
        // An update that rewrites the icon files in place.
        changesIn(resourcesDir),
      ],
      { concurrency: "unbounded" },
    );
    yield* triggers.pipe(
      Stream.debounce(SETTLE),
      Stream.runForEach(() => sync),
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("desktop.robloxStudioIcon.register"));

  return DesktopRobloxStudioIcon.of({ sync, register });
});

export const layer = Layer.effect(DesktopRobloxStudioIcon, make);
