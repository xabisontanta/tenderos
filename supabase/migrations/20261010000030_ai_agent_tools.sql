-- Tool grants for the AI executors.
--
-- The runtime now refuses any tool that is not on an agent's stored
-- allowed_tools (AGENTS.md section 5). New organisations get the lists in
-- agents/registry.ts when they sign up. This brings agents created earlier up
-- to date with the one tool added since: web.search for the Tender Scout and
-- the Intelligence Analyst. Using it still needs the organisation's own web
-- research switch, so granting the tool changes nothing by itself.
--
-- Not applied by the author of this change; the orchestrator applies it with
-- the other migrations.

update public.agents
   set allowed_tools = array_append(allowed_tools, 'web.search')
 where slug in ('tender_discovery', 'tender_intelligence')
   and not ('web.search' = any (allowed_tools));
