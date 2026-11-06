import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";

export async function getLocalVoiceTranscriber(
  _isLive: () => boolean,
): Promise<VoiceTranscriber | null> {
  return null;
}
