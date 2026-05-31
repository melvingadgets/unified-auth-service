import nodemailer from "nodemailer";
import { config } from "../config/Config.js";

const canSendMail = Boolean(
  config.mail.from &&
    config.mail.smtp.gmailUser &&
    config.mail.smtp.gmailAppPassword
);

const getTransporter = () => {
  if (!canSendMail) {
    throw new Error("Mail transport is not configured");
  }

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
  const transporter = getTransporter();
  await transporter.sendMail({
    from: config.mail.from,
    to: args.to,
    subject: args.subject,
    html: args.html,
  });
};

export const sendVerificationEmail = async (args: {
  to: string;
  fullName: string;
  verifyUrl: string;
  appDisplayName: string;
}) => {
  await sendHtmlEmail({
    to: args.to,
    subject: `Verify your ${args.appDisplayName} account`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <p>Hello ${args.fullName},</p>
        <p>Verify your ${args.appDisplayName} account with the link below.</p>
        <p><a href="${args.verifyUrl}">${args.verifyUrl}</a></p>
      </div>
    `,
  });
};

export const sendResetPasswordEmail = async (args: {
  to: string;
  fullName: string;
  resetUrl: string;
}) => {
  await sendHtmlEmail({
    to: args.to,
    subject: "Reset your password",
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <p>Hello ${args.fullName},</p>
        <p>Use this link to reset your password:</p>
        <p><a href="${args.resetUrl}">${args.resetUrl}</a></p>
      </div>
    `,
  });
};
