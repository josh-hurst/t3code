import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadEntryId,
  ThreadId,
  type ListThreadEntriesResult,
  type ScopedThreadRef,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const SCRATCH_ROOT = "/home/user/.t3/scratch";

const state = vi.hoisted(() => ({
  workspaceRoot: "",
  folder: "",
  pullRequests: [] as unknown[],
  configLoaded: true,
  entries: null as unknown,
  renameEntry: vi.fn(async (_entryId: string, _title: string) => true),
}));

// Topics are read and edited only through these; null entries is a server that keeps none.
vi.mock(import("~/state/threadEntries"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadEntries: ((
    _environmentId: unknown,
    _threadId: unknown,
    select?: (v: unknown) => unknown,
  ) => (select ? select(state.entries) : state.entries)) as never,
}));
vi.mock(import("~/state/session"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useEnvironmentScope: ((environmentId, scope) => {
      const granted = actual.useEnvironmentScope(environmentId, scope);
      return granted || (state.entries !== null && scope === AuthOrchestrationOperateScope);
    }) as typeof actual.useEnvironmentScope,
  };
});
vi.mock(import("./useThreadContentsActions"), () => ({
  useThreadContentsActions: (() => ({ renameEntry: state.renameEntry })) as never,
}));

vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProject: ((ref: unknown) =>
    ref === null
      ? null
      : {
          id: "project",
          environmentId: "environment",
          title: state.workspaceRoot === SCRATCH_ROOT ? "No project" : "plain",
          workspaceRoot: state.workspaceRoot,
          scripts: [],
        }) as never,
  useProjects: (() => []) as never,
  useQuietThreadShell: ((ref: unknown) =>
    ref === null
      ? null
      : {
          id: "thread",
          environmentId: "environment",
          projectId: "project",
          worktreePath: state.folder,
          branch: null,
          pullRequests: state.pullRequests,
        }) as never,
  useServerConfigs: (() =>
    new Map(
      state.configLoaded
        ? [
            [
              EnvironmentId.make("environment"),
              {
                scratchWorkspaceRoot: SCRATCH_ROOT,
                environment: { capabilities: { pullRequests: true } },
              },
            ],
          ]
        : [],
    )) as never,
}));
// Neither folder is a repository, which is what the server reports for both.
vi.mock(import("~/state/vcs"), async (importOriginal) => {
  const actual = await importOriginal();
  const notARepo = Atom.make(
    AsyncResult.success({
      isRepo: false,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 0,
      pr: null,
    }),
  );
  return {
    ...actual,
    vcsEnvironment: { ...actual.vcsEnvironment, status: (() => notARepo) as never },
  };
});

import { render } from "../../../test/render";
import { useRightPanelStore } from "../../rightPanelStore";
import { PopoverCreateHandle } from "../ui/popover";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { ThreadDetailsPanel } from "./ThreadDetailsPanel";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const container = { width: 1200, height: 800 };
const placement = { x: 908, y: 0, right: 12, width: 280, height: 400 } as const;
const linkedPullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "pingdotgg/t3code",
  number: 27513,
  url: "https://github.com/pingdotgg/t3code/pull/27513",
  source: "manual",
  linkedAt: "2026-10-30T00:00:00.000Z",
  snapshot: null,
  stack: null,
};

const topics = (count: number): ListThreadEntriesResult => ({
  revision: 1,
  entries: Array.from({ length: count }, (_, index) => ({
    id: ThreadEntryId.make(`entry-${index + 1}`),
    threadId: threadRef.threadId,
    title: `Topic ${index + 1}`,
    titleSource: "model" as const,
    outcome: "",
    open: [],
    runs: [],
    startMessageId: MessageId.make(`message-${index + 1}`),
    endMessageId: MessageId.make(`message-${index + 1}`),
    startedAt: "2026-11-01T00:00:00.000Z",
    endedAt: "2026-11-01T00:00:00.000Z",
    status: "active" as const,
  })),
});

function setup(input: {
  workspaceRoot: string;
  folder: string;
  pullRequests?: ThreadPullRequestLink[];
  configLoaded?: boolean;
  entries?: ListThreadEntriesResult;
}) {
  state.configLoaded = input.configLoaded ?? true;
  state.entries = input.entries ?? null;
  state.renameEntry.mockClear();
  state.workspaceRoot = input.workspaceRoot;
  state.folder = input.folder;
  state.pullRequests = input.pullRequests ?? [];
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  const anchor = document.createElement("div");
  document.body.append(anchor);
  return {
    anchor: { current: anchor },
    handle: PopoverCreateHandle(),
    [Symbol.dispose]: () => anchor.remove(),
  };
}

function Panel({ fixture, height }: { fixture: ReturnType<typeof setup>; height?: number }) {
  const noop = () => {};
  const cardPlacement = height === undefined ? placement : { ...placement, height };
  const scriptResult = async () => ({ ok: true }) as never;
  return (
    <ChatCanvasContext
      value={{
        container,
        lane: { padding: 48, minChatWidth: 640 },
        layout: resolveChatCanvasLayout({ container, preview: null }),
        previewKey: null,
        registerTimeline: noop,
        measureDetailsCard: noop,
        detailsCardTopInset: 0,
        preferredDetailsCard: cardPlacement,
        detailsCardPlacement: cardPlacement,
      }}
    >
      <ThreadDetailsPanel
        anchor={fixture.anchor}
        handle={fixture.handle}
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        projectId={ProjectId.make("project")}
        composerDraftTarget={threadRef}
        worktreePath={state.folder}
        isServerThread
        activeProjectName={state.workspaceRoot === SCRATCH_ROOT ? "No project" : "plain"}
        activeProjectScripts={undefined}
        preferredScriptId={null}
        keybindings={[]}
        availableEditors={[]}
        showOpenInPicker={false}
        openInShortcutEnabled={false}
        gitCwd={state.folder}
        workspaceMutationId={null}
        isGitRepo={false}
        envLocked
        availableEnvironments={[]}
        onEnvModeChange={noop}
        envMode="local"
        startFromOrigin={false}
        onStartFromOriginChange={noop}
        onComposerFocusRequest={noop}
        onRunProjectScript={noop}
        onAddProjectScript={scriptResult}
        onUpdateProjectScript={scriptResult}
        onDeleteProjectScript={scriptResult}
        usage={{} as never}
      />
    </ChatCanvasContext>
  );
}

it("offers no git controls in a No project thread, but shows its linked pull request", async () => {
  using fixture = setup({
    workspaceRoot: SCRATCH_ROOT,
    folder: `${SCRATCH_ROOT}/thread`,
    pullRequests: [linkedPullRequest],
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByText("#27513")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Initialize Git" }))
    .not.toBeInTheDocument();
});

it("shows a linked pull request in a folder that is not a git repository", async () => {
  using fixture = setup({
    workspaceRoot: "/work/plain",
    folder: "/work/plain",
    pullRequests: [linkedPullRequest],
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByRole("region", { name: "Workspace" })).toBeVisible();
  await expect.element(page.getByText("#27513")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Initialize Git" })).toBeVisible();
});

it("offers no Initialize Git before the server config says where No project lives", async () => {
  using fixture = setup({
    workspaceRoot: SCRATCH_ROOT,
    folder: `${SCRATCH_ROOT}/thread`,
    configLoaded: false,
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByRole("region", { name: "Workspace" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Initialize Git" }))
    .not.toBeInTheDocument();
});

it("keeps the rename field focused once the topic menu closes, and saves on Enter", async () => {
  using fixture = setup({
    workspaceRoot: "/work/plain",
    folder: "/work/plain",
    entries: topics(2),
  });
  // Tall enough for full density, so this depends only on the menu's focus handling.
  await using _screen = await render(<Panel fixture={fixture} height={2000} />);
  await page.getByRole("link", { name: "Topic 1" }).hover();
  await page.getByRole("button", { name: "Edit topic: Topic 1" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

  const field = page.getByRole("textbox", { name: "Topic title" });
  await expect.element(field).toHaveFocus();
  await field.fill("Renamed topic");
  await userEvent.keyboard("{Enter}");
  await expect.element(field).not.toBeInTheDocument();
  expect(state.renameEntry).toHaveBeenCalledTimes(1);
  expect(state.renameEntry).toHaveBeenCalledWith("entry-1", "Renamed topic");
});

it("still shows Contents when the card is too short for full density", async () => {
  using fixture = setup({
    workspaceRoot: "/work/plain",
    folder: "/work/plain",
    entries: topics(3),
  });
  await using screen = await render(<Panel fixture={fixture} height={2000} />);
  const card = page.getByRole("region", { name: "Thread details" });
  await expect.element(card).toHaveAttribute("data-density", "full");
  await expect.element(page.getByRole("region", { name: "Contents" })).toBeVisible();

  // The card measures its content, inside the scroll area's padding; one pixel short of it is too short.
  const fullHeight = document.querySelector<HTMLElement>(".group\\/details-items")!.offsetHeight;
  await screen.rerender(<Panel fixture={fixture} height={fullHeight - 1} />);
  await expect.element(card).toHaveAttribute("data-density", "compact");
  await expect.element(page.getByRole("region", { name: "Contents" })).toBeVisible();
  await expect.element(page.getByRole("link", { name: "Topic 3" })).toBeVisible();
});
