import "./setup-env.js";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { config } from "../config/Config.js";
import InternalRouter from "../Router/InternalRouter.js";
import * as Mailer from "../Utils/Mailer.js";
import { AVAILABLE_TEMPLATES, renderEmailTemplate } from "../Utils/Mailer.js";

const app = express();
app.use(express.json());
app.use("/api/v1/auth/internal", InternalRouter);

const SERVICE_KEY = config.serviceKey || "auth_service_key_dev";

// Mock external email dispatch to prevent hitting live Resend API during unit tests
vi.spyOn(Mailer, "sendCustomEmail").mockImplementation(async (args) => {
  return { id: "mock_msg_id", to: args.to, subject: args.subject } as any;
});

describe("Internal Mail Dispatch API", () => {
  it("rejects unauthenticated requests without service key", async () => {
    const res = await request(app)
      .post("/api/v1/auth/internal/mail/send")
      .send({
        to: "test@example.com",
        subject: "Hello",
        html: "<p>Hello</p>",
      });

    expect(res.status).toBe(401);
  });

  it("rejects requests missing 'to' or invalid email format", async () => {
    const res = await request(app)
      .post("/api/v1/auth/internal/mail/send")
      .set("x-service-key", SERVICE_KEY)
      .send({
        to: "invalid-email",
        subject: "Test Subject",
        html: "<p>Test</p>",
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("valid 'to' email");
  });

  it("rejects requests missing 'subject'", async () => {
    const res = await request(app)
      .post("/api/v1/auth/internal/mail/send")
      .set("x-service-key", SERVICE_KEY)
      .send({
        to: "recipient@example.com",
        html: "<p>Test</p>",
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("'subject' is required");
  });

  it("rejects requests missing both template and html", async () => {
    const res = await request(app)
      .post("/api/v1/auth/internal/mail/send")
      .set("x-service-key", SERVICE_KEY)
      .send({
        to: "recipient@example.com",
        subject: "Test Subject",
      });

    expect(res.status).toBe(400);
    expect(res.body.availableTemplates).toBeDefined();
  });

  it("rejects non-existent template names with 400", async () => {
    const res = await request(app)
      .post("/api/v1/auth/internal/mail/send")
      .set("x-service-key", SERVICE_KEY)
      .send({
        to: "recipient@example.com",
        subject: "Test Subject",
        template: "non-existent-template",
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Failed to render email template");
  });

  it("successfully renders and simulates sending raw HTML", async () => {
    const res = await request(app)
      .post("/api/v1/auth/internal/mail/send")
      .set("x-service-key", SERVICE_KEY)
      .send({
        to: "delivered@resend.dev",
        subject: "Welcome to Melvin",
        html: "<p>Direct HTML Content</p>",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.to).toBe("delivered@resend.dev");
  });

  it("renders all defined EJS email templates without error", async () => {
    const testCases: Record<string, Record<string, unknown>> = {
      verification: { fullName: "Amara Okonkwo", verifyUrl: "https://auth.test/verify?token=abc" },
      "reset-password": { fullName: "Amara Okonkwo", resetUrl: "https://auth.test/reset?token=xyz" },
      "generic-notification": {
        title: "Security Update",
        subtitle: "New Login Detected",
        message: "A new device signed into your Melvin account.",
        items: [{ label: "Device", value: "Chrome on macOS" }, { label: "Location", value: "Lagos, NG" }],
        ctaText: "Review Security",
        ctaUrl: "https://melvin-os-pink.vercel.app/profile/security",
      },
      "easybuy-loan-approved": {
        customerName: "Emeka Obi",
        deviceModel: "iPhone 13 128GB",
        plan: "Monthly (6 Months)",
        downPayment: "₦86,400.50",
        financedAmount: "₦320,000.00",
        dashboardUrl: "https://aurapaytracker.vercel.app/dashboard",
      },
      "easybuy-receipt-approved": {
        customerName: "Emeka Obi",
        amount: "₦54,000.00",
        paymentDate: "October 31, 2026",
        remainingBalance: "₦162,000.00",
      },
      "store-order-receipt": {
        customerName: "Chioma Adeleke",
        orderId: "ORD-9921",
        totalAmount: "₦145,000.00",
        deliveryAddress: "Victoria Island, Lagos",
      },
      "invoice-ready": {
        customerName: "Tunde Bakare",
        invoiceNumber: "INV-2026-000412",
        kindLabel: "EasyBuy Down Payment",
        totalAmount: "₦86,400.50",
        issueDate: "2026-10-31",
      },
      "reseller-commission": {
        resellerName: "Kelechi",
        commissionAmount: "₦12,800.00",
        transactionType: "EasyBuy Device Financed",
        date: "2026-10-31",
      },
      "reseller-payout": {
        resellerName: "Kelechi",
        payoutAmount: "₦78,500.00",
        batchReference: "PAY-2026-W44",
        bankName: "Access Bank",
        payoutDate: "2026-11-01",
      },
    };

    for (const templateName of AVAILABLE_TEMPLATES) {
      const data = testCases[templateName] || {};
      const renderedHtml = await renderEmailTemplate(templateName, data);
      expect(renderedHtml).toBeTruthy();
      expect(renderedHtml).toContain("Melvin Gadgets");
      expect(renderedHtml).toContain("Follow us on");

      // Now test via HTTP API
      const res = await request(app)
        .post("/api/v1/auth/internal/mail/send")
        .set("x-service-key", SERVICE_KEY)
        .send({
          to: "delivered@resend.dev",
          subject: `Test ${templateName}`,
          template: templateName,
          data,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    }
  });
});
