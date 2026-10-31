import type { Request, Response } from "express";
import {
  canSendMail,
  renderEmailTemplate,
  sendCustomEmail,
  AVAILABLE_TEMPLATES,
} from "../Utils/Mailer.js";

const isValidEmail = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export const InternalSendMail = async (req: Request, res: Response) => {
  const to = String(req.body?.to || "").trim();
  const subject = String(req.body?.subject || "").trim();
  const template = req.body?.template ? String(req.body.template).trim() : undefined;
  const data = typeof req.body?.data === "object" && req.body?.data !== null ? req.body.data : {};
  let html = typeof req.body?.html === "string" ? req.body.html : undefined;
  const text = typeof req.body?.text === "string" ? req.body.text : undefined;

  if (!to || !isValidEmail(to)) {
    return res.status(400).json({ message: "A valid 'to' email address is required" });
  }

  if (!subject) {
    return res.status(400).json({ message: "'subject' is required" });
  }

  if (!template && !html) {
    return res.status(400).json({
      message: "Either 'template' or 'html' must be provided",
      availableTemplates: AVAILABLE_TEMPLATES,
    });
  }

  try {
    if (template) {
      try {
        html = await renderEmailTemplate(template, data);
      } catch (renderError) {
        return res.status(400).json({
          message: `Failed to render email template '${template}'`,
          reason: renderError instanceof Error ? renderError.message : String(renderError),
          availableTemplates: AVAILABLE_TEMPLATES,
        });
      }
    }

    if (!html) {
      return res.status(400).json({ message: "Computed email HTML body is empty" });
    }

    if (!canSendMail) {
      return res.status(200).json({
        success: true,
        simulated: true,
        message: "Mail transport not configured; simulated dispatch",
        to,
        subject,
      });
    }

    await sendCustomEmail({ to, subject, html, text });

    return res.status(200).json({
      success: true,
      message: "Email sent successfully",
      to,
      subject,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to dispatch email",
      reason: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
