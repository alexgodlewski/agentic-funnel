# Security Policy

AgenticFunnel handles payments, webhooks, customer records, and signed download links, so please treat security reports with care.

## Reporting a Vulnerability

If you find a vulnerability, please open a private security advisory on GitHub if available for the repository. If advisories are not enabled yet, contact the repository owner privately and include:

- Affected version or commit.
- Steps to reproduce.
- Impact and any data exposure risk.
- Suggested fix, if you have one.

Please do not publish exploit details publicly until a fix is available.

## Sensitive Areas

Pay extra attention to:

- Stripe webhook signature verification.
- PaymentIntent settlement and idempotency.
- Offer and download token signing.
- S3/R2/MinIO object access.
- Outbox retry behavior for email and analytics integrations.
- Environment variable handling.

## Supported Versions

Until the project reaches `1.0.0`, security fixes target the latest commit on `main`.
