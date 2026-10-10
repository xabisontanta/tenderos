import type { TenderSourceConnector } from "./types";

/**
 * Tenders entered by a person. Nothing to search or fetch; it exists so every
 * tender has a source and the pipeline treats manual and automated tenders alike.
 */
export const manualConnector: TenderSourceConnector = {
  slug: "manual",
  displayName: "Manual entry",
  async search() {
    return { tenders: [], nextPage: null };
  },
  async getTender() {
    return null;
  },
  async getDocuments() {
    return [];
  },
  async getAmendments() {
    return [];
  },
  async getAward() {
    return null;
  },
  supportsSubmission() {
    return false;
  },
};
