import { z } from "zod";

export const metaStandardEventNames = [
  "PageView",
  "Lead",
  "AddToCart",
  "InitiateCheckout",
  "AddPaymentInfo",
  "Purchase",
  "ViewContent"
] as const;

export const metaCustomEventNames = [
  "OTO_Viewed",
  "OTO_Accepted",
  "OTO_Rejected",
  "Downsell_Viewed",
  "Downsell_Accepted",
  "Downsell_Rejected"
] as const;

export const metaEventNames = [...metaStandardEventNames, ...metaCustomEventNames] as const;
export type MetaEventName = (typeof metaEventNames)[number];

export const metaEventNameSchema = z.enum(metaEventNames);

export function isMetaStandardEvent(name: string): boolean {
  return (metaStandardEventNames as readonly string[]).includes(name);
}

export function metaEventId(scope: string, key: string): string {
  return `${scope}:${key}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const normalizeMetaEmail = (value: string) => value.trim().toLowerCase();
export const normalizeMetaPhone = (value: string) => value.replace(/[^\d]/g, "");
export const normalizeMetaName = (value: string) => value.trim().toLowerCase();

export async function hashMetaEmail(value: string) {
  return sha256Hex(normalizeMetaEmail(value));
}
export async function hashMetaPhone(value: string) {
  return sha256Hex(normalizeMetaPhone(value));
}
export async function hashMetaName(value: string) {
  return sha256Hex(normalizeMetaName(value));
}
export async function hashMetaExternalId(value: string) {
  return sha256Hex(value);
}

export const metaUserDataSchema = z.object({
  em: z.array(z.string().length(64)).optional(),
  ph: z.array(z.string().length(64)).optional(),
  fn: z.array(z.string().length(64)).optional(),
  ln: z.array(z.string().length(64)).optional(),
  external_id: z.array(z.string().length(64)).optional(),
  fbc: z.string().optional(),
  fbp: z.string().optional(),
  client_ip_address: z.string().optional(),
  client_user_agent: z.string().optional()
});
export type MetaUserData = z.infer<typeof metaUserDataSchema>;

export const metaContentItemSchema = z.object({
  id: z.string(),
  quantity: z.number().int().positive(),
  item_price: z.number().nonnegative()
});

export const metaCustomDataSchema = z
  .object({
    currency: z.string().length(3).optional(),
    value: z.number().nonnegative().optional(),
    content_type: z.enum(["product"]).optional(),
    content_ids: z.array(z.string()).optional(),
    content_name: z.string().optional(),
    contents: z.array(metaContentItemSchema).optional(),
    num_items: z.number().int().nonnegative().optional(),
    funnel_session_id: z.string().optional(),
    checkout_attempt_id: z.string().optional(),
    order_id: z.string().optional(),
    offer_token: z.string().optional()
  })
  .catchall(z.unknown());
export type MetaCustomData = z.infer<typeof metaCustomDataSchema>;

export const metaEventPayloadSchema = z.object({
  eventName: metaEventNameSchema,
  eventId: z.string().trim().min(1),
  eventTime: z.number().int().positive(),
  actionSource: z.literal("website"),
  eventSourceUrl: z.string().url().optional(),
  userData: metaUserDataSchema,
  customData: metaCustomDataSchema.optional()
});
export type MetaEventPayload = z.infer<typeof metaEventPayloadSchema>;
