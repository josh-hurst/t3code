import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const PROJECT_KEEP_RUNNING_FAILURE_MAX_LENGTH = 500;

export const ProjectKeepRunningState = Schema.Literals([
  "starting",
  "running",
  "restarting",
  "stopped",
  "failed",
]);
export type ProjectKeepRunningState = typeof ProjectKeepRunningState.Type;

export const ProjectKeepRunningStatus = Schema.Struct({
  projectId: ProjectId,
  scriptId: TrimmedNonEmptyString,
  state: ProjectKeepRunningState,
  pid: Schema.NullOr(PositiveInt),
  startedAt: Schema.NullOr(IsoDateTime),
  restartCount: NonNegativeInt,
  lastExitCode: Schema.NullOr(Schema.Int),
  lastExitSignal: Schema.NullOr(TrimmedNonEmptyString),
  failureMessage: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(PROJECT_KEEP_RUNNING_FAILURE_MAX_LENGTH)),
  ),
  sequence: NonNegativeInt,
});
export type ProjectKeepRunningStatus = typeof ProjectKeepRunningStatus.Type;

export const ProjectKeepRunningSubscribeInput = Schema.Struct({});
export type ProjectKeepRunningSubscribeInput = typeof ProjectKeepRunningSubscribeInput.Type;

export const ProjectKeepRunningListEvent = Schema.Array(ProjectKeepRunningStatus);
export type ProjectKeepRunningListEvent = typeof ProjectKeepRunningListEvent.Type;

export const ProjectKeepRunningOutputInput = Schema.Struct({
  projectId: ProjectId,
  scriptId: TrimmedNonEmptyString,
});
export type ProjectKeepRunningOutputInput = typeof ProjectKeepRunningOutputInput.Type;

export const ProjectKeepRunningOutputResult = Schema.Struct({
  projectId: ProjectId,
  scriptId: TrimmedNonEmptyString,
  lines: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
});
export type ProjectKeepRunningOutputResult = typeof ProjectKeepRunningOutputResult.Type;

export const ProjectKeepRunningControlAction = Schema.Literals(["stop", "restart"]);
export type ProjectKeepRunningControlAction = typeof ProjectKeepRunningControlAction.Type;

export const ProjectKeepRunningControlInput = Schema.Struct({
  projectId: ProjectId,
  scriptId: TrimmedNonEmptyString,
  action: ProjectKeepRunningControlAction,
});
export type ProjectKeepRunningControlInput = typeof ProjectKeepRunningControlInput.Type;

export const ProjectKeepRunningControlResult = Schema.Struct({
  applied: Schema.Boolean,
  status: Schema.NullOr(ProjectKeepRunningStatus),
});
export type ProjectKeepRunningControlResult = typeof ProjectKeepRunningControlResult.Type;
