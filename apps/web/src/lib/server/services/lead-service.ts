import { eq } from "drizzle-orm";

import { schema } from "@agentic-funnel/db";
import {
  leadCaptureInputSchema,
  type LeadIdentity,
  type MarketingConsent
} from "@agentic-funnel/shared";
import { normalizeEmail } from "@agentic-funnel/shared/crypto";

import { buildCheckoutQuote } from "../../config/funnels";
import { db } from "../db";
import { webEnv } from "../env";
import { extractClientMeta } from "../request-meta";
import {
  buildHyrosLeadOutboxEvent,
  buildMailerliteOutboxEvent,
  buildMetaOutboxEvent,
  buildTrackingOutboxEvent,
  enqueueOutboxEvents
} from "./outbox-service";

// PostHog distinct_id is the buyer's anonymous_id (set by middleware as
// `lts.anonymous_id` cookie). Falling back to `lead:<id>` covers legacy leads
// that pre-date the middleware so events still land on a stable person.
function distinctIdForLead(lead: { id: string; anonymousId: string | null | undefined }) {
  return lead.anonymousId ?? `lead:${lead.id}`;
}

export async function captureLead(
  input: {
    identity: LeadIdentity;
    consent: MarketingConsent;
  },
  request?: Request
) {
  const parsed = leadCaptureInputSchema.parse(input);
  const normalizedEmail = normalizeEmail(parsed.identity.email);
  const checkoutQuote = buildCheckoutQuote(parsed.identity.funnelKey, []);

  const result = await db.transaction(async (tx) => {
    const [existingLead] = await tx
      .select()
      .from(schema.leads)
      .where(eq(schema.leads.normalizedEmail, normalizedEmail))
      .limit(1);

    const lead =
      existingLead ??
      (
        await tx
          .insert(schema.leads)
          .values({
            email: parsed.identity.email,
            normalizedEmail,
            firstName: parsed.identity.firstName,
            lastName: parsed.identity.lastName,
            phone: parsed.identity.phone,
            anonymousId: parsed.identity.anonymousId,
            sourcePage: parsed.identity.sourcePage,
            funnelKey: parsed.identity.funnelKey,
            utm: parsed.identity.utm ?? {},
            metadata: {}
          })
          .returning()
      )[0];

    if (existingLead) {
      await tx
        .update(schema.leads)
        .set({
          email: parsed.identity.email,
          firstName: parsed.identity.firstName ?? existingLead.firstName,
          lastName: parsed.identity.lastName ?? existingLead.lastName,
          phone: parsed.identity.phone ?? existingLead.phone,
          anonymousId: parsed.identity.anonymousId ?? existingLead.anonymousId,
          sourcePage: parsed.identity.sourcePage,
          funnelKey: parsed.identity.funnelKey,
          utm: parsed.identity.utm ?? existingLead.utm,
          updatedAt: new Date()
        })
        .where(eq(schema.leads.id, existingLead.id));
    }

    await tx.insert(schema.marketingConsents).values({
      leadId: lead.id,
      status: parsed.consent.status,
      sourcePage: parsed.consent.sourcePage,
      ipHash: parsed.consent.ipHash,
      userAgentHash: parsed.consent.userAgentHash,
      capturedAt: new Date(parsed.consent.timestamp)
    });

    const [funnelSession] = await tx
      .insert(schema.funnelSessions)
      .values({
        leadId: lead.id,
        anonymousId: parsed.identity.anonymousId,
        funnelKey: parsed.identity.funnelKey,
        status: "lead_captured",
        priceSnapshot: checkoutQuote,
        offerSnapshot: checkoutQuote.offerSnapshot,
        firstTouch: parsed.identity.utm ?? {},
        lastTouch: parsed.identity.utm ?? {}
      })
      .returning();

    const nowIso = new Date().toISOString();
    const utmFlat = parsed.identity.utm
      ? Object.fromEntries(
          Object.entries(parsed.identity.utm).filter(([, value]) => value !== undefined)
        )
      : {};
    await enqueueOutboxEvents(tx, [
      buildTrackingOutboxEvent({
        aggregateType: "lead",
        aggregateId: lead.id,
        dedupeKey: `posthog:Lead Submitted:${funnelSession.id}`,
        event: {
          event: "Lead Submitted",
          eventId: `Lead Submitted:${funnelSession.id}`,
          distinctId: distinctIdForLead({ id: lead.id, anonymousId: parsed.identity.anonymousId }),
          anonymousId: parsed.identity.anonymousId,
          timestamp: nowIso,
          properties: {
            lead_id: lead.id,
            funnel_session_id: funnelSession.id,
            funnel_key: parsed.identity.funnelKey,
            source_page: parsed.identity.sourcePage
          },
          set: {
            email: parsed.identity.email,
            funnel_key: parsed.identity.funnelKey,
            lead_id: lead.id,
            last_seen_at: nowIso,
            // Optional identity fields are omitted when absent so a repeat
            // lead capture without these doesn't null-out previously enriched
            // person properties in PostHog.
            ...(parsed.identity.firstName ? { first_name: parsed.identity.firstName } : {}),
            ...(parsed.identity.lastName ? { last_name: parsed.identity.lastName } : {}),
            ...(parsed.identity.phone ? { phone: parsed.identity.phone } : {})
          },
          setOnce: {
            first_seen_at: nowIso,
            first_landing_path: parsed.identity.sourcePage,
            first_funnel_key: parsed.identity.funnelKey,
            ...(utmFlat.source ? { first_utm_source: utmFlat.source } : {}),
            ...(utmFlat.medium ? { first_utm_medium: utmFlat.medium } : {}),
            ...(utmFlat.campaign ? { first_utm_campaign: utmFlat.campaign } : {}),
            ...(utmFlat.term ? { first_utm_term: utmFlat.term } : {}),
            ...(utmFlat.content ? { first_utm_content: utmFlat.content } : {})
          }
        }
      }),
      ...(parsed.consent.status === "granted"
        ? [
            buildMailerliteOutboxEvent({
              aggregateType: "lead",
              aggregateId: lead.id,
              dedupeKey: `mailerlite:subscriber:${lead.id}`,
              eventName: "subscriber.upsert",
              payload: {
                email: parsed.identity.email,
                firstName: parsed.identity.firstName ?? null,
                fields: {
                  funnel_key: parsed.identity.funnelKey,
                  source_page: parsed.identity.sourcePage,
                  anonymous_id: parsed.identity.anonymousId ?? "",
                  locale: "pl"
                },
                groupKeys: ["leads_all"]
              }
            })
          ]
        : [])
    ]);

    return {
      lead,
      funnelSessionId: funnelSession.id
    };
  });

  // Skip the Meta Lead outbox event (and the client `lead` event id) when the
  // email is the `anon-<id>@checkout.local` placeholder the checkout client
  // mints to mount the Payment Element before the buyer types anything. Hashing
  // a fake email and shipping it to Meta as `em` poisons EMQ for that lead.
  // When the user upgrades to a real email, captureLead is called again and
  // the real Lead event ships then.
  const isPlaceholderLeadEmail =
    /^anon-[^@]+@checkout\.local$/i.test(result.lead.email);

  if (isPlaceholderLeadEmail) {
    return {
      leadId: result.lead.id,
      funnelSessionId: result.funnelSessionId,
      metaEventIds: {}
    };
  }

  const metaLead = await buildMetaOutboxEvent({
    aggregateType: "lead",
    aggregateId: result.lead.id,
    eventScope: "lead",
    eventKey: result.lead.id,
    eventName: "Lead",
    eventSourceUrl: `${webEnv.PUBLIC_APP_URL}${parsed.identity.sourcePage}`,
    lead: {
      email: result.lead.email,
      phone: result.lead.phone,
      firstName: result.lead.firstName,
      lastName: result.lead.lastName
    },
    externalId: result.lead.id,
    request,
    customData: {
      funnel_session_id: result.funnelSessionId
    }
  });

  // Hyros lead — POST once per lead so Hyros can stitch the click that brought
  // them in to this email/identity before the purchase fires. Identity-matched
  // by email; we also pass leadIps so Hyros can correlate by IP if email
  // matching falls short. Dedupe on `hyros:lead:${lead.id}` so a returning lead
  // re-submitting doesn't blast Hyros — Meta Lead still re-fires for EMQ.
  const clientMeta = request ? extractClientMeta(request) : undefined;
  const hyrosLead = buildHyrosLeadOutboxEvent({
    aggregateType: "lead",
    aggregateId: result.lead.id,
    dedupeKey: `hyros:lead:${result.lead.id}`,
    payload: {
      email: result.lead.email,
      ...(result.lead.phone ? { phoneNumbers: [result.lead.phone] } : {}),
      ...(result.lead.firstName ? { firstName: result.lead.firstName } : {}),
      ...(result.lead.lastName ? { lastName: result.lead.lastName } : {}),
      ...(clientMeta?.ip ? { leadIps: [clientMeta.ip] } : {}),
      date: new Date().toISOString()
    }
  });

  await db.transaction(async (tx) => {
    await enqueueOutboxEvents(tx, [metaLead.outbox, hyrosLead]);
  });

  return {
    leadId: result.lead.id,
    funnelSessionId: result.funnelSessionId,
    metaEventIds: {
      lead: metaLead.eventId
    }
  };
}
