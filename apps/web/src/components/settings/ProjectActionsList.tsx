import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  ProjectKeepRunningControlAction,
  ProjectKeepRunningStatus,
  ProjectScript,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { isKeepRunningProjectScript } from "@t3tools/shared/projectScripts";
import { T, useGT } from "gt-react";
import { SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { m } from "../../i18n/messages";
import { shortcutLabelForCommand } from "../../keybindings";
import { commandForProjectScript } from "../../projectScripts";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { ScriptIcon } from "../projectScriptEditor";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

function formatKeepRunningStatus(
  status: ProjectKeepRunningStatus | undefined,
  gt: ReturnType<typeof useGT>,
): string {
  if (!status) return gt("Not running");
  switch (status.state) {
    case "starting":
      return gt("Starting");
    case "running":
      return status.pid !== null ? gt("Running · PID {pid}", { pid: status.pid }) : gt("Running");
    case "restarting":
      if (status.lastExitSignal !== null) {
        return gt("Restarting · {signal}", { signal: status.lastExitSignal });
      }
      if (status.lastExitCode !== null) {
        return gt("Restarting · exit {code}", { code: status.lastExitCode });
      }
      return gt("Restarting");
    case "stopped":
      return gt("Stopped");
    case "failed":
      if (status.failureMessage) {
        return gt("Failed · {message}", { message: status.failureMessage });
      }
      if (status.lastExitSignal !== null) {
        return gt("Failed · {signal}", { signal: status.lastExitSignal });
      }
      if (status.lastExitCode !== null) {
        return gt("Failed · exit {code}", { code: status.lastExitCode });
      }
      return gt("Failed");
  }
}

function KeepRunningActionRow({
  script,
  disabled,
  environmentId,
  projectId,
  status,
  onEdit,
}: {
  script: ProjectScript;
  disabled: boolean;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  status: ProjectKeepRunningStatus | undefined;
  onEdit: (script: ProjectScript) => void;
}) {
  const gt = useGT();
  const canControl = useAtomValue(
    projectEnvironment.keepRunningControl.permissionAtom(environmentId),
  );
  const runControl = useAtomCommand(projectEnvironment.keepRunningControl, {
    reportFailure: false,
  });
  const fetchOutput = useAtomCommand(projectEnvironment.keepRunningOutput, {
    reportFailure: false,
  });
  const [busyAction, setBusyAction] = useState<ProjectKeepRunningControlAction | null>(null);
  const [outputOpen, setOutputOpen] = useState(false);
  const [outputState, setOutputState] = useState<{
    readonly lines: ReadonlyArray<string>;
    readonly truncated: boolean;
    readonly error: string | null;
    readonly loaded: boolean;
    readonly sequence: number;
  }>({ lines: [], truncated: false, error: null, loaded: false, sequence: -1 });

  const statusSequence = status?.sequence ?? -1;
  const isActive =
    status?.state === "starting" || status?.state === "running" || status?.state === "restarting";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the command's output from the server while the panel is open: on each status change, and every 2 s while it runs
  useEffect(() => {
    if (!outputOpen) return;
    let cancelled = false;
    const load = () =>
      void fetchOutput({
        environmentId,
        input: { projectId, scriptId: script.id },
      }).then((result) => {
        if (cancelled) return;
        if (result._tag === "Success") {
          setOutputState({
            lines: result.value.lines,
            truncated: result.value.truncated,
            error: null,
            loaded: true,
            sequence: statusSequence,
          });
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setOutputState((current) => ({
            ...current,
            error: thrownErrorMessage(error, m) ?? gt("Failed to load output."),
            loaded: true,
            sequence: statusSequence,
          }));
        }
      });
    load();
    const timer = isActive ? window.setInterval(load, 2_000) : null;
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [environmentId, fetchOutput, gt, isActive, outputOpen, projectId, script.id, statusSequence]);

  const handleControl = async (action: ProjectKeepRunningControlAction) => {
    setBusyAction(action);
    const result = await runControl({
      environmentId,
      input: { projectId, scriptId: script.id, action },
    });
    setBusyAction(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title:
          action === "stop"
            ? gt("Could not stop {name}", { name: script.name })
            : gt("Could not restart {name}", { name: script.name }),
        description: thrownErrorMessage(error, m) ?? gt("An unexpected error occurred."),
      });
    }
  };

  const controlDisabled = !canControl || busyAction !== null;

  return (
    <SettingsRow
      className="group py-2"
      title={
        <span className="flex min-w-0 items-center gap-2">
          <ScriptIcon icon={script.icon} className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{script.name}</span>
          <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-2xs font-normal text-muted-foreground">
            <T>keep running</T>
          </span>
        </span>
      }
      description={<code className="block max-w-full truncate font-mono">{script.command}</code>}
      status={
        <span className={status?.state === "failed" ? "text-destructive" : undefined}>
          {formatKeepRunningStatus(status, gt)}
        </span>
      }
      control={
        <>
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={outputOpen}
            onClick={() => setOutputOpen((open) => !open)}
          >
            {outputOpen ? <T>Hide output</T> : <T>Output</T>}
          </Button>
          {isActive ? (
            <Button
              size="xs"
              variant="outline"
              disabled={controlDisabled}
              onClick={() => void handleControl("stop")}
            >
              <T>Stop</T>
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={controlDisabled}
            onClick={() => void handleControl("restart")}
          >
            <T>Restart</T>
          </Button>
          <span className="flex shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={gt("Edit {name}", { name: script.name })}
              disabled={disabled}
              onClick={() => onEdit(script)}
            >
              <SettingsIcon className="size-3.5" />
            </Button>
          </span>
        </>
      }
    >
      {outputOpen ? (
        <div className="pt-2 pb-1">
          {outputState.error ? (
            <p className="text-xs text-destructive">{outputState.error}</p>
          ) : !outputState.loaded ? (
            <p className="text-xs text-muted-foreground">
              <T>Loading output…</T>
            </p>
          ) : outputState.lines.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              <T>No output yet.</T>
            </p>
          ) : (
            <pre className="max-h-56 overflow-auto rounded-md border border-border/60 bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-words text-foreground">
              {outputState.lines.join("\n")}
            </pre>
          )}
        </div>
      ) : null}
    </SettingsRow>
  );
}

export function ProjectActionsList({
  scripts,
  keybindings,
  disabled,
  keepRunning,
  onEdit,
}: {
  scripts: readonly ProjectScript[];
  keybindings: ResolvedKeybindingsConfig;
  disabled: boolean;
  keepRunning?: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly statuses: ReadonlyMap<string, ProjectKeepRunningStatus>;
  };
  onEdit: (script: ProjectScript) => void;
}) {
  const gt = useGT();
  if (scripts.length === 0)
    return (
      <p className="px-3 py-2 text-base text-muted-foreground sm:px-4 sm:text-sm">
        <T>No actions configured.</T>
      </p>
    );
  return scripts.map((script) => {
    if (isKeepRunningProjectScript(script) && keepRunning) {
      return (
        <KeepRunningActionRow
          key={script.id}
          script={script}
          disabled={disabled}
          environmentId={keepRunning.environmentId}
          projectId={keepRunning.projectId}
          status={keepRunning.statuses.get(script.id)}
          onEdit={onEdit}
        />
      );
    }
    const shortcutLabel = isKeepRunningProjectScript(script)
      ? null
      : shortcutLabelForCommand(keybindings, commandForProjectScript(script.id));
    return (
      <SettingsRow
        key={script.id}
        className="group py-2"
        title={
          <span className="flex min-w-0 items-center gap-2">
            <ScriptIcon icon={script.icon} className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{script.name}</span>
            {isKeepRunningProjectScript(script) ? (
              <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-2xs font-normal text-muted-foreground">
                <T>keep running</T>
              </span>
            ) : null}
            {!isKeepRunningProjectScript(script) && script.runOnWorktreeCreate ? (
              <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-2xs font-normal text-muted-foreground">
                {gt("setup", { $context: "badge, action runs when a worktree is created" })}
              </span>
            ) : null}
            {!isKeepRunningProjectScript(script) && script.runOnSettle ? (
              <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-2xs font-normal text-muted-foreground">
                <T>on settle</T>
              </span>
            ) : null}
            {!isKeepRunningProjectScript(script) && script.previewUrl ? (
              <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-2xs font-normal text-muted-foreground max-sm:hidden">
                <T>preview · desktop only</T>
              </span>
            ) : null}
          </span>
        }
        description={<code className="block max-w-full truncate font-mono">{script.command}</code>}
        control={
          <>
            {shortcutLabel ? (
              <span className="text-xs text-muted-foreground">{shortcutLabel}</span>
            ) : null}
            <span className="flex shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={gt("Edit {name}", { name: script.name })}
                disabled={disabled}
                onClick={() => onEdit(script)}
              >
                <SettingsIcon className="size-3.5" />
              </Button>
            </span>
          </>
        }
      />
    );
  });
}
