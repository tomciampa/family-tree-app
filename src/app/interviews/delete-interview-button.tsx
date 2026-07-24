"use client";

import { DeleteWithImpactButton } from "@/components/delete-with-impact-button";
import { deleteInterview, getInterviewDeleteImpact } from "./actions";

// Shared by the /interviews list and the /interviews/[id] review page —
// same DeleteWithImpactButton dialog the document pipeline's own delete
// button uses, just wired to the interview-specific impact/delete actions
// (which look across every segment under this session, not the session
// row alone — see deleteInterview's own comment for why).
export function DeleteInterviewButton({
  parentDocumentId,
  intervieweeName,
  onDeleted,
  redirectTo,
}: {
  parentDocumentId: string;
  intervieweeName: string;
  onDeleted?: () => void;
  redirectTo?: string;
}) {
  return (
    <DeleteWithImpactButton
      title={`Delete this interview with ${intervieweeName}?`}
      fetchImpact={() => getInterviewDeleteImpact(parentDocumentId)}
      onConfirmDelete={() => deleteInterview(parentDocumentId)}
      onDeleted={onDeleted}
      redirectTo={redirectTo}
    />
  );
}
