import { PostHog } from "posthog-node";

import { trackingEventSchema } from "@agentic-funnel/shared";

import { workerEnv } from "./env";

let posthogClient: PostHog | undefined;

export function getPosthogClient() {
  if (!workerEnv.PUBLIC_POSTHOG_KEY) {
    return null;
  }
  if (!posthogClient) {
    posthogClient = new PostHog(workerEnv.PUBLIC_POSTHOG_KEY, {
      host: workerEnv.PUBLIC_POSTHOG_HOST
    });
  }

  return posthogClient;
}

export async function dispatchPosthogEvent(payload: Record<string, unknown>) {
  const parsed = trackingEventSchema.parse(payload);
  const client = getPosthogClient();
  if (!client) return;

  client.capture({
    event: parsed.event,
    distinctId: parsed.distinctId,
    timestamp: new Date(parsed.timestamp),
    properties: {
      ...parsed.properties,
      $insert_id: parsed.eventId,
      ...(parsed.set ? { $set: parsed.set } : {}),
      ...(parsed.setOnce ? { $set_once: parsed.setOnce } : {}),
      // PostHog reserved key — when the same anonymousId later identifies
      // (client-side), PostHog automatically merges this server event's
      // anonymous person into the identified person. Distinct from the plain
      // `anonymous_id` we used to send (which PostHog ignored for stitching).
      ...(parsed.anonymousId && parsed.anonymousId !== parsed.distinctId
        ? { $anon_distinct_id: parsed.anonymousId }
        : {})
    }
  });
}

export async function shutdownPosthogClient() {
  if (!posthogClient) return;
  await posthogClient.shutdown();
  posthogClient = undefined;
}
