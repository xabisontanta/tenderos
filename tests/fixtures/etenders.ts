/**
 * Rows shaped exactly like the eTenders "PaginatedTenderOpportunities" feed
 * (copied from a live response, trimmed). Dates are generated relative to now
 * so the rows stay open whenever the tests run.
 */
function saLocal(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 86_400_000 + 2 * 3_600_000);
  return d.toISOString().slice(0, 19);
}

export function etendersRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 173689,
    tender_No: "JTC0012/2026-27",
    description:
      " REQUEST FOR QUOTATION FROM SUITABLY QUALIFIED AND REGISTERED SERVICE PROVIDERS TO:\r\nA)\tPROVIDE AIRPORT TRANSFERS & SHUTTLE SERVICES FOR CONFERENCE DELEGATES\r\n",
    category: "Travel agency, tour operator, reservation service and related activities",
    type: "Request for Quotation",
    organ_of_State: "City Council of Johannesburg",
    status: "Published",
    closing_Date: saLocal(10),
    date_Published: saLocal(-1),
    compulsory_briefing_session: null,
    briefingVenue: null,
    contactPerson: "PHUTHI",
    email: "procurement@example.org",
    telephone: "011-779-0200",
    briefingSession: false,
    briefingCompulsory: false,
    province: "Gauteng",
    department: "City Council of Johannesburg",
    eSubmission: false,
    supportDocument: [{ supportDocumentID: "6dc689a4-3b9d-4f88-b3b2-59622eeb68c4", fileName: "JTC0012-2026-27.pdf", extension: ".pdf" }],
    delivery: "Sandton Library Offices Nelson Mandela Square West Street, Sandton -SANDTON-SANDTON-2000",
    ...overrides,
  };
}

const NUL = "\u0000";

/** Real feeds carry stray control characters (the portal's editors paste from Word and PDF). Postgres rejects NUL in text and jsonb. */
export function nulRow(overrides: Record<string, unknown> = {}) {
  return etendersRow({
    id: 800001,
    tender_No: `NUL${NUL}-1`,
    description: `Supply of pipes${NUL}\r\nSecond${NUL} line\u0007 with a bell\u001b[31m`,
    department: `Water${NUL} Department`,
    category: `Cat${NUL}egory\u000b`,
    delivery: `Hand${NUL} delivery\u0000 at the office`,
    contactPerson: `Pat${NUL}`,
    email: `pat${NUL}@example.org`,
    telephone: `011${NUL}-1`,
    briefingSession: true,
    briefingVenue: `Room${NUL} 4`,
    supportDocument: [{ supportDocumentID: `id${NUL}1`, fileName: `spec${NUL}.pdf`, extension: `.pdf${NUL}` }],
    ...overrides,
  });
}

/** A row with nothing usable to name the tender after. */
export function untitledRow(overrides: Record<string, unknown> = {}) {
  return etendersRow({ id: 800002, tender_No: null, description: "N/A", ...overrides });
}

/** Rows that cannot become tenders, each for a different reason (schema drift, missing facts). */
export function unreadableRows() {
  return [
    etendersRow({ id: { surprise: "the portal changed the id" } }),
    etendersRow({ id: null }),
    "not an object at all",
    etendersRow({ id: 800010, closing_Date: null }),
    etendersRow({ id: 800011, closing_Date: "not a date" }),
    etendersRow({ id: 800012, department: null, organ_of_State: "" }),
  ];
}

export function etendersFetcher(rows: unknown[]) {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    const start = Number(new URL(url).searchParams.get("start") ?? 0);
    const length = Number(new URL(url).searchParams.get("length") ?? 500);
    return {
      ok: true,
      status: 200,
      json: async () => ({ draw: 1, recordsTotal: rows.length, recordsFiltered: rows.length, data: rows.slice(start, start + length) }),
    };
  };
  return { fetcher, calls };
}

export const futureSaLocal = saLocal;
