import { isMetaStandardEvent, metaEventPayloadSchema } from "@agentic-funnel/shared";

import { workerEnv } from "./env";

export async function dispatchMetaEvent(payload: Record<string, unknown>) {
  const parsed = metaEventPayloadSchema.parse(payload);
  if (!workerEnv.PUBLIC_META_PIXEL_ID || !workerEnv.META_ACCESS_TOKEN) {
    return;
  }
  const url = new URL(`https://graph.facebook.com/v20.0/${workerEnv.PUBLIC_META_PIXEL_ID}/events`);
  url.searchParams.set("access_token", workerEnv.META_ACCESS_TOKEN);

  const userData = {
    em: parsed.userData.em,
    ph: parsed.userData.ph,
    fn: parsed.userData.fn,
    ln: parsed.userData.ln,
    external_id: parsed.userData.external_id,
    fbc: parsed.userData.fbc,
    fbp: parsed.userData.fbp,
    client_ip_address: parsed.userData.client_ip_address,
    client_user_agent: parsed.userData.client_user_agent
  };

  const eventEntry = {
    event_name: parsed.eventName,
    event_time: parsed.eventTime,
    event_id: parsed.eventId,
    action_source: parsed.actionSource,
    event_source_url: parsed.eventSourceUrl,
    user_data: userData,
    custom_data: parsed.customData,
    custom_event_type: isMetaStandardEvent(parsed.eventName) ? undefined : parsed.eventName
  };

  // Hard-gate `test_event_code` to non-production: a leaked staging value in
  // production silently routes every CAPI event to Meta's test feed, where it
  // doesn't count toward optimisation. NODE_ENV is the canonical signal.
  const testEventCode =
    workerEnv.NODE_ENV === "production"
      ? undefined
      : workerEnv.META_TEST_EVENT_CODE || undefined;
  const body = {
    data: [eventEntry],
    test_event_code: testEventCode
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Meta CAPI request failed with ${response.status}: ${errorBody}`);
  }
}
