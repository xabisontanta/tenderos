-- Guided onboarding: keywords on the company profile, a record of when a company
-- finished (or skipped) the setup wizard, and automatic workflows off for new
-- organisations.

-- Keywords the company wants tenders matched on. Free text, at most 50, 2 to 60 characters
-- each, no surrounding spaces and no control characters. The wizard and the company page
-- validate the same rule (features/company/schema.ts); this is the backstop for direct writes.
create or replace function private.valid_keywords(p text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(cardinality(p), 0) <= 50
     and not exists (
       select 1 from unnest(p) k
        where k is null or char_length(k) not between 2 and 60 or k <> btrim(k) or k ~ '[[:cntrl:]]');
$$;

alter table public.company_profiles
  add column keywords text[] not null default '{}' check (private.valid_keywords(keywords));

alter table public.system_settings
  add column onboarding_completed_at timestamptz;

-- A new organisation does not start workflows on tenders the scout finds until someone
-- turns that on (Discover, or the wizard's province step which saves it off explicitly).
-- Before this, skipping the wizard and picking provinces later left it on by default.
-- Existing organisations keep the value they have.
alter table public.system_settings alter column auto_run_workflows set default false;

-- Marks the setup wizard as finished or skipped. Owners and admins only; the first call
-- stamps the time and later calls change nothing. Columns on system_settings are not
-- writable by browsers, so this is the only way in.
create or replace function public.complete_onboarding(p_org uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.hit_rate_limit('onboarding.complete', 20, 3600);
  if not private.has_org_role(p_org, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Only owners and admins can finish setting up the organisation' using errcode = 'insufficient_privilege';
  end if;
  update public.system_settings
     set onboarding_completed_at = now(), updated_by = auth.uid()
   where organisation_id = p_org and onboarding_completed_at is null;
  if found then
    perform private.write_audit(p_org, 'onboarding.completed', 'system_settings', p_org::text);
  end if;
end;
$$;
revoke execute on function public.complete_onboarding(uuid) from public, anon;
grant execute on function public.complete_onboarding(uuid) to authenticated;
