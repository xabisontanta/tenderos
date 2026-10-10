import { z } from "zod";

/**
 * Connector for National Treasury's eTenders portal (www.etenders.gov.za).
 * It reads the same public JSON feed that powers the portal's "Current
 * tenders" list, which carries the province, closing date, briefing and
 * delivery details for every published tender.
 */
export const ETENDERS_BASE = "https://www.etenders.gov.za";
const EMAIL_IN_TEXT = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PAGE_SIZE = 500;
const MAX_PAGES = 20;

const documentSchema = z.object({
  supportDocumentID: z.string(),
  fileName: z.string().nullable().optional(),
  extension: z.string().nullable().optional(),
});

export const etendersRowSchema = z.object({
  id: z.number(),
  tender_No: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  organ_of_State: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  closing_Date: z.string().nullable().optional(),
  date_Published: z.string().nullable().optional(),
  compulsory_briefing_session: z.string().nullable().optional(),
  briefingVenue: z.string().nullable().optional(),
  briefingSession: z.boolean().nullable().optional(),
  briefingCompulsory: z.boolean().nullable().optional(),
  province: z.string().nullable().optional(),
  delivery: z.string().nullable().optional(),
  contactPerson: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  telephone: z.string().nullable().optional(),
  eSubmission: z.boolean().nullable().optional(),
  supportDocument: z.array(documentSchema).nullable().optional(),
});
export type EtendersRow = z.infer<typeof etendersRowSchema>;

const pageSchema = z.object({
  recordsTotal: z.number(),
  data: z.array(z.unknown()),
});

const PROVINCE_NAMES: Record<string, string> = {
  easterncape: "EASTERN_CAPE",
  freestate: "FREE_STATE",
  gauteng: "GAUTENG",
  kwazulunatal: "KWAZULU_NATAL",
  kzn: "KWAZULU_NATAL",
  limpopo: "LIMPOPO",
  mpumalanga: "MPUMALANGA",
  northwest: "NORTH_WEST",
  northerncape: "NORTHERN_CAPE",
  westerncape: "WESTERN_CAPE",
  national: "NATIONAL",
};

/** Maps the portal's province name ("KwaZulu-Natal", "North West") to our code. */
export function provinceCode(name: string | null | undefined): string {
  if (!name) return "UNKNOWN";
  return PROVINCE_NAMES[name.toLowerCase().replace(/[^a-z]/g, "")] ?? "UNKNOWN";
}

/** The portal publishes South African local times without an offset. */
export function saTime(value: string | null | undefined): string | null {
  if (!value || value.startsWith("0001-")) return null;
  const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}+02:00`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function clean(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const v = value.replace(/\s+/g, " ").trim();
  if (!v || v.toUpperCase() === "N/A") return null;
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

export interface DiscoveredDocument {
  name: string;
  url: string;
}

export interface DiscoveredTender {
  source_ref: string;
  reference_number: string | null;
  title: string;
  issuing_organisation: string;
  description: string | null;
  province: string;
  sector: string | null;
  published_at: string | null;
  closing_at: string;
  briefing_at: string | null;
  briefing_compulsory: boolean;
  briefing_location: string | null;
  submission_method: "ELECTRONIC_PORTAL" | "EMAIL" | "PHYSICAL" | "UNKNOWN";
  submission_destination: string | null;
  source_url: string;
  documents: DiscoveredDocument[];
  contact: { person: string | null; email: string | null; telephone: string | null };
}

export type MapResult = { ok: true; tender: DiscoveredTender } | { ok: false; reason: string };

/**
 * Turns one portal row into a tender record. Only facts present in the row
 * are kept; anything missing stays null so the agents report it as missing.
 */
export function mapEtendersRow(row: EtendersRow, now: Date): MapResult {
  const closing = saTime(row.closing_Date);
  if (!closing) return { ok: false, reason: "no closing date" };
  if (new Date(closing).getTime() <= now.getTime()) return { ok: false, reason: "already closed" };
  const organisation = clean(row.department ?? row.organ_of_State, 200);
  if (!organisation || organisation.length < 2) return { ok: false, reason: "no issuing organisation" };

  const description = row.description ? row.description.replace(/\r\n?/g, "\n").trim().slice(0, 10000) : null;
  const reference = clean(row.tender_No, 120);
  const firstLine =
    description
      ?.split("\n")
      .find((l) => l.trim().length >= 3)
      ?.trim() ??
    reference ??
    `eTenders ${row.id}`;
  const title = clean(firstLine, 300)!;

  let published = saTime(row.date_Published);
  if (published && published > closing) published = null;
  let briefing = saTime(row.compulsory_briefing_session);
  if (briefing && briefing > closing) briefing = null;

  const delivery = clean(row.delivery?.replace(/-+/g, ", "), 500);
  // A delivery field that names a mailbox means the bid goes by email.
  const deliveryEmail = delivery?.match(EMAIL_IN_TEXT)?.[0].toLowerCase() ?? null;
  const method: DiscoveredTender["submission_method"] = row.eSubmission ? "ELECTRONIC_PORTAL" : deliveryEmail ? "EMAIL" : delivery ? "PHYSICAL" : "UNKNOWN";

  const documents = (row.supportDocument ?? []).map((d) => {
    const ext = d.extension ?? "";
    const name = d.fileName ?? `${d.supportDocumentID}${ext}`;
    return {
      name,
      url: `${ETENDERS_BASE}/home/Download?blobName=${encodeURIComponent(d.supportDocumentID + ext)}&downloadedFileName=${encodeURIComponent(name)}`,
    };
  });

  return {
    ok: true,
    tender: {
      source_ref: String(row.id),
      reference_number: reference,
      title,
      issuing_organisation: organisation,
      description,
      province: provinceCode(row.province),
      sector: clean(row.category, 120),
      published_at: published,
      closing_at: closing,
      briefing_at: row.briefingSession ? briefing : null,
      briefing_compulsory: Boolean(row.briefingCompulsory),
      briefing_location: row.briefingSession ? clean(row.briefingVenue, 300) : null,
      submission_method: method,
      submission_destination: method === "ELECTRONIC_PORTAL" ? `${ETENDERS_BASE} (eSubmission)` : method === "EMAIL" ? deliveryEmail : delivery,
      source_url: documents[0]?.url ?? `${ETENDERS_BASE}/Home/opportunities?id=1`,
      documents,
      contact: { person: clean(row.contactPerson, 120), email: clean(row.email, 200), telephone: clean(row.telephone, 60) },
    },
  };
}

export type Fetcher = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const PAGE_TIMEOUT_MS = 30_000;

/** Reads every currently published tender, page by page. */
export async function* fetchOpenTenders(fetcher: Fetcher, signal?: AbortSignal): AsyncGenerator<{ rows: EtendersRow[]; total: number }> {
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${ETENDERS_BASE}/Home/PaginatedTenderOpportunities?draw=${page + 1}&start=${page * PAGE_SIZE}&length=${PAGE_SIZE}&status=1`;
    // A page that hangs must not hold the worker: give each request 30 seconds.
    const timeout = AbortSignal.timeout(PAGE_TIMEOUT_MS);
    const res = await fetcher(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { accept: "application/json", "user-agent": "TenderOS tender discovery" },
    });
    if (!res.ok) throw new Error(`eTenders returned HTTP ${res.status}`);
    const body = pageSchema.parse(await res.json());
    const rows: EtendersRow[] = [];
    for (const raw of body.data) {
      const parsed = etendersRowSchema.safeParse(raw);
      if (parsed.success) rows.push(parsed.data);
    }
    yield { rows, total: body.recordsTotal };
    if (body.data.length < PAGE_SIZE || (page + 1) * PAGE_SIZE >= body.recordsTotal) return;
  }
}
