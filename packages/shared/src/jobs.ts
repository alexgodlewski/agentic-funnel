export const JOB_NAMES = {
  DISPATCH_OUTBOX: "outbox.dispatch",
  EXPIRE_FUNNEL: "funnel.expire",
  SEND_FULFILLMENT_EMAIL: "mail.fulfillment.send"
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];
