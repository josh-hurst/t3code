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
import * as DesktopRobloxStudioIcon from "./DesktopRobloxStudioIcon.ts";

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

const HOME = "/Users/test";
const ICON_HOME = `${HOME}/.local/share/roblox-studio-icon`;
const CUSTOM = `${ICON_HOME}/build`;
const BACKUP = `${ICON_HOME}/original-backup`;
const RESOURCES = `${DesktopRobloxStudioIcon.STUDIO_APP_PATH}/Contents/Resources`;

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | undefined) =>
  data === undefined ? undefined : new TextDecoder().decode(data);

const notFound = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
  });

const sync = (files: Map<string, Uint8Array>, commands: Array<string>) =>
  DesktopRobloxStudioIcon.DesktopRobloxStudioIcon.pipe(
    Effect.flatMap((icon) => icon.sync),
    Effect.provide(
      DesktopRobloxStudioIcon.layer.pipe(
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
                      homeDirectory: HOME,
                    }) as unknown as DesktopEnvironment.DesktopEnvironment["Service"],
                ),
                Effect.provide(Path.layer),
              ),
            ),
            FileSystem.layerNoop({
              exists: (path) => Effect.succeed(files.has(path)),
              readFile: (path) => {
                const content = files.get(path);
                return content === undefined
                  ? Effect.fail(notFound("readFile", path))
                  : Effect.succeed(content);
              },
              copyFile: (from, to) => {
                const content = files.get(from);
                if (content === undefined) return Effect.fail(notFound("copyFile", from));
                return Effect.sync(() => {
                  files.set(to, content);
                });
              },
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
                commands.push([name.split("/").at(-1), ...args].join(" "));
                return Effect.succeed(exitedProcess);
              }),
            ),
          ),
        ),
      ),
    ),
  );

const withCustomBuild = (version: string) =>
  new Map<string, Uint8Array>([
    [`${CUSTOM}/Assets.car`, bytes(`car glyph-light ${version}`)],
    [`${CUSTOM}/AppIcon.icns`, bytes(`icns ${version}`)],
  ]);

const REFRESH = [`lsregister -f ${DesktopRobloxStudioIcon.STUDIO_APP_PATH}`, "killall Dock"];

describe("DesktopRobloxStudioIcon", () => {
  it.effect("backs up the stock icon an update restored, then installs the custom one", () =>
    Effect.gen(function* () {
      const files = withCustomBuild("v2");
      files.set(`${RESOURCES}/Assets.car`, bytes("car Roblox Studio Mac OS"));
      files.set(`${RESOURCES}/AppIcon.icns`, bytes("icns stock"));
      const commands: Array<string> = [];

      yield* sync(files, commands);

      assert.equal(text(files.get(`${BACKUP}/Assets.car`)), "car Roblox Studio Mac OS");
      assert.equal(text(files.get(`${BACKUP}/AppIcon.icns`)), "icns stock");
      assert.equal(text(files.get(`${RESOURCES}/Assets.car`)), "car glyph-light v2");
      assert.equal(text(files.get(`${RESOURCES}/AppIcon.icns`)), "icns v2");
      assert.deepEqual(commands, REFRESH);
    }),
  );

  it.effect("leaves an up-to-date custom icon alone", () =>
    Effect.gen(function* () {
      const files = withCustomBuild("v2");
      files.set(`${RESOURCES}/Assets.car`, bytes("car glyph-light v2"));
      files.set(`${RESOURCES}/AppIcon.icns`, bytes("icns v2"));
      const commands: Array<string> = [];

      yield* sync(files, commands);

      assert.deepEqual(commands, []);
      assert.isFalse(files.has(`${BACKUP}/Assets.car`));
    }),
  );

  it.effect("replaces an older custom icon without overwriting the stock backup", () =>
    Effect.gen(function* () {
      const files = withCustomBuild("v2");
      files.set(`${RESOURCES}/Assets.car`, bytes("car glyph-light v1"));
      files.set(`${RESOURCES}/AppIcon.icns`, bytes("icns v1"));
      files.set(`${BACKUP}/Assets.car`, bytes("car Roblox Studio Mac OS"));
      const commands: Array<string> = [];

      yield* sync(files, commands);

      assert.equal(text(files.get(`${BACKUP}/Assets.car`)), "car Roblox Studio Mac OS");
      assert.equal(text(files.get(`${RESOURCES}/Assets.car`)), "car glyph-light v2");
      assert.deepEqual(commands, REFRESH);
    }),
  );

  it.effect("does nothing without a custom build or a Studio install", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];

      const noBuild = new Map<string, Uint8Array>([
        [`${RESOURCES}/Assets.car`, bytes("car Roblox Studio Mac OS")],
      ]);
      yield* sync(noBuild, commands);
      assert.equal(text(noBuild.get(`${RESOURCES}/Assets.car`)), "car Roblox Studio Mac OS");

      yield* sync(withCustomBuild("v2"), commands);
      assert.deepEqual(commands, []);
    }),
  );
});
