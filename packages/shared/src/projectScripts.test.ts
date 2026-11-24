import { DEFAULT_SERVER_SETTINGS, ProjectId, type ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isKeepRunningProjectScript,
  resolveKeepRunningProjectScripts,
  runnableProjectScripts,
  settleProjectScript,
  setupProjectScript,
} from "./projectScripts.ts";
import { parseT3ProjectFile } from "./t3ProjectFile.ts";

const projectId = ProjectId.make("project-1");

const keptScript = (overrides: Partial<ProjectScript> = {}): ProjectScript => ({
  id: "sync",
  name: "Sync",
  command: "pnpm sync",
  icon: "play",
  runOnWorktreeCreate: false,
  keepRunning: true,
  ...overrides,
});

const normalScript = (overrides: Partial<ProjectScript> = {}): ProjectScript => ({
  id: "test",
  name: "Test",
  command: "pnpm test",
  icon: "test",
  runOnWorktreeCreate: false,
  ...overrides,
});

describe("resolveKeepRunningProjectScripts", () => {
  it("returns kept scripts from projectSettingsOverrides", () => {
    const sync = keptScript();
    const result = resolveKeepRunningProjectScripts(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsFolded: true,
        projectSettingsOverrides: {
          [projectId]: { defaultProjectScripts: [normalScript(), sync] },
        },
      },
      { id: projectId, scripts: [] },
    );
    expect(result).toEqual([sync]);
  });

  it("returns kept scripts from legacy projectScriptOverrides when unfolded", () => {
    const sync = keptScript();
    const result = resolveKeepRunningProjectScripts(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsFolded: false,
        projectScriptOverrides: { [projectId]: [sync, normalScript()] },
      },
      { id: projectId, scripts: [] },
    );
    expect(result).toEqual([sync]);
  });

  it("returns kept scripts from project.scripts when unfolded and no override exists", () => {
    const sync = keptScript();
    const result = resolveKeepRunningProjectScripts(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsFolded: false,
      },
      { id: projectId, scripts: [sync, normalScript()] },
    );
    expect(result).toEqual([sync]);
  });

  it("returns none when the resolved list is global defaultProjectScripts", () => {
    const globalKept = keptScript();
    expect(
      resolveKeepRunningProjectScripts(
        {
          ...DEFAULT_SERVER_SETTINGS,
          projectSettingsFolded: true,
          defaultProjectScripts: [globalKept],
        },
        { id: projectId, scripts: [keptScript({ id: "ignored-folded" })] },
      ),
    ).toEqual([]);

    expect(
      resolveKeepRunningProjectScripts(
        {
          ...DEFAULT_SERVER_SETTINGS,
          projectSettingsFolded: false,
          defaultProjectScripts: [globalKept],
          projectScriptOverrides: { [projectId]: null },
        },
        { id: projectId, scripts: [keptScript({ id: "reset-to-global" })] },
      ),
    ).toEqual([]);

    expect(
      resolveKeepRunningProjectScripts(
        {
          ...DEFAULT_SERVER_SETTINGS,
          projectSettingsFolded: false,
          defaultProjectScripts: [globalKept],
        },
        { id: projectId, scripts: [] },
      ),
    ).toEqual([]);
  });

  it("returns none for archived or deleted projects", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsFolded: true,
      projectSettingsOverrides: {
        [projectId]: { defaultProjectScripts: [keptScript()] },
      },
    };
    expect(
      resolveKeepRunningProjectScripts(settings, {
        id: projectId,
        scripts: [],
        archivedAt: "2026-10-01T00:00:00.000Z",
      }),
    ).toEqual([]);
    expect(
      resolveKeepRunningProjectScripts(settings, {
        id: projectId,
        scripts: [],
        deletedAt: "2026-10-01T00:00:00.000Z",
      }),
    ).toEqual([]);
  });
});

describe("kept action filtering", () => {
  it("skips kept actions in setupProjectScript, settleProjectScript, and runnableProjectScripts", () => {
    const keptWithFlags = keptScript({
      runOnWorktreeCreate: true,
      runOnSettle: true,
      stopOnSettle: true,
      previewUrl: "http://localhost:3000",
      autoOpenPreview: true,
    });
    const setup = normalScript({ id: "setup", runOnWorktreeCreate: true });
    const settle = normalScript({ id: "settle", runOnSettle: true });

    expect(isKeepRunningProjectScript(keptWithFlags)).toBe(true);
    expect(setupProjectScript([keptWithFlags, setup])).toEqual(setup);
    expect(setupProjectScript([keptWithFlags])).toBeNull();
    expect(settleProjectScript([keptWithFlags, settle])).toEqual(settle);
    expect(settleProjectScript([keptWithFlags])).toBeNull();
    expect(runnableProjectScripts([keptWithFlags, setup, settle])).toEqual([setup, settle]);
  });

  it("strips keepRunning from parsed t3.json scripts", () => {
    const parsed = parseT3ProjectFile(
      JSON.stringify({
        scripts: [
          {
            name: "Watcher",
            command: "pnpm watch",
            keepRunning: true,
          },
        ],
      }),
    );
    expect(parsed?.scripts).toHaveLength(1);
    expect("keepRunning" in (parsed?.scripts?.[0] ?? {})).toBe(false);
  });
});
