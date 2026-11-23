# Brand icons

The Icon Composer projects are the source of truth for full application icons:

- `dev/app-icon.icon`
- `nightly/app-icon.icon`
- `prod/app-icon.icon`
- `blue/app-icon.icon`, the blue icon users can pick on macOS and iOS

Each project draws the icon from `quill-light.png` and `quill-dark.png`, switched by appearance. The older vector layers (`text.svg`, `background.svg` and the variant decorations) are no longer referenced by the projects; they remain only as the source of the Android artwork described below.

macOS desktop builds ship the `.icon` project itself: electron-builder compiles it with Xcode 26's `actool` into `Assets.car`, so the Dock icon follows the system's light and dark appearance. The macOS PNG below is still used for the app's runtime `icon.png`.

Run `vp run icons:export` from the repository root to regenerate the tracked iOS, macOS, Linux, Windows, and web assets, plus the Dock icon choices in `app-icons/`. The development web exports are also copied to `apps/web/public` for the browser favicon, web app manifest icons, and splash screen. Run `vp run icons:check` to verify that the generated assets and public copies match their sources without changing files.

Exporting requires Icon Composer 2 or newer and Xcode 26 on macOS. The script selects the newest compatible exporter from Xcode or a standalone Icon Composer installation and pins design generation 26. Set `ICON_COMPOSER_TOOL` to the full path of `Icon Composer.app/Contents/Executables/ictool` to override automatic discovery.

## macOS exports

The `*-macos-1024.png` files use the classic pre-Tahoe safe area: an 824×824 body inset 100 pixels on every side, with only the native shadow outside it. Icon Composer's command-line exporter cannot produce that preset, so the script compiles each project with `actool` for an older macOS target and extracts the 1024px fallback render from the asset catalog (`scripts/lib/extract-asset-catalog-icon.swift`).

The Dock icon choices in `app-icons/` are set at runtime with `app.dock.setIcon`, which draws the image exactly as given, so they must already look like a system-drawn icon. The script compiles each project for macOS 26 into a throwaway app bundle and renders that app's icon with the system's own icon renderer for the light and dark appearance (`scripts/lib/render-bundle-icon.swift`, which uses the private IconServices framework). Icon Composer's own `macOS` export lights the corners instead of the top and bottom edges, so it does not match. A runtime image cannot follow the system's Clear or Tinted icon styles; the bundled copper icon does.

Do not edit the generated PNG or ICO files directly.

## Android launcher and splash artwork

Android masks the central 72dp of a 108dp adaptive canvas, and the Android 12+ splash screen masks
the central two thirds of a 288dp canvas, so the Icon Composer exports cannot be used directly:
their rounded-square silhouette gets framed again and the wordmark is cropped. The Android artwork
is instead rendered from the same Icon Composer SVG sources by `vp run icons:export:android`:

- `apps/mobile/assets/android-icon-foreground.png`: the shared transparent wordmark, sized to stay
  inside the safe zone
- `apps/mobile/assets/android-icon-background-dev.png` and `-nightly.png`: full-bleed variant
  artwork (blueprint grid and annotations; night sky and clouds). Production uses a solid color.
- `apps/mobile/assets/android-splash-icon-*.png`: the two layers composed into one 288dp image, so
  the splash mask reproduces the launcher icon's framing.

Rerun the export after changing a layer SVG. `android-icon-mark.png` remains a flat silhouette for
Android's monochrome themed icon.
