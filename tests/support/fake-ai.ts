import type { AiClient, AiCountRequest, AiRequest, AiResponse } from "@/agents/runtime/ai/client";
import { ZERO_USAGE, type AiUsage } from "@/agents/runtime/ai/pricing";

/** What the fake model answers. `json` is serialised; `text` is used as given (for malformed output). */
export interface FakeReply {
  json?: unknown;
  text?: string;
  usage?: Partial<AiUsage>;
  stopReason?: string | null;
  stopCategory?: string | null;
  sources?: Array<{ url: string; title: string }>;
  throws?: Error;
}

export type FakeHandler = (req: AiRequest, callNo: number) => FakeReply | Promise<FakeReply>;

function sizeOf(req: Pick<AiCountRequest, "system" | "messages">): number {
  let n = req.system.length;
  for (const m of req.messages) for (const b of m.content) n += b.type === "pdf" ? b.base64.length / 20 : b.text.length;
  return n;
}

/**
 * A deterministic stand-in for the Anthropic client: no network, scripted
 * replies, token counts derived from text length. Used by unit tests and the
 * evaluation runner so wiring, citation downgrades and refusal paths run in CI.
 */
export class FakeAiClient implements AiClient {
  readonly requests: AiRequest[] = [];
  readonly countRequests: AiCountRequest[] = [];
  private calls = 0;

  constructor(private readonly script: FakeHandler | FakeReply[]) {}

  async complete(req: AiRequest): Promise<AiResponse> {
    this.requests.push(req);
    const callNo = this.calls++;
    const reply = Array.isArray(this.script) ? this.script[callNo] : await this.script(req, callNo);
    if (!reply) throw new Error(`FakeAiClient: no scripted reply for call ${callNo + 1}`);
    if (reply.throws) throw reply.throws;
    const text = reply.text ?? JSON.stringify(reply.json ?? {});
    const usage: AiUsage = {
      ...ZERO_USAGE,
      inputTokens: Math.ceil(sizeOf(req) / 4),
      outputTokens: Math.ceil(text.length / 4),
      ...reply.usage,
    };
    return {
      text,
      stopReason: reply.stopReason === undefined ? "end_turn" : reply.stopReason,
      stopCategory: reply.stopCategory ?? null,
      usage,
      model: req.model,
      requestId: `req_fake_${callNo + 1}`,
      sources: reply.sources ?? [],
    };
  }

  async countTokens(req: AiCountRequest): Promise<number> {
    this.countRequests.push(req);
    return Math.ceil(sizeOf(req) / 4);
  }
}
