# ADR 0001: Supabase with RLS as the security boundary

**Status:** accepted

**Context.** Multi-tenant data (company documents, pricing, personal data)
must stay isolated, and the UI needs live updates.

**Decision.** Use Supabase Postgres with RLS on every table. Users read
directly under RLS and write only through role-checked `SECURITY DEFINER`
RPCs. Realtime uses the same RLS.

**Consequences.** Business rules live in SQL as well as TypeScript, so some
logic is duplicated; parity tests keep the tender state machine identical.
A bug in a page cannot leak another tenant's rows.
