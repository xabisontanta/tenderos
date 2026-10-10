import { config } from "dotenv";

config({ path: [".env.test.local", ".env.local", ".env"], quiet: true });

for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "DATABASE_URL"]) {
  if (!process.env[k]) throw new Error(`Integration tests need ${k}. Run \`npm run db:start && npm run db:env\`.`);
}
const url = process.env.DATABASE_URL!;
if (!/127\.0\.0\.1|localhost/.test(url) && process.env.ALLOW_REMOTE_TEST_DB !== "1") {
  throw new Error("Refusing to run integration tests against a non-local database");
}
