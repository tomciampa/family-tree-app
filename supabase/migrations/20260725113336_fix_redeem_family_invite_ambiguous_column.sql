-- redeem_family_invite's own RETURNS TABLE declares an OUT parameter
-- named family_id, which shadows the real family_members.family_id
-- column for any BARE reference within the function body. Every other
-- statement either used the plpgsql variable directly or table-qualified
-- the column, but `on conflict (family_id, user_id)` can't be
-- table-qualified — that clause only accepts bare column names — so it
-- hit real "column reference family_id is ambiguous" errors the first
-- time this path actually ran (caught during Stage 1 verification, an
-- existing user joining a second family). Fixed by referring to the
-- unique constraint by name instead, which needs no column list at all.
create or replace function public.redeem_family_invite(invite_code text)
returns table(status text, family_id uuid, family_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_family_id uuid;
  fam_name text;
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
    if exists (select 1 from family_invites where code = invite_code and used_at is not null) then
      return query select 'used'::text, null::uuid, null::text;
    elsif exists (select 1 from family_invites where code = invite_code) then
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
