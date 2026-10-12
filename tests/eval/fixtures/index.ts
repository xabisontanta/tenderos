import type { EvalFixture } from "../types";
import { roadsRehabilitation } from "./01-roads-rehabilitation";
import { erpSupportServices } from "./02-erp-support-services";
import { hospitalCleaning } from "./03-hospital-cleaning";
import { municipalSecurityGuarding } from "./04-municipal-security-guarding";
import { medicalExaminationGloves } from "./05-medical-examination-gloves";
import { waterMetersBoq } from "./06-water-meters-boq";
import { schoolNutritionCatering } from "./07-school-nutrition-catering";
import { streetlightMaintenance } from "./08-streetlight-maintenance";
import { adversarialPromptInjection } from "./09-adversarial-prompt-injection";
import { adversarialMissingReturnables } from "./10-adversarial-missing-returnables";
import { adversarialConflictingDates } from "./11-adversarial-conflicting-dates";
import { adversarialScannedPdf } from "./12-adversarial-scanned-pdf";

/** Synthetic South African tenders, with labels. The format is documented in docs/ai-agents.md. */
export const FIXTURES: EvalFixture[] = [
  roadsRehabilitation,
  erpSupportServices,
  hospitalCleaning,
  municipalSecurityGuarding,
  medicalExaminationGloves,
  waterMetersBoq,
  schoolNutritionCatering,
  streetlightMaintenance,
  adversarialPromptInjection,
  adversarialMissingReturnables,
  adversarialConflictingDates,
  adversarialScannedPdf,
];

export function fixtureById(id: string): EvalFixture | undefined {
  return FIXTURES.find((f) => f.id === id);
}
