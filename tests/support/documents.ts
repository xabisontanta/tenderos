import type { DocumentSource, TenderDocument } from "@/agents/runtime/ai/documents";

/** A DocumentSource that serves documents from memory. Real downloading and text extraction come with document ingestion. */
export class FakeDocumentSource implements DocumentSource {
  readonly requestedFor: string[] = [];

  constructor(private readonly docs: TenderDocument[]) {}

  async listTenderDocuments(tenderId: string): Promise<TenderDocument[]> {
    this.requestedFor.push(tenderId);
    return this.docs;
  }
}
