import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopMacIconCache from "./DesktopMacIconCache.ts";

const exitedProcess = ChildProcessSpawner.makeHandle({
  pid: ChildProcessSpawner.ProcessId(1),
  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
  isRunning: Effect.succeed(false),
  kill: () => Effect.void,
  unref: Effect.succeed(Effect.void),
  stdin: Sink.drain,
  stdout: Stream.empty,
  stderr: Stream.empty,
  all: Stream.empty,
  getInputFd: () => Sink.drain,
  getOutputFd: () => Stream.empty,
});

const refresh = (input: {
  readonly files: Map<string, string>;
  readonly commands: Array<string>;
  readonly app: string;
  readonly appVersion: string;
}) =>
  DesktopMacIconCache.DesktopMacIconCache.pipe(
    Effect.flatMap((cache) => cache.refreshAfterInstall),
    Effect.provide(
      DesktopMacIconCache.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.effect(
              DesktopEnvironment.DesktopEnvironment,
              Path.Path.pipe(
                Effect.map(
                  (path) =>
                    ({
                      path,
                      platform: "darwin",
                      isPackaged: true,
                      appVersion: input.appVersion,
                      resourcesPath: `${input.app}/Contents/Resources`,
                      stateDir: "/home/.t3/userdata",
                    }) as unknown as DesktopEnvironment.DesktopEnvironment["Service"],
                ),
                Effect.provide(Path.layer),
              ),
            ),
            FileSystem.layerNoop({
              readFileString: (path) => {
                const content = input.files.get(path);
                return content === undefined
                  ? Effect.fail(
                      PlatformError.systemError({
                        _tag: "NotFound",
                        module: "FileSystem",
                        method: "readFileString",
                        pathOrDescriptor: path,
                      }),
                    )
                  : Effect.succeed(content);
              },
              writeFileString: (path, content) =>
                Effect.sync(() => {
                  input.files.set(path, content);
                }),
              makeDirectory: () => Effect.void,
              utimes: () => Effect.void,
            }),
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make((command) => {
                const { command: name, args } = command as unknown as {
                  readonly command: string;
                  readonly args: ReadonlyArray<string>;
                };
                input.commands.push([name.split("/").at(-1), ...args].join(" "));
                return Effect.succeed(exitedProcess);
              }),
            ),
          ),
        ),
      ),
    ),
  );

describe("DesktopMacIconCache", () => {
  it.effect("refreshes once per installed version of each app bundle", () =>
    Effect.gen(function* () {
      const files = new Map<string, string>();
      const commands: Array<string> = [];
      const fork = "/Applications/Fork.app";
      const official = "/Applications/Official.app";

      yield* refresh({ files, commands, app: fork, appVersion: "0.1.7001" });
      assert.deepEqual(commands, [`lsregister -f ${fork}`, "killall Dock"]);

      // Switching between side-by-side apps that share state must not restart the Dock again.
      yield* refresh({ files, commands, app: official, appVersion: "0.1.7" });
      yield* refresh({ files, commands, app: fork, appVersion: "0.1.7001" });
      yield* refresh({ files, commands, app: official, appVersion: "0.1.7" });
      assert.equal(commands.length, 4);

      yield* refresh({ files, commands, app: fork, appVersion: "0.1.7002" });
      assert.deepEqual(commands.slice(4), [`lsregister -f ${fork}`, "killall Dock"]);
    }),
  );
});
