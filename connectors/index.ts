import { manualConnector } from "./manual";
import type { TenderSourceConnector } from "./types";

const CONNECTORS: Record<string, TenderSourceConnector> = {
  [manualConnector.slug]: manualConnector,
};

export function getConnector(slug: string): TenderSourceConnector | undefined {
  return CONNECTORS[slug];
}

export type { TenderSourceConnector } from "./types";
