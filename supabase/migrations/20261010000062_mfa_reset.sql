-- The lost-device runbook for authenticator apps (docs/auth.md, "Multi-factor authentication").
--
-- Supabase Auth keeps no recovery codes that TenderOS relies on, so a person who loses every authenticator
-- cannot get past the second step on their own. After support has verified who they are (the runbook says
-- how, and who may approve), a request handler resets them with this function: it removes the person's
-- authenticators and ends every session they have, so a stolen device or session stops working at once; the
-- person then signs in with their password and sets up a new authenticator.
--
-- Service role only, rate limited, and audited with the ticket reference (no names or addresses in it, as for
-- the erasure functions). It touches nothing but the Auth tables for that one person.

create or replace function public.reset_user_mfa(p_user_id uuid, p_reference text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_factors integer;
  v_sessions integer;
begin
  if p_user_id is null then
    raise exception 'A user is required' using errcode = 'check_violation';
  end if;
  if p_reference is null or p_reference !~ '^[A-Za-z0-9._:-]{1,64}$' then
    raise exception 'A ticket reference is required; it may only hold letters, digits and . _ : - (no names or addresses)' using errcode = 'check_violation';
  end if;
  perform public.hit_rate_limit_key('mfa_reset:' || p_user_id::text, 'mfa.reset', 3, 3600);
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
  select m.organisation_id into v_org from public.organisation_members m where m.user_id = p_user_id;

  -- Challenges, and any recovery-code sets Auth may hold for a factor, go with the factor.
  delete from auth.mfa_factors f where f.user_id = p_user_id;
  get diagnostics v_factors = row_count;
  -- Refresh tokens and authentication-method claims go with the session.
  delete from auth.sessions s where s.user_id = p_user_id;
  get diagnostics v_sessions = row_count;

  insert into public.audit_logs (organisation_id, actor_type, action, resource_type, resource_id, metadata)
  values (v_org, 'system', 'mfa.reset', 'user', p_user_id::text,
          jsonb_build_object('reference', p_reference, 'factors_removed', v_factors, 'sessions_ended', v_sessions));
  return jsonb_build_object('factors_removed', v_factors, 'sessions_ended', v_sessions, 'reference', p_reference);
end;
$$;
revoke execute on function public.reset_user_mfa(uuid, text) from public, anon, authenticated;
grant execute on function public.reset_user_mfa(uuid, text) to service_role;
