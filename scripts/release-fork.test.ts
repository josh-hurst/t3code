import { assert, describe, it } from "@effect/vitest";

import {
  forkReleaseVersion,
  nextForkReleaseIndex,
  repositoryFromRemoteUrl,
} from "./release-fork.ts";

describe("release-fork", () => {
  it("sorts fork releases after their base and before the next official version", () => {
    assert.equal(forkReleaseVersion("0.1.2", 1), "0.1.2001");
    assert.equal(forkReleaseVersion("0.1.2", 999), "0.1.2999");
    assert.equal(forkReleaseVersion("0.1.3", 1), "0.1.3001");
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
});
