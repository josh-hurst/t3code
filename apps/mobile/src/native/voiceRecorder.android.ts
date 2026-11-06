import { AudioModule } from "expo-audio";
import { createLiveVoiceRecorder, supportsLiveVoiceRecorder } from "./voiceTranscription.android";

export const supportsLiveDictation = supportsLiveVoiceRecorder;

export function createVoiceRecorder(
  options: ConstructorParameters<typeof AudioModule.AudioRecorder>[0],
  live: boolean,
) {
  return (live ? createLiveVoiceRecorder() : null) ?? new AudioModule.AudioRecorder(options);
}
