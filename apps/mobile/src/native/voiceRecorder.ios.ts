import { AudioModule } from "expo-audio";
import { createLiveVoiceRecorder, hasLiveVoiceRecorder } from "./voiceTranscription.ios";

export const supportsLiveDictation = hasLiveVoiceRecorder;

export function createVoiceRecorder(
  options: ConstructorParameters<typeof AudioModule.AudioRecorder>[0],
  live: boolean,
) {
  return (live ? createLiveVoiceRecorder() : null) ?? new AudioModule.AudioRecorder(options);
}
