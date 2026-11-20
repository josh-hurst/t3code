"use strict";

// Precede expo-widgets so its reverse-ordered mods create and wipe the target before assets are added.

const path = require("path");
const fs = require("fs");
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");
const { addWidgetAssetCatalog } = require("./lib/addWidgetAssetCatalog.cjs");

const TARGET_NAME = "ExpoWidgetsTarget";
const CATALOG_NAME = "Assets.xcassets";
const WIDGET_IMAGES = {
  T3Mark: "widget/T3Mark.svg",
  CodexMark: "context-chip-icons/provider-codex.png",
  ClaudeMark: "context-chip-icons/provider-claudeAgent.png",
};

const info = { author: "expo", version: 1 };

function withAssetFiles(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const catalogDir = path.join(cfg.modRequest.platformProjectRoot, TARGET_NAME, CATALOG_NAME);
      fs.mkdirSync(catalogDir, { recursive: true });
      fs.writeFileSync(path.join(catalogDir, "Contents.json"), JSON.stringify({ info }, null, 2));
      for (const [name, asset] of Object.entries(WIDGET_IMAGES)) {
        const imageSet = path.join(catalogDir, name + ".imageset");
        const filename = path.basename(asset);
        fs.mkdirSync(imageSet, { recursive: true });
        fs.copyFileSync(
          path.join(cfg.modRequest.projectRoot, "assets", asset),
          path.join(imageSet, filename),
        );
        fs.writeFileSync(
          path.join(imageSet, "Contents.json"),
          JSON.stringify(
            {
              info,
              images: [{ idiom: "universal", filename }],
              properties: {
                "template-rendering-intent": "template",
                ...(filename.endsWith(".svg") ? { "preserves-vector-representation": true } : {}),
              },
            },
            null,
            2,
          ),
        );
      }
      return cfg;
    },
  ]);
}

function withAssetWiring(config) {
  return withXcodeProject(config, (cfg) => {
    addWidgetAssetCatalog(cfg.modResults, { targetName: TARGET_NAME });
    return cfg;
  });
}

module.exports = function withWidgetLogoAsset(config) {
  return withAssetWiring(withAssetFiles(config));
};
