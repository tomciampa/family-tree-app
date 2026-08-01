import type { createClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

export type GettingStartedItem = {
  id: string;
  label: string;
  href: string;
  done: boolean;
};

// Per-user, per-active-family "Getting Started" checklist for the
// homepage. Every item is computed fresh from existing rows — no new
// tracking table — except two pieces that genuinely didn't exist before
// this feature (see the migration this shipped with,
// 20260802130000_getting_started_tracking.sql, and the uploaded_by fixes
// in documents/actions.ts and interviews/actions.ts):
//   - family_members.has_viewed_tree (no view/analytics tracking existed
//     at all before this; deliberately just a boolean, not real
//     analytics — set once by tree/page.tsx the first time this user's
//     session loads /tree for their active family)
//   - photo_tags.tagged_by (photo_tags had no attribution column)
// documents.uploaded_by existed as a column but was never actually
// populated by uploadDocument or createInterviewSession — fixed
// alongside this feature, going forward only. Pre-existing rows from
// before that fix have uploaded_by = null and simply never count toward
// anyone's checklist, same as pre-existing photo_tags rows with no
// tagged_by — there's no reliable way to attribute them retroactively,
// so none is guessed.
export async function getGettingStartedChecklist(
  supabase: SupabaseClient,
  userId: string,
  familyId: string,
): Promise<GettingStartedItem[]> {
  const [
    { data: membership },
    { data: interviewSessions },
    { data: uploadedDocuments },
    { data: uploadedPhotos },
    { data: taggedPhotos },
    { data: redeemedInvites },
  ] = await Promise.all([
    supabase
      .from("family_members")
      .select("has_viewed_tree")
      .eq("family_id", familyId)
      .eq("user_id", userId)
      .maybeSingle(),
    // Top-level interview session rows (not segments) this user
    // conducted. "Completed" is judged the same way interviews-view.tsx
    // already treats a session as having real content — at least one
    // recorded segment, not just a created-then-abandoned session — via
    // the segment lookup below.
    supabase
      .from("documents")
      .select("id")
      .eq("uploaded_by", userId)
      .eq("family_id", familyId)
      .not("interviewee_person_id", "is", null)
      .is("parent_document_id", null),
    // Excludes interview sessions/segments, which also live in
    // `documents` — same filter convention as getPendingReview.
    supabase
      .from("documents")
      .select("id")
      .eq("uploaded_by", userId)
      .eq("family_id", familyId)
      .is("interviewee_person_id", null)
      .is("parent_document_id", null)
      .limit(1),
    supabase
      .from("photos")
      .select("id")
      .eq("uploaded_by", userId)
      .eq("family_id", familyId)
      .limit(1),
    // photo_tags has no family_id column of its own — same-family scope
    // here comes from RLS alone (the join back to photos), matching how
    // addPhotoTag already trusts RLS as the real enforcement boundary
    // for this table.
    supabase.from("photo_tags").select("id").eq("tagged_by", userId).limit(1),
    // family_invites uses the broader is_family_member RLS (not
    // active-only), so unlike the tables above this needs an explicit
    // family_id filter to stay scoped to the active family.
    supabase
      .from("family_invites")
      .select("id")
      .eq("created_by", userId)
      .eq("family_id", familyId)
      .not("used_at", "is", null)
      .limit(1),
  ]);

  let recordedMemory = false;
  const sessionIds = (interviewSessions ?? []).map((s) => s.id);
  if (sessionIds.length > 0) {
    const { data: segments } = await supabase
      .from("documents")
      .select("id")
      .in("parent_document_id", sessionIds)
      .limit(1);
    recordedMemory = (segments ?? []).length > 0;
  }

  return [
    {
      id: "viewed-tree",
      label: "Viewed the Family Tree",
      href: "/tree",
      done: membership?.has_viewed_tree ?? false,
    },
    {
      id: "recorded-memory",
      label: "Recorded a Memory",
      href: "/interviews",
      done: recordedMemory,
    },
    {
      id: "uploaded-document",
      label: "Uploaded a Document",
      href: "/documents",
      done: (uploadedDocuments ?? []).length > 0,
    },
    {
      id: "uploaded-photo",
      label: "Uploaded a Photo",
      href: "/photos",
      done: (uploadedPhotos ?? []).length > 0,
    },
    {
      id: "tagged-photo",
      label: "Tagged a Photo",
      href: "/photos",
      done: (taggedPhotos ?? []).length > 0,
    },
    {
      id: "invited-member",
      label: "Invited a Family Member",
      href: "/settings",
      done: (redeemedInvites ?? []).length > 0,
    },
  ];
}
