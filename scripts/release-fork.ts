// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Stages signed macOS and unsigned Windows fork builds for testing before publication.
//   vp run release:fork [--install]
//   vp run release:fork install <version> [--app /Applications/Example.app]
//   vp run release:fork publish <version>
//   vp run release:fork rollback [--app /Applications/Example.app]
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
//
// The Windows build is cross-compiled. It needs the Rust target
// x86_64-pc-windows-msvc, cargo-xwin, Homebrew's llvm and lld (for clang-cl and
// lld-link), and Rosetta, because electron-builder's makensis is x86_64 only.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";

import { loadRepoEnv } from "./lib/public-config.ts";
import { prepareForkApplicationInstall } from "./install-fork-release.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
const OFFICIAL_REPOSITORY = "pingdotgg/t3code";
const OFFICIAL_APP_ID = "com.t3tools.t3code";
// Each base version leaves room for this many fork releases before the next
// official version, so fork versions always sort after the one they build on.
const RELEASES_PER_BASE_VERSION = 1000;

const ForkRelease = Schema.Struct({
  version: Schema.String,
  repository: Schema.String,
  commit: Schema.String,
  appId: Schema.String,
  productName: Schema.String,
  assets: Schema.Record(Schema.String, Schema.String),
});
const decodeForkRelease = Schema.decodeUnknownSync(Schema.fromJsonString(ForkRelease));
const decodeDraft = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      isDraft: Schema.Boolean,
      tagName: Schema.String,
      targetCommitish: Schema.String,
      assets: Schema.Array(
        Schema.Struct({ name: Schema.String, digest: Schema.NullOr(Schema.String) }),
      ),
    }),
  ),
);

async function digest(file: string) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function stageForkRelease(
  directory: string,
  candidate: Omit<typeof ForkRelease.Type, "assets">,
  execute: (args: ReadonlyArray<string>) => string,
) {
  const assets: Record<string, string> = {};
  for (const name of NodeFS.readdirSync(directory)) {
    if (/\.(dmg|zip|exe|blockmap)$/.test(name) || /^latest(-mac)?\.yml$/.test(name)) {
      assets[name] = await digest(NodePath.join(directory, name));
    }
  }
  for (const required of ["latest-mac.yml", "latest.yml", ".zip", ".dmg", ".exe"]) {
    if (!Object.keys(assets).some((name) => name.endsWith(required))) {
      throw new Error(`The build did not produce a ${required} file in ${directory}.`);
    }
  }
  const release = { ...candidate, assets };
  NodeFS.writeFileSync(
    NodePath.join(directory, "candidate.json"),
    JSON.stringify(release, null, 2),
  );
  execute([
    "release",
    "create",
    `v${release.version}`,
    "--repo",
    release.repository,
    "--target",
    release.commit,
    "--title",
    `J6 Code ${release.version}`,
    "--notes",
    `Built from ${release.commit.slice(0, 12)}. Windows: run J6-Code-${release.version}-x64.exe; it is not code-signed, so if Windows shows "Windows protected your PC", click More info, then Run anyway. macOS (Apple Silicon): open the DMG and drag J6 Code to Applications. Installed apps update themselves.`,
    "--draft",
    ...Object.keys(assets).map((name) => NodePath.join(directory, name)),
  ]);
}

export async function readForkRelease(directory: string) {
  const release = decodeForkRelease(
    NodeFS.readFileSync(NodePath.join(directory, "candidate.json"), "utf8"),
  );
  if (release.repository.toLowerCase() === OFFICIAL_REPOSITORY) {
    throw new Error(`Refusing to publish to ${OFFICIAL_REPOSITORY}.`);
  }
  for (const [name, expected] of Object.entries(release.assets)) {
    if (
      NodePath.basename(name) !== name ||
      (await digest(NodePath.join(directory, name))) !== expected
    ) {
      throw new Error(`Release artifact ${name} changed after staging; build a new candidate.`);
    }
  }
  return release;
}

export async function publishForkRelease(
  directory: string,
  execute: (args: ReadonlyArray<string>) => string,
) {
  const release = await readForkRelease(directory);
  const draft = decodeDraft(
    execute([
      "release",
      "view",
      `v${release.version}`,
      "--repo",
      release.repository,
      "--json",
      "isDraft,tagName,targetCommitish,assets",
    ]),
  );
  if (!draft.isDraft) throw new Error("This release is no longer a draft.");
  if (draft.tagName !== `v${release.version}` || draft.targetCommitish !== release.commit) {
    throw new Error("The draft no longer targets this candidate's commit.");
  }
  if (
    draft.assets.length !== Object.keys(release.assets).length ||
    draft.assets.some((asset) => asset.digest !== `sha256:${release.assets[asset.name]}`)
  ) {
    throw new Error("The draft's artifacts do not match the saved candidate; refusing to publish.");
  }
  execute([
    "release",
    "edit",
    `v${release.version}`,
    "--repo",
    release.repository,
    "--draft=false",
    "--latest",
  ]);
}

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

async function main() {
  const { positionals, values } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: { install: { type: "boolean" }, app: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    console.log(
      "Usage: vp run release:fork [--install]\n       vp run release:fork install <version> [--app <path>]\n       vp run release:fork publish <version>\n       vp run release:fork rollback [--app <path>]",
    );
    return;
  }
  const [action = "build", versionArg] = positionals;
  if (
    !["build", "install", "publish", "rollback"].includes(action) ||
    positionals.length > 2 ||
    (action === "install" || action === "publish"
      ? !versionArg || !/^\d+\.\d+\.\d+$/.test(versionArg)
      : versionArg !== undefined) ||
    (values.install && action !== "build") ||
    (values.app && (action === "publish" || (action === "build" && !values.install)))
  ) {
    fail("Use --help for the build, install, publish, and rollback commands.");
  }
  const gh = (args: ReadonlyArray<string>) => output("gh", args);
  const desktopPackage = JSON.parse(
    NodeFS.readFileSync(NodePath.join(root, "apps/desktop/package.json"), "utf8"),
  ) as { productName: string };
  if (action === "publish") {
    await publishForkRelease(NodePath.join(root, "release-fork", versionArg!), gh);
    console.log(`release:fork: published ${versionArg}`);
    return;
  }
  const env = loadRepoEnv();
  if (action === "install" || action === "rollback") {
    const release =
      action === "install"
        ? await readForkRelease(NodePath.join(root, "release-fork", versionArg!))
        : undefined;
    const appId =
      (release?.appId ?? env.T3CODE_DESKTOP_APP_ID?.trim()) ||
      fail("Set T3CODE_DESKTOP_APP_ID to your fork's bundle ID.");
    if (appId === OFFICIAL_APP_ID) fail("Set T3CODE_DESKTOP_APP_ID to your fork's bundle ID.");
    prepareForkApplicationInstall({
      appId,
      destination: NodePath.resolve(
        values.app ??
          NodePath.join(
            "/Applications",
            `${release?.productName ?? desktopPackage.productName}.app`,
          ),
      ),
      ...(release
        ? {
            archive: NodePath.join(
              root,
              "release-fork",
              versionArg!,
              `J6-Code-${release.version}-arm64.zip`,
            ),
            version: release.version,
          }
        : {}),
    });
    return;
  }

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

  const appId =
    env.T3CODE_DESKTOP_APP_ID?.trim() ||
    fail("Set T3CODE_DESKTOP_APP_ID to your fork's bundle ID.");
  if (appId === OFFICIAL_APP_ID) {
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

  const crossToolPath = [
    "/opt/homebrew/opt/llvm/bin",
    "/opt/homebrew/opt/lld/bin",
    env.PATH ?? process.env.PATH ?? "",
  ].join(":");
  const windowsToolchain = [
    ["cargo", ["xwin", "--version"]],
    ["lld-link", ["--version"]],
    ["clang-cl", ["--version"]],
    ["arch", ["-x86_64", "/usr/bin/true"]],
  ] as const;
  for (const [command, args] of windowsToolchain) {
    const probe = NodeChildProcess.spawnSync(command, args, {
      env: { ...env, PATH: crossToolPath },
      stdio: "ignore",
    });
    if (probe.status !== 0) {
      fail(
        `${command} is missing for the Windows build. Install: rustup target add x86_64-pc-windows-msvc, cargo install --locked cargo-xwin, brew install llvm lld, softwareupdate --install-rosetta.`,
      );
    }
  }

  // `vp run dev` rebuilds apps/desktop/dist-electron while the release copies
  // it, which shipped apps without main.cjs (0.1.2002).
  const desktopDir = NodePath.join(root, "apps/desktop");
  const desktopWatchers = run("lsof", ["-a", "-d", "cwd", "-c", "node", "-Fn"])
    .stdout.split("\n")
    .filter((line) => line === `n${desktopDir}`);
  if (desktopWatchers.length > 0) {
    fail("Stop the desktop dev server (vp run dev) in this checkout first; it rewrites the build.");
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
  const releaseRoot = NodePath.join(root, "release-fork");
  if (NodeFS.existsSync(releaseRoot)) {
    tags.push(...NodeFS.readdirSync(releaseRoot).map((name) => `v${name}`));
  }
  const version =
    forkReleaseVersion(baseVersion, nextForkReleaseIndex(baseVersion, tags)) ??
    fail(`Cannot derive a fork version from ${baseVersion}.`);

  const outputDir = NodePath.join(root, "release-fork", version);
  NodeFS.mkdirSync(releaseRoot, { recursive: true });
  NodeFS.mkdirSync(outputDir);
  console.log(`release:fork: building ${version} for ${repository}`);
  const buildEnv = {
    ...env,
    T3CODE_DESKTOP_APP_ID: appId,
    T3CODE_DESKTOP_UPDATE_REPOSITORY: repository,
  };
  const buildDesktop = (args: ReadonlyArray<string>, extraEnv: Record<string, string> = {}) => {
    const build = NodeChildProcess.spawnSync(
      "node",
      [
        "scripts/build-desktop-artifact.ts",
        ...args,
        "--build-version",
        version,
        "--output-dir",
        outputDir,
      ],
      { cwd: root, stdio: "inherit", env: { ...buildEnv, ...extraEnv } },
    );
    if (build.status !== 0) fail(`The desktop build (${args.join(" ")}) failed.`);
  };

  buildDesktop(["--platform", "mac", "--target", "dmg", "--arch", "arm64", "--signed"]);

  // The build script's own cargo call cannot link MSVC binaries off Windows,
  // so the resource monitor is built with cargo-xwin first, as CI does.
  const monitor = NodeChildProcess.spawnSync(
    "cargo",
    [
      "xwin",
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      "native/resource-monitor/Cargo.toml",
      "--target",
      "x86_64-pc-windows-msvc",
    ],
    { cwd: root, stdio: "inherit", env: { ...env, PATH: crossToolPath } },
  );
  if (monitor.status !== 0) fail("Building the Windows resource monitor failed.");
  buildDesktop(["--platform", "win", "--target", "nsis", "--arch", "x64"], {
    T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "1",
  });

  await stageForkRelease(
    outputDir,
    { version, repository: repository!, commit, appId, productName: desktopPackage.productName },
    gh,
  );
  console.log(
    `release:fork: staged ${version}; users will keep receiving the previous release.\nTest locally: vp run release:fork install ${version}\nPublish after testing: vp run release:fork publish ${version}`,
  );
  if (values.install) {
    prepareForkApplicationInstall({
      appId,
      destination: NodePath.resolve(
        values.app ?? NodePath.join("/Applications", `${desktopPackage.productName}.app`),
      ),
      archive: NodePath.join(outputDir, `J6-Code-${version}-arm64.zip`),
      version,
    });
  }
}

if (import.meta.main)
  main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
