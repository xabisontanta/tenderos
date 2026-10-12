import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { DOCUMENT_BUCKET } from "@/lib/domain/documents";

/**
 * POPIA erasure and data-subject access, run with the service role by an authorised person
 * (docs/popia-operations.md). The database functions do the data work; this module does the part
 * SQL cannot: removing files from Storage, which Supabase only allows through its API.
 *
 * Callers pass the client in, so nothing here reads a key.
 */
type Admin = SupabaseClient<Database>;

export interface ErasureOptions {
  /** The request's reference (a ticket id). Letters, digits, dot, dash, underscore and colon only; no names or addresses. */
  reference?: string;
}

/** What erase_user returns: a pseudonym and counts, never anything about the person. */
export interface UserErasure {
  erased: "user";
  pseudonym: string;
  reference: string | null;
  audit_rows: number;
  events: number;
  status_history_rows: number;
  emails_deidentified: number;
}

/** What erase_organisation returns. */
export interface OrganisationErasure {
  erased: "organisation";
  organisation_id: string;
  reference: string | null;
  members_erased: number;
  documents_erased: number;
  /** Files removed from Storage before the database rows were erased. */
  files_removed: number;
}

const LIST_PAGE = 1000;
const REMOVE_CHUNK = 100;

/** Every object under a prefix, folders followed, so uploads that were never registered are found too. */
export async function listFiles(admin: Admin, prefix: string): Promise<string[]> {
  const found: string[] = [];
  const folders = [prefix];
  while (folders.length) {
    const folder = folders.pop()!;
    for (let offset = 0; ; offset += LIST_PAGE) {
      const { data, error } = await admin.storage.from(DOCUMENT_BUCKET).list(folder, { limit: LIST_PAGE, offset });
      if (error) throw new Error(`Could not list stored files: ${error.message}`);
      for (const entry of data ?? []) {
        // Folders come back without an id.
        if (entry.id) found.push(`${folder}/${entry.name}`);
        else folders.push(`${folder}/${entry.name}`);
      }
      if ((data ?? []).length < LIST_PAGE) break;
    }
  }
  return found;
}

async function removeFiles(admin: Admin, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
    const { error } = await admin.storage.from(DOCUMENT_BUCKET).remove(paths.slice(i, i + REMOVE_CHUNK));
    if (error) throw new Error(`Could not remove stored files: ${error.message}`);
  }
}

/**
 * Erases an organisation. Files go first: if the database call then fails, the request can simply be
 * run again, whereas the other order could leave files nobody can find.
 */
export async function eraseOrganisation(admin: Admin, organisationId: string, options: ErasureOptions = {}): Promise<OrganisationErasure> {
  const paths = await listFiles(admin, organisationId);
  await removeFiles(admin, paths);
  const { data, error } = await admin.rpc("erase_organisation", { p_org: organisationId, p_reference: options.reference });
  if (error) throw new Error(`Could not erase the organisation: ${error.message}`);
  return { ...(data as unknown as Omit<OrganisationErasure, "files_removed">), files_removed: paths.length };
}

/** Erases one person. Their uploads belong to the organisation and stay with it. */
export async function eraseUser(admin: Admin, userId: string, options: ErasureOptions = {}): Promise<UserErasure> {
  const { data, error } = await admin.rpc("erase_user", { p_user_id: userId, p_reference: options.reference });
  if (error) throw new Error(`Could not erase the user: ${error.message}`);
  return data as unknown as UserErasure;
}

/** Everything held about one person (data-subject access). `actor` is whoever ran the request. */
export async function exportUserData(admin: Admin, userId: string, actor?: string): Promise<Record<string, unknown>> {
  const { data, error } = await admin.rpc("export_user_data", { p_user_id: userId, p_actor: actor });
  if (error) throw new Error(`Could not export the user's data: ${error.message}`);
  return data as unknown as Record<string, unknown>;
}

/** An organisation's data as JSON. Never includes credentials, token hashes or file contents. */
export async function exportOrganisationData(admin: Admin, organisationId: string, actor?: string): Promise<Record<string, unknown>> {
  const { data, error } = await admin.rpc("export_organisation_data", { p_org: organisationId, p_actor: actor });
  if (error) throw new Error(`Could not export the organisation's data: ${error.message}`);
  return data as unknown as Record<string, unknown>;
}
