import { McpAttachmentInput } from "../attachment/input.ts";
import {
  clampedPositiveInt,
  IsoDateTime,
  MarkPublishedResult,
  MessageId,
  NonNegativeInt,
  ModelSelection,
  ThreadCardOpenKind,
  TrimmedNonEmptyString,
  ThreadId,
  RunId,
  OrchestrationV2DelegatedFrom,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  RuntimeMode,
  ProviderInteractionMode,
  Project,
  ProjectCreatePayload,
  ProjectKeepRunningControlAction,
  ProjectKeepRunningState,
  ProjectScript,
  ProjectUpdatePayload,
  ProjectId,
  PositiveInt,
  OrchestratorMcpClientRequestId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import * as ProjectKeepRunningService from "../../../project/ProjectKeepRunningService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as OpenItemService from "../../../orchestration-v2/OpenItemService.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  success: Project,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    ServerSettings.ServerSettingsService,
    SecureRandom.SecureRandom,
  ],
};
const ProjectListTool = Tool.make("t3_project_list", {
  ...shared,
  description: "List projects. Pages can shift.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(clampedPositiveInt(100)),
  }),
  success: Schema.Struct({
    projects: Schema.Array(Project),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectReadScript = Schema.Struct({
  ...ProjectScript.fields,
  keepRunningStatus: Schema.optional(
    Schema.Struct({
      state: ProjectKeepRunningState,
      pid: Schema.NullOr(PositiveInt),
      startedAt: Schema.NullOr(IsoDateTime),
      restartCount: NonNegativeInt,
      lastExitCode: Schema.NullOr(Schema.Int),
      lastExitSignal: Schema.NullOr(TrimmedNonEmptyString),
      failureMessage: Schema.NullOr(Schema.String),
      outputTail: Schema.Array(Schema.String),
    }),
  ),
});

const ProjectReadResult = Schema.Struct({
  ...Project.fields,
  scripts: Schema.Array(ProjectReadScript),
});

const ProjectReadTool = Tool.make("t3_project_read", {
  ...shared,
  description:
    "Read one project: workspace, saved scripts, and status/recent output for keepRunning scripts.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
  }),
  success: ProjectReadResult,
  dependencies: [...shared.dependencies, ProjectKeepRunningService.ProjectKeepRunningService],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectCreateTool = Tool.make("t3_project_create", {
  ...shared,
  description:
    "Register a project folder. `createWorkspaceRootIfMissing` creates it; a registered folder is rejected. No `workspaceRoot`: makes a git repo from `title` with README, icon, first commit (`commitError` on failure; project still exists). Clone first with `t3_project_clone` if needed.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...ProjectCreatePayload.fields,
    workspaceRoot: Schema.optional(ProjectCreatePayload.fields.workspaceRoot),
  }),
  success: Schema.Struct({ ...Project.fields, commitError: Schema.optional(Schema.String) }),
  dependencies: [
    ...shared.dependencies,
    ManagedProjectFolders.ManagedProjectFolders,
    ProjectKeepRunningService.ProjectKeepRunningService,
  ],
}).annotate(Tool.Destructive, true);
const ProjectUpdateTool = Tool.make("t3_project_update", {
  ...shared,
  description:
    "Update one project's settings or scripts (set `keepRunning: true` on a script to run it in the background and restart on exit or server restart; pass `keepRunningControl` to stop or restart one). Omitted fields are unchanged.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
    ...ProjectUpdatePayload.fields,
    keepRunningControl: Schema.optional(
      Schema.Struct({
        scriptId: TrimmedNonEmptyString,
        action: ProjectKeepRunningControlAction,
      }).annotate({
        description: "Stop or restart an active keepRunning script on this project.",
      }),
    ),
  }),
  dependencies: [...shared.dependencies, ProjectKeepRunningService.ProjectKeepRunningService],
}).annotate(Tool.Destructive, true);
const ProjectDeleteTool = Tool.make("t3_project_delete", {
  ...shared,
  description: "Delete one project. Nonempty needs `force: true`. Folder on disk stays.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
    force: Schema.optionalKey(Schema.Boolean),
  }),
  dependencies: [
    ...shared.dependencies,
    ProjectCloneTracker.ProjectCloneTracker,
    ManagedProjectFolders.ManagedProjectFolders,
  ],
}).annotate(Tool.Destructive, true);
const ProjectCloneTool = Tool.make("t3_project_clone", {
  ...shared,
  description:
    "Clone a repository (`destinationPath` new or empty). Register after with `t3_project_create`, with the same `environmentId`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...SourceControlCloneRepositoryInput.fields,
  }),
  success: SourceControlCloneRepositoryResult,
  dependencies: [
    ...shared.dependencies,
    SourceControlRepositoryService.SourceControlRepositoryService,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
const ThreadLaunchTool = Tool.make("t3_thread_launch", {
  ...shared,
  description:
    "Create a top-level thread in its workspace before starting. Task in `message`. Omit `projectId`, model and modes to inherit yours (outside a thread, pass `projectId` or `scratch`); modes cannot exceed yours. On error or lost reply, reuse `clientRequestId`. Follow it with `t3_thread_read` or `t3_thread_wait`. Mention it with its `link`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optional(ProjectId),
    scratch: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "No project: a new Scratch folder. Not with `projectId` or `workspaceStrategy`.",
      }),
    ),
    title: TrimmedNonEmptyString,
    generateTitle: Schema.optional(Schema.Boolean),
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    workspaceStrategy: Schema.optional(
      OrchestrationV2ThreadLaunchWorkspaceStrategy.annotate({
        description:
          "'worktree': new checkout from `baseRef`. Honor a requested base. Otherwise, independent work uses the default branch as `remote/branch` (e.g. `origin/main`) with `startFromOrigin: true`; with no remote, use the local default branch. Required unpublished commits and dependent or stacked work use their local base with `startFromOrigin: false`. 'existing_worktree': bind `worktreePath`, a project worktree. 'root': project checkout, the default, not your worktree. Uncommitted edits are not copied.",
      }),
    ),
    message: Schema.optional(
      Schema.String.check(Schema.isMaxLength(120000)).annotate({
        description: "First prompt. Omit it and `attachments` for idle.",
      }),
    ),
    attachments: Schema.optional(Schema.Array(McpAttachmentInput).check(Schema.isMaxLength(8))),
    outputSchema: Schema.optional(
      Schema.Record(Schema.String, Schema.Json).annotate({
        description: "As in `t3_thread_send`. Needs `message`.",
      }),
    ),
    clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
    /** Set by a linked environment launching its agent's delegated task here; ignored otherwise. */
    delegatedFrom: Schema.optional(OrchestrationV2DelegatedFrom),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    link: Schema.optional(Schema.String),
    projectId: ProjectId,
    modelSelection: ModelSelection,
    runId: Schema.NullOr(RunId),
    status: Schema.NullOr(OrchestrationV2RunStatus),
  }),
  dependencies: [
    ...shared.dependencies,
    ThreadLaunchService.ThreadLaunchService,
    ManagedProjectFolders.ManagedProjectFolders,
    GitVcsDriver.GitVcsDriver,
    FileSystem.FileSystem,
    ServerConfig.ServerConfig,
    ServerSettings.ServerSettingsService,
    ProviderRegistry.ProviderRegistry,
    DocumentText.DocumentText,
    Digest.Digest,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const OpenItemsTool = Tool.make("t3_open_items", {
  ...shared,
  description:
    "What is still owed in a project: publishes, commits, checks, questions. Omit `projectId` for this thread's project. `list` before answering whether it is safe to publish. `mark_published` only after the user says they have published; it clears the waiting-on-publish items and starts post-publish checks. `resolve`: one listed item that is done, by its `threadId` and `key`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    action: Schema.Literals(["list", "mark_published", "resolve"]),
    projectId: Schema.optional(ProjectId),
    threadId: Schema.optional(ThreadId),
    key: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  }),
  success: Schema.Union([
    Schema.Struct({
      items: Schema.Array(
        Schema.Struct({
          kind: ThreadCardOpenKind,
          text: Schema.String,
          dueAt: Schema.optional(IsoDateTime),
          key: Schema.String,
          threadId: ThreadId,
          link: Schema.optional(Schema.String),
          /** The thread's topic the item is filed with. */
          topic: Schema.String,
          /** The reply that left it open. */
          messageId: MessageId,
          settled: Schema.Boolean,
        }),
      ),
      lastPublishedAt: Schema.NullOr(IsoDateTime),
    }),
    MarkPublishedResult,
    Schema.Struct({ resolved: Schema.Literal(true) }),
  ]),
  dependencies: [...shared.dependencies, OpenItemService.OpenItemService],
})
  .annotate(Tool.Title, "Still open in a project")
  .annotate(Tool.Destructive, true);

export const ProjectToolkit = Toolkit.make(
  ThreadLaunchTool,
  ProjectListTool,
  ProjectReadTool,
  ProjectCreateTool,
  ProjectUpdateTool,
  ProjectDeleteTool,
  ProjectCloneTool,
  OpenItemsTool,
);
