// @effect-diagnostics nodeBuiltinImport:off -- the install handoff must outlive this process, so it cannot be a scoped Effect child.
// An updater for apps built with `vp run dist:desktop:source`. Instead of
// downloading a release it pulls the checkout the app was built from,
// rebuilds it, and swaps the rebuilt bundle in. It speaks electron-updater's
// event protocol so DesktopUpdates and the update UI work unchanged.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";

const SourceBuildMetadata = Schema.Struct({
  t3codeSourceRepo: Schema.String,
  t3codeCommitHash: Schema.String,
});
const decodeSourceBuildMetadata = Schema.decodeUnknownOption(
  Schema.fromJsonString(SourceBuildMetadata),
);
const VersionedPackageJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));
const decodePackageVersion = Schema.decodeUnknownOption(VersionedPackageJson);

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;
const ERROR_TAIL_LINES = 8;
const BUILD_OUTPUT_TAIL_LINES = 40;

export interface SourceBuild {
  readonly repo: string;
  readonly commit: string;
}

export function parseSourceBuild(packageJson: string): Option.Option<SourceBuild> {
  return decodeSourceBuildMetadata(packageJson).pipe(
    Option.filter(
      (metadata) =>
        metadata.t3codeSourceRepo.trim().length > 0 &&
        COMMIT_PATTERN.test(metadata.t3codeCommitHash),
    ),
    Option.map((metadata) => ({
      repo: metadata.t3codeSourceRepo,
      commit: metadata.t3codeCommitHash.toLowerCase(),
    })),
  );
}

function parsePackageVersion(packageJson: string): Option.Option<string> {
  return decodePackageVersion(packageJson).pipe(Option.map((parsed) => parsed.version));
}

// The app version alone repeats across commits, so the commit is what tells
// one source build from the next.
function sourceBuildVersion(appVersion: string, commit: string): string {
  return `${appVersion}+${commit.slice(0, 12).toLowerCase()}`;
}

// Milestones in build-desktop-artifact.ts output (verbose mode), in order.
// Progress only moves forward, so a line seen out of order cannot rewind it.
const BUILD_MILESTONES: ReadonlyArray<readonly [string, number]> = [
  ["Building desktop/server/web artifacts", 20],
  ["Staging release app", 55],
  ["Installing staged production dependencies", 62],
  ["Installing server sidecar runtime externals", 68],
  ["Packing server.asar", 72],
  ["• packaging", 80],
  ["• building", 90],
  ["Done. Artifacts", 98],
];

export function buildProgressForLine(line: string): number | undefined {
  let percent: number | undefined;
  for (const [marker, value] of BUILD_MILESTONES) {
    if (line.includes(marker)) percent = value;
  }
  return percent;
}

export function resolveAppBundlePath(executablePath: string): Option.Option<string> {
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(executablePath);
  return Option.fromNullishOr(match?.[1]);
}

function tail(output: string, lines = ERROR_TAIL_LINES): string {
  return output.trim().split("\n").slice(-lines).join("\n");
}

// Runs detached after the app quits: waits for the old process to exit, then
// replaces the bundle with the rebuilt one and reopens it. Unpacking next to
// the bundle keeps both renames on one volume, and the old bundle is restored
// if the swap fails.
const INSTALL_SCRIPT = `
pid="$1"; zip="$2"; app="$3"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
staging=$(mktemp -d "$(dirname "$app")/.t3code-update.XXXXXX") || exit 1
if ditto -x -k "$zip" "$staging"; then
  next=$(find "$staging" -maxdepth 1 -name '*.app' | head -n 1)
  if [ -n "$next" ]; then
    rm -rf "$app.previous"
    if mv "$app" "$app.previous"; then
      if mv "$next" "$app"; then rm -rf "$app.previous"; else mv "$app.previous" "$app"; fi
    fi
  fi
fi
rm -rf "$staging"
open "$app"
`;

export class SourceBuildUpdaterCommandError extends Schema.TaggedError<SourceBuildUpdaterCommandError>()(
  "SourceBuildUpdaterCommandError",
  {
    command: Schema.String,
    exitCode: Schema.Number,
    output: Schema.String,
  },
) {
  override get message(): string {
    return `${this.command} exited with code ${this.exitCode}.`;
  }
}

export class SourceBuildUpdaterMissingArchiveError extends Schema.TaggedError<SourceBuildUpdaterMissingArchiveError>()(
  "SourceBuildUpdaterMissingArchiveError",
  { path: Schema.String },
) {
  override get message(): string {
    return `The build did not produce ${this.path}.`;
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("SourceBuildUpdater.make")(function* (
  build: SourceBuild,
  appVersion: string,
) {
  const path = yield* Path.Path;
  const arch = yield* HostProcess.Architecture;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const events = new NodeEvents.EventEmitter();
  let rebuilt:
    | { readonly archive: string; readonly commit: string; readonly version: string }
    | undefined;

  const run = Effect.fn("SourceBuildUpdater.run")(function* (
    command: string,
    args: ReadonlyArray<string>,
    options: {
      readonly env?: Record<string, string>;
      readonly onLine?: (line: string) => void;
    } = {},
  ) {
    const lines: Array<string> = [];
    const exitCode = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(command, args, {
            cwd: build.repo,
            ...(options.env ? { env: options.env, extendEnv: true } : {}),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            killSignal: "SIGTERM",
          }),
        );
        const [, code] = yield* Effect.all(
          [
            child.all.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runForEach((line) =>
                Effect.sync(() => {
                  lines.push(line);
                  // A build prints thousands of lines; keep only what an
                  // error message could show.
                  if (options.onLine) {
                    if (lines.length > BUILD_OUTPUT_TAIL_LINES) lines.shift();
                    options.onLine(line);
                  }
                }),
              ),
            ),
            child.exitCode,
          ],
          { concurrency: 2 },
        );
        return Number(code);
      }),
    );
    return { exitCode, output: lines.join("\n") };
  });

  const runOrFail = (
    label: string,
    command: string,
    args: ReadonlyArray<string>,
    options?: Parameters<typeof run>[2],
  ) =>
    run(command, args, options).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.output)
          : Effect.fail(
              new SourceBuildUpdaterCommandError({
                command: label,
                exitCode: result.exitCode,
                output: tail(result.output),
              }),
            ),
      ),
    );

  const describeFailure = (action: string, cause: unknown): string =>
    Schema.is(SourceBuildUpdaterCommandError)(cause)
      ? `${action}: ${cause.command} failed.\n${cause.output}`.trim()
      : `${action}: ${cause instanceof Error ? cause.message : String(cause)}`;

  const readUpstreamVersion = Effect.gen(function* () {
    const commit = (yield* runOrFail("git rev-parse", "git", [
      "rev-parse",
      "--short=12",
      "@{u}",
    ])).trim();
    const packageJson = yield* runOrFail("git show", "git", [
      "show",
      "@{u}:apps/server/package.json",
    ]);
    const version = Option.getOrElse(parsePackageVersion(packageJson), () => appVersion);
    return sourceBuildVersion(version, commit);
  });

  const checkForUpdates = Effect.gen(function* () {
    events.emit("checking-for-update");
    yield* runOrFail("git fetch", "git", ["fetch", "--quiet"]);
    // Exit 0: the build already contains everything upstream has, including
    // when the checkout has local commits on top. Exit 1: upstream is ahead.
    const ancestor = yield* run("git", [
      "merge-base",
      "--is-ancestor",
      "@{u}",
      rebuilt?.commit ?? build.commit,
    ]);
    if (ancestor.exitCode === 0) {
      // Reporting the waiting rebuild keeps it installable instead of
      // resetting the state to "up to date".
      if (rebuilt) events.emit("update-available", { version: rebuilt.version });
      else events.emit("update-not-available", {});
      return;
    }
    if (ancestor.exitCode !== 1) {
      return yield* new SourceBuildUpdaterCommandError({
        command: "git merge-base",
        exitCode: ancestor.exitCode,
        output: tail(ancestor.output),
      });
    }
    events.emit("update-available", { version: yield* readUpstreamVersion });
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
          channel: null,
          detail: describeFailure("Could not check the source checkout for updates", cause),
          cause,
        }),
    ),
    Effect.withSpan("SourceBuildUpdater.checkForUpdates"),
  );

  const emitProgress = (percent: number) => events.emit("download-progress", { percent });

  const downloadUpdate = Effect.gen(function* () {
    rebuilt = undefined;
    emitProgress(1);
    yield* runOrFail("git pull", "git", ["pull", "--no-rebase", "--no-edit"]);
    emitProgress(8);
    yield* runOrFail("vp i", "vp", ["i"]);
    emitProgress(15);
    let percent = 15;
    yield* runOrFail("vp run dist:desktop:source", "vp", ["run", "dist:desktop:source"], {
      env: { T3CODE_DESKTOP_VERBOSE: "1" },
      onLine: (line) => {
        const next = buildProgressForLine(line);
        if (next !== undefined && next > percent) {
          percent = next;
          emitProgress(percent);
        }
      },
    });

    const commit = (yield* runOrFail("git rev-parse", "git", [
      "rev-parse",
      "--short=12",
      "HEAD",
    ])).trim();
    const builtVersion = Option.getOrElse(
      parsePackageVersion(
        yield* fileSystem.readFileString(path.join(build.repo, "apps/server/package.json")),
      ),
      () => appVersion,
    );
    const archive = path.join(build.repo, "release-source", `T3-Code-${builtVersion}-${arch}.zip`);
    if (!(yield* fileSystem.exists(archive))) {
      return yield* new SourceBuildUpdaterMissingArchiveError({ path: archive });
    }
    rebuilt = { archive, commit, version: sourceBuildVersion(builtVersion, commit) };
    emitProgress(100);
    events.emit("update-downloaded", { version: rebuilt.version });
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ElectronUpdater.ElectronUpdaterDownloadUpdateError({
          channel: null,
          detail: describeFailure("Could not rebuild T3 Code", cause),
          cause,
        }),
    ),
    Effect.withSpan("SourceBuildUpdater.downloadUpdate"),
  );

  const quitAndInstall: ElectronUpdater.ElectronUpdater["Service"]["quitAndInstall"] = ({
    isSilent,
    isForceRunAfter,
  }) =>
    Effect.try({
      try: () => {
        const appBundle = Option.getOrThrowWith(
          resolveAppBundlePath(process.execPath),
          () => new Error(`${process.execPath} is not inside a macOS app bundle.`),
        );
        if (rebuilt === undefined) throw new Error("No rebuilt app is ready to install.");
        NodeChildProcess.spawn(
          "/bin/sh",
          ["-c", INSTALL_SCRIPT, "t3code-update", String(process.pid), rebuilt.archive, appBundle],
          { detached: true, stdio: "ignore" },
        ).unref();
        Electron.app.quit();
      },
      catch: (cause) =>
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
          channel: null,
          isSilent,
          isForceRunAfter,
          cause,
        }),
    });

  return ElectronUpdater.ElectronUpdater.of({
    builtInFeed: Option.some({
      currentVersion: sourceBuildVersion(appVersion, build.commit),
    }),
    // electron-updater's feed and channel settings have no meaning here.
    setFeedURL: () => Effect.void,
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: () => Effect.void,
    setChannel: () => Effect.void,
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.succeed(false),
    setAllowDowngrade: () => Effect.void,
    setFullChangelog: () => Effect.void,
    setDisableDifferentialDownload: () => Effect.void,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    on: (eventName, listener) => {
      const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
      return Effect.acquireRelease(
        Effect.sync(() => {
          events.on(eventName, untypedListener);
        }),
        () =>
          Effect.sync(() => {
            events.removeListener(eventName, untypedListener);
          }),
      ).pipe(Effect.asVoid);
    },
  });
});

/**
 * Uses the source-build updater when this macOS app was built from a checkout
 * with `vp run dist:desktop:source`, and electron-updater otherwise.
 */
export const layer = Layer.effect(
  ElectronUpdater.ElectronUpdater,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    if (!environment.isPackaged || environment.platform !== "darwin") {
      return ElectronUpdater.make;
    }
    const packageJson = yield* fileSystem
      .readFileString(environment.path.join(environment.appRoot, "package.json"))
      .pipe(Effect.option);
    const build = Option.flatMap(packageJson, parseSourceBuild);
    if (
      Option.isNone(build) ||
      !(yield* fileSystem.exists(build.value.repo).pipe(Effect.orElseSucceed(() => false)))
    ) {
      return ElectronUpdater.make;
    }
    yield* Effect.logInfo("using source-build updater").pipe(
      Effect.annotateLogs({ repo: build.value.repo, commit: build.value.commit }),
    );
    return yield* make(build.value, environment.appVersion);
  }),
);
