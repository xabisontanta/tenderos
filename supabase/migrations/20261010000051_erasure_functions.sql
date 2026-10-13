-- POPIA erasure, part 2: erase_user and erase_organisation.
--
-- Both are SECURITY DEFINER and callable by the service role only. They run inside one transaction,
-- set `app.erasure` for that transaction (which private.reject_mutation honours), de-identify what the
-- audit trail has to keep, delete the rest, and leave one audit row saying an erasure happened. That row
-- holds a pseudonym and counts, never a name, address or user id.
--
-- Files in Storage cannot be deleted from SQL; lib/privacy/erasure.ts removes them first.
-- The runbook is docs/popia-operations.md.

-- Indexes the `on delete set null` actions below need; without them every account deletion scans the table.
create index if not exists audit_logs_actor_idx on public.audit_logs (actor_user_id) where actor_user_id is not null;
create index if not exists agent_events_actor_idx on public.agent_events (actor_user_id) where actor_user_id is not null;
create index if not exists tender_status_history_actor_idx on public.tender_status_history (actor_user_id) where actor_user_id is not null;

-- ---------------------------------------------------------------------------
-- De-identification helpers
-- ---------------------------------------------------------------------------
create or replace function private.redact_text(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(p_text, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[erased]', 'g');
$$;

-- True when any of the terms (an id, an address, a name) appears in the text, ignoring case.
create or replace function private.mentions(p_text text, p_terms text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select exists (select 1 from unnest(p_terms) t where t is not null and t <> '' and position(lower(t) in lower(coalesce(p_text, ''))) > 0);
$$;

-- Walks a jsonb value and replaces what could identify a person: free-text fields people type (comments,
-- reasons, labels, notes), contact and name fields, anything that looks like an email address, the user id
-- and any of p_terms (the person's name and address, wherever agents echoed them into a text). Keys and
-- structure stay, so the record still says what happened.
create or replace function private.scrub_personal_data(p_data jsonb, p_user uuid default null, p_terms text[] default '{}')
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_val jsonb;
  v_out jsonb;
  v_text text;
  v_term text;
begin
  case jsonb_typeof(p_data)
    when 'object' then
      v_out := '{}'::jsonb;
      for v_key, v_val in select * from jsonb_each(p_data) loop
        if v_key = any (array['label', 'comments', 'comment', 'reason', 'note', 'delivery_note', 'owner', 'name', 'full_name',
                              'display_name', 'person', 'phone', 'telephone', 'ip', 'user_agent', 'delivered_by', 'decided_by',
                              'contact', 'username', 'reference'])
           and jsonb_typeof(v_val) <> 'null' then
          v_out := v_out || jsonb_build_object(v_key, '[erased]'::text);
        else
          v_out := v_out || jsonb_build_object(v_key, private.scrub_personal_data(v_val, p_user, p_terms));
        end if;
      end loop;
      return v_out;
    when 'array' then
      return coalesce((select jsonb_agg(private.scrub_personal_data(e, p_user, p_terms)) from jsonb_array_elements(p_data) e), '[]'::jsonb);
    when 'string' then
      v_text := p_data #>> '{}';
      if p_user is not null and v_text = p_user::text then
        return to_jsonb('[erased]'::text);
      end if;
      foreach v_term in array p_terms loop
        if v_term is not null and v_term <> '' then
          -- Escape everything but letters, digits and spaces so the term is matched literally.
          v_text := regexp_replace(v_text, regexp_replace(v_term, '([^[:alnum:] ])', '\\\1', 'g'), '[erased]', 'gi');
        end if;
      end loop;
      return to_jsonb(private.redact_text(v_text));
    else
      return p_data;
  end case;
end;
$$;

-- ---------------------------------------------------------------------------
-- One person. Callers must have set app.erasure already (both public functions do).
-- p_org_rows is false when the whole organisation is being erased: its rows are deleted anyway, so
-- de-identifying them first would be wasted work.
-- ---------------------------------------------------------------------------
create or replace function private.erase_user_data(p_user uuid, p_pseudonym text, p_org_rows boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_name text;
  v_orgs uuid[];
  -- The person's address and name: agents echo them into text (a bid pack's "to be signed by ...").
  v_terms text[];
  v_find text[];
  v_pattern text := '%' || p_user::text || '%';
  v_audit integer;
  v_events integer;
  v_history integer := 0;
  v_mail integer := 0;
begin
  perform set_config('app.erasure', 'on', true);

  select lower(u.email) into v_email from auth.users u where u.id = p_user;
  select p.full_name into v_name from public.profiles p where p.id = p_user;
  select coalesce(array_agg(m.organisation_id), '{}') into v_orgs from public.organisation_members m where m.user_id = p_user;
  v_terms := array_remove(array_remove(array[v_email, v_name], null), '');
  v_find := v_terms || p_user::text;

  -- The trail keeps what happened, not who or what they typed. Rows that merely mention the user (a
  -- delivery note, a pairing owner) are cleaned too.
  update public.audit_logs
     set metadata = private.scrub_personal_data(metadata, p_user, v_terms), ip = null, user_agent = null, actor_user_id = null,
         resource_id = case when resource_id = p_user::text then p_pseudonym else resource_id end
   where actor_user_id = p_user or resource_id = p_user::text or metadata::text like v_pattern;
  get diagnostics v_audit = row_count;

  update public.agent_events
     set payload = private.scrub_personal_data(payload, p_user, v_terms), actor_user_id = null
   where actor_user_id = p_user;
  get diagnostics v_events = row_count;

  if p_org_rows then
    update public.tender_status_history
       set reason = case when reason is null then null else '[erased]' end, actor_user_id = null
     where actor_user_id = p_user;
    get diagnostics v_history = row_count;

    update public.approvals set comments = '[erased]' where decided_by = p_user and comments is not null;
    update public.approvals set payload = private.scrub_personal_data(payload, p_user, v_terms)
     where organisation_id = any (v_orgs) and private.mentions(payload::text, v_find);
    update public.tasks
       set input = private.scrub_personal_data(input, p_user, v_terms), output = private.scrub_personal_data(output, p_user, v_terms)
     where organisation_id = any (v_orgs) and private.mentions(input::text || ' ' || coalesce(output::text, ''), v_find);
    update public.handoffs set payload = private.scrub_personal_data(payload, p_user, v_terms)
     where organisation_id = any (v_orgs) and private.mentions(payload::text, v_find);
    update public.submission_records set receipt = private.scrub_personal_data(receipt, p_user, v_terms)
     where organisation_id = any (v_orgs) and private.mentions(receipt::text, v_find);

    -- The address and name of whoever sent a bid, and the recipient.
    update public.email_messages
       set from_address = '[erased]', to_address = '[erased]', error = private.redact_text(error)
     where sent_by = p_user or email_account_id in (select a.id from public.email_accounts a where a.user_id = p_user);
    get diagnostics v_mail = row_count;

    -- Contact details on the company profile that are this person's.
    update public.company_profiles cp
       set contact_email = case when lower(cp.contact_email) = v_email then null else cp.contact_email end,
           contact_person = case when v_name is not null and lower(cp.contact_person) = lower(v_name) then null else cp.contact_person end,
           contact_phone = case when v_name is not null and lower(cp.contact_person) = lower(v_name) then null else cp.contact_phone end,
           authorised_signatory = case when v_name is not null and lower(cp.authorised_signatory) = lower(v_name) then null else cp.authorised_signatory end
     where cp.organisation_id = any (v_orgs)
       and (lower(cp.contact_email) = v_email
            or (v_name is not null and (lower(cp.contact_person) = lower(v_name) or lower(cp.authorised_signatory) = lower(v_name))));
  end if;

  -- Rows outside the application's own tables that name the person.
  delete from private.rate_limits where key like p_user::text || ':%';
  delete from auth.audit_log_entries
   where (payload ->> 'actor_id') = p_user::text or (payload -> 'traits' ->> 'user_id') = p_user::text;
  update storage.objects set owner = null, owner_id = null where owner = p_user or owner_id = p_user::text;

  -- The account. This cascades to the profile, membership, mailboxes (and their Vault secrets, by trigger),
  -- pairing codes, notifications, consent records and sessions, and clears the remaining references.
  delete from auth.users where id = p_user;

  return jsonb_build_object('audit_rows', v_audit, 'events', v_events, 'status_history_rows', v_history, 'emails_deidentified', v_mail);
end;
$$;
revoke all on function private.erase_user_data(uuid, text, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- erase_user
-- ---------------------------------------------------------------------------
create or replace function public.erase_user(p_user_id uuid, p_reference text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_role public.org_role;
  v_pseudonym text;
  v_counts jsonb;
begin
  if p_user_id is null then
    raise exception 'A user is required' using errcode = 'check_violation';
  end if;
  if p_reference is not null and p_reference !~ '^[A-Za-z0-9._:-]{1,64}$' then
    raise exception 'The reference may only hold letters, digits and . _ : - (no names or addresses)' using errcode = 'check_violation';
  end if;
  perform public.hit_rate_limit_key('erasure:' || p_user_id::text, 'popia.erase', 3, 3600);
  perform pg_advisory_xact_lock(hashtextextended('tenderos.erase:' || p_user_id::text, 0));

  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'User not found' using errcode = 'P0002';
  end if;

  select m.organisation_id, m.role into v_org, v_role from public.organisation_members m where m.user_id = p_user_id;
  if v_org is not null then
    if not exists (select 1 from public.organisation_members m where m.organisation_id = v_org and m.user_id <> p_user_id) then
      raise exception 'Cannot erase the only member of an organisation; erase the organisation instead' using errcode = 'check_violation';
    end if;
    if v_role = 'owner' and not exists (
         select 1 from public.organisation_members m where m.organisation_id = v_org and m.role = 'owner' and m.user_id <> p_user_id) then
      raise exception 'Cannot erase the only owner of an organisation that has other members; make another member an owner or erase the organisation'
        using errcode = 'check_violation';
    end if;
  end if;

  v_pseudonym := 'erased-' || encode(extensions.gen_random_bytes(4), 'hex');
  v_counts := private.erase_user_data(p_user_id, v_pseudonym, true);

  insert into public.audit_logs (organisation_id, actor_type, action, resource_type, resource_id, metadata)
  values (v_org, 'system', 'popia.user_erased', 'user', v_pseudonym, jsonb_build_object('reference', p_reference) || v_counts);

  return jsonb_build_object('erased', 'user', 'pseudonym', v_pseudonym, 'reference', p_reference) || v_counts;
end;
$$;

-- ---------------------------------------------------------------------------
-- erase_organisation
-- ---------------------------------------------------------------------------
create or replace function public.erase_organisation(p_org uuid, p_reference text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_members uuid[];
  v_user uuid;
  v_documents integer;
  v_audit integer;
begin
  if p_org is null then
    raise exception 'An organisation is required' using errcode = 'check_violation';
  end if;
  if p_reference is not null and p_reference !~ '^[A-Za-z0-9._:-]{1,64}$' then
    raise exception 'The reference may only hold letters, digits and . _ : - (no names or addresses)' using errcode = 'check_violation';
  end if;
  perform public.hit_rate_limit_key('erasure:' || p_org::text, 'popia.erase', 3, 3600);
  perform pg_advisory_xact_lock(hashtextextended('tenderos.erase:' || p_org::text, 0));

  if not exists (select 1 from public.organisations o where o.id = p_org) then
    raise exception 'Organisation not found' using errcode = 'P0002';
  end if;
  perform set_config('app.erasure', 'on', true);

  select coalesce(array_agg(m.user_id), '{}') into v_members from public.organisation_members m where m.organisation_id = p_org;
  select count(*) into v_documents from public.company_documents d where d.organisation_id = p_org;

  -- The audit trail stays for its retention period, without names, addresses or what people typed.
  update public.audit_logs
     set metadata = private.scrub_personal_data(metadata), ip = null, user_agent = null, actor_user_id = null
   where organisation_id = p_org and action not like 'popia.%';
  get diagnostics v_audit = row_count;

  -- The people. Each belongs to this organisation only (one organisation per user).
  foreach v_user in array v_members loop
    perform private.erase_user_data(v_user, 'erased-' || encode(extensions.gen_random_bytes(4), 'hex'), false);
  end loop;

  -- Explicit order for the foreign keys that restrict; everything else follows the organisation row.
  delete from public.agent_events where organisation_id = p_org;
  delete from public.tender_status_history where organisation_id = p_org;
  delete from public.agent_status_transitions where organisation_id = p_org;
  delete from public.cost_usage where organisation_id = p_org;
  delete from public.submission_records where organisation_id = p_org;
  delete from public.email_messages where organisation_id = p_org;
  delete from public.approvals where organisation_id = p_org;
  delete from public.handoffs where organisation_id = p_org;
  delete from public.tasks where organisation_id = p_org;
  delete from public.agents where organisation_id = p_org;
  delete from public.departments where organisation_id = p_org;
  delete from public.organisations where id = p_org;

  insert into public.audit_logs (organisation_id, actor_type, action, resource_type, resource_id, metadata)
  values (p_org, 'system', 'popia.organisation_erased', 'organisation', p_org::text,
          jsonb_build_object('reference', p_reference, 'members_erased', coalesce(array_length(v_members, 1), 0),
                             'documents_erased', v_documents, 'audit_rows_deidentified', v_audit));

  return jsonb_build_object('erased', 'organisation', 'organisation_id', p_org, 'reference', p_reference,
                            'members_erased', coalesce(array_length(v_members, 1), 0), 'documents_erased', v_documents);
end;
$$;

revoke all on function private.redact_text(text) from public, anon, authenticated;
revoke all on function private.mentions(text, text[]) from public, anon, authenticated;
revoke all on function private.scrub_personal_data(jsonb, uuid, text[]) from public, anon, authenticated;
revoke execute on function public.erase_user(uuid, text) from public, anon, authenticated;
revoke execute on function public.erase_organisation(uuid, text) from public, anon, authenticated;
grant execute on function public.erase_user(uuid, text) to service_role;
grant execute on function public.erase_organisation(uuid, text) to service_role;
