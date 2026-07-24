-- Whether interview prompts should be read aloud at all (see
-- record-interview-flow.tsx). Set via /settings, same pattern as
-- interview_voice_uri. Not null, defaulting to true — narration being
-- always-on is the current behavior, so this column preserves that for
-- every existing row until someone explicitly opts out.
alter table family_members
  add column narration_enabled boolean not null default true;
