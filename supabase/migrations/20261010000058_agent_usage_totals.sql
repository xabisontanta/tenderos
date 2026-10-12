-- Totals computed by the database, for pages that used to fetch rows and add them up in the browser: the API
-- returns at most 1000 rows (max_rows), so the agent page showed spend and tokens for at most the first 1000
-- usage rows. SECURITY INVOKER: row level security applies, so a caller only ever sums their own
-- organisation's rows.
create or replace function public.agent_usage_totals(p_agent_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'calls', count(*),
    'cost_usd', coalesce(sum(u.cost_usd), 0),
    'input_tokens', coalesce(sum(u.input_tokens), 0),
    'output_tokens', coalesce(sum(u.output_tokens), 0),
    'all_simulated', coalesce(bool_and(u.is_simulated), false))
  from public.cost_usage u
  where u.agent_id = p_agent_id;
$$;
revoke execute on function public.agent_usage_totals(uuid) from public, anon;
grant execute on function public.agent_usage_totals(uuid) to authenticated;
