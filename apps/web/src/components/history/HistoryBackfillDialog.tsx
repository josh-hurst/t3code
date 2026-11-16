import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ContentsBackfillEstimate, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useId, useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { threadBackfillAtoms } from "./historyBackfillState";

export interface BackfillProjectOption {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label: string;
}

const SINCE_DAYS = { "30": 30, "90": 90 } as const;
const SINCE_ITEMS: Record<string, string> = {
  "30": "Active in the last 30 days",
  "90": "Active in the last 90 days",
  all: "All threads",
};
const DAY_MS = 86_400_000;
const NO_ESTIMATE: ReturnType<typeof threadBackfillAtoms.estimate> = Atom.make(
  AsyncResult.initial(),
).pipe(Atom.withLabel("web:contents-backfill-estimate:none"));

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const tokens = (count: number) =>
  count >= 1_000_000
    ? `${(count / 1_000_000).toFixed(1)} million`
    : count >= 1_000
      ? `${Math.round(count / 1_000)},000`
      : String(count);

function EstimateSummary({ estimate }: { estimate: ContentsBackfillEstimate }) {
  const threads = estimate.threads.short + estimate.threads.long;
  const calls = estimate.calls.headlines + estimate.calls.regroups;
  const migrated =
    estimate.threads.migrated > 0 ? (
      <p className="text-muted-foreground">
        {plural(estimate.threads.migrated, "thread")} came from an older version of T3 Code. Their
        replies from before can't be added; later ones can.
      </p>
    ) : null;
  if (threads === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p>Nothing to add: every thread here already has its topics.</p>
        {migrated}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p>
        {plural(threads, "thread")} ({estimate.threads.long} long), {estimate.runs}{" "}
        {estimate.runs === 1 ? "reply" : "replies"} without a topic. About {plural(calls, "call")}{" "}
        to the summary model, one at a time, with about {tokens(estimate.promptTokens)} tokens of
        prompt text and {tokens(estimate.outputTokens)} of output.
      </p>
      <p className="text-muted-foreground">
        Each call also carries the provider's own instructions: a dozen tokens or so through
        codex-lite, about 11,000 through the Codex CLI.
      </p>
      {migrated}
    </div>
  );
}

/** Picks a project and a range, shows what adding its older threads would cost, and starts it. */
export function HistoryBackfillDialog(props: {
  readonly projects: ReadonlyArray<BackfillProjectOption>;
  readonly initialKey: string | null;
  readonly canStart: (environmentId: EnvironmentId) => boolean;
  readonly onClose: () => void;
}) {
  const id = useId();
  const keyOf = (option: BackfillProjectOption) => `${option.environmentId}:${option.projectId}`;
  const [projectKey, setProjectKey] = useState(
    () => props.initialKey ?? (props.projects[0] ? keyOf(props.projects[0]) : ""),
  );
  const [since, setSince] = useState<string>("all");
  const [longOnly, setLongOnly] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [starting, setStarting] = useState(false);
  const [now] = useState(() => Date.now());
  const project = props.projects.find((option) => keyOf(option) === projectKey) ?? null;
  const days = SINCE_DAYS[since as keyof typeof SINCE_DAYS];

  const estimateResult = useAtomValue(
    project === null
      ? NO_ESTIMATE
      : threadBackfillAtoms.estimate({
          environmentId: project.environmentId,
          input: {
            projectId: project.projectId,
            ...(days === undefined ? {} : { since: new Date(now - days * DAY_MS).toISOString() }),
            ...(longOnly ? { only: "long" as const } : {}),
            attempt,
          },
        }),
  );
  const estimate =
    project === null || estimateResult.waiting
      ? null
      : AsyncResult.getOrElse(estimateResult, () => null);
  const start = useAtomCommand(threadBackfillAtoms.start, { reportFailure: false });
  const allowed = project !== null && props.canStart(project.environmentId);
  const nothing = estimate !== null && estimate.threads.short + estimate.threads.long === 0;

  const onStart = async () => {
    if (project === null || estimate === null) return;
    setStarting(true);
    const result = await start({
      environmentId: project.environmentId,
      input: { estimateId: estimate.estimateId },
    });
    setStarting(false);
    if (result._tag === "Success") {
      props.onClose();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not start adding older threads",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
    setAttempt((value) => value + 1);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add older threads</DialogTitle>
          <DialogDescription>
            Gives threads from before topics were kept their topics, from their messages and
            replies. Their summaries, open items and order in the sidebar stay as they are.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4 text-sm">
            <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-project`}>
              Project
              <Select
                value={projectKey}
                items={Object.fromEntries(
                  props.projects.map((option) => [keyOf(option), option.label]),
                )}
                onValueChange={(value) => {
                  if (typeof value === "string") setProjectKey(value);
                }}
              >
                <SelectTrigger id={`${id}-project`} className="min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {props.projects.map((option) => (
                    <SelectItem key={keyOf(option)} value={keyOf(option)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Label>
            <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-since`}>
              Threads
              <Select
                value={since}
                items={SINCE_ITEMS}
                onValueChange={(value) => {
                  if (typeof value === "string") setSince(value);
                }}
              >
                <SelectTrigger id={`${id}-since`} className="min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {Object.entries(SINCE_ITEMS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Label>
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${id}-long`}
                checked={longOnly}
                onCheckedChange={(checked) => setLongOnly(checked)}
              />
              <Label htmlFor={`${id}-long`}>
                Long threads only (ten or more messages), where topics help most
              </Label>
            </div>
            {project === null ? (
              <p className="text-muted-foreground">No project here keeps topics.</p>
            ) : estimate === null ? (
              <p className="text-muted-foreground">
                {estimateResult._tag === "Failure" && !estimateResult.waiting
                  ? "Could not count this project's threads."
                  : "Counting…"}
              </p>
            ) : (
              <EstimateSummary estimate={estimate} />
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!allowed || estimate === null || nothing || starting}
            title={allowed ? undefined : "This connection cannot start work on that server"}
            onClick={() => void onStart()}
          >
            Start
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
