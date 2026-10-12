import type { CompanyProfile } from "@/agents/runtime/types";
import type { CompanyKey } from "./types";

/**
 * Personal and sensitive values that must never reach a prompt. They appear in
 * every synthetic profile, and the evaluation fails if one is sent to a model.
 */
export const SENSITIVE_SENTINELS = ["Thandeka Sentinel", "sentinel.owner@example.test", "082 555 0100", "1 Sentinel Road, Sandton", "SENTINEL-TCS-PIN", "4999999999", "2019/999999/07", "MAAA9999999"];

const base: CompanyProfile = {
  organisation_id: "00000000-0000-0000-0000-0000000000aa",
  legal_name: null,
  trading_name: null,
  registration_number: "2019/999999/07",
  csd_number: "MAAA9999999",
  tax_pin: "SENTINEL-TCS-PIN",
  tax_pin_expires_at: "2027-06-30",
  vat_number: "4999999999",
  bbbee_level: 2,
  bbbee_expires_at: "2027-03-31",
  cidb_grade: null,
  sectors: [],
  provinces: [],
  max_contract_value_zar: null,
  authorised_signatory: "Thandeka Sentinel",
  contact_person: "Thandeka Sentinel",
  contact_email: "sentinel.owner@example.test",
  contact_phone: "082 555 0100",
  physical_address: "1 Sentinel Road, Sandton",
  postal_address: "1 Sentinel Road, Sandton",
  website: null,
};

/** Invented companies, one per sector family. */
export const COMPANIES: Record<CompanyKey, CompanyProfile> = {
  civils: {
    ...base,
    legal_name: "Umzansi Civils (Pty) Ltd",
    trading_name: "Umzansi Civils",
    cidb_grade: "6CE",
    sectors: ["Construction", "Civil engineering", "Roads"],
    provinces: ["LIMPOPO", "GAUTENG", "MPUMALANGA"],
    max_contract_value_zar: 25_000_000,
  },
  it: {
    ...base,
    legal_name: "Ikhwezi Digital Solutions (Pty) Ltd",
    trading_name: "Ikhwezi Digital",
    sectors: ["ICT services", "Software"],
    provinces: ["GAUTENG", "MPUMALANGA"],
    max_contract_value_zar: 15_000_000,
  },
  facilities: {
    ...base,
    legal_name: "Masakhane Facilities Management (Pty) Ltd",
    trading_name: "Masakhane Facilities",
    sectors: ["Cleaning", "Facilities management", "Security services"],
    provinces: ["EASTERN_CAPE", "KWAZULU_NATAL"],
    max_contract_value_zar: 25_000_000,
  },
  medical: {
    ...base,
    legal_name: "Sizwe Medical Supplies (Pty) Ltd",
    trading_name: "Sizwe Medical",
    sectors: ["Medical supplies"],
    provinces: ["GAUTENG", "FREE_STATE"],
    max_contract_value_zar: 80_000_000,
  },
};
