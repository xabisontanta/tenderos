import { NonRetryableError } from "@/agents/runtime/types";

/** The private Storage bucket tender documents are kept in, under <organisation_id>/<tender_id>/<sha256>.pdf. */
export const TENDER_DOCUMENT_BUCKET = "tender-documents";

/** Where the worker keeps and reads the fetched files. Only the service role can write to the bucket. */
export interface DocumentStorage {
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(path: string): Promise<Uint8Array>;
}

type Env = Record<string, string | undefined>;

/** `<organisation_id>/<tender_id>/<sha256>.pdf`: the organisation folder is what the Storage policy and erasure go by. */
export function tenderDocumentPath(organisationId: string, tenderId: string, sha256: string): string {
  return `${organisationId}/${tenderId}/${sha256}.pdf`;
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/**
 * Supabase Storage over its HTTP API with the service role key (the worker has only a database connection otherwise).
 * The key and the project URL come from the worker's environment; if either is missing the first use says which.
 */
export function createSupabaseStorage(env: Env = process.env, fetchImpl: typeof fetch = fetch): DocumentStorage {
  const config = () => {
    const url = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "").trim().replace(/\/+$/, "");
    const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url) throw new NonRetryableError("SUPABASE_URL is not set, so tender documents cannot be stored or read");
    if (!key) throw new NonRetryableError("SUPABASE_SERVICE_ROLE_KEY is not set, so tender documents cannot be stored or read");
    return { url, key };
  };
  const target = (url: string, path: string) => `${url}/storage/v1/object/${TENDER_DOCUMENT_BUCKET}/${encodePath(path)}`;

  return {
    async put(path, bytes, contentType) {
      const { url, key } = config();
      const res = await fetchImpl(target(url, path), {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, apikey: key, "content-type": contentType, "x-upsert": "true", "cache-control": "max-age=3600" },
        body: bytes as unknown as BodyInit,
      });
      if (!res.ok) throw new Error(`Storage refused the upload (HTTP ${res.status})`);
    },
    async get(path) {
      const { url, key } = config();
      const res = await fetchImpl(target(url, path), { headers: { authorization: `Bearer ${key}`, apikey: key } });
      if (!res.ok) throw new Error(`Storage could not return the file (HTTP ${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
