-- Observed during Stage 1 verification: a single real click through the
-- browser resulted in exactly one successful join (confirmed via
-- family_members.joined_at) but the UI reported "already used" — the
-- action's underlying call ran more than once for that one interaction
-- (confirmed via network logging: only one POST left the browser, so
-- this happens server-side, most likely Next dev's Strict-Mode-driven
-- double invocation of the Server Action, not a client bug). Regardless
-- of the exact cause, a mutation reachable from a UI button should
-- tolerate being invoked more than once for the same real interaction
-- (retries, double-clicks, dev-mode double-invocation) without punishing
-- the user who actually succeeded. Fix: if the code is already used BY
-- THE SAME CALLER, treat it as an idempotent success and report which
-- family they're already in, instead of a hard "used" error — a
-- different caller hitting an already-used code still correctly gets
-- 'used' (this must never let someone reuse another person's spent
-- invite).
create or replace function public.redeem_family_invite(invite_code text)
returns table(status text, family_id uuid, family_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_family_id uuid;
  fam_name text;
  existing record;
begin
  if auth.uid() is null then
    return query select 'not_authenticated'::text, null::uuid, null::text;
    return;
  end if;

  update family_invites
  set used_at = now(), used_by = auth.uid()
  where code = invite_code
    and used_at is null
    and expires_at > now()
  returning family_invites.family_id into claimed_family_id;

  if claimed_family_id is null then
    select fi.family_id, fi.used_by, fi.used_at, fi.expires_at
    into existing
    from family_invites fi
    where fi.code = invite_code;

    if existing.family_id is not null and existing.used_by = auth.uid() then
      select f.name into fam_name from families f where f.id = existing.family_id;
      return query select 'joined'::text, existing.family_id, fam_name;
      return;
    end if;

    if existing.used_at is not null then
      return query select 'used'::text, null::uuid, null::text;
    elsif existing.family_id is not null then
      return query select 'expired'::text, null::uuid, null::text;
    else
      return query select 'not_found'::text, null::uuid, null::text;
    end if;
    return;
  end if;

  select name into fam_name from families where id = claimed_family_id;

  insert into family_members (family_id, user_id, role)
  values (claimed_family_id, auth.uid(), 'member')
  on conflict on constraint family_members_pkey do nothing;

  return query select 'joined'::text, claimed_family_id, fam_name;
end;
$$;
