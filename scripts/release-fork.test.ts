// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  forkReleaseMacArchive,
  forkReleaseVersion,
  nextForkReleaseIndex,
  parseKeepLocalReleases,
  pruneLocalForkReleases,
  repositoryFromRemoteUrl,
  stageForkRelease,
  publishForkRelease,
} from "./release-fork.ts";

function fixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-release-"));
  for (const name of [
    "latest.yml",
    "T3-Code-0.1.7001-arm64.zip",
    "T3-Code-0.1.7001-arm64.dmg",
    "T3-Code-0.1.7001-x64.zip",
    "T3-Code-0.1.7001-x64.dmg",
    "T3-Code-0.1.7001-x64.exe",
  ]) {
    NodeFS.writeFileSync(NodePath.join(directory, name), name);
  }
  NodeFS.writeFileSync(
    NodePath.join(directory, "latest-mac.yml"),
    "files:\n  - url: T3-Code-0.1.7001-arm64.zip\n  - url: T3-Code-0.1.7001-x64.zip\n",
  );
  const calls: Array<ReadonlyArray<string>> = [];
  const remote = {
    isDraft: true,
    tagName: "v0.1.7001",
    targetCommitish: "abcdef",
    assets: NodeFS.readdirSync(directory).map((name) => ({
      name,
      digest: `sha256:${NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(NodePath.join(directory, name)))
        .digest("hex")}`,
    })),
  };
  const execute = (args: ReadonlyArray<string>) => {
    calls.push(args);
    return args[1] === "view" ? JSON.stringify(remote) : "";
  };
  return {
    directory,
    calls,
    execute,
    remote,
    [Symbol.dispose]() {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
}

const candidate = {
  version: "0.1.7001",
  repository: "josh-hurst/t3code",
  commit: "abcdef",
  appId: "com.joshhurst.t3code",
  productName: "T3 Code",
};

describe("release-fork", () => {
  it("sorts fork releases after their base and before the next official version", () => {
    assert.equal(forkReleaseVersion("0.1.2", 1), "0.1.2001");
    assert.equal(forkReleaseVersion("0.1.2", 999), "0.1.2999");
    assert.equal(forkReleaseVersion("0.1.3", 1), "0.1.3001");
    // Installed fork apps from older bases must see the new base as an update.
    assert.equal(forkReleaseVersion("0.1.7", 1), "0.1.7001");
    assert.isUndefined(forkReleaseVersion("0.1.2", 1000));
    assert.isUndefined(forkReleaseVersion("0.1.2-nightly.20261024.1", 1));
  });

  it("continues numbering from the fork's existing releases for the same base", () => {
    assert.equal(nextForkReleaseIndex("0.1.2", []), 1);
    assert.equal(nextForkReleaseIndex("0.1.2", ["v0.1.2001", "v0.1.2002", "v0.0.9001"]), 3);
    assert.equal(nextForkReleaseIndex("0.1.3", ["v0.1.2001", "v0.1.2002"]), 1);
  });

  it("reads owner/repo from GitHub remote URLs", () => {
    assert.equal(
      repositoryFromRemoteUrl("https://github.com/josh-hurst/t3code.git"),
      "josh-hurst/t3code",
    );
    assert.equal(
      repositoryFromRemoteUrl("git@github.com:josh-hurst/t3code.git"),
      "josh-hurst/t3code",
    );
    assert.equal(
      repositoryFromRemoteUrl("https://github.com/josh-hurst/t3code"),
      "josh-hurst/t3code",
    );
    assert.isUndefined(repositoryFromRemoteUrl("https://git.cafe/josh-hurst/t3code.git"));
  });

  it("stages a draft and publishes the same assets without rebuilding", async () => {
    using release = fixture();
    const staged = await stageForkRelease(release.directory, candidate, release.execute);
    assert.include(release.calls[0]!, "--draft");
    assert.notInclude(release.calls[0]!, "--latest");
    assert.equal(forkReleaseMacArchive(staged), "T3-Code-0.1.7001-arm64.zip");

    await publishForkRelease(release.directory, release.execute);
    assert.deepEqual(
      release.calls.map((args) => args[1]),
      ["create", "view", "edit"],
    );
    assert.include(release.calls[2]!, "--draft=false");
    assert.include(release.calls[2]!, "--latest");
  });

  it("refuses to publish when an artifact changed after staging", async () => {
    using release = fixture();
    await stageForkRelease(release.directory, candidate, release.execute);
    NodeFS.writeFileSync(
      NodePath.join(release.directory, "T3-Code-0.1.7001-arm64.zip"),
      "different build",
    );
    await expect(publishForkRelease(release.directory, release.execute)).rejects.toThrow(/changed/);
    assert.equal(release.calls.length, 1);
  });

  it("refuses to change a published release or a draft for another commit", async () => {
    using release = fixture();
    await stageForkRelease(release.directory, candidate, release.execute);
    await expect(
      publishForkRelease(release.directory, () =>
        JSON.stringify({ ...release.remote, isDraft: false }),
      ),
    ).rejects.toThrow(/draft/);
    await expect(
      publishForkRelease(release.directory, () =>
        JSON.stringify({ ...release.remote, targetCommitish: "different" }),
      ),
    ).rejects.toThrow(/commit/);
  });

  it("does not publish when the draft's assets have been replaced", async () => {
    using release = fixture();
    await stageForkRelease(release.directory, candidate, release.execute);
    release.remote.assets[0]!.digest = "sha256:different";
    await expect(publishForkRelease(release.directory, release.execute)).rejects.toThrow(
      /artifacts/,
    );
    assert.deepEqual(
      release.calls.map((args) => args[1]),
      ["create", "view"],
    );
  });

  it("does not publish when an asset is missing from the draft", async () => {
    using release = fixture();
    await stageForkRelease(release.directory, candidate, release.execute);
    release.remote.assets.pop();
    await expect(publishForkRelease(release.directory, release.execute)).rejects.toThrow(
      /artifacts/,
    );
    assert.deepEqual(
      release.calls.map((args) => args[1]),
      ["create", "view"],
    );
  });

  it("publishes an Intel-only release without making it the update feed", async () => {
    using release = fixture();
    for (const name of [
      "latest.yml",
      "T3-Code-0.1.7001-x64.exe",
      "T3-Code-0.1.7001-arm64.zip",
      "T3-Code-0.1.7001-arm64.dmg",
    ]) {
      NodeFS.rmSync(NodePath.join(release.directory, name));
    }
    release.remote.assets = release.remote.assets.filter((asset) =>
      NodeFS.existsSync(NodePath.join(release.directory, asset.name)),
    );
    const staged = await stageForkRelease(
      release.directory,
      { ...candidate, macArch: "x64" },
      release.execute,
    );
    assert.equal(forkReleaseMacArchive(staged), "T3-Code-0.1.7001-x64.zip");

    await publishForkRelease(release.directory, release.execute);
    assert.include(release.calls[2]!, "--latest=false");
  });

  it("refuses to stage an incomplete build", async () => {
    using release = fixture();
    NodeFS.rmSync(NodePath.join(release.directory, "latest.yml"));
    await expect(stageForkRelease(release.directory, candidate, release.execute)).rejects.toThrow(
      /latest.yml/,
    );
    assert.equal(release.calls.length, 0);
  });

  it("refuses to stage a full release whose Mac update feed strands Intel Macs", async () => {
    using release = fixture();
    // The shape 0.1.9022 shipped: Intel installs found no file for their arch.
    NodeFS.writeFileSync(
      NodePath.join(release.directory, "latest-mac.yml"),
      "files:\n  - url: T3-Code-0.1.7001-arm64.zip\n",
    );
    await expect(stageForkRelease(release.directory, candidate, release.execute)).rejects.toThrow(
      /x64/,
    );
    assert.equal(release.calls.length, 0);
  });

  it("prunes superseded local release directories by semver while preserving kept versions", () => {
    const releaseRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-prune-"));
    try {
      for (const name of [
        "0.1.9029",
        "0.1.11001",
        "0.1.11009",
        "0.1.11010",
        "0.1.11011",
        "notes",
      ]) {
        NodeFS.mkdirSync(NodePath.join(releaseRoot, name));
        NodeFS.writeFileSync(NodePath.join(releaseRoot, name, "payload.bin"), name);
      }
      NodeFS.writeFileSync(NodePath.join(releaseRoot, "README.txt"), "keep");

      const removed = pruneLocalForkReleases(releaseRoot, {
        keepCount: 2,
        keepVersions: ["0.1.11001"],
      });
      assert.deepEqual(removed, ["0.1.11009", "0.1.9029"]);
      assert.deepEqual(NodeFS.readdirSync(releaseRoot).sort(), [
        "0.1.11001",
        "0.1.11010",
        "0.1.11011",
        "README.txt",
        "notes",
      ]);

      // Disabling pruning via undefined keeps everything intact.
      assert.deepEqual(pruneLocalForkReleases(releaseRoot, { keepCount: undefined }), []);
    } finally {
      NodeFS.rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it("parses T3CODE_FORK_KEEP_LOCAL_RELEASES values", () => {
    assert.equal(parseKeepLocalReleases(undefined, 2), 2);
    assert.equal(parseKeepLocalReleases("", 2), 2);
    assert.equal(parseKeepLocalReleases("3", 2), 3);
    assert.isUndefined(parseKeepLocalReleases("all", 2));
    assert.isUndefined(parseKeepLocalReleases("ALL", 2));
    assert.throws(() => parseKeepLocalReleases("0", 2), /T3CODE_FORK_KEEP_LOCAL_RELEASES/);
    assert.throws(() => parseKeepLocalReleases("nope", 2), /T3CODE_FORK_KEEP_LOCAL_RELEASES/);
  });
});
