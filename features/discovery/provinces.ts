import { PROVINCES } from "@/lib/format";

/** Provinces the Tender Scout can watch (every real province plus national departments). */
export const WATCHABLE_PROVINCES = PROVINCES.filter((p) => p.value !== "UNKNOWN");
