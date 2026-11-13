import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  active: true,
  reducedMotion: false,
  stateListeners: new Set<() => void>(),
  workletTiming: vi.fn((value: number) => value),
  nativeTiming: vi.fn(),
  values: [] as { value: number; stopAnimation: ReturnType<typeof vi.fn> }[],
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Easing: { out: (fn: unknown) => fn, quad: (value: number) => value * value },
  Animated: {
    View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Value: class {
      value: number;
      stopAnimation = vi.fn();
      constructor(value: number) {
        this.value = value;
        mocks.values.push(this);
      }
      setValue(value: number) {
        this.value = value;
      }
      interpolate() {
        return this;
      }
    },
    timing: mocks.nativeTiming,
  },
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
  Easing: { out: (fn: unknown) => fn, inOut: (fn: unknown) => fn },
  ReduceMotion: { System: "system" },
  useAnimatedStyle: (fn: () => unknown) => fn(),
  useReducedMotion: () => mocks.reducedMotion,
  withTiming: mocks.workletTiming,
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("../../lib/appState", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    mocks.stateListeners.add(listener);
    return () => {
      mocks.stateListeners.delete(listener);
    };
  };
  return {
    useAppActive: () => useSyncExternalStore(subscribe, () => mocks.active),
    useReduceMotionEnabled: () => useSyncExternalStore(subscribe, () => mocks.reducedMotion),
  };
});
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/useAndroidControlSizing", () => ({
  useAndroidControlSizing: () => ({ scale: 1 }),
}));
vi.mock("./VoiceInputProvider", () => ({ useVoiceTranscriptPreview: () => null }));

import { CompactVoiceWaveform } from "./ComposerDictationControl";
import { createVoiceAudioLevels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";

it("pauses hidden waveform work and resumes at the latest level without replaying missed samples", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.active = true;
  mocks.reducedMotion = false;
  mocks.values = [];
  mocks.stateListeners.clear();
  mocks.workletTiming.mockClear();
  mocks.nativeTiming.mockReset().mockImplementation((value, config) => ({
    start: () => {
      value.value = config.toValue;
    },
  }));
  const meter = createVoiceAudioLevels();
  const listeners = new Set<() => void>();
  const audioLevels = {
    getSnapshot: meter.getSnapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      const unsubscribe = meter.subscribe(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    },
  };
  const publish = (level: number) => {
    meter.set(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(level));
  };
  const root = createRoot(document.createElement("div"));
  const render = (visible: boolean) =>
    act(() => {
      for (const listener of mocks.stateListeners) listener();
      root.render(<CompactVoiceWaveform audioLevels={audioLevels} visible={visible} />);
    });
  try {
    render(false);
    expect(mocks.workletTiming).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
    publish(0.5);
    render(true);
    expect(mocks.values.every((value) => value.value === 0.5)).toBe(true);
    publish(0.8);
    expect(mocks.nativeTiming).toHaveBeenCalledTimes(8);
    expect(
      mocks.nativeTiming.mock.calls.every(([, config]) => config.useNativeDriver === true),
    ).toBe(true);
    publish(0.8);
    expect(mocks.nativeTiming).toHaveBeenCalledTimes(8);
    mocks.active = false;
    render(true);
    expect(listeners.size).toBe(0);
    expect(mocks.values.every((value) => value.stopAnimation.mock.calls.length > 0)).toBe(true);
    publish(0.2);
    mocks.active = true;
    render(true);
    expect(mocks.values.every((value) => value.value === 0.2)).toBe(true);
    mocks.reducedMotion = true;
    render(true);
    publish(0.7);
    expect(mocks.values.every((value) => value.value === 0.7)).toBe(true);
    expect(mocks.nativeTiming).toHaveBeenCalledTimes(8);
  } finally {
    act(() => root.unmount());
  }
  expect(listeners.size).toBe(0);
});
