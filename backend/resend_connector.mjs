// Replit-only transport. Credentials are handled exclusively by the SDK.
// The VPS uses the portable Resend HTTP adapter or SMTP instead.
import { ReplitConnectors } from "@replit/connectors-sdk";

try {
  const connector = new ReplitConnectors();
  if (process.argv[2] === "ready") {
    const response = await connector.proxy("resend", `/domains/${encodeURIComponent(process.env.MAIL_RESEND_DOMAIN_ID || "")}`, { method: "GET" });
    const body = await response.json();
    console.log(JSON.stringify({ ok: response.ok && body.status === "verified" && body.name === "spiloveure.org" }));
  } else {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 20000) throw new Error("Input too large");
    }
    const response = await connector.proxy("resend", "/emails", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: input,
    });
    const body = await response.json();
    console.log(JSON.stringify({ ok: response.ok && typeof body.id === "string" }));
  }
} catch {
  // No recipient, code, provider response or credential is written to logs.
  console.log(JSON.stringify({ ok: false }));
  process.exitCode = 1;
}
