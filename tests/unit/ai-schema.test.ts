import { describe, expect, it } from "vitest";
import { z } from "zod";
import { StructuredSchemaError, assertWithinStructuredLimits, countSchemaComplexity, toStructuredSchema } from "@/agents/runtime/ai/schema";
import { analysisOutputSchema } from "@/agents/analysis/schema";

function walk(node: unknown, visit: (n: Record<string, unknown>) => void) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (node && typeof node === "object") {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((v) => walk(v, visit));
  }
}

describe("structured output schema from zod", () => {
  const schema = z.object({
    id: z.string().min(1).max(40),
    count: z.number().int().min(0).max(100),
    ratio: z.number().min(0).max(1),
    kind: z.enum(["A", "B"]),
    note: z.string().nullable(),
    items: z
      .array(z.object({ label: z.string(), at: z.string().datetime() }))
      .min(2)
      .max(5),
    flag: z.boolean(),
  });

  it("is derived with z.toJSONSchema and has no keywords the API rejects", () => {
    const json = toStructuredSchema(schema);
    expect(json).not.toHaveProperty("$schema");
    const forbidden = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "pattern"];
    walk(json, (n) => {
      for (const k of forbidden) expect(n, k).not.toHaveProperty(k);
      if (n.type === "array" && n.minItems !== undefined) expect([0, 1]).toContain(n.minItems);
    });
  });

  it("closes every object and keeps enums and required fields", () => {
    const json = toStructuredSchema(schema) as { properties: Record<string, { enum?: string[] }>; required: string[]; additionalProperties: boolean };
    expect(json.additionalProperties).toBe(false);
    expect(json.required).toEqual(expect.arrayContaining(["id", "count", "kind", "note", "items", "flag"]));
    expect(json.properties.kind.enum).toEqual(["A", "B"]);
    walk(json, (n) => {
      if (n.type === "object") expect(n.additionalProperties).toBe(false);
    });
  });

  it("keeps dropped constraints visible to the model in the description", () => {
    const json = toStructuredSchema(schema) as { properties: Record<string, { description?: string }> };
    expect(json.properties.id.description).toMatch(/maxLength/);
    expect(json.properties.ratio.description).toMatch(/maximum/);
  });

  it("does not describe the safe-integer bounds zod adds to .int()", () => {
    const json = toStructuredSchema(z.object({ n: z.number().int() })) as { properties: { n: { description?: string } } };
    expect(json.properties.n.description ?? "").not.toMatch(/9007199254740991/);
  });

  it("still validates the full constraints with zod after the model answers", () => {
    expect(schema.safeParse({ id: "", count: 1, ratio: 0.5, kind: "A", note: null, items: [], flag: true }).success).toBe(false);
  });

  it("expresses unions of objects as anyOf, never oneOf", () => {
    const json = toStructuredSchema(z.object({ v: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]) }));
    expect(JSON.stringify(json)).toContain("anyOf");
    expect(JSON.stringify(json)).not.toContain("oneOf");
  });
});

describe("structured output limits", () => {
  it("counts optional properties and unions", () => {
    const json = toStructuredSchema(z.object({ a: z.string().optional(), b: z.string().nullable(), c: z.string() }));
    expect(countSchemaComplexity(json)).toEqual({ optionalProperties: 1, unions: 1 });
  });

  it("rejects a schema over the documented limits instead of failing at the API", () => {
    const wide = z.object(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, z.string().optional()])));
    expect(() => assertWithinStructuredLimits(toStructuredSchema(wide), "wide")).toThrow(StructuredSchemaError);
    const unions = z.object(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, z.string().nullable()])));
    expect(() => assertWithinStructuredLimits(toStructuredSchema(unions), "unions")).toThrow(/anyOf|union/i);
  });

  it("accepts the existing stored output schemas as a conversion input", () => {
    // The stored analysis schema is richer than what the model fills in, but it must still convert cleanly.
    expect(() => toStructuredSchema(analysisOutputSchema)).not.toThrow();
  });
});
