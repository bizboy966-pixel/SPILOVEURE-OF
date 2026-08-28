/**
 * Expo Router API route — Reverse-proxy for BizTransPay webhooks.
 *
 * Purpose : BizTransPay's webhook manager tests the endpoint via a POST
 * on the raw URL the merchant provides. K8s ingress in this environment
 * routes only `/api/*` to the Python backend, so a URL like
 * `spiloveure.com/api/webhooks/biztranspay` requires the merchant to
 * include `/api/` — which some webhook UIs reject.
 *
 * This file runs inside Expo Router's server (Metro/Node) and forwards
 * every incoming request unchanged to the real backend handler at
 * `http://0.0.0.0:8001/api/webhooks/biztranspay`. Signature verification,
 * timestamp check, replay protection, and event processing all happen in
 * the Python handler — this proxy adds no logic and no security holes.
 *
 * Accepts: POST (real webhooks) + GET/HEAD/OPTIONS (URL validation probes).
 */

const BACKEND = "http://0.0.0.0:8001/api/webhooks/biztranspay";

async function forward(request: Request, method: string): Promise<Response> {
  const body = method === "POST" ? await request.arrayBuffer() : undefined;

  // Preserve all BizTransPay signature/timestamp/event headers.
  const fwdHeaders: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    // Drop hop-by-hop and host headers.
    if (k === "host" || k === "content-length" || k === "connection" || k === "accept-encoding") return;
    fwdHeaders[key] = value;
  });

  try {
    const resp = await fetch(BACKEND, {
      method,
      headers: fwdHeaders,
      body: body as any,
    });
    const respBody = await resp.arrayBuffer();
    // Strip content-encoding since fetch already decoded.
    const outHeaders = new Headers();
    resp.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === "content-encoding" || k === "transfer-encoding" || k === "content-length") return;
      outHeaders.set(key, value);
    });
    return new Response(respBody, { status: resp.status, headers: outHeaders });
  } catch (e: any) {
    return new Response(JSON.stringify({
      ok: false, error: "upstream_unreachable", message: String(e?.message || e),
    }), { status: 502, headers: { "content-type": "application/json" } });
  }
}

export async function POST(request: Request) { return forward(request, "POST"); }
export async function GET(request: Request) { return forward(request, "GET"); }
export async function HEAD(request: Request) { return forward(request, "HEAD"); }
export async function OPTIONS(request: Request) { return forward(request, "OPTIONS"); }
