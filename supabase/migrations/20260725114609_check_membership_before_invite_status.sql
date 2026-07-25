-- True root cause of the "used" error flashing after a real, successful
-- join (see the two preceding migrations — the idempotency fix on
-- redeem_family_invite was real defensive hardening but not actually the
-- cause): Next.js refreshes the invoking page's server component tree
-- after a Server Action completes. /join/[code]/page.tsx calls
-- get_invite_preview on every render, and that function checked
-- used_at/expires_at BEFORE checking whether the caller is already a
-- member — so the instant redeem_family_invite legitimately marked the
-- code used and inserted the caller's family_members row, the page's own
-- post-action refresh re-ran get_invite_preview, saw used_at set, and
-- rendered the "already used" error over top of the real success,
-- discarding it. Reordering so membership is checked first means a user
-- who is now (for any reason, including having just used this exact
-- code) a member of the target family always sees "already_member"
-- rather than a used/expired status that no longer reflects their own
-- reality.
create or replace function public.get_invite_preview(invite_code text)
returns table(status text, family_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  inv record;
begin
  select fi.family_id, fi.used_at, fi.expires_at, f.name as family_name
  into inv
  from family_invites fi
  join families f on f.id = fi.family_id
  where fi.code = invite_code;

  if not found then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  if auth.uid() is not null and exists (
    select 1 from family_members fm
    where fm.family_id = inv.family_id and fm.user_id = auth.uid()
  ) then
    return query select 'already_member'::text, inv.family_name;
    return;
  end if;

  if inv.used_at is not null then
    return query select 'used'::text, inv.family_name;
    return;
  end if;

  if inv.expires_at < now() then
    return query select 'expired'::text, inv.family_name;
    return;
  end if;

  return query select 'valid'::text, inv.family_name;
end;
$$;
