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
