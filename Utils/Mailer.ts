import nodemailer from "nodemailer";
import { Resend } from "resend";
import ejs from "ejs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config/Config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const canSendMail = Boolean(
  config.mail.from &&
    ((config.mail.provider === "smtp" && config.mail.smtp.gmailUser && config.mail.smtp.gmailAppPassword) ||
      (config.mail.provider === "resend" && config.mail.resend.apiKey))
);

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

const sendHtmlEmail = async (args: { to: string; subject: string; html: string }) => {
  if (!canSendMail) {
    throw new Error("Mail transport is not configured");
  }

  if (config.mail.provider === "resend" && resendClient) {
    await resendClient.emails.send({
      from: config.mail.from,
      to: args.to,
      subject: args.subject,
      html: args.html,
    });
  } else {
    const transporter = getTransporter();
    if (transporter) {
      await transporter.sendMail({
        from: config.mail.from,
        to: args.to,
        subject: args.subject,
        html: args.html,
      });
    }
  }
};

export const sendVerificationEmail = async (args: {
  to: string;
  fullName: string;
  verifyUrl: string;
}) => {
  const templatePath = path.join(__dirname, "../email-templates/verification.ejs");
  const html = await ejs.renderFile(templatePath, {
    fullName: args.fullName,
    verifyUrl: args.verifyUrl,
  });

  await sendHtmlEmail({
    to: args.to,
    subject: `Verify your Melvin Gadgets account`,
    html,
  });
};

export const sendResetPasswordEmail = async (args: {
  to: string;
  fullName: string;
  resetUrl: string;
}) => {
  const templatePath = path.join(__dirname, "../email-templates/reset-password.ejs");
  const html = await ejs.renderFile(templatePath, {
    fullName: args.fullName,
    resetUrl: args.resetUrl,
  });

  await sendHtmlEmail({
    to: args.to,
    subject: "Reset your password",
    html,
  });
};
