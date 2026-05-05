import { mailJobPayloadSchema } from "@agentic-funnel/shared";

import { workerEnv } from "./env";

function authHeader() {
  const token = Buffer.from(`api:${workerEnv.MAILGUN_API_KEY}`).toString("base64");
  return `Basic ${token}`;
}

export async function sendMailgunMessage(payload: Record<string, unknown>) {
  const parsed = mailJobPayloadSchema.parse(payload);
  if (!workerEnv.MAILGUN_API_KEY || !workerEnv.MAILGUN_DOMAIN_TX || !workerEnv.MAILGUN_FROM_TX) {
    return;
  }
  const url = `${workerEnv.MAILGUN_API_BASE}/v3/${workerEnv.MAILGUN_DOMAIN_TX}/messages`;
  const form = new URLSearchParams();

  form.set("from", workerEnv.MAILGUN_FROM_TX);
  form.set("to", parsed.to);
  form.set("subject", parsed.subject);
  form.set("html", parsed.html);
  form.set("text", parsed.text);
  if (workerEnv.MAILGUN_REPLY_TO) {
    form.set("h:Reply-To", workerEnv.MAILGUN_REPLY_TO);
  }
  if (parsed.tags.length > 0) {
    form.set("o:tag", parsed.tags.join(","));
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "content-type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Mailgun send failed with ${response.status}: ${body}`);
  }
}
