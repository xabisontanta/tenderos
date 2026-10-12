/**
 * A chainable stand-in for the parts of supabase-js that server actions use, for unit tests. Every
 * `.from(table)...` chain is recorded as one Call and answered by the handler, so a test can describe a
 * small in-memory database (including a unique index) without a real one.
 */
export interface FakeError {
  code?: string;
  message: string;
}
export interface FakeResult {
  data: unknown;
  error: FakeError | null;
}
export interface Call {
  table: string;
  op: "select" | "insert" | "update" | "delete" | "upsert";
  payload?: unknown;
  filters: Array<{ kind: "eq" | "is" | "in" | "neq"; column: string; value: unknown }>;
  /** `.select()` was chained after a write, asking for the written rows back. */
  returning: boolean;
  single: "one" | "maybe" | null;
}
export type Handler = (call: Call) => FakeResult | Promise<FakeResult>;
export type RpcHandler = (name: string, args: Record<string, unknown> | undefined) => FakeResult | Promise<FakeResult>;

const WRITES = new Set(["insert", "update", "delete", "upsert"]);

export function fakeSupabase(
  handler: Handler,
  rpc: RpcHandler = () => ({ data: null, error: null }),
  storage?: { download: (path: string) => Promise<FakeResult> },
) {
  const calls: Call[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> | undefined }> = [];

  function builder(table: string) {
    const call: Call = { table, op: "select", filters: [], returning: false, single: null };
    const chain: Record<string, unknown> = {};
    const proxy: unknown = new Proxy(chain, {
      get(_, prop: string) {
        if (prop === "then") {
          calls.push(call);
          return (resolve: (v: FakeResult) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(handler(call)).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          if (WRITES.has(prop)) {
            call.op = prop as Call["op"];
            call.payload = args[0];
          } else if (prop === "select") {
            if (call.op !== "select") call.returning = true;
          } else if (prop === "eq" || prop === "is" || prop === "in" || prop === "neq") {
            call.filters.push({ kind: prop, column: String(args[0]), value: args[1] });
          } else if (prop === "single") call.single = "one";
          else if (prop === "maybeSingle") call.single = "maybe";
          return proxy;
        };
      },
    });
    return proxy;
  }

  const client = {
    from: (table: string) => builder(table),
    rpc: async (name: string, args?: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return rpc(name, args);
    },
    storage: {
      from: () => ({ download: (path: string) => (storage ? storage.download(path) : Promise.resolve({ data: null, error: { message: "no storage" } })) }),
    },
  };
  return { client, calls, rpcCalls };
}

/** The value of an `.eq(column, value)` filter on a call. */
export function eq(call: Call, column: string): unknown {
  return call.filters.find((f) => f.kind === "eq" && f.column === column)?.value;
}
