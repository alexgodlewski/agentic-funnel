import { schema } from "@agentic-funnel/db";
import type {
  HyrosLeadPayload,
  HyrosOrderPayload,
  MetaCustomData,
  MetaEventName,
  MetaEventPayload,
  MetaUserData,
  TrackingEvent
} from "@agentic-funnel/shared";
import {
  hashMetaEmail,
  hashMetaExternalId,
  hashMetaName,
  hashMetaPhone,
  hyrosLeadPayloadSchema,
  hyrosOrderPayloadSchema,
  metaEventId,
  metaEventPayloadSchema,
  trackingEventSchema
} from "@agentic-funnel/shared";

import type { AppDbTx } from "../db";
import { extractClientMeta } from "../request-meta";

type OutboxInsert = {
  aggregateType: string;
  aggregateId: string;
  channel: "posthog" | "meta" | "mailgun" | "internal" | "mailerlite" | "hyros";
  eventName: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  availableAt?: Date;
};

export async function enqueueOutboxEvents(tx: AppDbTx, events: OutboxInsert[]) {
  if (events.length === 0) {
    return;
  }

  await tx
    .insert(schema.outboxEvents)
    .values(
      events.map((event) => ({
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        channel: event.channel,
        eventName: event.eventName,
        dedupeKey: event.dedupeKey,
        payload: event.payload,
        availableAt: event.availableAt ?? new Date()
      }))
    )
    .onConflictDoNothing({ target: schema.outboxEvents.dedupeKey });
}

export function buildTrackingOutboxEvent(input: {
  aggregateType: string;
  aggregateId: string;
  dedupeKey: string;
  event: TrackingEvent;
}) {
  return {
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    channel: "posthog" as const,
    eventName: input.event.event,
    dedupeKey: input.dedupeKey,
    payload: trackingEventSchema.parse(input.event) as Record<string, unknown>
  };
}

type MetaLeadInfo = {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

type BuildMetaOutboxEventInput = {
  aggregateType: string;
  aggregateId: string;
  eventScope: string;
  eventKey: string;
  eventId?: string;
  eventName: MetaEventName;
  eventTimeMs?: number;
  eventSourceUrl?: string;
  lead?: MetaLeadInfo;
  externalId?: string;
  request?: Request;
  fbc?: string;
  fbp?: string;
  ip?: string;
  userAgent?: string;
  customData?: MetaCustomData;
};

export async function buildMetaOutboxEvent(input: BuildMetaOutboxEventInput) {
  const eventId = input.eventId ?? metaEventId(input.eventScope, input.eventKey);
  const dedupeKey = `meta:${eventId}`;
  const eventTime = Math.floor((input.eventTimeMs ?? Date.now()) / 1000);

  const userData: MetaUserData = {};

  if (input.lead?.email) {
    userData.em = [await hashMetaEmail(input.lead.email)];
  }
  if (input.lead?.phone) {
    userData.ph = [await hashMetaPhone(input.lead.phone)];
  }
  if (input.lead?.firstName) {
    userData.fn = [await hashMetaName(input.lead.firstName)];
  }
  if (input.lead?.lastName) {
    userData.ln = [await hashMetaName(input.lead.lastName)];
  }
  if (input.externalId) {
    userData.external_id = [await hashMetaExternalId(input.externalId)];
  }

  const requestMeta = input.request ? extractClientMeta(input.request) : undefined;
  const fbc = input.fbc ?? requestMeta?.fbc;
  const fbp = input.fbp ?? requestMeta?.fbp;
  const ip = input.ip ?? requestMeta?.ip;
  const userAgent = input.userAgent ?? requestMeta?.userAgent;

  if (fbc) userData.fbc = fbc;
  if (fbp) userData.fbp = fbp;
  if (ip) userData.client_ip_address = ip;
  if (userAgent) userData.client_user_agent = userAgent;

  const payload: MetaEventPayload = {
    eventName: input.eventName,
    eventId,
    eventTime,
    actionSource: "website",
    eventSourceUrl: input.eventSourceUrl,
    userData,
    customData: input.customData
  };

  return {
    eventId,
    dedupeKey,
    outbox: {
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      channel: "meta" as const,
      eventName: input.eventName,
      dedupeKey,
      payload: metaEventPayloadSchema.parse(payload) as Record<string, unknown>
    }
  };
}

export type MailerliteEventName =
  | "subscriber.upsert"
  | "cart.upsert"
  | "order.upsert"
  | "subscriber.group.assign"
  | "subscriber.group.unassign";

export function buildMailerliteOutboxEvent(input: {
  aggregateType: string;
  aggregateId: string;
  dedupeKey: string;
  eventName: MailerliteEventName;
  payload: Record<string, unknown>;
}): OutboxInsert {
  return {
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    channel: "mailerlite",
    eventName: input.eventName,
    dedupeKey: input.dedupeKey,
    payload: input.payload
  };
}

export function buildHyrosOrderOutboxEvent(input: {
  aggregateType: string;
  aggregateId: string;
  dedupeKey: string;
  payload: HyrosOrderPayload;
}): OutboxInsert {
  return {
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    channel: "hyros",
    eventName: "order.send",
    dedupeKey: input.dedupeKey,
    payload: hyrosOrderPayloadSchema.parse(input.payload) as Record<string, unknown>
  };
}

export function buildHyrosLeadOutboxEvent(input: {
  aggregateType: string;
  aggregateId: string;
  dedupeKey: string;
  payload: HyrosLeadPayload;
}): OutboxInsert {
  return {
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    channel: "hyros",
    eventName: "lead.send",
    dedupeKey: input.dedupeKey,
    payload: hyrosLeadPayloadSchema.parse(input.payload) as Record<string, unknown>
  };
}
