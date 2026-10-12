-- "Apply with TenderOS": the browser helper reports that it prepared a portal
-- form for an approved bid, so the tender page can show "Prepared by TenderOS
-- at <time>: N fields, M documents".
--
-- The helper never submits anything. This only records, for the member whose
-- pairing code made the request, that the form was filled and how much: a
-- host name and counts, never field values, file names or document ids.
-- File downloads stay audited one by one (autofill_document_download).
--
-- Service role only. The /api/autofill route resolves the pairing code and
-- passes its id; the function re-checks that the code is live, that the
-- member still holds a role that may use the helper, and that the tender has
-- an approved real bid waiting for delivery. It rate-limits per code inside
-- the database (AGENTS.md section 12) and writes an audit log row (compliance
-- trail, owners and admins) and an agent_events row (visible to all members
-- on the tender's audit tab).

create or replace function public.autofill_record_prepared(
  p_token_id uuid,
  p_tender_id uuid,
  p_host text,
  p_fields integer,
  p_documents integer,
  p_left integer,
  p_sensitive boolean,
  p_confirmed_host boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tok record;
  v_title text;
begin
  select t.id, t.organisation_id, t.user_id, m.role
    into v_tok
    from public.autofill_tokens t
    join public.organisation_members m on m.organisation_id = t.organisation_id and m.user_id = t.user_id
   where t.id = p_token_id
     and t.revoked_at is null
     and t.expires_at > now()
     and m.role in ('owner', 'admin', 'operator');
  if v_tok.id is null then
    raise exception 'Pairing code not found' using errcode = 'insufficient_privilege';
  end if;

  if p_host is null or char_length(p_host) > 253 or p_host !~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' then
    raise exception 'Invalid portal host' using errcode = 'check_violation';
  end if;
  if p_fields is null or p_fields not between 0 and 500
     or p_documents is null or p_documents not between 0 and 30
     or p_left is null or p_left not between 0 and 1000
     or p_sensitive is null or p_confirmed_host is null then
    raise exception 'Invalid report' using errcode = 'check_violation';
  end if;
  if p_sensitive and v_tok.role not in ('owner', 'admin') then
    raise exception 'Only owners and admins can attach personal documents' using errcode = 'insufficient_privilege';
  end if;

  -- Only for a tender of this organisation that has an approved real bid waiting for a person to deliver it.
  select td.title into v_title
    from public.tenders td
   where td.id = p_tender_id
     and td.organisation_id = v_tok.organisation_id
     and exists (
       select 1 from public.submission_records s
        where s.tender_id = td.id
          and s.organisation_id = td.organisation_id
          and s.status = 'ACTION_REQUIRED'
          and not s.is_simulation
     );
  if v_title is null then
    raise exception 'This tender has no approved bid waiting for delivery' using errcode = 'check_violation';
  end if;

  perform public.hit_rate_limit_key('autofill_token:' || p_token_id::text, 'autofill.record_prepared', 20, 3600);

  insert into public.audit_logs (organisation_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_tok.organisation_id, 'user', v_tok.user_id, 'autofill.form_prepared', 'tender', p_tender_id::text,
          jsonb_build_object('host', p_host, 'fields', p_fields, 'documents', p_documents, 'left', p_left,
                             'sensitive', p_sensitive, 'confirmed_host', p_confirmed_host,
                             'via', 'browser_helper', 'autofill_token_id', p_token_id));

  insert into public.agent_events (organisation_id, event_type, severity, tender_id, actor_user_id, summary, payload)
  values (v_tok.organisation_id, 'BID_FORM_PREPARED', 'INFO', p_tender_id, v_tok.user_id,
          format('Portal form prepared in the browser helper on %s: %s fields, %s documents, %s left for the person',
                 p_host, p_fields, p_documents, p_left),
          jsonb_build_object('host', p_host, 'fields', p_fields, 'documents', p_documents, 'left', p_left,
                             'sensitive', p_sensitive, 'confirmed_host', p_confirmed_host));
end;
$$;

revoke execute on function public.autofill_record_prepared(uuid, uuid, text, integer, integer, integer, boolean, boolean) from public, anon, authenticated;
grant execute on function public.autofill_record_prepared(uuid, uuid, text, integer, integer, integer, boolean, boolean) to service_role;
