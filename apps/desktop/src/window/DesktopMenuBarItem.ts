import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const MENU_BAR_ICON_RESOURCE = "menuBarTemplate.png";

export class DesktopMenuBarItem extends Context.Service<
  DesktopMenuBarItem,
  {
    readonly register: Effect.Effect<void, never, Scope.Scope>;
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopMenuBarItem") {}

const { logWarning } = makeComponentLogger("desktop-menu-bar");

const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  let tray: Electron.Tray | null = null;

  const destroyTray = Effect.gen(function* () {
    const current = tray;
    tray = null;
    if (current !== null && !current.isDestroyed()) {
      current.destroy();
    }
    yield* desktopWindow.closeMenuBarPopover;
  });

  const createTray = Effect.gen(function* () {
    if (tray !== null && !tray.isDestroyed()) return;
    const iconPath = yield* assets
      .resolveResourcePath(MENU_BAR_ICON_RESOURCE)
      .pipe(Effect.orElseSucceed(() => Option.none<string>()));
    if (Option.isNone(iconPath)) {
      yield* logWarning("menu bar template icon is missing", {
        fileName: MENU_BAR_ICON_RESOURCE,
      });
      return;
    }
    const image = Electron.nativeImage.createFromPath(iconPath.value);
    image.setTemplateImage(true);
    const created = new Electron.Tray(image);
    created.setToolTip(environment.displayName);
    created.on("click", (_event, eventBounds) => {
      if (created.isDestroyed()) return;
      const bounds = created.getBounds();
      const trayBounds = bounds.width > 0 || bounds.height > 0 ? bounds : eventBounds;
      runFork(
        desktopWindow
          .handleMenuBarItemClick({
            x: trayBounds.x,
            y: trayBounds.y,
            width: trayBounds.width,
            height: trayBounds.height,
          })
          .pipe(
            Effect.catchCause((cause) => logWarning("menu bar click handler failed", { cause })),
          ),
      );
    });
    tray = created;
  });

  const sync = Effect.fn("desktop.menuBarItem.sync")(function* (enabled: boolean) {
    if (environment.platform !== "darwin") return;
    if (enabled) {
      yield* createTray;
    } else {
      yield* destroyTray;
    }
  });

  return DesktopMenuBarItem.of({
    register: Effect.gen(function* () {
      if (environment.platform !== "darwin") return;
      yield* Effect.addFinalizer(() => destroyTray);
      const saved = yield* clientSettings.get.pipe(
        Effect.orElseSucceed(() => Option.none<ClientSettings>()),
      );
      const enabled = Option.match(saved, {
        onNone: () => DEFAULT_CLIENT_SETTINGS.menuBarItemEnabled,
        onSome: (settings) => settings.menuBarItemEnabled,
      });
      yield* sync(enabled);
    }).pipe(Effect.withSpan("desktop.menuBarItem.register")),
    configure: Effect.fn("desktop.menuBarItem.configure")(function* (settings) {
      yield* sync(settings.menuBarItemEnabled);
    }),
  });
});

export const layer = Layer.effect(DesktopMenuBarItem, make);
