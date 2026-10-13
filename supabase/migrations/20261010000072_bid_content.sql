-- Bid content a person reviews and enters: the proposal sections and the pricing schedule.
--
-- The Proposal Writer and the Pricing Analyst seed these tables when they finish (the worker, TypeScript); from then on a
-- person's text and figures are the bid. QA and the Submission Officer read the content from here (the engine overlays it on
-- the step outputs), so what they check, and what the approval's package hash covers, is what the person wrote.
--
--   * bid_proposal_sections   one row per outline section: text, status (DRAFT, MISSING_INFORMATION, REVIEWED), whether the
--                             current text is the AI's, the facts and requirements it cites, who edited it and who reviewed it.
--   * bid_pricing             one row per tender: VAT treatment, notes, and who confirmed the schedule.
--   * bid_pricing_lines       the schedule lines. Quantity and description come from the tender (a bidder cannot change a
--                             printed quantity); unit price and supplier quote reference are entered by a person, in whole
--                             cents. Line amount and VAT are generated columns: integer cents, rounded half up, VAT at 15
--                             percent. A figure is never produced by AI (AGENTS.md section 13).
--   * bid_content_history     every version of every section and line, with who and when.
--
--   Writes from a browser go through the functions below only: owners, admins and operators; rate limited; audited; behind the
--   second factor when the organisation requires one; with a version check so two people cannot overwrite each other. Editing a
--   bid that is waiting for approval withdraws the approval and sends the bid back to PREPARING_BID (as changing the delivery
--   details does), so the person prepares it again, QA runs on the new content and the approver sees it afresh. A bid that has
--   been approved or closed cannot be edited. The worker seeds and reads with the service role.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.bid_proposal_sections (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  tender_id uuid not null,
  section_key text not null check (section_key ~ '^[a-z][a-z0-9_]{0,59}$'),
  title text not null check (char_length(title) between 1 and 200),
  position integer not null default 0,
  version integer not null default 1 check (version >= 1),
  content text check (content is null or char_length(content) between 1 and 20000),
  status text not null check (status in ('DRAFT', 'MISSING_INFORMATION', 'REVIEWED')),
  -- The current text is the AI's and no person has changed it.
  ai_generated boolean not null default false,
  needs jsonb not null default '[]'::jsonb check (jsonb_typeof(needs) = 'array'),
  fact_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(fact_ids) = 'array'),
  requirement_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(requirement_ids) = 'array'),
  warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  source_task_id uuid references public.tasks (id) on delete set null,
  edited_by uuid references auth.users (id) on delete set null,
  edited_at timestamptz,
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organisation_id, tender_id) references public.tenders (organisation_id, id) on delete cascade,
  unique (tender_id, section_key),
  check ((status = 'MISSING_INFORMATION') = (content is null)),
  check ((status = 'REVIEWED') = (reviewed_at is not null))
);
create trigger bid_proposal_sections_updated_at before update on public.bid_proposal_sections
  for each row execute function private.set_updated_at();

create table public.bid_pricing (
  tender_id uuid primary key,
  organisation_id uuid not null,
  vat_treatment text not null default 'NOT_STATED' check (vat_treatment in ('EXCLUSIVE', 'INCLUSIVE', 'NOT_STATED')),
  vat_status text not null default 'REQUIRES_CONFIRMATION' check (vat_status in ('STATED', 'REQUIRES_CONFIRMATION')),
  vat_requirement_id text check (vat_requirement_id is null or char_length(vat_requirement_id) <= 80),
  notes jsonb not null default '[]'::jsonb check (jsonb_typeof(notes) = 'array'),
  ai_generated boolean not null default false,
  source_task_id uuid references public.tasks (id) on delete set null,
  confirmed_by uuid references auth.users (id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organisation_id, tender_id) references public.tenders (organisation_id, id) on delete cascade
);
create trigger bid_pricing_updated_at before update on public.bid_pricing
  for each row execute function private.set_updated_at();

create table public.bid_pricing_lines (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  tender_id uuid not null,
  position integer not null default 0,
  version integer not null default 1 check (version >= 1),
  -- TENDER: a line the analysis found in the price schedule. PERSON: a line a person added.
  source text not null check (source in ('TENDER', 'PERSON')),
  description text not null check (char_length(description) between 1 and 300),
  item_ref text check (item_ref is null or char_length(item_ref) <= 40),
  quantity numeric(14, 3) check (quantity is null or (quantity > 0 and quantity <= 1000000)),
  -- The quantity is the tender's printed one, which a bidder cannot change.
  quantity_printed boolean not null default false,
  unit text check (unit is null or char_length(unit) <= 40),
  unit_price_cents bigint check (unit_price_cents is null or (unit_price_cents >= 0 and unit_price_cents <= 1000000000000)),
  supplier_quote_ref text check (supplier_quote_ref is null or char_length(supplier_quote_ref) <= 120),
  supplier_quote_likely boolean not null default false,
  requirement_id text check (requirement_id is null or char_length(requirement_id) <= 80),
  quote text check (quote is null or char_length(quote) <= 500),
  page integer check (page is null or page >= 0),
  warning text check (warning is null or char_length(warning) <= 500),
  -- Integer cents, rounded half up. VAT is worked out per line at 15 percent; lib/domain/bid-money.ts does the same sums.
  amount_cents bigint generated always as (
    case when unit_price_cents is not null and quantity is not null then round(quantity * unit_price_cents)::bigint end
  ) stored check (amount_cents is null or amount_cents <= 1000000000000),
  vat_cents bigint generated always as (
    case when unit_price_cents is not null and quantity is not null then round(round(quantity * unit_price_cents) * 15 / 100)::bigint end
  ) stored,
  source_task_id uuid references public.tasks (id) on delete set null,
  edited_by uuid references auth.users (id) on delete set null,
  edited_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organisation_id, tender_id) references public.tenders (organisation_id, id) on delete cascade
);
create unique index bid_pricing_lines_requirement_uq on public.bid_pricing_lines (tender_id, requirement_id) where requirement_id is not null;
create index bid_pricing_lines_tender_idx on public.bid_pricing_lines (tender_id, position);
create trigger bid_pricing_lines_updated_at before update on public.bid_pricing_lines
  for each row execute function private.set_updated_at();

create table public.bid_content_history (
  id bigint generated always as identity primary key,
  organisation_id uuid not null,
  tender_id uuid not null,
  kind text not null check (kind in ('PROPOSAL_SECTION', 'PRICING_LINE', 'PRICING')),
  -- The section key, the line id, or 'pricing'.
  ref text not null check (char_length(ref) <= 80),
  version integer not null,
  change text not null check (change ~ '^[A-Z_]{3,40}$'),
  snapshot jsonb not null,
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now(),
  foreign key (organisation_id, tender_id) references public.tenders (organisation_id, id) on delete cascade
);
create index bid_content_history_tender_idx on public.bid_content_history (tender_id, kind, ref, id);

alter table public.bid_proposal_sections enable row level security;
alter table public.bid_pricing enable row level security;
alter table public.bid_pricing_lines enable row level security;
alter table public.bid_content_history enable row level security;
create policy "members read bid sections" on public.bid_proposal_sections for select to authenticated using (private.is_org_member(organisation_id));
create policy "members read bid pricing" on public.bid_pricing for select to authenticated using (private.is_org_member(organisation_id));
create policy "members read bid pricing lines" on public.bid_pricing_lines for select to authenticated using (private.is_org_member(organisation_id));
create policy "members read bid history" on public.bid_content_history for select to authenticated using (private.is_org_member(organisation_id));
revoke all on public.bid_proposal_sections, public.bid_pricing, public.bid_pricing_lines, public.bid_content_history from anon;
revoke insert, update, delete, truncate on public.bid_proposal_sections, public.bid_pricing, public.bid_pricing_lines, public.bid_content_history from authenticated;

-- ---------------------------------------------------------------------------
-- Bid totals, summed by the database
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER: row level security applies, so a caller only ever sums their own organisation's lines.
create or replace function public.bid_pricing_totals(p_tender_id uuid)
returns table (lines integer, priced integer, subtotal_cents bigint, vat_cents bigint, total_cents bigint, complete boolean)
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*)::integer,
         count(l.amount_cents)::integer,
         coalesce(sum(l.amount_cents), 0)::bigint,
         coalesce(sum(l.vat_cents), 0)::bigint,
         (coalesce(sum(l.amount_cents), 0) + coalesce(sum(l.vat_cents), 0))::bigint,
         count(*) > 0 and count(l.amount_cents) = count(*)
    from public.bid_pricing_lines l
   where l.tender_id = p_tender_id;
$$;
revoke execute on function public.bid_pricing_totals(uuid) from public, anon;
grant execute on function public.bid_pricing_totals(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The gate every edit passes: which bids can be edited, and what editing one waiting for approval does
-- ---------------------------------------------------------------------------
-- Callers have already checked the person's role and the second factor, and hold the tender row locked.
--   PREPARING_BID, PRICING, QUALITY_ASSURANCE, QA_FAILED, COMPLIANCE_REVIEW, MISSING_INFORMATION: editable.
--   READY_FOR_APPROVAL: editable, and the approval is withdrawn and the bid sent back to PREPARING_BID.
--   Anything else (approved, being delivered, delivered, closed): refused. lib/domain/bid-content.ts mirrors this.
create or replace function private.prepare_bid_edit(p_tender uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.tenders;
  v_run record;
  v_cancelled integer := 0;
begin
  select * into v_t from public.tenders where id = p_tender;
  if v_t.id is null then
    raise exception 'Tender not found' using errcode = 'insufficient_privilege';
  end if;
  if v_t.is_simulation then
    raise exception 'A simulated tender has no bid content to edit' using errcode = 'check_violation';
  end if;
  if v_t.status not in ('PREPARING_BID', 'PRICING', 'QUALITY_ASSURANCE', 'QA_FAILED', 'COMPLIANCE_REVIEW', 'MISSING_INFORMATION', 'READY_FOR_APPROVAL') then
    raise exception 'This bid has been approved or closed, so its content can no longer be edited' using errcode = 'check_violation';
  end if;
  if v_t.status <> 'READY_FOR_APPROVAL' then
    return;
  end if;

  -- Withdraw: the approval was for content that is about to change.
  update public.approvals set status = 'CANCELLED', comments = 'Withdrawn because the bid content was edited'
   where tender_id = v_t.id and status = 'PENDING';
  get diagnostics v_cancelled = row_count;
  for v_run in select r.id from public.workflow_runs r where r.tender_id = v_t.id and r.status in ('PENDING', 'RUNNING', 'WAITING_APPROVAL', 'BLOCKED') loop
    update public.workflow_runs set status = 'CANCELLED', outcome = 'BID_EDITED', error = 'The bid content was edited', completed_at = now() where id = v_run.id;
    update public.tasks set status = 'CANCELLED', blocked_reason = 'The bid content was edited'
     where workflow_run_id = v_run.id and status in ('QUEUED', 'WAITING', 'BLOCKED', 'NEEDS_APPROVAL', 'FAILED');
    update public.handoffs set status = 'CANCELLED' where workflow_run_id = v_run.id and status = 'PENDING';
    perform private.enqueue_job(v_t.organisation_id, 'agents.refresh', jsonb_build_object('workflow_run_id', v_run.id));
  end loop;
  perform set_config('app.transition_reason', 'Bid content edited: the approval was withdrawn', true);
  update public.tenders set status = 'PREPARING_BID' where id = v_t.id;
  perform private.write_audit(v_t.organisation_id, 'bid.approval_withdrawn', 'tender', v_t.id::text, jsonb_build_object('approvals_cancelled', v_cancelled));
  perform private.emit_event(v_t.organisation_id, 'BID_CONTENT_EDITED',
    format('"%s" was edited while waiting for approval: the approval was withdrawn and the bid sent back for preparation', left(v_t.title, 200)),
    jsonb_build_object('approvals_cancelled', v_cancelled), 'WARNING', null, v_t.id);
  perform private.notify_members(v_t.organisation_id, 'BID_CONTENT_EDITED', 'WARNING', 'Approval withdrawn',
    format('"%s" was edited while it waited for approval. Prepare the bid again for a fresh review and approval.', left(v_t.title, 200)),
    '/tenders/' || v_t.id::text);
end;
$$;
revoke all on function private.prepare_bid_edit(uuid) from public, anon, authenticated;
grant execute on function private.prepare_bid_edit(uuid) to service_role;

create or replace function private.bid_history(
  p_org uuid, p_tender uuid, p_kind text, p_ref text, p_version integer, p_change text, p_snapshot jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.bid_content_history (organisation_id, tender_id, kind, ref, version, change, snapshot, changed_by)
  values (p_org, p_tender, p_kind, p_ref, p_version, p_change, p_snapshot, auth.uid());
$$;
revoke all on function private.bid_history(uuid, uuid, text, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function private.bid_history(uuid, uuid, text, text, integer, text, jsonb) to service_role;

-- Clears a confirmation when a figure changes: the schedule a person confirmed is not the schedule that now stands.
create or replace function private.unconfirm_pricing(p_org uuid, p_tender uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_was timestamptz;
begin
  select confirmed_at into v_was from public.bid_pricing where tender_id = p_tender for update;
  if v_was is null then
    return;
  end if;
  update public.bid_pricing set confirmed_by = null, confirmed_at = null where tender_id = p_tender;
  perform private.bid_history(p_org, p_tender, 'PRICING', 'pricing', 0, 'UNCONFIRMED', jsonb_build_object('confirmed', false, 'reason', 'a figure changed'));
end;
$$;
revoke all on function private.unconfirm_pricing(uuid, uuid) from public, anon, authenticated;
grant execute on function private.unconfirm_pricing(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Proposal sections
-- ---------------------------------------------------------------------------
create or replace function public.save_proposal_section(p_tender_id uuid, p_key text, p_content text, p_expected_version integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.tenders;
  v_s public.bid_proposal_sections;
  v_content text;
  v_status text;
  v_version integer;
begin
  perform public.hit_rate_limit('bid.edit', 300, 3600);
  select * into v_t from public.tenders where id = p_tender_id for update;
  if v_t.id is null or not private.has_org_role(v_t.organisation_id, array['owner', 'admin', 'operator']::public.org_role[]) then
    raise exception 'Not permitted' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(v_t.organisation_id);
  select * into v_s from public.bid_proposal_sections where tender_id = p_tender_id and section_key = p_key for update;
  if v_s.id is null then
    raise exception 'That section does not exist' using errcode = 'check_violation';
  end if;
  if v_s.version is distinct from p_expected_version then
    raise exception 'This section was changed by someone else. Reload the page to see their version.';
  end if;
  -- Surrounding white space goes (trim() alone leaves line breaks); control characters other than tab and line breaks go.
  v_content := nullif(btrim(regexp_replace(coalesce(p_content, ''), '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]', '', 'g'), E' \t\r\n'), '');
  if char_length(v_content) > 20000 then
    raise exception 'A section can hold 20 000 characters at most' using errcode = 'check_violation';
  end if;
  if v_content is not distinct from v_s.content then
    return v_s.version;
  end if;
  perform private.prepare_bid_edit(p_tender_id);

  v_status := case when v_content is null then 'MISSING_INFORMATION' else 'DRAFT' end;
  update public.bid_proposal_sections
     set content = v_content, status = v_status, ai_generated = false, version = version + 1,
         edited_by = auth.uid(), edited_at = now(), reviewed_by = null, reviewed_at = null
   where id = v_s.id
  returning version into v_version;
  perform private.bid_history(v_t.organisation_id, p_tender_id, 'PROPOSAL_SECTION', p_key, v_version, 'EDITED',
    jsonb_build_object('content', v_content, 'status', v_status, 'ai_generated', false));
  perform private.write_audit(v_t.organisation_id, 'bid.section_edited', 'tender', p_tender_id::text,
    jsonb_build_object('section', p_key, 'version', v_version, 'characters', coalesce(char_length(v_content), 0), 'was_ai_text', v_s.ai_generated));
  return v_version;
end;
$$;
revoke execute on function public.save_proposal_section(uuid, text, text, integer) from public, anon;
grant execute on function public.save_proposal_section(uuid, text, text, integer) to authenticated;

create or replace function public.set_proposal_section_review(p_tender_id uuid, p_key text, p_reviewed boolean, p_expected_version integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.tenders;
  v_s public.bid_proposal_sections;
  v_version integer;
begin
  perform public.hit_rate_limit('bid.edit', 300, 3600);
  select * into v_t from public.tenders where id = p_tender_id for update;
  if v_t.id is null or not private.has_org_role(v_t.organisation_id, array['owner', 'admin', 'operator']::public.org_role[]) then
    raise exception 'Not permitted' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(v_t.organisation_id);
  if p_reviewed is null then
    raise exception 'Choose reviewed or not reviewed' using errcode = 'check_violation';
  end if;
  select * into v_s from public.bid_proposal_sections where tender_id = p_tender_id and section_key = p_key for update;
  if v_s.id is null then
    raise exception 'That section does not exist' using errcode = 'check_violation';
  end if;
  if v_s.version is distinct from p_expected_version then
    raise exception 'This section was changed by someone else. Reload the page to see their version.';
  end if;
  if p_reviewed and v_s.status = 'REVIEWED' then
    raise exception 'This section has already been reviewed' using errcode = 'check_violation';
  end if;
  if p_reviewed and (v_s.status <> 'DRAFT' or v_s.content is null) then
    raise exception 'A section needs text before it can be reviewed' using errcode = 'check_violation';
  end if;
  if not p_reviewed and v_s.status <> 'REVIEWED' then
    raise exception 'This section has not been reviewed' using errcode = 'check_violation';
  end if;
  perform private.prepare_bid_edit(p_tender_id);

  update public.bid_proposal_sections
     set status = case when p_reviewed then 'REVIEWED' else 'DRAFT' end, version = version + 1,
         reviewed_by = case when p_reviewed then auth.uid() end, reviewed_at = case when p_reviewed then now() end
   where id = v_s.id
  returning version into v_version;
  perform private.bid_history(v_t.organisation_id, p_tender_id, 'PROPOSAL_SECTION', p_key, v_version, case when p_reviewed then 'REVIEWED' else 'UNREVIEWED' end,
    jsonb_build_object('content', v_s.content, 'status', case when p_reviewed then 'REVIEWED' else 'DRAFT' end, 'ai_generated', v_s.ai_generated));
  perform private.write_audit(v_t.organisation_id, case when p_reviewed then 'bid.section_reviewed' else 'bid.section_unreviewed' end, 'tender', p_tender_id::text,
    jsonb_build_object('section', p_key, 'version', v_version, 'ai_text', v_s.ai_generated));
  return v_version;
end;
$$;
revoke execute on function public.set_proposal_section_review(uuid, text, boolean, integer) from public, anon;
grant execute on function public.set_proposal_section_review(uuid, text, boolean, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Pricing
-- ---------------------------------------------------------------------------
create or replace function public.save_pricing_line(
  p_line_id uuid, p_unit_price_cents bigint, p_quantity numeric, p_supplier_ref text, p_expected_version integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.tenders;
  v_l public.bid_pricing_lines;
  v_ref text;
  v_qty numeric(14, 3);
  v_version integer;
  v_after public.bid_pricing_lines;
begin
  perform public.hit_rate_limit('bid.edit', 300, 3600);
  select l.* into v_l from public.bid_pricing_lines l where l.id = p_line_id;
  if v_l.id is null then
    raise exception 'That line does not exist' using errcode = 'check_violation';
  end if;
  select * into v_t from public.tenders where id = v_l.tender_id for update;
  if v_t.id is null or not private.has_org_role(v_t.organisation_id, array['owner', 'admin', 'operator']::public.org_role[]) then
    raise exception 'Not permitted' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(v_t.organisation_id);
  select * into v_l from public.bid_pricing_lines where id = p_line_id for update;
  if v_l.version is distinct from p_expected_version then
    raise exception 'This line was changed by someone else. Reload the page to see their version.';
  end if;
  if p_unit_price_cents is not null and (p_unit_price_cents < 0 or p_unit_price_cents > 1000000000000) then
    raise exception 'A unit price must be between R0 and R10 000 000 000' using errcode = 'check_violation';
  end if;
  if v_l.quantity_printed then
    if p_quantity is distinct from v_l.quantity then
      raise exception 'The quantity is printed in the tender and cannot be changed' using errcode = 'check_violation';
    end if;
    v_qty := v_l.quantity;
  else
    if p_quantity is not null and (p_quantity <= 0 or p_quantity > 1000000 or p_quantity <> round(p_quantity, 3)) then
      raise exception 'A quantity must be more than zero, up to 1 000 000, with at most three decimals' using errcode = 'check_violation';
    end if;
    v_qty := p_quantity;
  end if;
  v_ref := nullif(trim(regexp_replace(coalesce(p_supplier_ref, ''), '[\x01-\x1f\x7f]', '', 'g')), '');
  if char_length(v_ref) > 120 then
    raise exception 'A supplier quote reference can be 120 characters at most' using errcode = 'check_violation';
  end if;
  if p_unit_price_cents is not null and v_qty is not null and round(v_qty * p_unit_price_cents) > 1000000000000 then
    raise exception 'That line amount is too large' using errcode = 'check_violation';
  end if;
  if p_unit_price_cents is not distinct from v_l.unit_price_cents and v_qty is not distinct from v_l.quantity and v_ref is not distinct from v_l.supplier_quote_ref then
    return v_l.version;
  end if;
  perform private.prepare_bid_edit(v_l.tender_id);

  update public.bid_pricing_lines
     set unit_price_cents = p_unit_price_cents, quantity = v_qty, supplier_quote_ref = v_ref, version = version + 1,
         edited_by = auth.uid(), edited_at = now()
   where id = p_line_id
  returning * into v_after;
  v_version := v_after.version;
  perform private.unconfirm_pricing(v_t.organisation_id, v_l.tender_id);
  perform private.bid_history(v_t.organisation_id, v_l.tender_id, 'PRICING_LINE', p_line_id::text, v_version, 'FIGURES_ENTERED',
    jsonb_build_object('unit_price_cents', v_after.unit_price_cents, 'quantity', v_after.quantity, 'supplier_quote_ref', v_after.supplier_quote_ref,
                       'amount_cents', v_after.amount_cents, 'vat_cents', v_after.vat_cents));
  perform private.write_audit(v_t.organisation_id, 'bid.price_entered', 'tender', v_l.tender_id::text,
    jsonb_build_object('line', p_line_id, 'version', v_version, 'unit_price_cents', v_after.unit_price_cents, 'amount_cents', v_after.amount_cents,
                       'has_supplier_quote', v_ref is not null));
  return v_version;
end;
$$;
revoke execute on function public.save_pricing_line(uuid, bigint, numeric, text, integer) from public, anon;
grant execute on function public.save_pricing_line(uuid, bigint, numeric, text, integer) to authenticated;

create or replace function public.add_pricing_line(p_tender_id uuid, p_description text, p_unit text, p_quantity numeric)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.tenders;
  v_desc text := nullif(trim(regexp_replace(coalesce(p_description, ''), '[\x01-\x1f\x7f]', '', 'g')), '');
  v_unit text := nullif(trim(regexp_replace(coalesce(p_unit, ''), '[\x01-\x1f\x7f]', '', 'g')), '');
  v_id uuid;
  v_pos integer;
begin
  perform public.hit_rate_limit('bid.edit', 300, 3600);
  select * into v_t from public.tenders where id = p_tender_id for update;
  if v_t.id is null or not private.has_org_role(v_t.organisation_id, array['owner', 'admin', 'operator']::public.org_role[]) then
    raise exception 'Not permitted' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(v_t.organisation_id);
  if v_desc is null or char_length(v_desc) < 3 or char_length(v_desc) > 300 then
    raise exception 'Describe the line in 3 to 300 characters' using errcode = 'check_violation';
  end if;
  if char_length(v_unit) > 40 then
    raise exception 'A unit can be 40 characters at most' using errcode = 'check_violation';
  end if;
  if p_quantity is not null and (p_quantity <= 0 or p_quantity > 1000000 or p_quantity <> round(p_quantity, 3)) then
    raise exception 'A quantity must be more than zero, up to 1 000 000, with at most three decimals' using errcode = 'check_violation';
  end if;
  if (select count(*) from public.bid_pricing_lines where tender_id = p_tender_id) >= 200 then
    raise exception 'A schedule can have 200 lines at most' using errcode = 'check_violation';
  end if;
  perform private.prepare_bid_edit(p_tender_id);

  insert into public.bid_pricing (tender_id, organisation_id) values (p_tender_id, v_t.organisation_id) on conflict (tender_id) do nothing;
  select coalesce(max(position), -1) + 1 into v_pos from public.bid_pricing_lines where tender_id = p_tender_id;
  insert into public.bid_pricing_lines (organisation_id, tender_id, position, source, description, unit, quantity, quantity_printed, edited_by, edited_at)
  values (v_t.organisation_id, p_tender_id, v_pos, 'PERSON', v_desc, v_unit, p_quantity, false, auth.uid(), now())
  returning id into v_id;
  perform private.unconfirm_pricing(v_t.organisation_id, p_tender_id);
  perform private.bid_history(v_t.organisation_id, p_tender_id, 'PRICING_LINE', v_id::text, 1, 'ADDED',
    jsonb_build_object('description', v_desc, 'unit', v_unit, 'quantity', p_quantity));
  perform private.write_audit(v_t.organisation_id, 'bid.pricing_line_added', 'tender', p_tender_id::text, jsonb_build_object('line', v_id));
  return v_id;
end;
$$;
revoke execute on function public.add_pricing_line(uuid, text, text, numeric) from public, anon;
grant execute on function public.add_pricing_line(uuid, text, text, numeric) to authenticated;

create or replace function public.remove_pricing_line(p_line_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.tenders;
  v_l public.bid_pricing_lines;
begin
  perform public.hit_rate_limit('bid.edit', 300, 3600);
  select l.* into v_l from public.bid_pricing_lines l where l.id = p_line_id;
  if v_l.id is null then
    raise exception 'That line does not exist' using errcode = 'check_violation';
  end if;
  select * into v_t from public.tenders where id = v_l.tender_id for update;
  if v_t.id is null or not private.has_org_role(v_t.organisation_id, array['owner', 'admin', 'operator']::public.org_role[]) then
    raise exception 'Not permitted' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(v_t.organisation_id);
  if v_l.source <> 'PERSON' then
    raise exception 'A line from the tender''s price schedule cannot be removed; only lines you added can' using errcode = 'check_violation';
  end if;
  perform private.prepare_bid_edit(v_l.tender_id);

  delete from public.bid_pricing_lines where id = p_line_id;
  perform private.unconfirm_pricing(v_t.organisation_id, v_l.tender_id);
  perform private.bid_history(v_t.organisation_id, v_l.tender_id, 'PRICING_LINE', p_line_id::text, v_l.version + 1, 'REMOVED',
    jsonb_build_object('description', v_l.description, 'unit_price_cents', v_l.unit_price_cents));
  perform private.write_audit(v_t.organisation_id, 'bid.pricing_line_removed', 'tender', v_l.tender_id::text, jsonb_build_object('line', p_line_id));
end;
$$;
revoke execute on function public.remove_pricing_line(uuid) from public, anon;
grant execute on function public.remove_pricing_line(uuid) to authenticated;

create or replace function public.set_pricing_confirmed(p_tender_id uuid, p_confirmed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.tenders;
  v_totals record;
  v_was timestamptz;
begin
  perform public.hit_rate_limit('bid.edit', 300, 3600);
  select * into v_t from public.tenders where id = p_tender_id for update;
  if v_t.id is null or not private.has_org_role(v_t.organisation_id, array['owner', 'admin', 'operator']::public.org_role[]) then
    raise exception 'Not permitted' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(v_t.organisation_id);
  if p_confirmed is null then
    raise exception 'Choose confirmed or not confirmed' using errcode = 'check_violation';
  end if;
  select * into v_totals from public.bid_pricing_totals(p_tender_id);
  if p_confirmed and not coalesce(v_totals.complete, false) then
    raise exception 'Every line needs a quantity and a price (a price of R0.00 is allowed) before the schedule can be confirmed' using errcode = 'check_violation';
  end if;
  select confirmed_at into v_was from public.bid_pricing where tender_id = p_tender_id;
  if (v_was is not null) = p_confirmed then
    return;
  end if;
  perform private.prepare_bid_edit(p_tender_id);

  insert into public.bid_pricing (tender_id, organisation_id) values (p_tender_id, v_t.organisation_id) on conflict (tender_id) do nothing;
  update public.bid_pricing
     set confirmed_by = case when p_confirmed then auth.uid() end, confirmed_at = case when p_confirmed then now() end
   where tender_id = p_tender_id;
  perform private.bid_history(v_t.organisation_id, p_tender_id, 'PRICING', 'pricing', 0, case when p_confirmed then 'CONFIRMED' else 'UNCONFIRMED' end,
    jsonb_build_object('confirmed', p_confirmed, 'subtotal_cents', v_totals.subtotal_cents, 'vat_cents', v_totals.vat_cents, 'total_cents', v_totals.total_cents));
  perform private.write_audit(v_t.organisation_id, case when p_confirmed then 'bid.pricing_confirmed' else 'bid.pricing_unconfirmed' end, 'tender', p_tender_id::text,
    jsonb_build_object('lines', v_totals.lines, 'total_cents', v_totals.total_cents));
end;
$$;
revoke execute on function public.set_pricing_confirmed(uuid, boolean) from public, anon;
grant execute on function public.set_pricing_confirmed(uuid, boolean) to authenticated;
