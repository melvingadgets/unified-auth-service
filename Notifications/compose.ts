import { kobo, koboToNaira, type EventEnvelope } from "@melvingadgets/platform-kit";

// What one event tells one person (Shortwork/docs/notifications.md §3). Pure: no database, no clock.
//
// The text carries product names and amounts, never a name, an email, a phone number, a NIN, a
// free-text reason or message content. The person reads the rest in the app it opens.

export const NOTIFICATION_APPS = ["Profile", "Easybuy Portal", "Recommerce Store", "Reseller", "Chat"] as const;
export type NotificationApp = (typeof NOTIFICATION_APPS)[number];

export type NotificationCategory = "easybuy.application" | "easybuy.finance" | "store.order" | "reseller.payout" | "reseller.chat";

/**
 * Notices that collapse: one per recipient and conversation instead of one per event, so ten chat
 * messages make one "10 new messages" notice, not ten.
 */
export interface CollapseRule {
  /** The notice's own id, the same for every message in the conversation. */
  id: string;
  /** The conversation's message counter. A notice only ever moves forward. */
  seq: number;
  /** The body once more than one message is waiting: `${count}${manySuffix}`. */
  manySuffix: string;
  /** Replaces the previous alert for the conversation on the person's device. */
  tag: string;
}

export interface NotificationDraft {
  personId: string;
  category: NotificationCategory;
  app: NotificationApp;
  title: string;
  /** The body for one event (one message, for a collapsing notice). */
  body: string;
  collapse?: CollapseRule;
}

type Plan = "Weekly" | "Monthly";

/** 2500000 kobo → "₦25,000"; 2500050 → "₦25,000.50". */
export const formatNaira = (amountKobo: number): string => {
  const [whole, fraction] = koboToNaira(kobo(amountKobo)).split(".");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}₦${grouped}${fraction === "00" ? "" : `.${fraction}`}`;
};

const planLabel = (plan: Plan): string => (plan === "Weekly" ? "weekly plan" : "monthly plan");
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const draft = (
  personId: string | null,
  category: NotificationCategory,
  app: NotificationApp,
  title: string,
  body: string,
): NotificationDraft | null => (personId ? { personId, category, app, title, body } : null);

/**
 * The notification an event produces, or null when it produces none: no platform person (an
 * anonymous Apply request), an event this module doesn't announce, or a version it can't read yet.
 * The envelope has already been validated against the kit's registry.
 */
export const composeNotification = (event: EventEnvelope): NotificationDraft | null => {
  if (event.version !== 1) return null;

  switch (event.type) {
    case "easybuy.request.submitted": {
      const d = event.data as { personId: string | null; model: string; capacity: string; plan: Plan };
      return draft(
        d.personId,
        "easybuy.application",
        "Profile",
        "Application received",
        `Your EasyBuy application for ${d.model} ${d.capacity} on a ${planLabel(d.plan)} is in. We'll let you know when it's reviewed.`,
      );
    }
    case "easybuy.request.approved": {
      const d = event.data as { personId: string | null };
      return draft(
        d.personId,
        "easybuy.application",
        "Profile",
        "Application approved",
        "Good news: your EasyBuy application was approved. Open Profile for the next step.",
      );
    }
    case "easybuy.request.rejected": {
      // The reason is free text and stays in EasyBuy.
      const d = event.data as { personId: string | null };
      return draft(
        d.personId,
        "easybuy.application",
        "Profile",
        "Application update",
        "Your EasyBuy application wasn't approved this time. Open Profile for details.",
      );
    }
    case "easybuy.item.created": {
      const d = event.data as { personId: string | null; model: string; capacity: string; plan: Plan; financedKobo: number };
      return draft(
        d.personId,
        "easybuy.finance",
        "Easybuy Portal",
        "Device financed",
        `Your ${d.model} ${d.capacity} is financed: ${formatNaira(d.financedKobo)} on a ${planLabel(d.plan)}. Your receipt is in Profile → Documents.`,
      );
    }
    case "easybuy.payment.approved": {
      const d = event.data as { personId: string | null; amountKobo: number };
      return draft(
        d.personId,
        "easybuy.finance",
        "Easybuy Portal",
        "Payment confirmed",
        `We received your EasyBuy payment of ${formatNaira(d.amountKobo)}. Thank you.`,
      );
    }
    case "store.order.paid": {
      const d = event.data as { personId: string | null; items: { quantity: number }[]; totalKobo: number };
      const items = d.items.reduce((total, item) => total + item.quantity, 0);
      return draft(
        d.personId,
        "store.order",
        "Recommerce Store",
        "Order confirmed",
        `Your order of ${count(items, "item", "items")} is paid: ${formatNaira(d.totalKobo)}.`,
      );
    }
    case "store.order.completed": {
      const d = event.data as { personId: string | null };
      return draft(
        d.personId,
        "store.order",
        "Recommerce Store",
        "Order delivered",
        "Your order is complete. Thanks for shopping with Melvin Gadgets.",
      );
    }
    case "store.order.cancelled": {
      const d = event.data as { personId: string | null; reason: "rejected_at_delivery" | "cancelled" | "refunded" };
      const [title, body] =
        d.reason === "refunded"
          ? ["Order refunded", "Your order was refunded."]
          : d.reason === "rejected_at_delivery"
            ? ["Order returned", "Your order was returned at delivery."]
            : ["Order cancelled", "Your order was cancelled."];
      return draft(d.personId, "store.order", "Recommerce Store", title, body);
    }
    case "reseller.payout.paid": {
      const d = event.data as { resellerPersonId: string; totalKobo: number; entryCount: number };
      return draft(
        d.resellerPersonId,
        "reseller.payout",
        "Reseller",
        "Payout sent",
        `${formatNaira(d.totalKobo)} for ${count(d.entryCount, "commission", "commissions")} is on its way to your bank.`,
      );
    }
    case "reseller.chat.message.posted": {
      // Who should hear about it, never what was said: the message stays in the reseller service.
      const d = event.data as { conversationId: string; seq: number; from: "customer" | "reseller"; recipientPersonId: string };
      const collapse = (manySuffix: string): CollapseRule => ({
        id: `chat:${d.recipientPersonId}:${d.conversationId}`,
        seq: d.seq,
        manySuffix,
        tag: `chat:${d.conversationId}`,
      });
      return d.from === "reseller"
        ? {
            personId: d.recipientPersonId,
            category: "reseller.chat",
            app: "Chat",
            title: "New message",
            body: "Your reseller replied.",
            collapse: collapse(" new messages from your reseller."),
          }
        : {
            personId: d.recipientPersonId,
            category: "reseller.chat",
            app: "Reseller",
            title: "New message from a customer",
            body: "A customer sent you a message. Open Chats to reply.",
            collapse: collapse(" new messages from a customer. Open Chats to reply."),
          };
    }
    default:
      return null;
  }
};
