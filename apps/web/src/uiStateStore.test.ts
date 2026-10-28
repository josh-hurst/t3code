import { ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  legacyProjectCwdPreferenceKey,
  markThreadUnread,
  markThreadVisited,
  parsePersistedState,
  PERSISTED_STATE_KEY,
  type PersistedUiState,
  persistState,
  setSidebarProjectHidden,
  createSidebarFolder,
  deleteSidebarFolder,
  renameSidebarFolder,
  setSidebarFolderOrder,
  setSidebarThreadFolder,
  reorderProjects,
  resolveProjectExpanded,
  setProjectExpanded,
  type UiState,
} from "./uiStateStore";

function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
    projectExpandedById: {},
    projectOrder: [],
    sidebarProjectScopeKeys: [],
    sidebarHiddenProjectKeys: [],
    sidebarFolders: [],
    sidebarThreadFolderById: {},
    threadLastVisitedAtById: {},
    threadChangedFilesExpandedById: {},
    defaultAdvertisedEndpointKey: null,
    pullRequestMergeMethod: "merge",
    ...overrides,
  };
}

describe("uiStateStore pure functions", () => {
  it("stores server timestamps without moving visit state backwards", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState();
    const visited = markThreadVisited(initialState, threadId, "2026-02-25T12:30:00.700Z");

    expect(visited.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:30:00.700Z");
    expect(markThreadVisited(visited, threadId, "2026-02-25T12:30:00.000Z")).toBe(visited);
    expect(markThreadVisited(visited, threadId, "not-a-date")).toBe(visited);
  });

  it("marks a completed thread unread using the server completion timestamp", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = markThreadUnread(initialState, threadId, "2026-02-25T12:30:00.000Z");

    expect(next.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:29:59.999Z");
    expect(markThreadUnread(next, threadId, null)).toBe(next);
  });

  it("resolves project expansion from logical, physical, and legacy preference keys", () => {
    const physicalKey = "environment:/repo/project";
    const legacyKey = legacyProjectCwdPreferenceKey("/repo/project");

    expect(resolveProjectExpanded({ logical: false, [physicalKey]: true }, ["logical"])).toBe(
      false,
    );
    expect(resolveProjectExpanded({ [physicalKey]: false }, ["new-logical", physicalKey])).toBe(
      false,
    );
    expect(resolveProjectExpanded({ [legacyKey]: false }, ["new-logical", legacyKey])).toBe(false);
    expect(resolveProjectExpanded({}, ["new-logical"])).toBe(true);
  });

  it("sets expansion for every stable key belonging to a logical project", () => {
    const initialState = makeUiState();
    const keys = ["logical", "environment-a:/repo", "environment-b:/repo"];

    const next = setProjectExpanded(initialState, keys, false);

    expect(next.projectExpandedById).toEqual({
      logical: false,
      "environment-a:/repo": false,
      "environment-b:/repo": false,
    });
    expect(setProjectExpanded(next, keys, false)).toBe(next);
  });

  it("moves grouped project members together", () => {
    const keyALocal = "env-local:proj-a";
    const keyARemote = "env-remote:proj-a";
    const keyB = "env-local:proj-b";
    const keyC = "env-local:proj-c";
    const currentOrder = [keyALocal, keyARemote, keyB, keyC];

    const next = reorderProjects(makeUiState(), currentOrder, [keyALocal, keyARemote], [keyC]);

    expect(next.projectOrder).toEqual([keyB, keyC, keyALocal, keyARemote]);
  });
});

describe("parsePersistedState", () => {
  it("hydrates raw UI-owned state without server entities", () => {
    const parsed = parsePersistedState({
      projectExpandedById: {
        logical: false,
        invalid: "no" as unknown as boolean,
      },
      projectOrder: ["physical-b", "", "physical-a", "physical-b"],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
        invalid: "not-a-date",
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      threadChangedFilesExpansionVersion: 2,
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
    });

    expect(parsed).toEqual({
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      sidebarProjectScopeKeys: [],
      sidebarHiddenProjectKeys: [],
      sidebarFolders: [],
      sidebarThreadFolderById: {},
      pullRequestMergeMethod: "merge",
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
    });
  });

  it.each([undefined, 1])("ignores changed-file expansion version %s", (version) => {
    const parsed = parsePersistedState({
      ...(version === undefined ? {} : { threadChangedFilesExpansionVersion: version }),
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
        },
      },
    });

    expect(parsed.threadChangedFilesExpandedById).toEqual({});
  });

  it("migrates legacy CWD project preferences into local alias keys", () => {
    const parsed = parsePersistedState({
      collapsedProjectCwds: ["/repo/b"],
      expandedProjectCwds: ["/repo/a"],
      projectOrderCwds: ["/repo/b", "/repo/a"],
    });
    const projectAKey = legacyProjectCwdPreferenceKey("/repo/a");
    const projectBKey = legacyProjectCwdPreferenceKey("/repo/b");

    expect(parsed.projectOrder).toEqual([projectBKey, projectAKey]);
    expect(resolveProjectExpanded(parsed.projectExpandedById, [projectAKey])).toBe(true);
    expect(resolveProjectExpanded(parsed.projectExpandedById, [projectBKey])).toBe(false);
    expect(resolveProjectExpanded(parsed.projectExpandedById, ["unknown"])).toBe(true);
  });
});

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => {
      store.clear();
    },
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

describe("uiStateStore persistence", () => {
  let localStorageStub: Storage;

  beforeEach(() => {
    localStorageStub = createLocalStorageStub();
    vi.stubGlobal("window", { localStorage: localStorageStub });
    vi.stubGlobal("localStorage", localStorageStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists raw UI preferences including thread visit markers", () => {
    const state = makeUiState({
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
    });

    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(persisted).toEqual({
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      sidebarProjectScopeKeys: [],
      sidebarProjectScopeKey: null,
      sidebarHiddenProjectKeys: [],
      sidebarFolders: [],
      sidebarThreadFolderById: {},
      threadChangedFilesExpansionVersion: 2,
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
      pullRequestMergeMethod: "merge",
    });
    expect(parsePersistedState(persisted)).toEqual({
      ...state,
    });
  });

  it("restores the sidebar project scope across reloads", () => {
    const keys = ["github.com/pingdotgg/t3code", "github.com/pingdotgg/uploadthing"];
    persistState(makeUiState({ sidebarProjectScopeKeys: keys }));

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;

    expect(parsePersistedState(persisted).sidebarProjectScopeKeys).toEqual(keys);
  });

  it("keeps a single-project scope readable by older clients", () => {
    persistState(makeUiState({ sidebarProjectScopeKeys: ["github.com/pingdotgg/t3code"] }));

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;

    expect(persisted.sidebarProjectScopeKey).toBe("github.com/pingdotgg/t3code");
  });

  it("restores a single-project scope saved before multi-project filtering", () => {
    expect(
      parsePersistedState({ sidebarProjectScopeKey: "github.com/pingdotgg/t3code" })
        .sidebarProjectScopeKeys,
    ).toEqual(["github.com/pingdotgg/t3code"]);
  });

  it("hides and unhides sidebar projects across reloads", () => {
    const hidden = setSidebarProjectHidden(makeUiState(), "github.com/a/b", true);
    expect(setSidebarProjectHidden(hidden, "github.com/a/b", true)).toBe(hidden);
    persistState(hidden);
    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(parsePersistedState(persisted).sidebarHiddenProjectKeys).toEqual(["github.com/a/b"]);
    expect(
      setSidebarProjectHidden(hidden, "github.com/a/b", false).sidebarHiddenProjectKeys,
    ).toEqual([]);
  });

  it("files threads into folders across reloads and drops them with their folder", () => {
    let state = createSidebarFolder(makeUiState(), { id: "f1", name: "Bugs" });
    state = createSidebarFolder(state, { id: "f2", name: "Ideas" });
    state = setSidebarThreadFolder(state, ["env:t1", "env:t2"], "f1");
    state = setSidebarThreadFolder(state, ["env:t3"], "f2");
    // Unknown folders are ignored.
    expect(setSidebarThreadFolder(state, ["env:t1"], "missing")).toBe(state);
    state = renameSidebarFolder(state, "f2", "Later");
    state = setSidebarFolderOrder(state, ["f2", "f1"]);
    persistState(state);
    const restored = parsePersistedState(
      JSON.parse(localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}") as PersistedUiState,
    );
    expect(restored.sidebarFolders).toEqual([
      { id: "f2", name: "Later" },
      { id: "f1", name: "Bugs" },
    ]);
    expect(restored.sidebarThreadFolderById).toEqual({
      "env:t1": "f1",
      "env:t2": "f1",
      "env:t3": "f2",
    });
    const deleted = deleteSidebarFolder(restored, "f1");
    expect(deleted.sidebarFolders).toEqual([{ id: "f2", name: "Later" }]);
    expect(deleted.sidebarThreadFolderById).toEqual({ "env:t3": "f2" });
    expect(setSidebarThreadFolder(deleted, ["env:t3"], null).sidebarThreadFolderById).toEqual({});
  });

  it("drops persisted assignments to folders that no longer exist", () => {
    expect(
      parsePersistedState({
        sidebarFolders: [{ id: "f1", name: "Bugs" }],
        sidebarThreadFolderById: { "env:t1": "f1", "env:t2": "gone" },
      }).sidebarThreadFolderById,
    ).toEqual({ "env:t1": "f1" });
  });
});
