import { useEffect, useId, useState } from "react";
import { create } from "zustand";
import {
  THREAD_FOLLOW_UP_AFTER_PUBLISH_MINUTES,
  THREAD_FOLLOW_UP_QUESTION_MAX,
  type EnvironmentId,
} from "@t3tools/contracts";
import { localSnoozeDate, localSnoozeTime } from "@t3tools/client-runtime/state/thread-settled";
import type { TimestampFormat } from "@t3tools/contracts/settings";

import { resolveSnoozePresets, type SnoozePreset } from "./Sidebar.snooze";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

export interface LaterRecheckChoice {
  readonly question: string;
  /** Null: an hour after the project is next marked published. */
  readonly dueAt: string | null;
}

interface Request {
  readonly id: number;
  readonly environmentId: EnvironmentId;
  readonly timestampFormat: TimestampFormat;
  readonly question: string;
  readonly dueAt: string | null;
  /** The server can mark a project published, so a re-check can wait for it. */
  readonly afterPublishAvailable: boolean;
  readonly afterPublish: boolean;
  readonly editing: boolean;
  readonly resolve: (choice: LaterRecheckChoice | null) => void;
}

const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Asks when to re-check a thread and what to ask then; null when the user cancels. */
let nextRequestId = 0;

export function requestLaterRecheck(
  input: Omit<Request, "id" | "resolve">,
): Promise<LaterRecheckChoice | null> {
  useRequest.getState().request?.resolve(null);
  const id = ++nextRequestId;
  return new Promise((resolve) => useRequest.setState({ request: { ...input, id, resolve } }));
}

function finish(choice: LaterRecheckChoice | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

export function LaterRecheckDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves a pending re-check request with null when the host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <LaterRecheckDialog key={request.id} request={request} /> : null;
}

const CUSTOM = "custom";
const AFTER_PUBLISH = "after-publish";

const toLocalInput = (date: Date) => `${localSnoozeDate(date)}T${localSnoozeTime(date)}`;

function LaterRecheckDialog({ request }: { request: Request }) {
  const id = useId();
  const [presets] = useState<ReadonlyArray<SnoozePreset>>(() =>
    resolveSnoozePresets(new Date(), request.timestampFormat, request.environmentId),
  );
  const [when, setWhen] = useState(() =>
    request.afterPublish && request.afterPublishAvailable
      ? AFTER_PUBLISH
      : request.dueAt !== null
        ? CUSTOM
        : ((presets.find((preset) => preset.label === "Tomorrow") ?? presets[0])?.id ?? CUSTOM),
  );
  const [custom, setCustom] = useState(() =>
    toLocalInput(new Date(request.dueAt ?? Date.now() + 3_600_000)),
  );
  const [question, setQuestion] = useState(request.question);
  const [error, setError] = useState<string | null>(null);
  const items: Record<string, string> = Object.fromEntries([
    ...presets.map((preset) => [preset.id, `${preset.label} · ${preset.whenLabel}`] as const),
    [CUSTOM, "Pick a date and time"] as const,
    ...(request.afterPublishAvailable
      ? [
          [
            AFTER_PUBLISH,
            `After the next publish · ${THREAD_FOLLOW_UP_AFTER_PUBLISH_MINUTES} minutes after you mark it published`,
          ] as const,
        ]
      : []),
  ]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = question.trim();
            if (trimmed === "") {
              setError("Write the question to ask.");
              return;
            }
            if (when === AFTER_PUBLISH) {
              finish({ question: trimmed, dueAt: null });
              return;
            }
            const dueAtMs =
              when === CUSTOM
                ? new Date(custom).getTime()
                : Date.parse(presets.find((preset) => preset.id === when)?.snoozedUntil ?? "");
            if (!Number.isFinite(dueAtMs) || dueAtMs <= Date.now()) {
              setError("Choose a time in the future.");
              return;
            }
            finish({ question: trimmed, dueAt: new Date(dueAtMs).toISOString() });
          }}
        >
          <DialogHeader>
            <DialogTitle>{request.editing ? "Edit re-check" : "Re-check later"}</DialogTitle>
            <DialogDescription>
              The thread waits in Later. At this time the question is sent to its agent, which works
              on it without you.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-when`}>
                When
                <Select
                  value={when}
                  items={items}
                  onValueChange={(value) => {
                    if (typeof value === "string") setWhen(value);
                    setError(null);
                  }}
                >
                  <SelectTrigger id={`${id}-when`} className="min-w-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {Object.entries(items).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Label>
              {when === CUSTOM ? (
                <Input
                  nativeInput
                  aria-label="Re-check date and time"
                  type="datetime-local"
                  required
                  value={custom}
                  onChange={(event) => {
                    setCustom(event.target.value);
                    setError(null);
                  }}
                />
              ) : null}
              <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-question`}>
                Question to ask
                <Textarea
                  id={`${id}-question`}
                  rows={4}
                  maxLength={THREAD_FOLLOW_UP_QUESTION_MAX}
                  value={question}
                  placeholder="Did the overnight run finish? Compare with the numbers above."
                  onChange={(event) => {
                    setQuestion(event.target.value);
                    setError(null);
                  }}
                />
              </Label>
            </div>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit">{request.editing ? "Save" : "Schedule re-check"}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
