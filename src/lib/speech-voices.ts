// Verified via direct investigation of a real speechSynthesis.getVoices()
// call on this app's actual usage platform (macOS/Chromium): among every
// non-novelty en-US voice available with no extra "Enhanced"/premium voice
// downloaded, "Samantha" is both the clearly best-sounding option AND
// already the OS's own reported default voice — every other en-US voice on
// that list is either an explicit novelty voice (Bad News, Bahh, Bells,
// Boing, Bubbles, Cellos, Good News, Jester, Organ, Superstar, Trinoids,
// Whisper, Wobble, Zarvox) or a dated, more robotic standard voice (Aaron,
// Albert, Fred, Kathy, Nicky, Ralph). Listed explicitly here — rather than
// leaving SpeechSynthesisUtterance.voice unset and hoping whatever the
// device's default happens to be is reasonable — so narration quality
// doesn't depend on chance. The remaining entries are best-effort names for
// non-Apple platforms (Chrome/Windows/Android), not verified the way
// Samantha was; they're just tried in order and skipped gracefully if
// absent, never assumed present.
const PREFERRED_VOICE_NAMES = [
  "Samantha",
  "Google US English",
  "Microsoft Aria Online (Natural) - English (United States)",
];

// getVoices() can legitimately return [] on the very first call — the
// voice list loads asynchronously in the browser and only becomes
// available once the 'voiceschanged' event fires (verified empirically:
// on this platform the immediate call returns nothing until that event).
// Calling getVoices() once and assuming the result is final is the classic
// mistake this works around. The timeout is a fallback for browsers that
// never fire the event at all, so this never hangs forever.
export function getVoicesAsync(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || typeof window.speechSynthesis === "undefined") {
      resolve([]);
      return;
    }
    const existing = window.speechSynthesis.getVoices();
    if (existing.length > 0) {
      resolve(existing);
      return;
    }
    const handleChange = () => resolve(window.speechSynthesis.getVoices());
    window.speechSynthesis.onvoiceschanged = handleChange;
    setTimeout(() => resolve(window.speechSynthesis.getVoices()), 3000);
  });
}

// preferredVoiceURI is the signed-in user's saved choice from Settings
// (family_members.interview_voice_uri) — matched by voiceURI, the Web
// Speech API's own stable identifier, not by display name. Falls through
// to the improved default, then whatever the platform itself marks as
// default, then simply the first available voice, so this always returns
// something usable as long as any voice exists at all.
export function pickPreferredVoice(
  voices: SpeechSynthesisVoice[],
  preferredVoiceURI?: string | null,
): SpeechSynthesisVoice | null {
  if (preferredVoiceURI) {
    const saved = voices.find((v) => v.voiceURI === preferredVoiceURI);
    if (saved) return saved;
  }
  for (const name of PREFERRED_VOICE_NAMES) {
    const match = voices.find((v) => v.name === name);
    if (match) return match;
  }
  return voices.find((v) => v.default) ?? voices[0] ?? null;
}
