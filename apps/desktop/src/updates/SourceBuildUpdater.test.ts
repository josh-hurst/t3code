// @effect-diagnostics nodeBuiltinImport:off -- fixture repos are set up with plain git calls.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as SourceBuildUpdater from "./SourceBuildUpdater.ts";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

const commitVersion = (repo: string, version: string) => {
  NodeFS.mkdirSync(NodePath.join(repo, "apps/server"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(repo, "apps/server/package.json"),
    JSON.stringify({ version }),
  );
  git(repo, "add", ".");
  git(repo, "commit", "-m", version);
  git(repo, "push", "--quiet", "origin", "HEAD:main");
  return git(repo, "rev-parse", "--short=12", "HEAD");
};

describe("SourceBuildUpdater", () => {
  it("reads the source checkout a build came from", () => {
    assert.deepStrictEqual(
      SourceBuildUpdater.parseSourceBuild(
        JSON.stringify({ t3codeSourceRepo: "/src/t3code", t3codeCommitHash: "ABCDEF123456" }),
      ),
      Option.some({ repo: "/src/t3code", commit: "abcdef123456" }),
    );
    assert.isTrue(
      Option.isNone(
        SourceBuildUpdater.parseSourceBuild(JSON.stringify({ t3codeCommitHash: "abcdef123456" })),
      ),
    );
    // The build script records "unknown" when git is unavailable.
    assert.isTrue(
      Option.isNone(
        SourceBuildUpdater.parseSourceBuild(
          JSON.stringify({ t3codeSourceRepo: "/src/t3code", t3codeCommitHash: "unknown" }),
        ),
      ),
    );
  });

  it("only moves build progress forward through known milestones", () => {
    assert.equal(
      SourceBuildUpdater.buildProgressForLine(
        "[desktop-artifact] Building desktop/server/web artifacts...",
      ),
      20,
    );
    assert.equal(
      SourceBuildUpdater.buildProgressForLine("  • building        target=zip arch=arm64"),
      90,
    );
    assert.isUndefined(SourceBuildUpdater.buildProgressForLine("vite v8 building for production"));
  });

  it("finds the app bundle from its executable", () => {
    assert.deepStrictEqual(
      SourceBuildUpdater.resolveAppBundlePath("/Applications/T3 Code.app/Contents/MacOS/T3 Code"),
      Option.some("/Applications/T3 Code.app"),
    );
    assert.isTrue(Option.isNone(SourceBuildUpdater.resolveAppBundlePath("/usr/local/bin/node")));
  });

  it.effect("reports an update only once upstream has commits the build lacks", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-source-updater-" });
      const upstream = NodePath.join(root, "upstream.git");
      const checkout = NodePath.join(root, "checkout");
      const maintainer = NodePath.join(root, "maintainer");
      git(root, "init", "--quiet", "--bare", "--initial-branch=main", upstream);
      git(root, "clone", "--quiet", upstream, checkout);
      git(checkout, "checkout", "--quiet", "-b", "main");
      const builtCommit = commitVersion(checkout, "1.0.0");
      git(checkout, "branch", "--quiet", "--set-upstream-to=origin/main");

      const updater = yield* SourceBuildUpdater.make(
        { repo: checkout, commit: builtCommit },
        "1.0.0",
      );
      const events: Array<{ readonly name: string; readonly info: unknown }> = [];
      for (const name of ["update-available", "update-not-available"]) {
        yield* updater.on(name, (info: unknown) => {
          events.push({ name, info });
        });
      }
      assert.deepStrictEqual(Option.getOrUndefined(updater.builtInFeed), {
        currentVersion: `1.0.0+${builtCommit}`,
      });

      yield* updater.checkForUpdates;
      assert.deepStrictEqual(
        events.map((event) => event.name),
        ["update-not-available"],
      );

      git(root, "clone", "--quiet", upstream, maintainer);
      const pushedCommit = commitVersion(maintainer, "1.1.0");
      yield* updater.checkForUpdates;
      assert.deepStrictEqual(events.at(-1), {
        name: "update-available",
        info: { version: `1.1.0+${pushedCommit}` },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("explains a check that cannot reach an upstream", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-source-updater-" });
      git(checkout, "init", "--quiet", "--initial-branch=main");
      git(checkout, "commit", "--quiet", "--allow-empty", "-m", "init");
      const updater = yield* SourceBuildUpdater.make(
        { repo: checkout, commit: git(checkout, "rev-parse", "--short=12", "HEAD") },
        "1.0.0",
      );

      const error = yield* Effect.flip(updater.checkForUpdates);
      assert.match(error.message, /^Could not check the source checkout for updates: git /);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
