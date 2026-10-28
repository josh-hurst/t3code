// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";

function execute(command: string, args: ReadonlyArray<string>) {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function plist(app: string, key: string) {
  return execute("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${key}`,
    NodePath.join(app, "Contents/Info.plist"),
  ]);
}

function verifyApplication(app: string, appId: string, version?: string) {
  if (plist(app, "CFBundleIdentifier") !== appId) {
    throw new Error(`The app at ${app} does not have the fork's bundle ID ${appId}.`);
  }
  if (version && plist(app, "CFBundleShortVersionString") !== version) {
    throw new Error(`The app at ${app} is not version ${version}.`);
  }
  execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
}

export function replaceForkApplication(
  staged: string,
  destination: string,
  launch: (app: string) => void,
) {
  const backup = `${destination}.previous`;
  const olderBackup = NodePath.join(NodePath.dirname(staged), "older-backup.app");
  let savedCurrent = false;
  let savedPrevious = false;
  let replaced = false;
  try {
    if (NodeFS.existsSync(backup)) {
      NodeFS.renameSync(backup, olderBackup);
      savedPrevious = true;
    }
    NodeFS.renameSync(destination, backup);
    savedCurrent = true;
    NodeFS.renameSync(staged, destination);
    replaced = true;
    launch(destination);
  } catch (error) {
    if (replaced) NodeFS.renameSync(destination, staged);
    if (savedCurrent) NodeFS.renameSync(backup, destination);
    if (savedPrevious) NodeFS.renameSync(olderBackup, backup);
    launch(destination);
    throw error;
  }
}

const quitApplicationScript = `on run argv
  set appPath to item 1 of argv
  if application appPath is running then
    tell application appPath to quit
  end if
  repeat 120 times
    if not (application appPath is running) then return
    delay 1
  end repeat
  error "The app did not quit. The installed app has not been replaced."
end run`;

export function prepareForkApplicationInstall(input: {
  readonly appId: string;
  readonly destination: string;
  readonly archive?: string;
  readonly version?: string;
}) {
  if (
    HostProcess.Platform.defaultValue() !== "darwin" ||
    (input.archive && HostProcess.Architecture.defaultValue() !== "arm64")
  ) {
    throw new Error("Local fork installation requires an Apple Silicon Mac.");
  }
  verifyApplication(input.destination, input.appId);
  NodeFS.accessSync(NodePath.dirname(input.destination), NodeFS.constants.W_OK);
  const lock = `${input.destination}.install-lock`;
  NodeFS.mkdirSync(lock);
  const directory = lock;
  try {
    const payload = NodePath.join(directory, "payload");
    NodeFS.mkdirSync(payload);
    let staged: string;
    if (input.archive) {
      execute("/usr/bin/ditto", ["-x", "-k", input.archive, payload]);
      const apps = NodeFS.readdirSync(payload).filter((name) => name.endsWith(".app"));
      if (apps.length !== 1)
        throw new Error("The release ZIP must contain exactly one application.");
      staged = NodePath.join(payload, apps[0]!);
    } else {
      staged = NodePath.join(payload, "Rollback.app");
      execute("/usr/bin/ditto", [`${input.destination}.previous`, staged]);
    }
    verifyApplication(staged, input.appId, input.version);
    const plan = NodePath.join(directory, "install.json");
    NodeFS.writeFileSync(plan, JSON.stringify({ staged, destination: input.destination }));
    NodeFS.writeFileSync(NodePath.join(directory, "quit.applescript"), quitApplicationScript);
    const logPath = `${input.destination}.install.log`;
    const log = NodeFS.openSync(logPath, "a");
    try {
      // The app owns the calling terminal; the installer must outlive its normal shutdown.
      const child = NodeChildProcess.spawn(
        process.execPath,
        [import.meta.filename, "--apply", plan],
        {
          detached: true,
          stdio: ["pipe", log, log],
          cwd: directory,
        },
      );
      child.on("error", (error) => {
        console.error(`Installer failed to start: ${error.message}`);
        NodeFS.rmSync(directory, { recursive: true, force: true });
        process.exitCode = 1;
      });
      console.log(
        `release:fork: switching ${input.destination}${input.version ? ` to ${input.version}` : " to its previous build"}.\nThe app will quit and relaunch. Installer log: ${logPath}\nRollback: vp run release:fork rollback --app '${input.destination.replaceAll("'", "'\\''")}'`,
      );
      // EOF lets the parent print the handoff before the installer closes its app.
      child.stdin!.end();
      child.unref();
    } finally {
      NodeFS.closeSync(log);
    }
  } catch (error) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function applyInstall(plan: string) {
  const directory = NodePath.dirname(plan);
  const { staged, destination } = JSON.parse(NodeFS.readFileSync(plan, "utf8")) as {
    staged: string;
    destination: string;
  };
  for await (const _chunk of process.stdin) {
    /* Wait for the initiating command's handoff. */
  }
  const quit = NodeChildProcess.spawnSync(
    "/usr/bin/osascript",
    [NodePath.join(directory, "quit.applescript"), destination],
    {
      encoding: "utf8",
      timeout: 150_000,
    },
  );
  if (quit.status !== 0)
    throw new Error(
      `The app could not quit; it has not been replaced. ${quit.error?.message ?? quit.stderr}`,
    );
  replaceForkApplication(staged, destination, (app) => execute("/usr/bin/open", [app]));
  console.log(`Installed ${destination}; previous app saved at ${destination}.previous`);
  NodeFS.rmSync(directory, { recursive: true, force: true });
}

if (import.meta.main) {
  const plan = process.argv[2] === "--apply" ? process.argv[3] : undefined;
  if (!plan)
    throw new Error("Run vp run release:fork install <version> or vp run release:fork rollback.");
  applyInstall(plan).catch((error: unknown) => {
    console.error(error);
    const recovery = NodeFS.mkdtempSync(`${NodePath.dirname(plan)}.failed-`);
    NodeFS.renameSync(NodePath.dirname(plan), recovery);
    console.error(`Installer files preserved for recovery: ${recovery}`);
    process.exitCode = 1;
  });
}
