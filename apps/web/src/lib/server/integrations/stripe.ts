import Stripe from "stripe";

import { webEnv } from "../env";

export const stripe = new Stripe(webEnv.STRIPE_SECRET_KEY, {
  apiVersion: webEnv.STRIPE_API_VERSION as never,
  appInfo: {
    name: "agentic-funnel",
    version: "0.1.0"
  }
});
