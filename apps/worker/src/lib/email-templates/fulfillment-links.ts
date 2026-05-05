// Fulfillment email — inlined HTML + text. Single source of truth for starter copy.

type Asset = { label: string; url: string };

type Input = {
  firstName: string;
  orderId: string;
  assets: Asset[];
};

type Rendered = {
  subject: string;
  html: string;
  text: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

export function renderFulfillmentEmail(input: Input): Rendered {
  const trimmedFirstName = input.firstName.trim();
  const greetingName = trimmedFirstName ? escapeHtml(trimmedFirstName) : null;
  const subject = trimmedFirstName
    ? `${trimmedFirstName}, your files are ready`
    : "Your files are ready";

  const buttons = input.assets
    .map(
      (asset) => `
        <a href="${escapeAttr(asset.url)}"
           style="display:block;background:#ec3a93;color:#ffffff;text-decoration:none;
                  padding:14px 20px;border-radius:12px;font-weight:600;
                  margin-bottom:10px;text-align:center;">
          Download: ${escapeHtml(asset.label)}
        </a>`
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>Your files are ready</title></head>
<body style="font-family:-apple-system,Segoe UI,Inter,Arial,sans-serif;background:#f6f3ee;margin:0;padding:32px 16px;color:#1a0a14;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden;">
    <tr><td style="padding:32px 32px 8px;">
      <h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;font-weight:700;">
        Hi${greetingName ? ` ${greetingName}` : ""},
      </h1>
      <p style="margin:0 0 14px;font-size:16px;line-height:1.55;">
        Thanks for your order. Your digital files are ready below.
      </p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#4a3640;">
        These starter links are active for 7 days. Download the files now so you have a local copy.
      </p>

      <div style="margin:0 0 24px;">${buttons}
      </div>

      <p style="margin:0 0 8px;font-size:13px;color:#766670;">
        Order id: <strong>${escapeHtml(input.orderId)}</strong>
      </p>
      <p style="margin:24px 0 0;font-size:15px;line-height:1.55;">
        If a file does not open or you need help, reply to this email.
      </p>
      <p style="margin:24px 0 0;font-size:15px;line-height:1.55;">
        Thanks,<br/>
        <strong>Your team</strong>
      </p>
    </td></tr>

    <tr><td style="padding:24px 32px;background:#fbf5f0;font-size:12px;color:#766670;line-height:1.5;">
      You are receiving this transactional email because you purchased a digital product.
    </td></tr>
  </table>
</body>
</html>`;

  const textLinks = input.assets.map((a) => `${a.label}: ${a.url}`).join("\n");
  const greetingLine = trimmedFirstName ? `Hi ${trimmedFirstName},` : "Hi,";
  const text = `${greetingLine}

Thanks for your order. Your digital files are ready below.

These starter links are active for 7 days. Download the files now so you have a local copy.

${textLinks}

Order id: ${input.orderId}

If a file does not open or you need help, reply to this email.

Thanks,
Your team`;

  return { subject, html, text };
}
