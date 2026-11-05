// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import { replaceForkApplication } from "./install-fork-release.ts";

function fixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-install-"));
  const destination = NodePath.join(directory, "App.app");
  const staged = NodePath.join(directory, "staged", "App.app");
  const backup = `${destination}.previous`;
  for (const [path, version] of [
    [destination, "current"],
    [staged, "candidate"],
    [backup, "previous"],
  ]) {
    NodeFS.mkdirSync(path!, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(path!, "version"), version!);
  }
  return {
    directory,
    destination,
    staged,
    backup,
    version(path: string) {
      return NodeFS.readFileSync(NodePath.join(path, "version"), "utf8");
    },
    [Symbol.dispose]() {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("replaceForkApplication", () => {
  it("replaces the app and retains the installed build for rollback", () => {
    using app = fixture();
    const launched: Array<string> = [];
    replaceForkApplication(app.staged, app.destination, (path) => launched.push(path));
    assert.equal(app.version(app.destination), "candidate");
    assert.equal(app.version(app.backup), "current");
    assert.deepEqual(launched, [app.destination]);
  });

  it("restores the app and its previous backup if replacement fails", () => {
    using app = fixture();
    NodeFS.rmSync(app.staged, { recursive: true });
    const launched: Array<string> = [];
    assert.throws(() =>
      replaceForkApplication(app.staged, app.destination, (path) => launched.push(path)),
    );
    assert.equal(app.version(app.destination), "current");
    assert.equal(app.version(app.backup), "previous");
    assert.deepEqual(launched, [app.destination]);
  });

  it("restores and relaunches the original app if the candidate cannot launch", () => {
    using app = fixture();
    const launched: Array<string> = [];
    assert.throws(
      () =>
        replaceForkApplication(app.staged, app.destination, (path) => {
          launched.push(app.version(path));
          if (app.version(path) === "candidate") throw new Error("launch failed");
        }),
      /launch failed/,
    );
    assert.equal(app.version(app.destination), "current");
    assert.equal(app.version(app.backup), "previous");
    assert.deepEqual(launched, ["candidate", "current"]);
  });
});
