-- Bid email can no longer be sent twice (docs/production-readiness.md, P0 #10).
--
-- sendBidEmail used to check "already sent?", then send, then record. Two presses of Send (or a retried
-- request) both passed the check and both emailed the bid. The send is now reserved first: a message row
-- in state SENDING, and the database allows only one SENDING or SENT message per submission. A second
-- reservation fails on the unique index, before any mail leaves. A failed attempt is marked FAILED and no
-- longer counts, so the person can try again; an attempt that was interrupted stays SENDING and keeps
-- blocking until a person has checked the mailbox's Sent folder (AGENTS.md, section 8).

alter table public.email_messages drop constraint email_messages_status_check;
alter table public.email_messages add constraint email_messages_status_check check (status in ('SENDING', 'SENT', 'FAILED'));

-- Refuse to proceed rather than guess which of several recorded sends is the real one. If this fails,
-- decide with the customer which message was the real send and mark the others FAILED by hand.
do $$
declare
  v_dupes integer;
begin
  select count(*) into v_dupes
    from (select submission_record_id from public.email_messages
           where status in ('SENDING', 'SENT') and submission_record_id is not null
           group by submission_record_id having count(*) > 1) many;
  if v_dupes > 0 then
    raise exception 'Cannot enforce one email per bid: % submission(s) have more than one SENT message. Resolve them first (AGENTS.md, section 8).', v_dupes;
  end if;
end;
$$;

create unique index email_messages_one_live_send_uq on public.email_messages (submission_record_id)
  where status in ('SENDING', 'SENT');
