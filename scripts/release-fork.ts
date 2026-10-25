// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Publishes a signed, notarized Apple Silicon build of this checkout as a
// GitHub Release of a fork. Apps installed from those releases check the
// fork's releases for updates instead of the official repository's.
//
//   vp run release:fork
//
// HEAD must be committed and pushed to the fork. Settings come from the shell
// or the gitignored .env:
//
//   T3CODE_DESKTOP_APP_ID   bundle ID registered to your Apple team (required;
//                           the official one belongs to T3 Tools)
//   T3CODE_FORK_REPOSITORY  owner/repo to publish to (default: the `fork`
//                           remote, else `origin`)
//
// Signing uses a "Developer ID Application" certificate from the login
// keychain, or CSC_LINK + CSC_KEY_PASSWORD. Notarization needs either
// APPLE_API_KEY (path to the .p8) + APPLE_API_KEY_ID + APPLE_API_ISSUER, or
// APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { loadRepoEnv } from "./lib/public-config.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
const OFFICIAL_REPOSITORY = "pingdotgg/t3code";
const OFFICIAL_APP_ID = "com.t3tools.t3code";
// Each base version leaves room for this many fork releases before the next
// official version, so fork versions always sort after the one they build on.
const RELEASES_PER_BASE_VERSION = 1000;

const fail = (message: string): never => {
  console.error(`release:fork: ${message}`);
  process.exit(1);
};

const run = (command: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync(command, args, { cwd: root, encoding: "utf8" });

const output = (command: string, args: ReadonlyArray<string>) => {
  const result = run(command, args);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed:\n${result.stderr.trim()}`);
  return result.stdout.trim();
};

export function repositoryFromRemoteUrl(url: string): string | undefined {
  return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1];
}

// Fork version for release `index` (1-based) on top of official `baseVersion`:
// 0.1.2 -> 0.1.2001, 0.1.2002, ... A plain x.y.z keeps electron-updater on its
// stable path, which prerelease suffixes would leave.
export function forkReleaseVersion(baseVersion: string, index: number): string | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(baseVersion);
  if (!match || index < 1 || index >= RELEASES_PER_BASE_VERSION) return undefined;
  const patch = Number(match[3]) * RELEASES_PER_BASE_VERSION + index;
  return `${match[1]}.${match[2]}.${patch}`;
}

export function nextForkReleaseIndex(baseVersion: string, tags: ReadonlyArray<string>): number {
  let latest = 0;
  for (let index = 1; index < RELEASES_PER_BASE_VERSION; index += 1) {
    if (tags.includes(`v${forkReleaseVersion(baseVersion, index)}`)) latest = index;
  }
  return latest + 1;
}

function main() {
  const env = loadRepoEnv();

  const repository =
    env.T3CODE_FORK_REPOSITORY?.trim() ||
    ["fork", "origin"]
      .map((remote) => run("git", ["remote", "get-url", remote]))
      .filter((result) => result.status === 0)
      .map((result) => repositoryFromRemoteUrl(result.stdout))
      .find((value) => value !== undefined);
  if (!repository) fail("Set T3CODE_FORK_REPOSITORY to the fork's owner/repo.");
  if (repository!.toLowerCase() === OFFICIAL_REPOSITORY) {
    fail(`Refusing to publish to ${OFFICIAL_REPOSITORY}. Set T3CODE_FORK_REPOSITORY.`);
  }

  const appId = env.T3CODE_DESKTOP_APP_ID?.trim();
  if (!appId || appId === OFFICIAL_APP_ID) {
    fail(
      "Set T3CODE_DESKTOP_APP_ID to a bundle ID registered to your Apple team, e.g. com.yourname.t3code.",
    );
  }

  const notarizes =
    (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) ||
    (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID);
  if (!notarizes) {
    fail(
      "Notarization credentials are missing. Set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER, or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID.",
    );
  }
  if (
    !env.CSC_LINK &&
    !output("security", ["find-identity", "-v", "-p", "codesigning"]).includes(
      "Developer ID Application",
    )
  ) {
    fail('No "Developer ID Application" certificate in the keychain, and CSC_LINK is not set.');
  }

  if (output("git", ["status", "--porcelain"]) !== "") {
    fail("Commit or stash your changes first; a release is built from HEAD.");
  }
  const commit = output("git", ["rev-parse", "HEAD"]);
  if (run("gh", ["api", `repos/${repository}/commits/${commit}`, "--silent"]).status !== 0) {
    fail(`Push ${commit.slice(0, 12)} to ${repository} first.`);
  }

  const baseVersion = (
    JSON.parse(NodeFS.readFileSync(NodePath.join(root, "apps/server/package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  const tags = output("gh", [
    "release",
    "list",
    "--repo",
    repository!,
    "--limit",
    "1000",
    "--json",
    "tagName",
    "--jq",
    ".[].tagName",
  ]).split("\n");
  const version =
    forkReleaseVersion(baseVersion, nextForkReleaseIndex(baseVersion, tags)) ??
    fail(`Cannot derive a fork version from ${baseVersion}.`);

  const outputDir = NodePath.join(root, "release-fork", version);
  console.log(`release:fork: building ${version} for ${repository}`);
  const build = NodeChildProcess.spawnSync(
    "node",
    [
      "scripts/build-desktop-artifact.ts",
      "--platform",
      "mac",
      "--target",
      "dmg",
      "--arch",
      "arm64",
      "--build-version",
      version,
      "--output-dir",
      outputDir,
      "--signed",
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...env,
        T3CODE_DESKTOP_APP_ID: appId,
        T3CODE_DESKTOP_UPDATE_REPOSITORY: repository,
      },
    },
  );
  if (build.status !== 0) fail("The desktop build failed.");

  // The updater reads latest-mac.yml and installs the zip; the DMG is for
  // first installs.
  const assets = NodeFS.readdirSync(outputDir)
    .filter((name) => /\.(dmg|zip|blockmap)$/.test(name) || name === "latest-mac.yml")
    .map((name) => NodePath.join(outputDir, name));
  for (const required of ["latest-mac.yml", ".zip", ".dmg"]) {
    if (!assets.some((asset) => asset.endsWith(required))) {
      fail(`The build did not produce a ${required} file in ${outputDir}.`);
    }
  }

  const release = NodeChildProcess.spawnSync(
    "gh",
    [
      "release",
      "create",
      `v${version}`,
      "--repo",
      repository!,
      "--target",
      commit,
      "--title",
      `T3 Code ${version}`,
      "--notes",
      `Built from ${commit.slice(0, 12)}. Download the DMG for a first install; installed apps update themselves.`,
      "--latest",
      ...assets,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (release.status !== 0) fail("Creating the GitHub release failed.");
}

if (import.meta.main) main();
