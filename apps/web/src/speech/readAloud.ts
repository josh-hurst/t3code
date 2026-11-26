import { useSyncExternalStore } from "react";

type VoiceInfo = Pick<SpeechSynthesisVoice, "name" | "voiceURI" | "lang" | "default">;

// macOS ships Eloquence and novelty voices that sound robotic or comic.
const ROBOTIC_VOICES = new Set([
  "albert",
  "bad news",
  "bahh",
  "bells",
  "boing",
  "bubbles",
  "cellos",
  "eddy",
  "flo",
  "fred",
  "good news",
  "grandma",
  "grandpa",
  "jester",
  "junior",
  "kathy",
  "organ",
  "ralph",
  "reed",
  "rocko",
  "sandy",
  "shelley",
  "superstar",
  "trinoids",
  "whisper",
  "wobble",
  "zarvox",
]);

function voiceQuality({ name, voiceURI }: VoiceInfo) {
  const id = `${name} ${voiceURI}`.toLowerCase();
  const base = name.toLowerCase().replace(/\s*\(.*$/, "");
  if (ROBOTIC_VOICES.has(base) || /eloquence|speech\.synthesis\.voice/.test(id)) return -100;
  if (id.includes("premium")) return 40;
  if (/enhanced|natural|neural/.test(id)) return 30;
  if (base.startsWith("google")) return 20;
  return 0;
}

function languageMatch(voiceLang: string, preferred: readonly string[]) {
  const lang = voiceLang.toLowerCase().replace("_", "-");
  for (const [index, locale] of preferred.entries()) {
    const want = locale.toLowerCase();
    if (lang === want) return 200 - index * 10;
    if (lang.split("-")[0] === want.split("-")[0]) return 150 - index * 10;
  }
  return 0;
}

export function pickReadAloudVoice<Voice extends VoiceInfo>(
  voices: readonly Voice[],
  preferredLocales: readonly string[],
): Voice | null {
  let best: Voice | null = null;
  let bestScore = -Infinity;
  for (const voice of voices) {
    const score =
      languageMatch(voice.lang, preferredLocales) + voiceQuality(voice) + (voice.default ? 1 : 0);
    if (score > bestScore) {
      best = voice;
      bestScore = score;
    }
  }
  return best;
}

/** Reduces reply markdown to what a listener wants to hear; code blocks are skipped. */
export function speakableText(markdown: string) {
  return markdown
    .replace(/^[^\S\n]*(`{3,}|~{3,})[\s\S]*?^[^\S\n]*\1[^\S\n]*$/gm, "\n")
    .replace(/<[^>\n]+>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^[^\S\n]*\|?([^\S\n]*:?-{3,}:?[^\S\n]*\|?)+[^\S\n]*(\n|$)/gm, "")
    .replace(/[^\S\n]*\|[^\S\n]*/g, ", ")
    .replace(/^[^\S\n]{0,3}(#{1,6}[^\S\n]+|>[^\S\n]?|[-*+][^\S\n]+|\d+[.)][^\S\n]+)/gm, "")
    .replace(/^[^\S\n]*([-*_][^\S\n]*){3,}$/gm, "")
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1$2")
    .replace(/^,[^\S\n]*|,[^\S\n]*$/gm, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ $/gm, "")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

// Chrome drops an utterance that runs past about 15 seconds, so queue sentence-sized chunks.
const MAX_CHUNK = 220;

export function speechChunks(text: string) {
  const chunks: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    let chunk = "";
    for (const sentence of paragraph.match(/[^.!?\n]+(?:[.!?]+["')\]]*|\n|$)\s*/g) ?? []) {
      if (chunk && chunk.length + sentence.length > MAX_CHUNK) {
        chunks.push(chunk.trim());
        chunk = "";
      }
      chunk += sentence;
    }
    if (chunk.trim()) chunks.push(chunk.trim());
  }
  return chunks;
}

let speakingId: string | null = null;
let run: object | null = null;
const listeners = new Set<() => void>();

function setSpeaking(id: string | null) {
  speakingId = id;
  listeners.forEach((notify) => notify());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const readAloudSupported =
  typeof window !== "undefined" &&
  "speechSynthesis" in window &&
  typeof SpeechSynthesisUtterance !== "undefined";

// Chrome loads its voice list on first request; ask early so the first click gets a good voice.
if (readAloudSupported) window.speechSynthesis.getVoices();

export function useReadingAloud(id: string) {
  return useSyncExternalStore(
    subscribe,
    () => speakingId === id,
    () => false,
  );
}

function stopReadingAloud() {
  run = null;
  window.speechSynthesis.cancel();
  setSpeaking(null);
}

export function toggleReadAloud(id: string, markdown: string) {
  const reading = speakingId === id;
  stopReadingAloud();
  if (reading) return;
  const chunks = speechChunks(speakableText(markdown));
  if (chunks.length === 0) return;
  const synth = window.speechSynthesis;
  const voice = pickReadAloudVoice(synth.getVoices(), navigator.languages ?? [navigator.language]);
  const current = {};
  run = current;
  const finish = () => {
    if (run === current) {
      run = null;
      setSpeaking(null);
    }
  };
  chunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.onerror = finish;
    if (index === chunks.length - 1) utterance.onend = finish;
    synth.speak(utterance);
  });
  setSpeaking(id);
}
