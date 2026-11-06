import type { DesktopAppIcon as AppIconChoice } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const { logWarning } = makeComponentLogger("desktop-app-icon");

const appIconResourceFileName = (icon: AppIconChoice, dark: boolean) =>
  `app-icon-${icon}-${dark ? "dark" : "light"}.png`;

export class DesktopAppIcon extends Context.Service<
  DesktopAppIcon,
  {
    readonly get: Effect.Effect<AppIconChoice>;
    readonly set: (
      icon: AppIconChoice,
    ) => Effect.Effect<void, DesktopAppSettings.DesktopSettingsWriteError>;
    readonly register: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/app/DesktopAppIcon") {}

/** @public */
export const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  // The bundle's copper icon already follows the appearance; only override it once the user picks another.
  const overridden = yield* Ref.make(false);

  const apply = Effect.gen(function* () {
    if (environment.platform !== "darwin" || !environment.isPackaged) return;
    const icon = (yield* settings.get).appIcon;
    if (icon === "copper" && !(yield* Ref.get(overridden))) return;
    const fileName = appIconResourceFileName(icon, yield* electronTheme.shouldUseDarkColors);
    const resolved = yield* assets
      .resolveResourcePath(fileName)
      .pipe(Effect.orElseSucceed(() => Option.none<string>()));
    if (Option.isNone(resolved)) {
      return yield* logWarning("app icon resource is missing", { fileName });
    }
    yield* electronApp.setDockIcon(resolved.value);
    yield* Ref.set(overridden, true);
  }).pipe(Effect.withSpan("desktop.appIcon.apply"));

  return DesktopAppIcon.of({
    get: settings.get.pipe(Effect.map((current) => current.appIcon)),
    set: Effect.fn("desktop.appIcon.set")(function* (icon) {
      yield* settings.setAppIcon(icon);
      yield* apply;
    }),
    register: Effect.gen(function* () {
      const runFork = Effect.runForkWith(yield* Effect.context<never>());
      yield* electronTheme.onUpdated(() => {
        runFork(apply);
      });
      yield* apply;
    }).pipe(Effect.withSpan("desktop.appIcon.register")),
  });
});

export const layer = Layer.effect(DesktopAppIcon, make);
