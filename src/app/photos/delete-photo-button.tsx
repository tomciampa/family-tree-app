"use client";

import { DeleteWithImpactButton } from "@/components/delete-with-impact-button";
import { deletePhoto, getPhotoDeleteImpact } from "./actions";

// Same shared dialog the documents and interview pipelines already use —
// see delete-with-impact-button.tsx. Deletable by any active family
// member, not just whoever uploaded it (matches deleteDocument/
// deleteInterview, confirmed neither checks uploaded_by).
export function DeletePhotoButton({
  photoId,
  filename,
  onDeleted,
  redirectTo,
}: {
  photoId: string;
  filename: string;
  onDeleted?: () => void;
  // Detail-style pages (e.g. the duplicate-compare view) that aren't the
  // gallery itself: navigate here after a successful delete instead of
  // just relying on the delete action's own revalidatePath. Same
  // redirectTo pattern DeleteDocumentButton/DeleteInterviewButton already
  // use.
  redirectTo?: string;
}) {
  return (
    <DeleteWithImpactButton
      title={`Delete "${filename}"?`}
      fetchImpact={() => getPhotoDeleteImpact(photoId)}
      onConfirmDelete={() => deletePhoto(photoId)}
      onDeleted={onDeleted}
      redirectTo={redirectTo}
    />
  );
}
