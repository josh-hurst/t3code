export const VOICE_WAVEFORM_SAMPLE_COUNT = 64;

export function createVoiceAudioLevels() {
  let levels: ReadonlyArray<number> = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => levels,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next: ReadonlyArray<number>) => {
      levels = next;
      for (const listener of listeners) listener();
    },
  };
}

export type VoiceAudioLevels = Pick<
  ReturnType<typeof createVoiceAudioLevels>,
  "getSnapshot" | "subscribe"
>;

const VOICE_NOISE_FLOOR_DECIBELS = -60;
const VOICE_NOISE_FLOOR_AMPLITUDE = 10 ** (VOICE_NOISE_FLOOR_DECIBELS / 20);

export function normalizeVoiceInputDecibels(decibels: number | undefined) {
  if (decibels === undefined || !Number.isFinite(decibels)) return 0;
  if (decibels <= VOICE_NOISE_FLOOR_DECIBELS) return 0;
  if (decibels >= 0) return 1;

  const amplitude = 10 ** (decibels / 20);
  return Math.sqrt((amplitude - VOICE_NOISE_FLOOR_AMPLITUDE) / (1 - VOICE_NOISE_FLOOR_AMPLITUDE));
}
