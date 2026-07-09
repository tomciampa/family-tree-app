import { createClient } from "@/lib/supabase/server";

export async function getFamilyId() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("families")
    .select("id")
    .limit(1)
    .single();

  if (error || !data) {
    throw new Error("No family configured for this account yet.");
  }

  return data.id;
}
