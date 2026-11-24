import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  accentPolicyForMode,
  applyWindowsLegacyGlassWithApi,
  installWindowsLegacyGlass,
  windowsLegacyGlassMode,
  WM_ENTERSIZEMOVE,
  WM_EXITSIZEMOVE,
  type LegacyGlassWindowLike,
  type WindowsLegacyGlassApi,
} from "./windowGlass.ts";

function nativeHandle(value: bigint, bytes: 4 | 8 = 8): Buffer {
  const handle = Buffer.alloc(bytes);
  if (bytes === 8) handle.writeBigUInt64LE(value);
  else handle.writeUInt32LE(Number(value));
  return handle;
}

function makeApi() {
  return {
    extendFrameIntoClientArea: vi.fn<WindowsLegacyGlassApi["extendFrameIntoClientArea"]>(),
    setAccentPolicy: vi.fn<WindowsLegacyGlassApi["setAccentPolicy"]>(() => true),
  } satisfies WindowsLegacyGlassApi;
}

function makeFakeWindow(handle: Buffer) {
  const listeners = new Map<string, Array<() => void>>();
  const messageHooks = new Map<number, () => void>();
  let destroyed = false;

  const window: LegacyGlassWindowLike = {
    isDestroyed: () => destroyed,
    getNativeWindowHandle: () => handle,
    on: (event, listener) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    hookWindowMessage: (message, callback) => {
      messageHooks.set(message, callback);
    },
  };

  return {
    window,
    emit: (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    sendMessage: (message: number) => {
      messageHooks.get(message)?.();
    },
    destroy: () => {
      destroyed = true;
    },
    listeners,
    messageHooks,
  };
}

describe("window glass on Windows", () => {
  it.each([
    { platform: "darwin" as const, release: "24.0.0", expected: null },
    { platform: "linux" as const, release: "6.11.0", expected: null },
    { platform: "win32" as const, release: "10.0.10240", expected: "blur-behind" },
    { platform: "win32" as const, release: "10.0.17134", expected: "acrylic" },
    { platform: "win32" as const, release: "10.0.19045", expected: "acrylic" },
    { platform: "win32" as const, release: "10.0.22000", expected: "acrylic" },
    { platform: "win32" as const, release: "10.0.22621", expected: null },
    { platform: "win32" as const, release: "10.0.26100", expected: null },
  ])(
    "selects legacy fallback $expected for $platform $release",
    ({ platform, release, expected }) => {
      assert.strictEqual(windowsLegacyGlassMode(platform, release), expected);
    },
  );

  it.each([4, 8] as const)(
    "extends frame and applies acrylic policy for %i-byte handles",
    (bytes) => {
      const api = makeApi();
      const applied = applyWindowsLegacyGlassWithApi(nativeHandle(99n, bytes), "acrylic", api);

      assert.isTrue(applied);
      assert.deepEqual(api.extendFrameIntoClientArea.mock.calls, [[99n]]);
      assert.deepEqual(api.setAccentPolicy.mock.calls, [
        [99n, bytes, accentPolicyForMode("acrylic")],
      ]);
    },
  );

  it("rejects malformed native handles", () => {
    const api = makeApi();
    assert.throws(() => applyWindowsLegacyGlassWithApi(Buffer.alloc(6), "acrylic", api));
    assert.lengthOf(api.extendFrameIntoClientArea.mock.calls, 0);
  });

  it("reapplies on frame-resetting events and steps down to blur-behind during move/resize", async () => {
    const api = makeApi();
    const fake = makeFakeWindow(nativeHandle(77n, 8));

    const installed = installWindowsLegacyGlass(fake.window, "win32", {
      osRelease: "10.0.19045",
      loadApi: async () => api,
    });
    assert.isTrue(installed);
    await Promise.resolve();

    assert.deepEqual(
      api.setAccentPolicy.mock.calls.map((call) => call[2]),
      [accentPolicyForMode("acrylic")],
    );

    fake.emit("show");
    fake.emit("maximize");
    fake.sendMessage(WM_ENTERSIZEMOVE);
    fake.sendMessage(WM_EXITSIZEMOVE);

    assert.deepEqual(
      api.setAccentPolicy.mock.calls.map((call) => call[2]),
      [
        accentPolicyForMode("acrylic"),
        accentPolicyForMode("acrylic"),
        accentPolicyForMode("acrylic"),
        accentPolicyForMode("blur-behind"),
        accentPolicyForMode("acrylic"),
      ],
    );
    assert.lengthOf(api.extendFrameIntoClientArea.mock.calls, 5);

    fake.destroy();
    fake.emit("restore");
    assert.lengthOf(api.extendFrameIntoClientArea.mock.calls, 5);
  });

  it("does not install hooks on Windows 11 22H2+ or non-Windows platforms", () => {
    const loadApi = vi.fn(async () => makeApi());
    const win11 = makeFakeWindow(nativeHandle(10n, 8));
    const mac = makeFakeWindow(nativeHandle(11n, 8));

    assert.isFalse(
      installWindowsLegacyGlass(win11.window, "win32", { osRelease: "10.0.22621", loadApi }),
    );
    assert.isFalse(
      installWindowsLegacyGlass(mac.window, "darwin", { osRelease: "24.0.0", loadApi }),
    );
    assert.lengthOf(loadApi.mock.calls, 0);
    assert.strictEqual(win11.listeners.size, 0);
    assert.strictEqual(win11.messageHooks.size, 0);
  });
});
