-- Which speechSynthesis voice this logged-in user prefers for interview
-- narration (see record-interview-flow.tsx), set via /settings. Stores the
-- Web Speech API's own voiceURI — the spec-defined stable identifier for a
-- SpeechSynthesisVoice — rather than the display name, since that's what
-- getVoices() results are actually matched against. Nullable, same pattern
-- as linked_person_id: unset (never opened Settings, or a saved voiceURI
-- that doesn't exist on this particular device/browser) must fall back to
-- the app's own improved default rather than breaking anything.
alter table family_members
  add column interview_voice_uri text;
