-- A handoff that follows a human approval originates from that decision, not
-- from the agent that owned the approval task.
alter table public.handoffs add column from_approval boolean not null default false;
alter table public.handoffs add constraint handoffs_single_approval_side check (not (from_approval and to_approval));
