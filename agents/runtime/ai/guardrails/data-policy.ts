import type { DataCategory } from "@/agents/registry";
import { PROMPT_PROHIBITED_CATEGORIES } from "../../permissions";
import { PromptPolicyError } from "../errors";
import { findSaIdNumbers } from "./text";

declare const approvedBrand: unique symbol;

export type PromptPart =
  | { type: "text"; category: DataCategory; label: string; text: string; cache?: boolean }
  | { type: "pdf"; category: DataCategory; label: string; base64: string; cache?: boolean };

/** A prompt block that passed the data policy. The client accepts nothing else. */
export type ApprovedBlock = PromptPart & { readonly chars: number; readonly [approvedBrand]: true };

const approved = new WeakSet<object>();
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The only way to turn material into prompt content. Each part names its data
 * category; the part is refused when the category may never reach a model
 * (director personal data, bank details, proof of address), when the agent was
 * not granted it for this task, or when the text carries an identity number.
 */
export function buildPrompt(parts: PromptPart[], granted: ReadonlySet<DataCategory>): ApprovedBlock[] {
  return parts.map((part) => {
    if ((PROMPT_PROHIBITED_CATEGORIES as readonly string[]).includes(part.category)) {
      throw new PromptPolicyError(`Prompt part "${part.label}" is ${part.category} data, which may never be sent to a model`);
    }
    if (!granted.has(part.category)) {
      throw new PromptPolicyError(`Prompt part "${part.label}" needs ${part.category}, which is not granted to this agent for this task`);
    }
    if (part.type === "text") {
      if (findSaIdNumbers(part.text).length > 0) {
        throw new PromptPolicyError(`Prompt part "${part.label}" contains a personal identity number and was not sent`);
      }
    } else if (!BASE64.test(part.base64)) {
      throw new PromptPolicyError(`Prompt part "${part.label}" is not valid base64`);
    }
    const chars = part.type === "text" ? part.text.length : part.base64.length;
    const block = Object.freeze({ ...part, chars }) as ApprovedBlock;
    approved.add(block);
    return block;
  });
}

declare const trustedBrand: unique symbol;

/** Static instruction text written by us (task wording, repair requests). It carries no data category and no company or tender data. */
export interface TrustedBlock {
  readonly type: "trusted";
  readonly label: string;
  readonly category: null;
  readonly text: string;
  readonly chars: number;
  readonly cache?: undefined;
  readonly [trustedBrand]: true;
}

/**
 * Wraps instruction text. Instructions must not interpolate tender or company
 * data (that goes through buildPrompt with a category); this only guards
 * against an identity number slipping in through a template.
 */
export function trusted(text: string, label = "instruction"): TrustedBlock {
  if (findSaIdNumbers(text).length > 0) throw new PromptPolicyError(`Instruction "${label}" contains a personal identity number and was not sent`);
  const block = Object.freeze({ type: "trusted" as const, label, category: null, text, chars: text.length }) as TrustedBlock;
  approved.add(block);
  return block;
}

/** Runtime check behind the type: blocks must come from buildPrompt or trusted, not from a cast. */
export function assertApproved(blocks: readonly (ApprovedBlock | TrustedBlock)[]): void {
  for (const b of blocks) {
    if (!approved.has(b)) throw new PromptPolicyError("Prompt content did not pass the data policy (buildPrompt)");
  }
}
