import { asc, eq } from "drizzle-orm";

import { schema } from "@agentic-funnel/db";

import { db } from "../db";

export async function getThankYouPageData(orderId: string) {
  const [order] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .limit(1);

  if (!order) {
    throw new Error("Order not found");
  }

  const [customer] = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.id, order.customerId))
    .limit(1);

  const [lead] = customer
    ? await db
        .select()
        .from(schema.leads)
        .where(eq(schema.leads.id, customer.leadId))
        .limit(1)
    : [];

  const lines = await db
    .select()
    .from(schema.orderLines)
    .where(eq(schema.orderLines.orderId, order.id))
    .orderBy(asc(schema.orderLines.createdAt));

  const payments = await db
    .select()
    .from(schema.paymentRecords)
    .where(eq(schema.paymentRecords.orderId, order.id))
    .orderBy(asc(schema.paymentRecords.createdAt));

  return {
    order,
    customer,
    lead,
    lines,
    payments
  };
}
