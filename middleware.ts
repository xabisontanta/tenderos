import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { buildCsp, STATIC_SECURITY_HEADERS } from "@/lib/security/csp";

export async function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce, process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321", process.env.NODE_ENV !== "production");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = await updateSession(request, requestHeaders);
  response.headers.set("Content-Security-Policy", csp);
  for (const [k, v] of Object.entries(STATIC_SECURITY_HEADERS)) response.headers.set(k, v);
  if (process.env.NODE_ENV === "production") {
    response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and image optimisation.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
