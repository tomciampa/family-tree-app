import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getFamilyId } from "@/lib/family";
import { exchangeCodeForToken, fetchCurrentUser } from "@/lib/familysearch";

const STATE_COOKIE = "fs_oauth_state";
const STATUS_PATH = "/familysearch";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const returnedState = searchParams.get("state");

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(STATE_COOKIE)?.value;
  cookieStore.delete(STATE_COOKIE);

  if (!code || !returnedState || !expectedState || returnedState !== expectedState) {
    return NextResponse.redirect(`${origin}${STATUS_PATH}?error=state_mismatch`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(`${origin}/login`);
  }

  try {
    const token = await exchangeCodeForToken(code);
    const fsUser = await fetchCurrentUser(token.access_token);
    const familyId = await getFamilyId();

    const { error } = await supabase.from("familysearch_connection").upsert({
      family_id: familyId,
      fs_user_id: fsUser.id,
      fs_display_name: fsUser.displayName,
      access_token: token.access_token,
      token_expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      connected_by: user.id,
      connected_at: new Date().toISOString(),
    });
    if (error) throw error;

    return NextResponse.redirect(`${origin}${STATUS_PATH}?connected=1`);
  } catch (err) {
    console.error("FamilySearch OAuth callback failed:", err);
    return NextResponse.redirect(`${origin}${STATUS_PATH}?error=connection_failed`);
  }
}
