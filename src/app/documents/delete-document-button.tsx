"use client";

import { DeleteWithImpactButton } from "@/components/delete-with-impact-button";
import { deleteDocument, getDocumentDeleteImpact } from "./actions";

// Shared by the /documents list and the /documents/[id] review page — one
// delete dialog, not two (see DeleteWithImpactButton, also reused by the
// interview pipeline's own delete button).
export function DeleteDocumentButton({
  documentId,
  filename,
  onDeleted,
  redirectTo,
}: {
  documentId: string;
  filename: string | null;
  onDeleted?: () => void;
  redirectTo?: string;
}) {
  return (
    <DeleteWithImpactButton
      title={`Delete "${filename ?? "this document"}"?`}
      fetchImpact={() => getDocumentDeleteImpact(documentId)}
      onConfirmDelete={() => deleteDocument(documentId)}
      onDeleted={onDeleted}
      redirectTo={redirectTo}
    />
  );
}
