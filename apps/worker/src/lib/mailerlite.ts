import { workerEnv } from "./env";

const ML_API_BASE = "https://connect.mailerlite.com/api";

let cachedGroupMap: Record<string, string> | null = null;
let warnedNoToken = false;

function groupMap(): Record<string, string> {
  if (cachedGroupMap) return cachedGroupMap;
  if (!workerEnv.MAILERLITE_GROUPS_JSON) {
    cachedGroupMap = {};
    return cachedGroupMap;
  }
  try {
    cachedGroupMap = JSON.parse(workerEnv.MAILERLITE_GROUPS_JSON) as Record<string, string>;
  } catch (error) {
    console.warn("[mailerlite] MAILERLITE_GROUPS_JSON is not valid JSON:", error);
    cachedGroupMap = {};
  }
  return cachedGroupMap;
}

export function resolveGroupId(key: string): string | null {
  const id = groupMap()[key];
  if (!id) {
    console.warn(`[mailerlite] missing group id for key "${key}" in MAILERLITE_GROUPS_JSON`);
    return null;
  }
  return id;
}

function isConfigured(): boolean {
  if (workerEnv.MAILERLITE_API_TOKEN) return true;
  if (!warnedNoToken) {
    console.warn("[mailerlite] MAILERLITE_API_TOKEN unset — ML pushes are no-ops");
    warnedNoToken = true;
  }
  return false;
}

async function mlFetch(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) {
  const response = await fetch(`${ML_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${workerEnv.MAILERLITE_API_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`MailerLite ${method} ${path} failed ${response.status}: ${text.slice(0, 400)}`);
  }

  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

export type MlSubscriberUpsert = {
  email: string;
  firstName?: string | null;
  fields?: Record<string, string | number | null | undefined>;
  groupKeys?: string[];
};

export async function mlUpsertSubscriber(input: MlSubscriberUpsert): Promise<{ id: string } | null> {
  if (!isConfigured()) return null;

  const fields: Record<string, string> = {};
  if (input.firstName) fields.name = input.firstName;
  for (const [key, value] of Object.entries(input.fields ?? {})) {
    if (value === null || value === undefined || value === "") continue;
    fields[key] = String(value);
  }

  const groupIds = (input.groupKeys ?? [])
    .map((key) => resolveGroupId(key))
    .filter((id): id is string => Boolean(id));

  const body: Record<string, unknown> = {
    email: input.email,
    fields,
    status: "active"
  };
  if (groupIds.length > 0) body.groups = groupIds;

  const response = (await mlFetch("POST", "/subscribers", body)) as { data?: { id?: string } } | null;
  return response?.data?.id ? { id: response.data.id } : null;
}

export type MlCartItem = {
  product_id: string;
  name: string;
  price: number;
  quantity: number;
  url?: string;
};

export type MlCartUpsert = {
  id: string;
  email: string;
  items: MlCartItem[];
  total: number;
  currency: string;
};

export async function mlUpsertCart(input: MlCartUpsert): Promise<void> {
  if (!isConfigured()) return;
  const shop = workerEnv.MAILERLITE_SHOP_ID;
  if (!shop) {
    console.warn("[mailerlite] MAILERLITE_SHOP_ID unset — skipping cart upsert");
    return;
  }

  await mlFetch("POST", `/ecommerce/shops/${shop}/carts`, {
    id: input.id,
    customer: { email: input.email },
    currency: input.currency.toUpperCase(),
    total: input.total,
    items: input.items
  });
}

export type MlOrderItem = MlCartItem;

export type MlOrderUpsert = {
  id: string;
  email: string;
  items: MlOrderItem[];
  total: number;
  currency: string;
  status?: "complete" | "cancelled";
};

export async function mlUpsertOrder(input: MlOrderUpsert): Promise<void> {
  if (!isConfigured()) return;
  const shop = workerEnv.MAILERLITE_SHOP_ID;
  if (!shop) {
    console.warn("[mailerlite] MAILERLITE_SHOP_ID unset — skipping order upsert");
    return;
  }

  await mlFetch("POST", `/ecommerce/shops/${shop}/orders`, {
    id: input.id,
    customer: { email: input.email },
    currency: input.currency.toUpperCase(),
    total: input.total,
    status: input.status ?? "complete",
    items: input.items
  });
}

async function getSubscriberIdByEmail(email: string): Promise<string | null> {
  if (!isConfigured()) return null;
  const response = (await mlFetch("GET", `/subscribers/${encodeURIComponent(email)}`)) as
    | { data?: { id?: string } }
    | null;
  return response?.data?.id ?? null;
}

export async function mlAssignGroup(email: string, groupKey: string): Promise<void> {
  if (!isConfigured()) return;
  const groupId = resolveGroupId(groupKey);
  if (!groupId) return;

  const subscriberId = await getSubscriberIdByEmail(email);
  if (!subscriberId) {
    console.warn(`[mailerlite] cannot assign group ${groupKey} — subscriber not found for ${email}`);
    return;
  }

  await mlFetch("POST", `/subscribers/${subscriberId}/groups/${groupId}`);
}

export async function mlUnassignGroup(email: string, groupKey: string): Promise<void> {
  if (!isConfigured()) return;
  const groupId = resolveGroupId(groupKey);
  if (!groupId) return;

  const subscriberId = await getSubscriberIdByEmail(email);
  if (!subscriberId) return;

  await mlFetch("DELETE", `/subscribers/${subscriberId}/groups/${groupId}`);
}
