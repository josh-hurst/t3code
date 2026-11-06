"use strict";

// Registers an Icon Composer project as an iOS alternate app icon that Settings → Appearance can select.

const fs = require("fs");
const path = require("path");
const { IOSConfig, withDangerousMod, withXcodeProject } = require("expo/config-plugins");

module.exports = function withAlternateAppIcon(config, { name, source }) {
  config = withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const target = path.join(
        cfg.modRequest.platformProjectRoot,
        cfg.modRequest.projectName,
        `${name}.icon`,
      );
      await fs.promises.rm(target, { recursive: true, force: true });
      await fs.promises.cp(path.resolve(cfg.modRequest.projectRoot, source), target, {
        recursive: true,
      });
      return cfg;
    },
  ]);
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectName = cfg.modRequest.projectName;
    IOSConfig.XcodeUtils.addResourceFileToGroup({
      filepath: `${projectName}/${name}.icon`,
      groupName: projectName,
      project,
      isBuildFile: true,
      verbose: true,
    });
    const [, target] = IOSConfig.Target.findNativeTargetByName(project, projectName);
    for (const [, buildConfig] of IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
      project,
      target.buildConfigurationList,
    )) {
      if (buildConfig?.buildSettings) {
        buildConfig.buildSettings.ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = `"${name}"`;
        buildConfig.buildSettings.ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS = "YES";
      }
    }
    return cfg;
  });
};
