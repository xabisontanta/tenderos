# ADR 0004: shadcn-style components written in the repo

**Status:** accepted

**Context.** The shadcn registry was unreachable from the build environment.

**Decision.** The primitives in `components/ui` follow shadcn's structure
(Radix, `cva`, `cn`) and `components.json` is kept, so the CLI can manage
them later.

**Consequences.** Components can be regenerated or diffed against the
registry when it is reachable.
