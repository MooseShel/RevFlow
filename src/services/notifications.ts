import twilio from "twilio";
import sgMail from "@sendgrid/mail";
import { logger } from "./logger";
import dotenv from "dotenv";

dotenv.config();

// Load Twilio config
const twilioSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhone = process.env.TWILIO_PHONE_NUMBER;

// Load SendGrid config
const sendgridKey = process.env.SENDGRID_API_KEY;
const sendgridFrom = process.env.SENDGRID_FROM_EMAIL;

// Initialize clients if credentials are present
const twilioClient = twilioSid && twilioAuthToken ? twilio(twilioSid, twilioAuthToken) : null;
if (sendgridKey) {
  sgMail.setApiKey(sendgridKey);
}

export interface SMSPayload {
  toPhone: string;
  verificationUrl: string;
  tokenId: string;
}

export interface EmailPayload {
  toEmail: string;
  verificationUrl: string;
  tokenId: string;
}

/**
 * Dispatches a secure billing statement notification via Twilio SMS.
 * Strictly guarantees ZERO PHI (no names, dates, or dollar amounts).
 */
export async function sendSMSNotification(payload: SMSPayload): Promise<boolean> {
  const { toPhone, verificationUrl, tokenId } = payload;
  const messageBody = `A new secure billing statement is available for review. Access your secure portal here: ${verificationUrl} . This verification link will expire in 72 hours.`;

  logger.info("Preparing secure SMS notification dispatch", { tokenId });

  if (twilioClient && twilioPhone) {
    try {
      const message = await twilioClient.messages.create({
        body: messageBody,
        from: twilioPhone,
        to: toPhone,
      });
      logger.info("Successfully sent SMS via Twilio API", { tokenId, messageSid: message.sid });
      return true;
    } catch (error: any) {
      logger.error("Failed to send SMS via Twilio API", { tokenId, error: error.message });
      return false;
    }
  } else {
    // Fallback Mock mode for developer testing
    logger.warn("Twilio credentials not configured. Simulating SMS transmission.", {
      tokenId,
      recipient: toPhone,
      bodyPreview: messageBody,
    });
    return true;
  }
}

/**
 * Dispatches a secure billing statement notification via SendGrid Email.
 * Strictly guarantees ZERO PHI in the message subject and body.
 */
export async function sendEmailNotification(payload: EmailPayload): Promise<boolean> {
  const { toEmail, verificationUrl, tokenId } = payload;
  
  const msg = {
    to: toEmail,
    from: sendgridFrom || "billing-alerts@example.com",
    subject: "New Secure Billing Statement Available",
    text: `Dear Patient,\n\nWe have generated a new billing statement for your recent medical visit.\n\nTo securely view your statement details, please verify your identity by visiting the link below:\n\n${verificationUrl}\n\nFor your privacy, this verification link will expire in 72 hours and contains no Personal Health Information (PHI).\n\nIf you did not expect this statement, please ignore this email.\n\nThank you,\nBilling Services Team`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #1e3a8a; margin-top: 0;">Secure Billing Notification</h2>
        <p>Dear Patient,</p>
        <p>We have generated a new billing statement for your recent medical visit.</p>
        <p>To securely access your statement details and billing options, click the button below to verify your identity:</p>
        <div style="text-align: center; margin: 25px 0;">
          <a href="${verificationUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Verify Identity & View Statement</a>
        </div>
        <p style="font-size: 13px; color: #64748b;">
          <strong>Security Notice:</strong> For your privacy, this link will expire in 72 hours and contains no Personal Health Information (PHI). Do not share this URL.
        </p>
        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
        <p style="font-size: 11px; color: #94a3b8; text-align: center;">
          This is an automated security transmission. If you did not receive medical services, please contact our support.
        </p>
      </div>
    `,
  };

  logger.info("Preparing secure Email notification dispatch", { tokenId });

  if (sendgridKey && sendgridFrom) {
    try {
      await sgMail.send(msg);
      logger.info("Successfully sent Email via SendGrid API", { tokenId });
      return true;
    } catch (error: any) {
      logger.error("Failed to send Email via SendGrid API", { tokenId, error: error.message });
      return false;
    }
  } else {
    // Fallback Mock mode for developer testing
    logger.warn("SendGrid credentials not configured. Simulating Email transmission.", {
      tokenId,
      recipient: toEmail,
      subject: msg.subject,
    });
    return true;
  }
}
