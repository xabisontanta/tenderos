/**
 * Data-subject requests, run by the person authorised to handle them (docs/popia-operations.md).
 *
 *   npm run popia -- export-user <user-id>  [--by <operator-user-id>] [--out file.json]
 *   npm run popia -- export-org  <org-id>   [--by <operator-user-id>] [--out file.json]
 *   npm run popia -- erase-user  <user-id>  --ref <request-reference> --yes
 *   npm run popia -- erase-org   <org-id>   --ref <request-reference> --yes
 *   npm run popia -- reset-mfa   <user-id>  --ref <request-reference> --yes   (a lost authenticator, docs/auth.md)
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (environment or .env.local). Exports hold
 * personal data: they are written with owner-only permissions, never printed unless no --out is given,
 * and must be sent to the requester through a secure channel and then deleted. Erasure cannot be undone.
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import type { Database } from "@/types/database";
import { eraseOrganisation, eraseUser, exportOrganisationData, exportUserData, resetUserMfa } from "@/lib/privacy/erasure";

config({ path: [".env.local", ".env"], quiet: true });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMANDS = ["export-user", "export-org", "erase-user", "erase-org", "reset-mfa"] as const;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [command, id, ...rest] = process.argv.slice(2);
  if (!COMMANDS.includes(command as (typeof COMMANDS)[number]) || !id || !UUID.test(id)) {
    fail(`Usage: npm run popia -- <${COMMANDS.join("|")}> <uuid> [--ref REQ-1] [--by <uuid>] [--out file.json] [--yes]`);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (environment or .env.local).");
  const admin = createClient<Database>(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } });

  const by = option(rest, "--by");
  if (by && !UUID.test(by)) fail("--by must be the user id of whoever handles the request.");

  if (command.startsWith("export-")) {
    const data = command === "export-user" ? await exportUserData(admin, id, by) : await exportOrganisationData(admin, id, by);
    const json = JSON.stringify(data, null, 2);
    const out = option(rest, "--out");
    if (out) {
      writeFileSync(out, json, { mode: 0o600 });
      console.error(`Wrote ${out}. It holds personal data: send it securely, then delete it.`);
    } else {
      console.log(json);
    }
    return;
  }

  const reference = option(rest, "--ref");
  if (!reference || !/^[A-Za-z0-9._:-]{1,64}$/.test(reference))
    fail("--ref is required: the request's reference (letters, digits and . _ : - only; no names or addresses).");
  if (command === "reset-mfa") {
    if (!rest.includes("--yes"))
      fail("This removes the person's authenticators and signs them out everywhere. Run again with --yes once their identity is verified.");
    console.log(JSON.stringify(await resetUserMfa(admin, id, { reference }), null, 2));
    return;
  }
  if (!rest.includes("--yes"))
    fail(`This permanently erases ${command === "erase-user" ? "the user" : "the organisation, its members and its files"}. Run again with --yes to proceed.`);
  const summary = command === "erase-user" ? await eraseUser(admin, id, { reference }) : await eraseOrganisation(admin, id, { reference });
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => fail(`Failed: ${(err as Error).message}`));
