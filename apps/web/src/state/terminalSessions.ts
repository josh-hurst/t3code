import { useAtomValue } from "@effect/atom-react";
import {
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  EMPTY_TERMINAL_SESSION_STATE,
  selectRunningSubprocessTerminalIds,
  type KnownTerminalSession,
  type TerminalSessionState,
} from "@t3tools/client-runtime/state/terminal";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  TerminalAttachInput,
  type TerminalSummary,
} from "@t3tools/contracts";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { formatEnvironmentQueryError } from "./query";
import { terminalEnvironment } from "./terminal";
import { environmentSession, sessionHasScope, useEnvironmentScope } from "./session";
import { environmentThreadShells } from "./threads";

const EMPTY_KNOWN_TERMINAL_SESSIONS = Object.freeze<ReadonlyArray<KnownTerminalSession>>([]);

interface TerminalMetadataIndex {
  readonly all: ReadonlyArray<TerminalSummary>;
  readonly byThreadId: ReadonlyMap<string, ReadonlyArray<TerminalSummary>>;
  readonly views: Map<EnvironmentId, Map<ThreadId | null, ReadonlyArray<KnownTerminalSession>>>;
}

const metadataIndexes = new WeakMap<ReadonlyArray<TerminalSummary>, TerminalMetadataIndex>();
const sessionsBySummary = new WeakMap<TerminalSummary, Map<EnvironmentId, KnownTerminalSession>>();
// Reuse held groups without retaining old members when their anchor survives in newer snapshots.
const groupsByAnchor = new WeakMap<
  TerminalSummary,
  Map<
    EnvironmentId,
    {
      readonly all?: WeakRef<ReadonlyArray<KnownTerminalSession>>;
      readonly thread?: WeakRef<ReadonlyArray<KnownTerminalSession>>;
    }
  >
>();

function knownSession(
  summary: TerminalSummary,
  environmentId: EnvironmentId,
): KnownTerminalSession {
  let byEnvironment = sessionsBySummary.get(summary);
  const previous = byEnvironment?.get(environmentId);
  if (previous) return previous;
  const session = {
    target: {
      environmentId,
      threadId: ThreadId.make(summary.threadId),
      terminalId: summary.terminalId,
    },
    state: combineTerminalSessionState(summary, EMPTY_TERMINAL_BUFFER_STATE),
  };
  if (!byEnvironment) {
    byEnvironment = new Map();
    sessionsBySummary.set(summary, byEnvironment);
  }
  byEnvironment.set(environmentId, session);
  return session;
}

function terminalMetadataIndex(metadata: ReadonlyArray<TerminalSummary>): TerminalMetadataIndex {
  let index = metadataIndexes.get(metadata);
  if (!index) {
    const compare = new Intl.Collator(undefined, { numeric: true }).compare;
    const all = metadata.toSorted((left, right) => compare(left.terminalId, right.terminalId));
    const byThreadId = new Map<string, TerminalSummary[]>();
    for (const summary of all) {
      const group = byThreadId.get(summary.threadId);
      if (group) group.push(summary);
      else byThreadId.set(summary.threadId, [summary]);
    }
    index = { all, byThreadId, views: new Map() };
    metadataIndexes.set(metadata, index);
  }
  return index;
}

export function selectKnownTerminalSessions(
  metadata: ReadonlyArray<TerminalSummary> | null,
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ReadonlyArray<KnownTerminalSession> {
  if (environmentId === null || metadata === null || metadata.length === 0) {
    return EMPTY_KNOWN_TERMINAL_SESSIONS;
  }
  const index = terminalMetadataIndex(metadata);
  let views = index.views.get(environmentId);
  const cached = views?.get(threadId);
  if (cached) return cached;
  const summaries = threadId === null ? index.all : index.byThreadId.get(threadId);
  if (!summaries || summaries.length === 0) return EMPTY_KNOWN_TERMINAL_SESSIONS;

  const anchor = summaries[0]!;
  const kind = threadId === null ? "all" : "thread";
  let groups = groupsByAnchor.get(anchor);
  const previousGroups = groups?.get(environmentId);
  const previous = previousGroups?.[kind]?.deref();
  const sessions =
    previous?.length === summaries.length &&
    previous.every((session, index) => session.state.summary === summaries[index])
      ? previous
      : summaries.map((summary) => knownSession(summary, environmentId));
  if (!groups) {
    groups = new Map();
    groupsByAnchor.set(anchor, groups);
  }
  if (sessions !== previous) {
    groups.set(environmentId, { ...previousGroups, [kind]: new WeakRef(sessions) });
  }
  if (!views) {
    views = new Map();
    index.views.set(environmentId, views);
  }
  views.set(threadId, sessions);
  return sessions;
}

/**
 * Live terminals that other threads of the same project own, for shared project terminals.
 * Exited shells stay out: there is nothing left to switch to.
 */
function selectSharedProjectTerminalSessions(
  sessions: ReadonlyArray<KnownTerminalSession>,
  projectThreadRefs: ReadonlyArray<{ readonly threadId: ThreadId }>,
  threadId: ThreadId,
): ReadonlyArray<KnownTerminalSession> {
  if (sessions.length === 0 || projectThreadRefs.length === 0) {
    return EMPTY_KNOWN_TERMINAL_SESSIONS;
  }
  const projectThreadIds = new Set<string>(projectThreadRefs.map((ref) => ref.threadId));
  const shared = sessions.filter(
    (session) =>
      session.target.threadId !== threadId &&
      projectThreadIds.has(session.target.threadId) &&
      (session.state.status === "running" || session.state.status === "starting"),
  );
  return shared.length === 0 ? EMPTY_KNOWN_TERMINAL_SESSIONS : shared;
}

const EMPTY_TERMINAL_SESSION_ATOM = Atom.make(EMPTY_TERMINAL_SESSION_STATE).pipe(
  Atom.withLabel("web-terminal-session:empty"),
);

const decodeAttachKey = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Tuple([EnvironmentId, TerminalAttachInput])),
);

// The family key carries the whole launch so an idle atom leaves nothing behind.
const attachedTerminalSessionFamily = Atom.family((key: string) => {
  const decoded = decodeAttachKey(key);
  if (Option.isNone(decoded)) {
    return Atom.make<TerminalSessionState>({
      ...EMPTY_TERMINAL_SESSION_STATE,
      error: "Invalid terminal launch input",
      status: "error",
    }).pipe(Atom.withLabel(`web-terminal-session:${key}`));
  }
  const [environmentId, terminal] = decoded.value;
  return Atom.make((get): TerminalSessionState => {
    const session = get(environmentSession.sessionStateAtom(environmentId));
    const canRead = sessionHasScope(session, AuthTerminalReadScope);
    const canOperate = sessionHasScope(session, AuthTerminalOperateScope);
    const attach = canOperate
      ? get(terminalEnvironment.attach({ environmentId, input: terminal }))
      : canRead
        ? get(
            terminalEnvironment.observe({
              environmentId,
              input: { threadId: terminal.threadId, terminalId: terminal.terminalId },
            }),
          )
        : null;
    const metadata = canRead
      ? AsyncResult.getOrElse(
          get(terminalEnvironment.metadata({ environmentId, input: null })),
          () => null,
        )
      : null;
    const summary =
      (metadata === null
        ? null
        : terminalMetadataIndex(metadata)
            .byThreadId.get(terminal.threadId)
            ?.find((candidate) => candidate.terminalId === terminal.terminalId)) ?? null;
    const buffer =
      attach === null
        ? EMPTY_TERMINAL_BUFFER_STATE
        : AsyncResult.getOrElse(attach, () => EMPTY_TERMINAL_BUFFER_STATE);
    const state = combineTerminalSessionState(summary, buffer);
    return attach?._tag === "Failure"
      ? { ...state, error: formatEnvironmentQueryError(attach.cause), status: "error" }
      : state;
  }).pipe(Atom.withLabel(`web-terminal-session:${key}`));
});

/**
 * One shown terminal's session: its attach (or read-only observe) buffer
 * combined with the metadata summary. Surfaces subscribe to it imperatively so
 * output chunks never re-render React.
 */
export function attachedTerminalSessionAtom(
  environmentId: EnvironmentId | null,
  terminal: TerminalAttachInput | null,
): Atom.Atom<TerminalSessionState> {
  if (environmentId === null || terminal === null) return EMPTY_TERMINAL_SESSION_ATOM;
  return attachedTerminalSessionFamily(JSON.stringify([environmentId, terminal]));
}

const NO_KNOWN_TERMINAL_SESSIONS_ATOM = Atom.make<ReadonlyArray<KnownTerminalSession> | null>(null);

const decodeKnownSessionsKey = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Tuple([EnvironmentId, Schema.NullOr(ThreadId)])),
);

// Derived per thread, so a terminal update elsewhere in the environment notifies no one here.
const knownTerminalSessionsFamily = Atom.family((key: string) => {
  const [environmentId, threadId] = Option.getOrThrow(decodeKnownSessionsKey(key));
  return Atom.make((get) => {
    const metadata = get(terminalEnvironment.metadata({ environmentId, input: null }));
    return metadata._tag === "Success"
      ? selectKnownTerminalSessions(metadata.value, environmentId, threadId)
      : null;
  }).pipe(Atom.withLabel(`web-known-terminal-sessions:${key}`));
});

export function knownTerminalSessionsAtom(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): Atom.Atom<ReadonlyArray<KnownTerminalSession> | null> {
  return knownTerminalSessionsFamily(JSON.stringify([environmentId, threadId]));
}

const decodeSharedSessionsKey = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Tuple([EnvironmentId, ProjectId, ThreadId])),
);

// Derived per thread, so terminal updates outside the project's other threads notify no one here.
const sharedProjectTerminalSessionsFamily = Atom.family((key: string) => {
  const [environmentId, projectId, threadId] = Option.getOrThrow(decodeSharedSessionsKey(key));
  let previous = EMPTY_KNOWN_TERMINAL_SESSIONS;
  return Atom.make((get) => {
    const metadata = get(terminalEnvironment.metadata({ environmentId, input: null }));
    if (metadata._tag !== "Success") return null;
    const projectThreadRefs =
      get(environmentThreadShells.environmentThreadRefsByProjectAtom(environmentId)).get(
        projectId,
      ) ?? [];
    const next = selectSharedProjectTerminalSessions(
      selectKnownTerminalSessions(metadata.value, environmentId, null),
      projectThreadRefs,
      threadId,
    );
    if (arrayElementsEqual(next, previous)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-shared-project-terminal-sessions:${key}`));
});

export function sharedProjectTerminalSessionsAtom(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
): Atom.Atom<ReadonlyArray<KnownTerminalSession> | null> {
  return sharedProjectTerminalSessionsFamily(JSON.stringify([environmentId, projectId, threadId]));
}

/** `null` input turns the lookup off; a `null` result means metadata has not loaded. */
export function useSharedProjectTerminalSessions(
  input: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  } | null,
): ReadonlyArray<KnownTerminalSession> | null {
  const canRead = useEnvironmentScope(input?.environmentId ?? null, AuthTerminalReadScope);
  return useAtomValue(
    input === null || !canRead
      ? NO_KNOWN_TERMINAL_SESSIONS_ATOM
      : sharedProjectTerminalSessionsAtom(input.environmentId, input.projectId, input.threadId),
  );
}

export function useKnownTerminalSessions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<KnownTerminalSession> | null {
  const canRead = useEnvironmentScope(input.environmentId, AuthTerminalReadScope);
  return useAtomValue(
    input.environmentId === null || !canRead
      ? NO_KNOWN_TERMINAL_SESSIONS_ATOM
      : knownTerminalSessionsAtom(input.environmentId, input.threadId),
  );
}

export function useThreadRunningTerminalIds(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<string> {
  const sessions = useKnownTerminalSessions(input);
  return selectRunningSubprocessTerminalIds(sessions ?? []);
}
