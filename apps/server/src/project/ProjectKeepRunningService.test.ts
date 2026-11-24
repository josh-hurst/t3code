import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type ApplicationStoredEvent,
  type ProjectKeepRunningStatus,
  type ProjectScript,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectKeepRunningService from "./ProjectKeepRunningService.ts";

const projectId = ProjectId.make("project-keep-1");
const encoder = new TextEncoder();

interface FakeProcess {
  readonly pid: number;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>> | undefined;
  readonly stdinOption: unknown;
  readonly exitDeferred: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
  readonly stdoutQueue: Queue.Queue<Uint8Array, Cause.Done>;
  readonly stderrQueue: Queue.Queue<Uint8Array, Cause.Done>;
  readonly released: Deferred.Deferred<void>;
  readonly emitStdout: (text: string) => Effect.Effect<void>;
  readonly emitStderr: (text: string) => Effect.Effect<void>;
  readonly finish: (code?: number) => Effect.Effect<void>;
}

const makeFakeSpawner = () =>
  Effect.gen(function* () {
    const spawnedQueue = yield* Queue.unbounded<FakeProcess>();
    const spawnedList: Array<FakeProcess> = [];
    let nextPid = 4000;

    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") {
          return yield* Effect.die("Expected StandardCommand");
        }
        const pid = ++nextPid;
        const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const stdoutQueue = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const stderrQueue = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const released = yield* Deferred.make<void>();

        const closeOutputs = Effect.all([
          Queue.end(stdoutQueue).pipe(Effect.ignore),
          Queue.end(stderrQueue).pipe(Effect.ignore),
        ]);

        const fake: FakeProcess = {
          pid,
          command: command.command,
          args: command.args.map((arg) => (typeof arg === "string" ? arg : Redacted.value(arg))),
          cwd: command.options.cwd,
          env: command.options.env as Readonly<Record<string, string | undefined>> | undefined,
          stdinOption: command.options.stdin,
          exitDeferred,
          stdoutQueue,
          stderrQueue,
          released,
          emitStdout: (text) => Queue.offer(stdoutQueue, encoder.encode(text)).pipe(Effect.asVoid),
          emitStderr: (text) => Queue.offer(stderrQueue, encoder.encode(text)).pipe(Effect.asVoid),
          finish: (code = 0) =>
            closeOutputs.pipe(
              Effect.andThen(Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(code))),
              Effect.asVoid,
            ),
        };

        yield* Effect.addFinalizer(() =>
          closeOutputs.pipe(Effect.andThen(Deferred.succeed(released, undefined)), Effect.asVoid),
        );

        spawnedList.push(fake);
        yield* Queue.offer(spawnedQueue, fake);

        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(pid),
          exitCode: Deferred.await(exitDeferred),
          isRunning: Deferred.isDone(exitDeferred).pipe(Effect.map((done) => !done)),
          kill: () =>
            closeOutputs.pipe(Effect.andThen(Deferred.succeed(released, undefined)), Effect.asVoid),
          stdin: Sink.drain,
          stdout: Stream.fromQueue(stdoutQueue),
          stderr: Stream.fromQueue(stderrQueue),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
        return handle;
      }),
    );

    return {
      spawner,
      nextSpawn: Queue.take(spawnedQueue),
      spawnCount: () => spawnedList.length,
    };
  });

const makeProjectRow = (
  overrides: Partial<ProjectStore.ProjectRow> = {},
): ProjectStore.ProjectRow => ({
  projectId,
  title: "App",
  hasCustomTitle: false,
  workspaceRoot: "/workspace/app",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  trackedFolders: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

const makeScript = (overrides: Partial<ProjectScript> = {}): ProjectScript => ({
  id: "sync",
  name: "Sync",
  command: "pnpm sync",
  icon: "play",
  runOnWorktreeCreate: false,
  keepRunning: true,
  ...overrides,
});

const makeHarness = (input: {
  readonly projects: ReadonlyArray<ProjectStore.ProjectRow>;
  readonly settings?: Partial<ServerSettingsValue>;
  readonly existingDirs?: ReadonlySet<string>;
}) =>
  Effect.gen(function* () {
    const fakeSpawner = yield* makeFakeSpawner();
    const projectsRef = yield* Ref.make<ReadonlyArray<ProjectStore.ProjectRow>>(input.projects);
    const settingsRef = yield* Ref.make<ServerSettingsValue>({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsFolded: true,
      ...input.settings,
    });
    const settingsPubSub = yield* PubSub.unbounded<ServerSettingsValue>();
    const eventPubSub = yield* PubSub.unbounded<ApplicationStoredEvent>();
    let seq = 0;
    const dirs = input.existingDirs ?? new Set(input.projects.map((p) => p.workspaceRoot));

    const updateSettings = (patch: Parameters<typeof applyServerSettingsPatch>[1]) =>
      Ref.updateAndGet(settingsRef, (current) => applyServerSettingsPatch(current, patch)).pipe(
        Effect.tap((next) => PubSub.publish(settingsPubSub, next)),
      );

    const setProjects = (nextProjects: ReadonlyArray<ProjectStore.ProjectRow>) =>
      Ref.set(projectsRef, nextProjects).pipe(
        Effect.andThen(
          PubSub.publish(eventPubSub, {
            sequence: ++seq,
            aggregateKind: "project",
            aggregateId: projectId,
            type: "project.meta-updated",
          } as unknown as ApplicationStoredEvent),
        ),
        Effect.asVoid,
      );

    const layer = ProjectKeepRunningService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner.spawner),
          Layer.succeed(HostProcess.Platform, "darwin"),
          Layer.succeed(HostProcess.Environment, {
            SHELL: "/bin/zsh",
            PATH: "/usr/bin:/bin",
            PORT: "3773",
            T3CODE_HOME: "/server/home",
          }),
          FileSystem.layerNoop({
            stat: (target) =>
              dirs.has(target)
                ? Effect.succeed({ type: "Directory" } as FileSystem.File.Info)
                : Effect.fail({
                    _tag: "PlatformError",
                    reason: { _tag: "NotFound" },
                  } as never),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            list: () =>
              Ref.get(projectsRef).pipe(
                Effect.map((rows) => rows.filter((row) => row.deletedAt === null)),
              ),
          }),
          Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
            latestApplicationSequence: Effect.sync(() => seq),
            streamApplicationEvents: () => Stream.fromPubSub(eventPubSub),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Ref.get(settingsRef),
            updateSettings: (patch) => updateSettings(patch),
            streamChanges: Stream.fromPubSub(settingsPubSub),
            subscribeChanges: PubSub.subscribe(settingsPubSub).pipe(
              Effect.map((sub) => Stream.fromSubscription(sub)),
            ),
          }),
        ),
      ),
    );

    const serviceScope = yield* Scope.make("parallel");
    const built = yield* Layer.buildWithScope(layer, serviceScope);
    const service = Context.get(built, ProjectKeepRunningService.ProjectKeepRunningService);
    yield* Effect.addFinalizer(() => Scope.close(serviceScope, Exit.void));

    const waitForStatus = (
      predicate: (status: ProjectKeepRunningStatus | undefined) => boolean,
      scriptId = "sync",
    ) =>
      service.stream.pipe(
        Stream.map((statuses) =>
          statuses.find((entry) => entry.projectId === projectId && entry.scriptId === scriptId),
        ),
        Stream.filter(predicate),
        Stream.runHead,
        Effect.map(Option.getOrUndefined),
      );

    return {
      service,
      fakeSpawner,
      updateSettings,
      setProjects,
      waitForStatus,
      closeServiceScope: () => Scope.close(serviceScope, Exit.void),
    };
  });

describe("ProjectKeepRunningService", () => {
  it("caps exponential restart backoff at 30 seconds", () => {
    expect(ProjectKeepRunningService.nextKeepRunningRestartDelayMs(1)).toBe(1_000);
    expect(ProjectKeepRunningService.nextKeepRunningRestartDelayMs(2)).toBe(2_000);
    expect(ProjectKeepRunningService.nextKeepRunningRestartDelayMs(3)).toBe(4_000);
    expect(ProjectKeepRunningService.nextKeepRunningRestartDelayMs(4)).toBe(8_000);
    expect(ProjectKeepRunningService.nextKeepRunningRestartDelayMs(5)).toBe(16_000);
    expect(ProjectKeepRunningService.nextKeepRunningRestartDelayMs(6)).toBe(30_000);
    expect(ProjectKeepRunningService.nextKeepRunningRestartDelayMs(9)).toBe(30_000);
  });

  it.effect("starts kept actions at boot and closes everything on scope close", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        projects: [makeProjectRow()],
        settings: {
          projectSettingsOverrides: {
            [projectId]: { defaultProjectScripts: [makeScript()] },
          },
        },
      });

      const proc = yield* harness.fakeSpawner.nextSpawn;
      expect(proc.command).toBe("/bin/zsh");
      expect(proc.args).toEqual(["-c", "pnpm sync"]);
      expect(proc.cwd).toBe("/workspace/app");
      expect(proc.env).toEqual({
        SHELL: "/bin/zsh",
        PATH: "/usr/bin:/bin",
        T3CODE_PROJECT_ROOT: "/workspace/app",
      });
      expect(proc.stdinOption).toBe("ignore");

      const running = yield* harness.waitForStatus((status) => status?.state === "running");
      expect(running?.pid).toBe(proc.pid);
      expect(running?.startedAt).not.toBeNull();

      yield* harness.closeServiceScope();
      yield* Deferred.await(proc.released);
    }),
  );

  it.effect("backs off on short exits, stops after 5 short runs, and resets after a 60s run", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        projects: [makeProjectRow()],
        settings: {
          projectSettingsOverrides: {
            [projectId]: { defaultProjectScripts: [makeScript()] },
          },
        },
      });

      // Run 1 exits after 1s -> 1s delay
      const run1 = yield* harness.fakeSpawner.nextSpawn;
      yield* harness.waitForStatus((s) => s?.state === "running" && s.pid === run1.pid);
      yield* TestClock.adjust("1 second");
      yield* run1.finish(0);
      const after1 = yield* harness.waitForStatus((s) => s?.state === "restarting");
      expect(after1?.lastExitCode).toBe(0);

      // Should not spawn before 1s
      yield* TestClock.adjust("500 millis");
      expect(harness.fakeSpawner.spawnCount()).toBe(1);
      yield* TestClock.adjust("500 millis");

      // Run 2 lasts 60s -> resets failure count and delay back to 1s
      const run2 = yield* harness.fakeSpawner.nextSpawn;
      yield* harness.waitForStatus((s) => s?.state === "running" && s.pid === run2.pid);
      yield* TestClock.adjust("60 seconds");
      yield* run2.finish(1);
      yield* harness.waitForStatus((s) => s?.state === "restarting" && s.lastExitCode === 1);

      // Delay after healthy run is 1s
      yield* TestClock.adjust("1 second");

      // Now 5 consecutive short exits: delays 1s, 2s, 4s, 8s, then failed
      const expectedDelays = [1_000, 2_000, 4_000, 8_000] as const;
      for (const delayMs of expectedDelays) {
        const proc = yield* harness.fakeSpawner.nextSpawn;
        yield* harness.waitForStatus((s) => s?.state === "running" && s.pid === proc.pid);
        yield* TestClock.adjust("5 seconds");
        yield* proc.finish(2);
        yield* harness.waitForStatus((s) => s?.state === "restarting");
        const countBefore = harness.fakeSpawner.spawnCount();
        yield* TestClock.adjust(`${delayMs - 100} millis`);
        expect(harness.fakeSpawner.spawnCount()).toBe(countBefore);
        yield* TestClock.adjust("100 millis");
      }

      // 5th short run ends in failed without scheduling another restart
      const run5 = yield* harness.fakeSpawner.nextSpawn;
      yield* harness.waitForStatus((s) => s?.state === "running" && s.pid === run5.pid);
      yield* run5.finish(3);
      const failed = yield* harness.waitForStatus((s) => s?.state === "failed");
      expect(failed?.lastExitCode).toBe(3);
      expect(failed?.failureMessage).toContain("5 short runs");

      const finalCount = harness.fakeSpawner.spawnCount();
      yield* TestClock.adjust("2 minutes");
      expect(harness.fakeSpawner.spawnCount()).toBe(finalCount);
    }),
  );

  it.effect(
    "restarts on command change, ignores rename/icon change, and stops on toggle off or archive",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          projects: [makeProjectRow()],
          settings: {
            projectSettingsOverrides: {
              [projectId]: { defaultProjectScripts: [makeScript()] },
            },
          },
        });

        const first = yield* harness.fakeSpawner.nextSpawn;
        yield* harness.waitForStatus((s) => s?.state === "running" && s.pid === first.pid);

        // Rename + icon change does NOT restart
        yield* harness.updateSettings({
          projectSettingsOverrides: {
            [projectId]: {
              defaultProjectScripts: [makeScript({ name: "Renamed Sync", icon: "configure" })],
            },
          },
        });
        yield* harness.service.reconcile;
        expect(harness.fakeSpawner.spawnCount()).toBe(1);
        expect(yield* Deferred.isDone(first.released)).toBe(false);

        // Command change restarts it
        yield* harness.updateSettings({
          projectSettingsOverrides: {
            [projectId]: {
              defaultProjectScripts: [makeScript({ command: "pnpm sync --watch" })],
            },
          },
        });
        yield* Deferred.await(first.released);
        const second = yield* harness.fakeSpawner.nextSpawn;
        expect(second.args).toEqual(["-c", "pnpm sync --watch"]);
        yield* harness.waitForStatus((s) => s?.state === "running" && s.pid === second.pid);

        // Project archive stops it
        yield* harness.setProjects([makeProjectRow({ archivedAt: "2026-10-02T00:00:00.000Z" })]);
        yield* Deferred.await(second.released);
        const afterArchive = yield* harness.waitForStatus((s) => s === undefined);
        expect(afterArchive).toBeUndefined();

        // Unarchive brings it back; toggle off stops and removes it
        yield* harness.setProjects([makeProjectRow({ archivedAt: null })]);
        const third = yield* harness.fakeSpawner.nextSpawn;
        yield* harness.waitForStatus((s) => s?.state === "running" && s.pid === third.pid);

        yield* harness.updateSettings({
          projectSettingsOverrides: {
            [projectId]: {
              defaultProjectScripts: [
                makeScript({ command: "pnpm sync --watch", keepRunning: false }),
              ],
            },
          },
        });
        yield* Deferred.await(third.released);
        expect(yield* harness.waitForStatus((s) => s === undefined)).toBeUndefined();
      }),
  );

  it.effect(
    "preserves user Stop across unrelated settings changes and restarts on user Restart",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          projects: [makeProjectRow()],
          settings: {
            projectSettingsOverrides: {
              [projectId]: { defaultProjectScripts: [makeScript()] },
            },
          },
        });

        const first = yield* harness.fakeSpawner.nextSpawn;
        yield* harness.waitForStatus((s) => s?.state === "running" && s.pid === first.pid);

        const stopped = yield* harness.service.control({
          projectId,
          scriptId: "sync",
          action: "stop",
        });
        expect(stopped.applied).toBe(true);
        expect(stopped.status?.state).toBe("stopped");
        yield* Deferred.await(first.released);

        // Unrelated settings change keeps it stopped
        yield* harness.updateSettings({ defaultProjectScripts: [] });
        yield* harness.service.reconcile;
        expect(harness.fakeSpawner.spawnCount()).toBe(1);
        const statuses = yield* harness.service.getStatusesForProject(projectId);
        expect(statuses[0]?.state).toBe("stopped");

        // User Restart brings it back
        const restarted = yield* harness.service.control({
          projectId,
          scriptId: "sync",
          action: "restart",
        });
        expect(restarted.applied).toBe(true);
        const second = yield* harness.fakeSpawner.nextSpawn;
        yield* harness.waitForStatus((s) => s?.state === "running" && s.pid === second.pid);
      }),
  );

  it.effect("marks a missing project folder as failed without retrying", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        projects: [makeProjectRow({ workspaceRoot: "/workspace/missing" })],
        settings: {
          projectSettingsOverrides: {
            [projectId]: { defaultProjectScripts: [makeScript()] },
          },
        },
        existingDirs: new Set(),
      });

      const failed = yield* harness.waitForStatus((s) => s?.state === "failed");
      expect(failed?.failureMessage).toContain("does not exist");
      yield* TestClock.adjust("5 minutes");
      expect(harness.fakeSpawner.spawnCount()).toBe(0);
    }),
  );

  it.effect("caps output tail at 200 lines and 32 KB", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        projects: [makeProjectRow()],
        settings: {
          projectSettingsOverrides: {
            [projectId]: { defaultProjectScripts: [makeScript()] },
          },
        },
      });

      const proc = yield* harness.fakeSpawner.nextSpawn;
      yield* harness.waitForStatus((s) => s?.state === "running" && s.pid === proc.pid);

      // Line count cap (250 short lines -> keep last 200)
      const shortLines = Array.from({ length: 250 }, (_, index) => `line-${index + 1}`).join("\n");
      yield* proc.emitStdout(`${shortLines}\n`);
      yield* proc.finish(0);
      yield* harness.waitForStatus((s) => s?.state === "restarting");

      const byLines = yield* harness.service.getOutput({ projectId, scriptId: "sync" });
      expect(byLines.truncated).toBe(true);
      expect(byLines.lines).toHaveLength(200);
      expect(byLines.lines[0]).toBe("line-51");
      expect(byLines.lines.at(-1)).toBe("line-250");

      // Byte cap (40 lines x 1024 bytes = 40 KB -> capped <= 32 KB)
      yield* TestClock.adjust("1 second");
      const proc2 = yield* harness.fakeSpawner.nextSpawn;
      yield* harness.waitForStatus((s) => s?.state === "running" && s.pid === proc2.pid);
      const chunk = "x".repeat(1024);
      for (let i = 0; i < 40; i += 1) {
        yield* proc2.emitStderr(`${i}:${chunk}\n`);
      }
      yield* proc2.finish(0);
      yield* harness.waitForStatus((s) => s?.state === "restarting");

      const byBytes = yield* harness.service.getOutput({ projectId, scriptId: "sync" });
      expect(byBytes.truncated).toBe(true);
      expect(byBytes.lines.length).toBeLessThan(40);
      const totalBytes = byBytes.lines.reduce(
        (acc, line) => acc + encoder.encode(line).byteLength + 1,
        0,
      );
      expect(totalBytes).toBeLessThanOrEqual(
        ProjectKeepRunningService.KEEP_RUNNING_MAX_OUTPUT_BYTES,
      );
    }),
  );
});
