"use client";

import { useEffect, useState, useTransition } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import type { PersonSummary } from "@/lib/family";
import { PersonSearch } from "@/components/person-search";
import { getVoicesAsync, pickPreferredVoice } from "@/lib/speech-voices";
import { setLinkedPerson, setInterviewVoice, setNarrationEnabled } from "./actions";

type Person = Tables<"people">;

export function SettingsView({
  people,
  personSummaries,
  linkedPersonId,
  interviewVoiceURI,
  narrationEnabled,
}: {
  people: Person[];
  personSummaries: Record<string, PersonSummary>;
  linkedPersonId: string | null;
  interviewVoiceURI: string | null;
  narrationEnabled: boolean;
}) {
  return (
    <>
      <ThisIsMeSettings
        people={people}
        personSummaries={personSummaries}
        linkedPersonId={linkedPersonId}
      />
      <NarrationToggleSettings narrationEnabled={narrationEnabled} />
      <VoiceSettings interviewVoiceURI={interviewVoiceURI} />
    </>
  );
}

// A single boolean toggle auto-saves on change rather than needing an
// explicit Save button — the other two sections below use one since
// they involve picking from a list first, but there's nothing to "pick"
// here beyond flipping the switch itself. Defaults to on (matching the
// narration_enabled column's own default), since always-reading-aloud is
// the existing behavior this preserves for anyone who never visits this
// page. The recording screen itself also has its own override for
// switching this in the moment without coming here first — see
// record-interview-flow.tsx.
function NarrationToggleSettings({ narrationEnabled }: { narrationEnabled: boolean }) {
  const [enabled, setEnabled] = useState(narrationEnabled);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  function handleToggle(next: boolean) {
    setEnabled(next);
    setError(null);
    setSavedMessage(null);
    startTransition(async () => {
      const result = await setNarrationEnabled(next);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSavedMessage(
        next ? "Saved — questions will be read aloud." : "Saved — questions will stay silent.",
      );
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-6 shadow-[var(--shadow-2)]">
      <div>
        <h2 className="text-[length:var(--font-size-heading-3)] leading-[var(--line-height-heading-3)] font-semibold">
          Interview narration
        </h2>
        <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
          Whether interview questions get read aloud during recording. On by default.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => handleToggle(e.target.checked)}
          disabled={isPending}
        />
        🔊 Read questions aloud
      </label>

      {error && <p className="text-sm text-[color:var(--color-error)]">{error}</p>}
      {savedMessage && (
        <p className="text-sm text-[color:var(--color-success-subtle-fg)]">{savedMessage}</p>
      )}
    </section>
  );
}

function ThisIsMeSettings({
  people,
  personSummaries,
  linkedPersonId,
}: {
  people: Person[];
  personSummaries: Record<string, PersonSummary>;
  linkedPersonId: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(linkedPersonId);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const linkedPerson = linkedPersonId
    ? (people.find((p) => p.id === linkedPersonId) ?? null)
    : null;

  function save(personId: string | null) {
    setError(null);
    setSavedMessage(null);
    startTransition(async () => {
      const result = await setLinkedPerson(personId);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSavedMessage(
        personId ? "Saved." : "Cleared — you're not linked to anyone in the tree.",
      );
    });
  }

  function handleNotInTree() {
    setSelectedId(null);
    save(null);
  }

  return (
    <section className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-6 shadow-[var(--shadow-2)]">
      <div>
        <h2 className="text-[length:var(--font-size-heading-3)] leading-[var(--line-height-heading-3)] font-semibold">
          This is me
        </h2>
        <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
          Link your account to your own record in the family tree. This is used to show your
          part of the tree by default when you open it.
        </p>
      </div>

      <p className="text-sm text-[color:var(--color-text-secondary)]">
        {linkedPerson ? (
          <>
            Currently linked to{" "}
            <strong className="text-[color:var(--color-text-primary)]">
              {linkedPerson.name}
            </strong>
            .
          </>
        ) : (
          "You're not linked to anyone in the tree yet."
        )}
      </p>

      <PersonSearch
        people={people}
        personSummaries={personSummaries}
        selectedId={selectedId}
        onSelect={setSelectedId}
        placeholder="Search for your name…"
      />

      {error && <p className="text-sm text-[color:var(--color-error)]">{error}</p>}
      {savedMessage && (
        <p className="text-sm text-[color:var(--color-success-subtle-fg)]">{savedMessage}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => save(selectedId)}
          disabled={isPending || selectedId === linkedPersonId}
          className="rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={handleNotInTree}
          disabled={isPending || (!selectedId && !linkedPersonId)}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-4 py-2 text-sm transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
        >
          I&apos;m not in the tree yet
        </button>
      </div>
    </section>
  );
}

// A plain <select> of voice names means nothing to most people — hearing
// the actual difference before choosing is what matters, hence a
// "▶ Preview" button per row rather than a native dropdown. Filtered to
// English voices only, since that's what interview prompts are actually
// read in — the full getVoices() list can run into the hundreds once every
// language variant is counted (verified: 190 on a real Mac), and showing
// all of them here would bury the handful that are actually relevant.
function VoiceSettings({ interviewVoiceURI }: { interviewVoiceURI: string | null }) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[] | null>(null);
  const [selectedURI, setSelectedURI] = useState<string | null>(interviewVoiceURI);
  const [previewingURI, setPreviewingURI] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getVoicesAsync().then((all) => {
      if (cancelled) return;
      setVoices(all.filter((v) => v.lang.toLowerCase().startsWith("en")));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const defaultVoice = voices ? pickPreferredVoice(voices, null) : null;
  const selectedVoice = voices?.find((v) => v.voiceURI === selectedURI) ?? null;

  function handlePreview(voice: SpeechSynthesisVoice) {
    if (typeof window === "undefined" || typeof window.speechSynthesis === "undefined") return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(
      "Hi, I'm going to be reading your interview questions aloud, just like this.",
    );
    utterance.voice = voice;
    setPreviewingURI(voice.voiceURI);
    const clear = () => setPreviewingURI((current) => (current === voice.voiceURI ? null : current));
    utterance.onend = clear;
    utterance.onerror = clear;
    window.speechSynthesis.speak(utterance);
  }

  function save(voiceURI: string | null) {
    setError(null);
    setSavedMessage(null);
    startTransition(async () => {
      const result = await setInterviewVoice(voiceURI);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSavedMessage(
        voiceURI ? "Saved." : "Cleared — the default voice will be used.",
      );
    });
  }

  function handleUseDefault() {
    setSelectedURI(null);
    save(null);
  }

  return (
    <section className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-6 shadow-[var(--shadow-2)]">
      <div>
        <h2 className="text-[length:var(--font-size-heading-3)] leading-[var(--line-height-heading-3)] font-semibold">
          Narration voice
        </h2>
        <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
          Choose which voice reads interview questions aloud. Preview a voice before picking it —
          a name alone won&apos;t tell you much.
        </p>
      </div>

      <p className="text-sm text-[color:var(--color-text-secondary)]">
        {selectedVoice ? (
          <>
            Currently set to{" "}
            <strong className="text-[color:var(--color-text-primary)]">{selectedVoice.name}</strong>.
          </>
        ) : selectedURI ? (
          "Currently set to a voice that isn't available on this device — the default will be used here instead."
        ) : (
          <>
            No preference set — using the default voice
            {defaultVoice ? (
              <>
                : <strong className="text-[color:var(--color-text-primary)]">{defaultVoice.name}</strong>
              </>
            ) : (
              ""
            )}
            .
          </>
        )}
      </p>

      {voices === null ? (
        <p className="text-sm text-[color:var(--color-text-secondary)]">Loading available voices…</p>
      ) : voices.length === 0 ? (
        <p className="text-sm text-[color:var(--color-text-secondary)]">
          No voices available in this browser — narration will fall back to on-screen text only.
        </p>
      ) : (
        <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-[var(--radius-sm)] border border-[color:var(--color-border)] p-2">
          {voices.map((voice) => (
            <div
              key={voice.voiceURI}
              className="flex items-center justify-between gap-2 rounded-[var(--radius-xs)] px-2 py-1.5 text-sm hover:bg-[color:var(--color-bg-surface-hover)]"
            >
              <label className="flex flex-1 items-center gap-2">
                <input
                  type="radio"
                  name="interview-voice"
                  checked={selectedURI === voice.voiceURI}
                  onChange={() => setSelectedURI(voice.voiceURI)}
                />
                <span>{voice.name}</span>
                <span className="text-xs text-[color:var(--color-text-tertiary)]">{voice.lang}</span>
                {voice.default && (
                  <span className="text-xs text-[color:var(--color-text-tertiary)]">
                    (device default)
                  </span>
                )}
              </label>
              <button
                type="button"
                onClick={() => handlePreview(voice)}
                disabled={previewingURI === voice.voiceURI}
                className="shrink-0 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-xs transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
              >
                {previewingURI === voice.voiceURI ? "▶ Playing…" : "▶ Preview"}
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-sm text-[color:var(--color-error)]">{error}</p>}
      {savedMessage && (
        <p className="text-sm text-[color:var(--color-success-subtle-fg)]">{savedMessage}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => save(selectedURI)}
          disabled={isPending || selectedURI === interviewVoiceURI}
          className="rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={handleUseDefault}
          disabled={isPending || (!selectedURI && !interviewVoiceURI)}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-4 py-2 text-sm transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
        >
          Use default instead
        </button>
      </div>
    </section>
  );
}
