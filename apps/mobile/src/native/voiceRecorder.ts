import { AudioModule } from "expo-audio";

export const supportsLiveDictation = false;

export function createVoiceRecorder(
  options: ConstructorParameters<typeof AudioModule.AudioRecorder>[0],
  _live: boolean,
) {
  return new AudioModule.AudioRecorder(options);
}
