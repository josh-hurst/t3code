import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  VOICE_RECORDING_LIMIT_SECONDS,
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceInputPhase,
  type VoiceInputState,
  type VoiceTranscriptPreview,
} from "@t3tools/client-runtime/voice-input";

import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";

const VOICE_METERING_INTERVAL_MS = 80;
// Send takes the place of the check mark when a transcript lands; a tap meant to skip
// cleanup must not send the message.
const SUBMISSION_HOLD_MS = 500;
const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const SILENT_LEVELS: ReadonlyArray<number> = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);

/** Where the draft lives: its project's vocabulary and optional cleanup come from there. */
export type VoiceDraftContext = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly projectName: string | null;
};

export type VoiceInputTarget = {
  readonly ownerKey: string;
  readonly label?: string;
  readonly context?: VoiceDraftContext;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: VoiceInputControllerDependencies["commitDraft"];
};

export type VoiceInputSnapshot = {
  readonly state: VoiceInputState;
  readonly ownerKey: string | null;
  readonly label: string | null;
  readonly elapsedSeconds: number;
  readonly focusedOwners: ReadonlySet<string>;
};

export type VoiceRecordingSample = {
  readonly durationMillis: number;
  readonly metering: number | undefined;
};

export type VoiceInputSessionDependencies = Omit<
  VoiceInputControllerDependencies,
  "readDraft" | "commitDraft" | "onStateChange" | "onPreview"
> & {
  /** Reads the live recorder, or null when it is not capturing. */
  readonly sampleRecording: () => VoiceRecordingSample | null;
  /** Levels change every metering tick, so they bypass React state. */
  readonly publishAudioLevels: (levels: ReadonlyArray<number>) => void;
  /** Holds the screen awake while recording; returns the release. */
  readonly keepAwake: () => () => void;
};

export function createVoiceInputTarget(
  ownerKey: string,
  readText: () => string | null,
  commitDraft: VoiceInputTarget["commitDraft"],
  selection: VoiceDraftSnapshot["selection"],
): VoiceInputTarget {
  return {
    ownerKey,
    readDraft: () => {
      const text = readText();
      return text === null ? null : { ownerKey, text, selection };
    },
    commitDraft,
  };
}

/**
 * The app's single voice input: it owns the controller, the recording-only
 * side effects (keep-awake, metering) and publishes what the UI renders.
 */
export class VoiceInputSession {
  readonly controller: VoiceInputController;
  private readonly dependencies: VoiceInputSessionDependencies;
  private target: VoiceInputTarget | null = null;
  private startText: string | null = null;
  private snapshot: VoiceInputSnapshot = {
    state: IDLE_STATE,
    ownerKey: null,
    label: null,
    elapsedSeconds: 0,
    focusedOwners: new Set(),
  };
  private readonly listeners = new Set<() => void>();
  // Previews change several times a second, so only the preview view subscribes to them.
  private preview: VoiceTranscriptPreview | null = null;
  private readonly previewListeners = new Set<() => void>();
  private audioLevels = SILENT_LEVELS;
  private releaseKeepAwake: (() => void) | null = null;
  private inserted: { readonly ownerKey: string; readonly at: number } | null = null;
  private meteringInterval: ReturnType<typeof setInterval> | null = null;

  constructor(dependencies: VoiceInputSessionDependencies) {
    this.dependencies = dependencies;
    this.controller = new VoiceInputController({
      ...dependencies,
      onStateChange: (state) => this.handleStateChange(state),
      onPreview: (preview) => this.setPreview(preview),
      // The target's selection is fixed at start, so a draft changed since refuses the transcript.
      readDraft: () => {
        const draft = this.target?.readDraft() ?? null;
        return draft?.text === this.startText ? draft : null;
      },
      commitDraft: (text, selection) => this.target?.commitDraft(text, selection),
    });
  }

  get ownerKey(): string | null {
    return this.target?.ownerKey ?? null;
  }

  get label(): string | null {
    return this.target?.label ?? null;
  }

  get context(): VoiceDraftContext | null {
    return this.target?.context ?? null;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): VoiceInputSnapshot => this.snapshot;

  readonly subscribePreview = (listener: () => void): (() => void) => {
    this.previewListeners.add(listener);
    return () => this.previewListeners.delete(listener);
  };

  readonly getPreview = (): VoiceTranscriptPreview | null => this.preview;

  setOwnerFocused(ownerKey: string, focused: boolean): void {
    if (this.snapshot.focusedOwners.has(ownerKey) === focused) return;
    const focusedOwners = new Set(this.snapshot.focusedOwners);
    if (focused) focusedOwners.add(ownerKey);
    else focusedOwners.delete(ownerKey);
    this.publish({ ...this.snapshot, focusedOwners });
  }

  /** True just after a transcript was inserted into `ownerKey`'s draft. */
  holdsSubmission(ownerKey: string): boolean {
    return (
      this.inserted?.ownerKey === ownerKey && Date.now() - this.inserted.at < SUBMISSION_HOLD_MS
    );
  }

  cancel(ownerKey: string | null): void {
    if (ownerKey !== null && this.ownerKey === ownerKey) this.controller.cancel();
  }

  retry(): Promise<void> {
    return this.target ? this.start(this.target) : Promise.resolve();
  }

  start(target: VoiceInputTarget): Promise<void> {
    if (voiceInputBlocksSubmission(this.controller.currentState)) return Promise.resolve();
    this.target = target;
    this.startText = target.readDraft()?.text ?? null;
    return this.controller.start();
  }

  dispose(): void {
    this.controller.dispose();
    this.stopRecordingActivity();
    this.listeners.clear();
    this.previewListeners.clear();
  }

  private handleStateChange(state: VoiceInputState): void {
    // Kept through transcription and cleanup so the text does not vanish before it is inserted.
    if (state.phase === "idle" || state.phase === "error" || state.phase === "preparing") {
      this.setPreview(null);
    }
    const previousPhase = this.snapshot.state.phase;
    const ownerKey = this.ownerKey;
    if (
      state.phase === "idle" &&
      ownerKey !== null &&
      (previousPhase === "transcribing" || previousPhase === "post-processing")
    ) {
      this.inserted = { ownerKey, at: Date.now() };
    }
    let elapsedSeconds = this.snapshot.elapsedSeconds;
    if (state.phase !== previousPhase) {
      if (previousPhase === "recording") this.stopRecordingActivity();
      if (capturesAudio(state.phase)) {
        if (this.audioLevels.some((level) => level !== 0)) this.setAudioLevels(SILENT_LEVELS);
        elapsedSeconds = 0;
      }
    }
    this.publish({
      ...this.snapshot,
      state,
      ownerKey: this.ownerKey,
      label: this.label,
      elapsedSeconds,
    });
    if (state.phase === "recording" && previousPhase !== "recording") {
      this.startRecordingActivity();
    }
  }

  private startRecordingActivity(): void {
    this.releaseKeepAwake = this.dependencies.keepAwake();
    this.sampleRecording();
    this.meteringInterval = setInterval(() => this.sampleRecording(), VOICE_METERING_INTERVAL_MS);
  }

  private stopRecordingActivity(): void {
    if (this.meteringInterval !== null) clearInterval(this.meteringInterval);
    this.meteringInterval = null;
    this.releaseKeepAwake?.();
    this.releaseKeepAwake = null;
  }

  private sampleRecording(): void {
    if (this.controller.currentState.phase !== "recording") return;
    const sample = this.dependencies.sampleRecording();
    if (!sample) return;

    const level = normalizeVoiceInputDecibels(sample.metering);
    if (level !== 0 || this.audioLevels.some((sample) => sample !== 0)) {
      this.setAudioLevels([...this.audioLevels.slice(1), level]);
    }

    const elapsedSeconds = Math.min(
      VOICE_RECORDING_LIMIT_SECONDS,
      Math.max(0, Math.floor(sample.durationMillis / 1_000)),
    );
    if (elapsedSeconds !== this.snapshot.elapsedSeconds) {
      this.publish({ ...this.snapshot, elapsedSeconds });
    }
  }

  private setPreview(preview: VoiceTranscriptPreview | null): void {
    if (this.preview === preview) return;
    this.preview = preview;
    for (const listener of this.previewListeners) listener();
  }

  private setAudioLevels(levels: ReadonlyArray<number>): void {
    this.audioLevels = levels;
    this.dependencies.publishAudioLevels(levels);
  }

  private publish(snapshot: VoiceInputSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function capturesAudio(phase: VoiceInputPhase): boolean {
  return phase === "preparing" || phase === "recording";
}
