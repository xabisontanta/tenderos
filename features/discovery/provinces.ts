import { PROVINCES } from "@/lib/format";

/** Provinces the Tender Scout can watch (every real province plus national departments). */
export const WATCHABLE_PROVINCES = PROVINCES.filter((p) => p.value !== "UNKNOWN");

/** Ways a bid can be delivered, as the Tender Scout reads them from eTenders. */
export const DELIVERY_METHODS = [
  { value: "ELECTRONIC_PORTAL", label: "Upload on eTenders", hint: "eSubmission on the portal" },
  { value: "EMAIL", label: "Email", hint: "Bid sent to a tender mailbox" },
  { value: "PHYSICAL", label: "Deliver in person", hint: "Tender box or courier" },
  { value: "UNKNOWN", label: "Not stated", hint: "Method not given on the portal" },
] as const;
