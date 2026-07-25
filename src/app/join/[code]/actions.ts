"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type RedeemInviteResult =
  | { error: string }
  | { status: "not_authenticated" }
  | { status: "not_found" | "used" | "expired" }
  | { status: "joined"; familyName: string };

// Thin wrapper around the redeem_family_invite() RPC (see the
// family_invites migration) — all the actual validation, single-use
// enforcement, and family_members insert happens there, atomically, so
// there's no separate check-then-act step here that could race a
// concurrent redemption of the same code.
export async function redeemInvite(code: string): Promise<RedeemInviteResult> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .rpc("redeem_family_invite", { invite_code: code })
    .single();
  if (error) return { error: error.message };

  if (data.status === "joined") {
    revalidatePath("/tree");
    revalidatePath("/settings");
    return { status: "joined", familyName: data.family_name ?? "the family" };
  }

  return { status: data.status as "not_authenticated" | "not_found" | "used" | "expired" };
}
