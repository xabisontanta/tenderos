import { config } from "dotenv";
import { runLive } from "./live";

// Reads .env.local the same way the worker does; real environment variables win.
config({ path: [".env.local", ".env"], quiet: true });

runLive(process.env, (line) => console.log(line))
  .then((r) => process.exit(r.exitCode))
  .catch((err) => {
    console.error(`eval:live failed: ${(err as Error).message}`);
    process.exit(2);
  });
