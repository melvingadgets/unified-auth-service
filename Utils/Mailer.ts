import nodemailer from "nodemailer";
import { Resend } from "resend";
import ejs from "ejs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config/Config.js";
import { isMailConfigured } from "./authHelpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// One definition, imported: a second copy of this rule is how the two drifted apart before
// (2026-10-30, when a placeholder key passed the presence check).
export const canSendMail = isMailConfigured();

export const AVAILABLE_TEMPLATES = [
  "verification",
  "reset-password",
  "generic-notification",
  "easybuy-loan-approved",
  "easybuy-receipt-approved",
  "store-order-receipt",
  "invoice-ready",
  "reseller-commission",
  "reseller-payout",
] as const;

export type EmailTemplateName = (typeof AVAILABLE_TEMPLATES)[number] | (string & {});

const resendClient =
  config.mail.provider === "resend" && config.mail.resend.apiKey
    ? new Resend(config.mail.resend.apiKey)
    : null;

const getTransporter = () => {
  if (config.mail.provider !== "smtp") return null;

  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: config.mail.smtp.gmailUser,
      pass: config.mail.smtp.gmailAppPassword,
    },
  });
};

export const sendCustomEmail = async (args: { to: string; subject: string; html: string; text?: string }) => {
  if (!canSendMail) {
    throw new Error("Mail transport is not configured");
  }

  if (config.mail.provider === "resend" && resendClient) {
    const { data, error } = await resendClient.emails.send({
      from: config.mail.from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      ...(args.text ? { text: args.text } : {}),
    });

    if (error) {
      console.error("Resend Error:", error);
      throw new Error(`Resend failed: ${error.message}`);
    }
    return data;
  } else {
    const transporter = getTransporter();
    if (transporter) {
      return await transporter.sendMail({
        from: config.mail.from,
        to: args.to,
        subject: args.subject,
        html: args.html,
        ...(args.text ? { text: args.text } : {}),
      });
    }
  }
};

const resolveTemplatePath = (safeName: string): string => {
  const candidates = [
    path.join(__dirname, "../email-templates", safeName),
    path.join(__dirname, "../../email-templates", safeName),
    path.resolve(process.cwd(), "email-templates", safeName),
    path.resolve(process.cwd(), "unified-auth-service/email-templates", safeName),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
};

export const renderEmailTemplate = async (
  templateName: string,
  data: Record<string, unknown> = {}
): Promise<string> => {
  const safeName = templateName.endsWith(".ejs") ? templateName : `${templateName}.ejs`;
  const templatePath = resolveTemplatePath(safeName);
  return await ejs.renderFile(templatePath, data);
};

export const sendTemplateEmail = async (args: {
  to: string;
  subject: string;
  template: EmailTemplateName;
  data?: Record<string, unknown>;
}) => {
  const html = await renderEmailTemplate(args.template, args.data || {});
  return await sendCustomEmail({
    to: args.to,
    subject: args.subject,
    html,
  });
};

export const sendVerificationEmail = async (args: {
  to: string;
  fullName: string;
  verifyUrl: string;
}) => {
  return await sendTemplateEmail({
    to: args.to,
    subject: "Verify your Melvin Gadgets account",
    template: "verification",
    data: {
      fullName: args.fullName,
      verifyUrl: args.verifyUrl,
    },
  });
};

export const sendResetPasswordEmail = async (args: {
  to: string;
  fullName: string;
  resetUrl: string;
}) => {
  return await sendTemplateEmail({
    to: args.to,
    subject: "Reset your password",
    template: "reset-password",
    data: {
      fullName: args.fullName,
      resetUrl: args.resetUrl,
    },
  });
};
