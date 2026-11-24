import {
  PROJECT_KEEP_RUNNING_FAILURE_MAX_LENGTH,
  type ProjectId,
  type ProjectKeepRunningControlInput,
  type ProjectKeepRunningControlResult,
  type ProjectKeepRunningOutputInput,
  type ProjectKeepRunningOutputResult,
  type ProjectKeepRunningStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  projectScriptRuntimeEnv,
  resolveKeepRunningProjectScripts,
} from "@t3tools/shared/projectScripts";
import { listLoginShellCandidates, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { shouldExcludeTerminalEnvKey } from "../terminal/Manager.ts";

const KEEP_RUNNING_INITIAL_RESTART_DELAY_MS = 1_000;
const KEEP_RUNNING_MAX_RESTART_DELAY_MS = 30_000;
const KEEP_RUNNING_HEALTHY_RUN_MS = 60_000;
const KEEP_RUNNING_MAX_SHORT_EXITS = 5;
const KEEP_RUNNING_MAX_OUTPUT_LINES = 200;
export const KEEP_RUNNING_MAX_OUTPUT_BYTES = 32 * 1024;
const FORCE_KILL_AFTER = "3 seconds";
const WATCH_RETRY_DELAY = "2 seconds";

const textEncoder = new TextEncoder();

export function nextKeepRunningRestartDelayMs(shortExitCount: number): number {
  const exponent = Math.max(0, shortExitCount - 1);
  return Math.min(
    KEEP_RUNNING_INITIAL_RESTART_DELAY_MS * 2 ** exponent,
    KEEP_RUNNING_MAX_RESTART_DELAY_MS,
  );
}

function clampFailure(message: string): string {
  const trimmed = message.trim();
  return trimmed.length <= PROJECT_KEEP_RUNNING_FAILURE_MAX_LENGTH
    ? trimmed
    : `${trimmed.slice(0, PROJECT_KEEP_RUNNING_FAILURE_MAX_LENGTH - 1)}…`;
}

function truncateUtf8Tail(text: string, maxBytes: number): string {
  if (textEncoder.encode(text).byteLength <= maxBytes) return text;
  // Walk backwards from the end so we never split a surrogate pair or exceed maxBytes.
  const chars = Array.from(text);
  let bytes = 0;
  let start = chars.length;
  while (start > 0) {
    const nextBytes = textEncoder.encode(chars[start - 1]!).byteLength;
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    start -= 1;
  }
  return chars.slice(start).join("");
}

/** In-memory bounded line ring buffer capped at both line count and UTF-8 bytes. */
class OutputRingBuffer {
  private readonly lines: string[] = [];
  private readonly bytes: number[] = [];
  private totalBytes = 0;
  private truncated = false;
  private readonly decoders = {
    stdout: new TextDecoder("utf-8", { fatal: false }),
    stderr: new TextDecoder("utf-8", { fatal: false }),
  };
  private readonly partial = {
    stdout: "",
    stderr: "",
  };

  appendChunk(stream: "stdout" | "stderr", chunk: Uint8Array): void {
    const decoded = this.decoders[stream].decode(chunk, { stream: true });
    this.appendText(stream, decoded);
  }

  flushStream(stream: "stdout" | "stderr"): void {
    const tail = this.decoders[stream].decode();
    if (tail.length > 0) this.appendText(stream, tail);
    if (this.partial[stream].length > 0) {
      const line = this.partial[stream].replace(/\r$/, "");
      this.partial[stream] = "";
      this.pushLine(line);
    }
  }

  private appendText(stream: "stdout" | "stderr", text: string): void {
    if (text.length === 0) return;
    const combined = this.partial[stream] + text;
    const parts = combined.split("\n");
    this.partial[stream] = parts.pop() ?? "";
    for (const part of parts) {
      this.pushLine(part.replace(/\r$/, ""));
    }
    if (textEncoder.encode(this.partial[stream]).byteLength > KEEP_RUNNING_MAX_OUTPUT_BYTES) {
      this.partial[stream] = truncateUtf8Tail(this.partial[stream], KEEP_RUNNING_MAX_OUTPUT_BYTES);
      this.truncated = true;
    }
  }

  private pushLine(rawLine: string): void {
    let line = rawLine;
    let lineBytes = textEncoder.encode(line).byteLength + 1;
    if (lineBytes > KEEP_RUNNING_MAX_OUTPUT_BYTES) {
      line = truncateUtf8Tail(line, KEEP_RUNNING_MAX_OUTPUT_BYTES - 1);
      lineBytes = textEncoder.encode(line).byteLength + 1;
      this.truncated = true;
    }
    this.lines.push(line);
    this.bytes.push(lineBytes);
    this.totalBytes += lineBytes;
    while (
      this.lines.length > KEEP_RUNNING_MAX_OUTPUT_LINES ||
      this.totalBytes > KEEP_RUNNING_MAX_OUTPUT_BYTES
    ) {
      this.lines.shift();
      const removed = this.bytes.shift() ?? 0;
      this.totalBytes -= removed;
      this.truncated = true;
    }
  }

  snapshot(maxLines?: number): {
    readonly lines: ReadonlyArray<string>;
    readonly truncated: boolean;
  } {
    const combined = [...this.lines];
    for (const stream of ["stdout", "stderr"] as const) {
      const pending = this.partial[stream].replace(/\r$/, "");
      if (pending.length > 0) combined.push(pending);
    }
    let truncated = this.truncated;
    let result = combined;
    if (result.length > KEEP_RUNNING_MAX_OUTPUT_LINES) {
      result = result.slice(-KEEP_RUNNING_MAX_OUTPUT_LINES);
      truncated = true;
    }
    if (maxLines !== undefined && result.length > maxLines) {
      result = result.slice(-maxLines);
      truncated = true;
    }
    return { lines: result, truncated };
  }

  clear(): void {
    this.lines.length = 0;
    this.bytes.length = 0;
    this.totalBytes = 0;
    this.truncated = false;
    this.partial.stdout = "";
    this.partial.stderr = "";
  }
}

export class ProjectKeepRunningService extends Context.Service<
  ProjectKeepRunningService,
  {
    readonly listStatuses: Effect.Effect<ReadonlyArray<ProjectKeepRunningStatus>>;
    readonly getStatusesForProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<ProjectKeepRunningStatus>>;
    readonly getOutput: (
      input: ProjectKeepRunningOutputInput & { readonly maxLines?: number },
    ) => Effect.Effect<ProjectKeepRunningOutputResult>;
    readonly control: (
      input: ProjectKeepRunningControlInput,
    ) => Effect.Effect<ProjectKeepRunningControlResult>;
    readonly reconcile: Effect.Effect<void>;
    readonly stream: Stream.Stream<ReadonlyArray<ProjectKeepRunningStatus>>;
  }
>()("t3/project/ProjectKeepRunningService") {}

interface DesiredEntry {
  readonly key: string;
  readonly projectId: ProjectId;
  readonly scriptId: string;
  readonly command: string;
  readonly workspaceRoot: string;
}

interface TrackedEntry {
  readonly projectId: ProjectId;
  readonly scriptId: string;
  readonly command: string;
  readonly workspaceRoot: string;
  readonly generation: number;
  readonly userStopped: boolean;
  readonly fiber: Fiber.Fiber<void, never> | null;
  readonly output: OutputRingBuffer;
  readonly status: ProjectKeepRunningStatus;
}

const entryKey = (projectId: ProjectId, scriptId: string) => `${projectId}\0${scriptId}`;
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const SIGNAL_EXIT_PATTERN = /receipt of signal: '([^']+)'/;

function parseExitFailure(cause: Cause.Cause<unknown>): {
  readonly signal: string | null;
  readonly message: string | null;
} {
  const squashed = Cause.squash(cause);
  const text = squashed instanceof Error ? squashed.message : String(squashed);
  const match = SIGNAL_EXIT_PATTERN.exec(text);
  if (match?.[1]) return { signal: match[1], message: null };
  return { signal: null, message: text.trim().length > 0 ? clampFailure(text) : null };
}

function shellInvocation(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  command: string,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  if (platform === "win32") {
    return {
      command: env.COMSPEC?.trim() || "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  const shell = listLoginShellCandidates(platform, env.SHELL)[0] ?? "/bin/sh";
  return {
    command: shell,
    args: ["-c", command],
  };
}

/** @public */
export const make = Effect.gen(function* () {
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const eventStore = yield* OrchestrationEventStore.OrchestrationEventStore;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const hostEnvironment = yield* HostProcess.Environment;

  // The server's own PORT and T3CODE_* values would point a dev server or `t3` started here at this server.
  const inheritedEnv = Object.fromEntries(
    Object.entries(hostEnvironment).filter(
      ([key, value]) => value !== undefined && !shouldExcludeTerminalEnvKey(key),
    ),
  );

  const entries = yield* Ref.make(new Map<string, TrackedEntry>());
  const changes = yield* PubSub.unbounded<ReadonlyArray<ProjectKeepRunningStatus>>();
  const actionLock = yield* Semaphore.make(1);
  const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => actionLock.withPermits(1)(effect);

  const serviceScope = yield* Scope.make("parallel");
  yield* Effect.addFinalizer(() => Scope.close(serviceScope, Exit.void));

  let sequence = 0;
  let nextGeneration = 0;

  const listStatuses: ProjectKeepRunningService["Service"]["listStatuses"] = Ref.get(entries).pipe(
    Effect.map((current) => Array.from(current.values(), (entry) => entry.status)),
  );

  const publish = listStatuses.pipe(
    Effect.flatMap((statuses) => PubSub.publish(changes, statuses)),
  );

  const updateIfCurrent = (
    key: string,
    generation: number,
    mutate: (entry: TrackedEntry) => TrackedEntry,
  ) =>
    Ref.modify(entries, (current) => {
      const existing = current.get(key);
      if (!existing || existing.generation !== generation) return [false, current] as const;
      const updated = mutate(existing);
      const next = new Map(current);
      next.set(key, {
        ...updated,
        status: { ...updated.status, sequence: ++sequence },
      });
      return [true, next] as const;
    }).pipe(
      Effect.tap((changed) => (changed ? publish : Effect.void)),
      Effect.asVoid,
    );

  const runAttempt = Effect.fn("ProjectKeepRunningService.runAttempt")(function* (
    entry: DesiredEntry,
    generation: number,
    output: OutputRingBuffer,
  ) {
    const env = {
      ...inheritedEnv,
      ...projectScriptRuntimeEnv({ project: { cwd: entry.workspaceRoot } }),
    };
    const shell = shellInvocation(platform, hostEnvironment, entry.command);
    const resolved = yield* resolveSpawnCommand(shell.command, shell.args, {
      env,
      extendEnv: false,
    });

    const childScope = yield* Scope.make("sequential");
    const drainScope = yield* Scope.make("parallel");

    return yield* Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            cwd: entry.workspaceRoot,
            env,
            extendEnv: false,
            shell: resolved.shell,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            forceKillAfter: FORCE_KILL_AFTER,
          }),
        )
        .pipe(
          Scope.provide(childScope),
          Effect.catchCause((cause) => {
            const detail = parseExitFailure(cause);
            return Effect.fail(detail.message ?? "Failed to start process.");
          }),
        );

      const startedAt = yield* nowIso;
      const startedAtMs = yield* Clock.currentTimeMillis;

      const drainStream = (
        streamName: "stdout" | "stderr",
        stream: Stream.Stream<Uint8Array, unknown>,
      ) =>
        stream.pipe(
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              output.appendChunk(streamName, chunk);
            }),
          ),
          Effect.ignoreCause,
          Effect.ensuring(Effect.sync(() => output.flushStream(streamName))),
          Effect.forkIn(drainScope),
        );

      const stdoutFiber = yield* drainStream("stdout", child.stdout);
      const stderrFiber = yield* drainStream("stderr", child.stderr);

      yield* updateIfCurrent(entry.key, generation, (current) => ({
        ...current,
        status: {
          ...current.status,
          state: "running",
          pid: Number(child.pid) > 0 ? Number(child.pid) : null,
          startedAt,
          failureMessage: null,
        },
      }));

      const exitResult = yield* Effect.exit(child.exitCode);
      const endedAtMs = yield* Clock.currentTimeMillis;
      // Close childScope before joining output fibers so no surviving grandchild holds stdout/stderr open.
      yield* Scope.close(childScope, Exit.void);
      yield* Fiber.await(stdoutFiber);
      yield* Fiber.await(stderrFiber);
      yield* Scope.close(drainScope, Exit.void);

      if (Exit.isSuccess(exitResult)) {
        return {
          exitCode: Number(exitResult.value),
          exitSignal: null as string | null,
          errorMessage: null as string | null,
          durationMs: Math.max(0, endedAtMs - startedAtMs),
        };
      }
      if (Cause.hasInterruptsOnly(exitResult.cause)) {
        return yield* Effect.interrupt;
      }
      const parsed = parseExitFailure(exitResult.cause);
      return {
        exitCode: null as number | null,
        exitSignal: parsed.signal,
        errorMessage: parsed.message,
        durationMs: Math.max(0, endedAtMs - startedAtMs),
      };
    }).pipe(
      Effect.ensuring(
        Effect.all([Scope.close(childScope, Exit.void), Scope.close(drainScope, Exit.void)], {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    );
  });

  const runSupervisor = Effect.fn("ProjectKeepRunningService.runSupervisor")(function* (
    entry: DesiredEntry,
    generation: number,
    output: OutputRingBuffer,
  ) {
    let consecutiveShortExits = 0;

    while (true) {
      const stat = yield* fileSystem.stat(entry.workspaceRoot).pipe(Effect.option);
      if (Option.isNone(stat) || stat.value.type !== "Directory") {
        yield* updateIfCurrent(entry.key, generation, (current) => ({
          ...current,
          fiber: null,
          status: {
            ...current.status,
            state: "failed",
            pid: null,
            startedAt: null,
            failureMessage: clampFailure(
              Option.isNone(stat)
                ? `Project folder does not exist: ${entry.workspaceRoot}`
                : `Project path is not a folder: ${entry.workspaceRoot}`,
            ),
          },
        }));
        return;
      }

      yield* updateIfCurrent(entry.key, generation, (current) => ({
        ...current,
        status: {
          ...current.status,
          state: "starting",
          pid: null,
          failureMessage: null,
        },
      }));

      const attempt = yield* Effect.result(runAttempt(entry, generation, output));
      const outcome =
        attempt._tag === "Success"
          ? attempt.success
          : {
              exitCode: null as number | null,
              exitSignal: null as string | null,
              errorMessage: attempt.failure,
              durationMs: 0,
            };

      let delayMs: number;
      if (outcome.durationMs >= KEEP_RUNNING_HEALTHY_RUN_MS) {
        consecutiveShortExits = 0;
        delayMs = KEEP_RUNNING_INITIAL_RESTART_DELAY_MS;
      } else {
        consecutiveShortExits += 1;
        if (consecutiveShortExits >= KEEP_RUNNING_MAX_SHORT_EXITS) {
          const reason =
            outcome.errorMessage ??
            (outcome.exitSignal !== null
              ? `Stopped after ${KEEP_RUNNING_MAX_SHORT_EXITS} short runs (last signal ${outcome.exitSignal}).`
              : outcome.exitCode !== null
                ? `Stopped after ${KEEP_RUNNING_MAX_SHORT_EXITS} short runs (last exit code ${outcome.exitCode}).`
                : `Stopped after ${KEEP_RUNNING_MAX_SHORT_EXITS} short runs.`);
          yield* updateIfCurrent(entry.key, generation, (current) => ({
            ...current,
            fiber: null,
            status: {
              ...current.status,
              state: "failed",
              pid: null,
              lastExitCode: outcome.exitCode,
              lastExitSignal: outcome.exitSignal,
              failureMessage: clampFailure(reason),
            },
          }));
          return;
        }
        delayMs = nextKeepRunningRestartDelayMs(consecutiveShortExits);
      }

      yield* updateIfCurrent(entry.key, generation, (current) => ({
        ...current,
        status: {
          ...current.status,
          state: "restarting",
          pid: null,
          lastExitCode: outcome.exitCode,
          lastExitSignal: outcome.exitSignal,
          failureMessage: outcome.errorMessage ? clampFailure(outcome.errorMessage) : null,
        },
      }));

      yield* Effect.sleep(Duration.millis(delayMs));

      yield* updateIfCurrent(entry.key, generation, (current) => ({
        ...current,
        status: {
          ...current.status,
          restartCount: current.status.restartCount + 1,
        },
      }));
    }
  });

  const stopEntryFiber = (entry: TrackedEntry) =>
    entry.fiber ? Fiber.interrupt(entry.fiber).pipe(Effect.ignore) : Effect.void;

  const startEntry = Effect.fn("ProjectKeepRunningService.startEntry")(function* (
    desired: DesiredEntry,
    output: OutputRingBuffer,
  ) {
    const generation = ++nextGeneration;
    const initialStatus: ProjectKeepRunningStatus = {
      projectId: desired.projectId,
      scriptId: desired.scriptId,
      state: "starting",
      pid: null,
      startedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastExitSignal: null,
      failureMessage: null,
      sequence: ++sequence,
    };
    yield* Ref.update(entries, (current) => {
      const next = new Map(current);
      next.set(desired.key, {
        projectId: desired.projectId,
        scriptId: desired.scriptId,
        command: desired.command,
        workspaceRoot: desired.workspaceRoot,
        generation,
        userStopped: false,
        fiber: null,
        output,
        status: initialStatus,
      });
      return next;
    });
    yield* publish;
    const fiber = yield* runSupervisor(desired, generation, output).pipe(
      Effect.ignoreCause,
      Effect.forkIn(serviceScope),
    );
    yield* Ref.update(entries, (current) => {
      const existing = current.get(desired.key);
      if (!existing || existing.generation !== generation) return current;
      const next = new Map(current);
      next.set(desired.key, { ...existing, fiber });
      return next;
    });
  });

  const reconcileLocked = Effect.fn("ProjectKeepRunningService.reconcile")(function* () {
    const [settings, rows] = yield* Effect.all([
      serverSettings.getSettings.pipe(Effect.option),
      projectStore.list().pipe(Effect.option),
    ]);
    if (Option.isNone(settings) || Option.isNone(rows)) return;

    const desired = new Map<string, DesiredEntry>();
    for (const row of rows.value) {
      const scripts = resolveKeepRunningProjectScripts(settings.value, {
        id: row.projectId,
        scripts: row.scripts,
        archivedAt: row.archivedAt,
        deletedAt: row.deletedAt,
      });
      for (const script of scripts) {
        const key = entryKey(row.projectId, script.id);
        desired.set(key, {
          key,
          projectId: row.projectId,
          scriptId: script.id,
          command: script.command,
          workspaceRoot: row.workspaceRoot,
        });
      }
    }

    const current = yield* Ref.get(entries);
    const toRemove: Array<TrackedEntry> = [];
    const toRestart: Array<{ readonly existing: TrackedEntry; readonly next: DesiredEntry }> = [];
    const toAdd: Array<DesiredEntry> = [];

    for (const [key, existing] of current) {
      const next = desired.get(key);
      if (next === undefined) {
        toRemove.push(existing);
      } else if (
        existing.command !== next.command ||
        existing.workspaceRoot !== next.workspaceRoot
      ) {
        toRestart.push({ existing, next });
      }
    }
    for (const [key, next] of desired) {
      if (!current.has(key)) toAdd.push(next);
    }

    if (toRemove.length === 0 && toRestart.length === 0 && toAdd.length === 0) return;

    for (const removed of toRemove) {
      yield* Ref.update(entries, (map) => {
        const next = new Map(map);
        next.delete(entryKey(removed.projectId, removed.scriptId));
        return next;
      });
    }
    if (toRemove.length > 0) yield* publish;

    yield* Effect.forEach(toRemove, stopEntryFiber, { concurrency: "unbounded", discard: true });

    for (const { existing, next } of toRestart) {
      yield* stopEntryFiber(existing);
      const freshOutput = new OutputRingBuffer();
      yield* startEntry(next, freshOutput);
    }

    for (const added of toAdd) {
      yield* startEntry(added, new OutputRingBuffer());
    }
  });

  const reconcile = locked(reconcileLocked());

  const controlLocked = Effect.fn("ProjectKeepRunningService.control")(function* (
    input: ProjectKeepRunningControlInput,
  ): Effect.fn.Return<ProjectKeepRunningControlResult> {
    const key = entryKey(input.projectId, input.scriptId);
    const current = yield* Ref.get(entries);
    const existing = current.get(key);
    if (!existing) {
      return { applied: false, status: null };
    }

    if (input.action === "stop") {
      const generation = ++nextGeneration;
      const stoppedStatus: ProjectKeepRunningStatus = {
        ...existing.status,
        state: "stopped",
        pid: null,
        startedAt: null,
        failureMessage: null,
        sequence: ++sequence,
      };
      yield* Ref.update(entries, (map) => {
        const next = new Map(map);
        next.set(key, {
          ...existing,
          generation,
          userStopped: true,
          fiber: null,
          status: stoppedStatus,
        });
        return next;
      });
      yield* publish;
      yield* stopEntryFiber(existing);
      return { applied: true, status: stoppedStatus };
    }

    yield* stopEntryFiber(existing);
    yield* startEntry(
      {
        key,
        projectId: existing.projectId,
        scriptId: existing.scriptId,
        command: existing.command,
        workspaceRoot: existing.workspaceRoot,
      },
      existing.output,
    );
    const updated = (yield* Ref.get(entries)).get(key)?.status ?? null;
    return { applied: true, status: updated };
  });

  const control: ProjectKeepRunningService["Service"]["control"] = Effect.fnUntraced(
    function* (input) {
      return yield* locked(controlLocked(input));
    },
  );

  const getStatusesForProject: ProjectKeepRunningService["Service"]["getStatusesForProject"] = (
    projectId,
  ) =>
    Ref.get(entries).pipe(
      Effect.map((current) =>
        Array.from(current.values())
          .filter((entry) => entry.projectId === projectId)
          .map((entry) => entry.status),
      ),
    );

  const getOutput: ProjectKeepRunningService["Service"]["getOutput"] = (input) =>
    Ref.get(entries).pipe(
      Effect.map((current) => {
        const existing = current.get(entryKey(input.projectId, input.scriptId));
        if (!existing) {
          return {
            projectId: input.projectId,
            scriptId: input.scriptId,
            lines: [],
            truncated: false,
          };
        }
        const snap = existing.output.snapshot(input.maxLines);
        return {
          projectId: input.projectId,
          scriptId: input.scriptId,
          lines: snap.lines,
          truncated: snap.truncated,
        };
      }),
    );

  const stream: ProjectKeepRunningService["Service"]["stream"] = Stream.callback<
    ReadonlyArray<ProjectKeepRunningStatus>
  >(
    (mailbox) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        Queue.offerUnsafe(mailbox, yield* listStatuses);
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((statuses) => Effect.sync(() => Queue.offerUnsafe(mailbox, statuses))),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 1, strategy: "sliding" },
  );

  // Subscribe to settings and project event streams before the initial reconcile so nothing in between is missed.
  const settingsStream = yield* serverSettings.subscribeChanges.pipe(Scope.provide(serviceScope));
  yield* settingsStream.pipe(
    Stream.runForEach(() => reconcile.pipe(Effect.ignoreCause({ log: true }))),
    Effect.forkIn(serviceScope),
  );

  const watchProjects = Stream.unwrap(
    eventStore.latestApplicationSequence.pipe(
      Effect.map((afterSequence) =>
        eventStore
          .streamApplicationEvents({ afterSequence })
          .pipe(
            Stream.filter(
              (stored) => "aggregateKind" in stored && stored.aggregateKind === "project",
            ),
          ),
      ),
    ),
  ).pipe(
    Stream.runForEach(() => reconcile.pipe(Effect.ignoreCause({ log: true }))),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Keep-running project watcher failed; retrying", { cause }).pipe(
            Effect.andThen(Effect.sleep(WATCH_RETRY_DELAY)),
          ),
    ),
    Effect.forever,
  );
  yield* watchProjects.pipe(Effect.forkIn(serviceScope));

  yield* reconcile;

  return ProjectKeepRunningService.of({
    listStatuses,
    getStatusesForProject,
    getOutput,
    control,
    reconcile,
    stream,
  });
});

export const layer = Layer.effect(ProjectKeepRunningService, make);
