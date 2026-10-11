import { z } from "zod";
import { NonRetryableError } from "../types";

type Json = Record<string, unknown>;

/** The API accepts these string formats and ignores nothing else, so others are described instead. */
const SUPPORTED_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);
const SAFE_INTEGER = 9007199254740991;

/** Documented limits for output_config.format: 24 optional properties, 16 properties using anyOf or type arrays. */
export const MAX_OPTIONAL_PROPERTIES = 24;
export const MAX_UNIONS = 16;

export class StructuredSchemaError extends NonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = "StructuredSchemaError";
  }
}

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function mapValues(v: unknown): Json {
  if (!isRecord(v)) return {};
  return Object.fromEntries(Object.entries(v).map(([k, s]) => [k, isRecord(s) ? convert(s) : s]));
}

/**
 * Rewrites one JSON Schema node into the subset the API enforces: objects are
 * closed, oneOf becomes anyOf, and keywords it rejects (numeric bounds, string
 * length, maxItems and so on) move into the description so the model still
 * sees them. The full constraints are enforced afterwards by zod.
 */
function convert(schema: Json): Json {
  const out: Json = {};
  const notes: string[] = [];
  const formatSupported = typeof schema.format === "string" && SUPPORTED_FORMATS.has(schema.format);

  for (const [key, value] of Object.entries(schema)) {
    switch (key) {
      case "$schema":
      case "$id":
      case "id":
      case "default":
      case "examples":
      case "additionalProperties":
        break;
      case "$defs":
      case "definitions":
      case "properties":
        out[key] = mapValues(value);
        break;
      case "items":
        out.items = Array.isArray(value) ? value.map((v) => (isRecord(v) ? convert(v) : v)) : isRecord(value) ? convert(value) : value;
        break;
      case "anyOf":
      case "allOf":
        out[key] = (value as unknown[]).map((v) => (isRecord(v) ? convert(v) : v));
        break;
      case "oneOf":
        out.anyOf = (value as unknown[]).map((v) => (isRecord(v) ? convert(v) : v));
        break;
      case "type":
      case "enum":
      case "const":
      case "required":
      case "title":
      case "description":
      case "$ref":
        out[key] = value;
        break;
      case "format":
        if (formatSupported) out.format = value;
        else notes.push(`format: ${JSON.stringify(value)}`);
        break;
      case "pattern":
        // A supported format already says what the pattern says.
        if (!formatSupported) notes.push(`pattern: ${JSON.stringify(value)}`);
        break;
      case "minItems":
        if (value === 0 || value === 1) out.minItems = value;
        else notes.push(`minItems: ${JSON.stringify(value)}`);
        break;
      case "minimum":
        if (value !== -SAFE_INTEGER) notes.push(`minimum: ${JSON.stringify(value)}`);
        break;
      case "maximum":
        if (value !== SAFE_INTEGER) notes.push(`maximum: ${JSON.stringify(value)}`);
        break;
      default:
        notes.push(`${key}: ${JSON.stringify(value)}`);
    }
  }

  if (schema.type === "object" || isRecord(schema.properties)) {
    out.additionalProperties = false;
    if (!isRecord(out.properties)) out.properties = {};
  }
  if (notes.length) out.description = [typeof out.description === "string" ? out.description : "", `{${notes.join(", ")}}`].filter(Boolean).join("\n\n");
  return out;
}

/** JSON Schema for output_config.format, generated from a zod schema with z.toJSONSchema. */
export function toStructuredSchema(schema: z.ZodType): Json {
  return convert(z.toJSONSchema(schema, { io: "input", unrepresentable: "throw" }) as Json);
}

/** Counts what the API limits: optional properties and properties/nodes using anyOf or type arrays. */
export function countSchemaComplexity(schema: unknown): { optionalProperties: number; unions: number } {
  let optionalProperties = 0;
  let unions = 0;
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isRecord(node)) return;
    if (Array.isArray(node.anyOf) || Array.isArray(node.type)) unions++;
    if (isRecord(node.properties)) {
      const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
      optionalProperties += Object.keys(node.properties).filter((k) => !required.has(k)).length;
    }
    Object.values(node).forEach(visit);
  };
  visit(schema);
  return { optionalProperties, unions };
}

/** Fails in our code, with a clear message, instead of with a 400 from the API at run time. */
export function assertWithinStructuredLimits(schema: unknown, name: string): void {
  const { optionalProperties, unions } = countSchemaComplexity(schema);
  if (optionalProperties > MAX_OPTIONAL_PROPERTIES) {
    throw new StructuredSchemaError(`Output schema "${name}" has ${optionalProperties} optional properties; the API allows ${MAX_OPTIONAL_PROPERTIES}. Make fields required.`);
  }
  if (unions > MAX_UNIONS) {
    throw new StructuredSchemaError(`Output schema "${name}" has ${unions} anyOf or nullable properties; the API allows ${MAX_UNIONS}.`);
  }
}
