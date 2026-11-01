import { describe, expect, it } from "vitest";
import {
  createEvent,
  easybuyItemCreated,
  easybuyPaymentApproved,
  easybuyRepaymentDue,
  easybuyRequestApproved,
  easybuyRequestRejected,
  easybuyRequestSubmitted,
  resellerChatMessagePosted,
  resellerPayoutPaid,
  storeOrderCancelled,
  storeOrderCompleted,
  storeOrderPaid,
  type EventEnvelope,
} from "@melvingadgets/platform-kit";
import { composeNotification, formatDueDate, formatNaira } from "../Notifications/compose.js";

// Unit tests for the text each event becomes (Shortwork/docs/notifications.md §3). Events are
// built with the kit's own createEvent, so every envelope here passes the real contract.

const PERSON = "6720a1b2c3d4e5f6a7b8c9d0";
const meta = (kind: string, id: string) => ({ subject: { kind, id, personId: PERSON }, seq: 1, traceId: "trace-notify-test" });

const events = {
  submitted: createEvent(easybuyRequestSubmitted, {
    ...meta("request", "req-1"),
    data: { requestId: "req-1", personId: PERSON, provider: "Apple", model: "iPhone 15 Pro", capacity: "256GB", plan: "Monthly" },
  }),
  approved: createEvent(easybuyRequestApproved, { ...meta("request", "req-1"), data: { requestId: "req-1", personId: PERSON } }),
  rejected: createEvent(easybuyRequestRejected, { ...meta("request", "req-1"), data: { requestId: "req-1", personId: PERSON } }),
  financed: createEvent(easybuyItemCreated, {
    ...meta("item", "item-1"),
    data: {
      itemId: "item-1",
      requestId: "req-1",
      personId: PERSON,
      provider: "Apple",
      model: "iPhone 15 Pro",
      capacity: "256GB",
      plan: "Weekly",
      phonePriceKobo: 120_000_000,
      downPaymentKobo: 40_000_000,
      financedKobo: 80_000_000,
      serviceFeeKobo: 6_400_000,
      serviceFeeBps: 800,
    },
  }),
  paid: createEvent(easybuyPaymentApproved, {
    ...meta("receipt", "rcpt-1"),
    data: {
      receiptId: "rcpt-1",
      personId: PERSON,
      itemId: "item-1",
      amountKobo: 2_500_050,
      plan: "Weekly",
      method: "bank_transfer",
      approvedAt: "2026-11-01T09:00:00.000+01:00",
    },
  }),
  orderPaid: createEvent(storeOrderPaid, {
    ...meta("order", "ord-1"),
    data: {
      orderId: "ord-1",
      personId: PERSON,
      items: [
        { name: "AirPods Pro", quantity: 2, priceKobo: 30_000_000 },
        { name: "USB-C cable", quantity: 1, priceKobo: 1_500_000 },
      ],
      subtotalKobo: 61_500_000,
      deliveryFeeKobo: 300_000,
      serviceFeeKobo: 750_000,
      totalKobo: 62_550_000,
    },
  }),
  orderCompleted: createEvent(storeOrderCompleted, {
    ...meta("order", "ord-1"),
    data: { orderId: "ord-1", personId: PERSON, serviceFeeKobo: 750_000 },
  }),
  payout: createEvent(resellerPayoutPaid, {
    subject: { kind: "payout", id: "batch-1", personId: PERSON },
    seq: 1,
    traceId: "trace-notify-test",
    data: {
      batchId: "batch-1",
      resellerPersonId: PERSON,
      weekEnding: "2026-11-01T00:00:00.000+01:00",
      totalKobo: 1_234_500,
      entryCount: 3,
      reference: "TRF-001",
      paidAt: "2026-11-01T10:00:00.000+01:00",
    },
  }),
};

const reminder = (stage: "upcoming" | "due" | "overdue", amountKobo = 16_000_000, dueOn = "2026-11-08") =>
  createEvent(easybuyRepaymentDue, {
    ...meta("instalment", "item-1:2"),
    data: { itemId: "item-1", personId: PERSON, instalment: 2, dueOn, amountKobo, stage },
  });

const cancelled = (reason: "rejected_at_delivery" | "cancelled" | "refunded") =>
  createEvent(storeOrderCancelled, { ...meta("order", "ord-1"), data: { orderId: "ord-1", personId: PERSON, reason } });

describe("formatNaira", () => {
  it("groups thousands and drops a zero kobo part", () => {
    expect(formatNaira(2_500_000)).toBe("₦25,000");
    expect(formatNaira(2_500_050)).toBe("₦25,000.50");
    expect(formatNaira(123_456_789_00)).toBe("₦123,456,789");
    expect(formatNaira(5)).toBe("₦0.05");
    expect(formatNaira(0)).toBe("₦0");
  });

  it("refuses a fractional kobo amount instead of rounding it silently", () => {
    expect(() => formatNaira(10.5)).toThrow();
  });
});

describe("formatDueDate", () => {
  it("writes a calendar date plainly, with no leading zero", () => {
    expect(formatDueDate("2026-11-08")).toBe("8 Nov 2026");
    expect(formatDueDate("2027-01-31")).toBe("31 Jan 2027");
    expect(formatDueDate("2028-02-29")).toBe("29 Feb 2028");
    expect(formatDueDate("2026-12-01")).toBe("1 Dec 2026");
  });

  it("gives the same day in any server timezone, because it never builds a Date", () => {
    const was = process.env.TZ;
    try {
      for (const zone of ["Pacific/Honolulu", "Pacific/Kiritimati", "UTC"]) {
        process.env.TZ = zone;
        expect(formatDueDate("2026-11-08")).toBe("8 Nov 2026");
      }
    } finally {
      process.env.TZ = was;
    }
  });
});

describe("composeNotification", () => {
  it("announces each application step to the applicant and opens Profile", () => {
    expect(composeNotification(events.submitted)).toEqual({
      personId: PERSON,
      category: "easybuy.application",
      app: "Profile",
      title: "Application received",
      body: "Your EasyBuy application for iPhone 15 Pro 256GB on a monthly plan is in. We'll let you know when it's reviewed.",
    });
    expect(composeNotification(events.approved)).toMatchObject({ personId: PERSON, app: "Profile", title: "Application approved" });
    expect(composeNotification(events.rejected)).toMatchObject({ personId: PERSON, app: "Profile", title: "Application update" });
  });

  it("states financed and paid amounts in naira, from kobo, and opens the EasyBuy portal", () => {
    expect(composeNotification(events.financed)).toMatchObject({
      category: "easybuy.finance",
      app: "Easybuy Portal",
      title: "Device financed",
      body: "Your iPhone 15 Pro 256GB is financed: ₦800,000 on a weekly plan. Your receipt is in Profile → Documents.",
    });
    expect(composeNotification(events.paid)).toMatchObject({
      app: "Easybuy Portal",
      title: "Payment confirmed",
      body: "We received your EasyBuy payment of ₦25,000.50. Thank you.",
    });
  });

  it("reminds about a repayment with its naira amount and due date, in the EasyBuy portal", () => {
    expect(composeNotification(reminder("upcoming"))).toEqual({
      personId: PERSON,
      category: "easybuy.finance",
      app: "Easybuy Portal",
      title: "Repayment due soon",
      body: "Your EasyBuy instalment of ₦160,000 is due on 8 Nov 2026.",
    });
    expect(composeNotification(reminder("due"))).toEqual({
      personId: PERSON,
      category: "easybuy.finance",
      app: "Easybuy Portal",
      title: "Repayment due today",
      body: "Your EasyBuy instalment of ₦160,000 is due today, 8 Nov 2026.",
    });
    expect(composeNotification(reminder("overdue"))).toEqual({
      personId: PERSON,
      category: "easybuy.finance",
      app: "Easybuy Portal",
      title: "Repayment overdue",
      body: "Your EasyBuy instalment of ₦160,000 was due on 8 Nov 2026. Please pay as soon as you can.",
    });
  });

  it("shows kobo when a part-paid instalment leaves some", () => {
    expect(composeNotification(reminder("due", 10_000_050))?.body).toBe("Your EasyBuy instalment of ₦100,000.50 is due today, 8 Nov 2026.");
  });

  it("counts order quantities, not lines, and opens the store", () => {
    expect(composeNotification(events.orderPaid)).toMatchObject({
      category: "store.order",
      app: "Recommerce Store",
      title: "Order confirmed",
      body: "Your order of 3 items is paid: ₦625,500.",
    });
    expect(composeNotification(events.orderCompleted)).toMatchObject({ app: "Recommerce Store", title: "Order delivered" });
  });

  it("names how an order ended", () => {
    expect(composeNotification(cancelled("refunded"))).toMatchObject({ title: "Order refunded", body: "Your order was refunded." });
    expect(composeNotification(cancelled("rejected_at_delivery"))).toMatchObject({ title: "Order returned" });
    expect(composeNotification(cancelled("cancelled"))).toMatchObject({ title: "Order cancelled" });
  });

  it("addresses a payout to the reseller and opens the Reseller app", () => {
    expect(composeNotification(events.payout)).toEqual({
      personId: PERSON,
      category: "reseller.payout",
      app: "Reseller",
      title: "Payout sent",
      body: "₦12,345 for 3 commissions is on its way to your bank.",
    });
  });

  it("tells the other side of a chat that a message is waiting, without its text, one notice per conversation", () => {
    const chat = (from: "customer" | "reseller", recipientPersonId: string, seq: number) =>
      createEvent(resellerChatMessagePosted, {
        subject: { kind: "conversation", id: "conv-7" },
        seq,
        traceId: "trace-notify-test",
        data: { conversationId: "conv-7", seq, from, recipientPersonId },
      });
    expect(composeNotification(chat("reseller", PERSON, 3))).toEqual({
      personId: PERSON,
      category: "reseller.chat",
      app: "Chat",
      title: "New message",
      body: "Your reseller replied.",
      collapse: { id: `chat:${PERSON}:conv-7`, seq: 3, manySuffix: " new messages from your reseller.", tag: "chat:conv-7" },
    });
    const RESELLER = "6720a1b2c3d4e5f6a7b8c9ff";
    expect(composeNotification(chat("customer", RESELLER, 4))).toEqual({
      personId: RESELLER,
      category: "reseller.chat",
      app: "Reseller",
      title: "New message from a customer",
      body: "A customer sent you a message. Open Chats to reply.",
      collapse: { id: `chat:${RESELLER}:conv-7`, seq: 4, manySuffix: " new messages from a customer. Open Chats to reply.", tag: "chat:conv-7" },
    });
    // Both sides of one conversation get separate notices; one side's messages always share one.
    expect(composeNotification(chat("reseller", PERSON, 9))?.collapse?.id).toBe(composeNotification(chat("reseller", PERSON, 3))?.collapse?.id);
  });

  it("makes nothing for an event with no platform person", () => {
    const anonymous = createEvent(easybuyRequestSubmitted, {
      subject: { kind: "request", id: "req-2" },
      seq: 1,
      traceId: "trace-notify-test",
      data: { requestId: "req-2", personId: null, provider: "Apple", model: "iPhone 13", capacity: "128GB", plan: "Weekly" },
    });
    expect(composeNotification(anonymous)).toBeNull();
  });

  it("makes nothing for events it does not announce, or versions it cannot read", () => {
    expect(composeNotification({ ...events.paid, type: "easybuy.price.updated" } as EventEnvelope)).toBeNull();
    expect(composeNotification({ ...events.paid, version: 2 } as EventEnvelope)).toBeNull();
  });

  it("never puts an email, a phone number or a person's name into the text", () => {
    const all = [...Object.values(events), cancelled("refunded"), reminder("upcoming"), reminder("due"), reminder("overdue")].map((event) => composeNotification(event));
    for (const notification of all) {
      expect(notification).not.toBeNull();
      const text = `${notification!.title} ${notification!.body}`;
      expect(text).not.toMatch(/@/);
      expect(text).not.toMatch(/\+?\d{10,}/);
      expect(text).not.toContain(PERSON);
    }
  });
});
