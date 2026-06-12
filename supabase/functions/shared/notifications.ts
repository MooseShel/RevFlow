// Deno Notifications Dispatcher Service
// Sends SMS (Twilio) and Emails (SendGrid) using Deno's lightweight native fetch client.
// Guarantees zero PHI (no patient names or dollar amounts) inside alerts.

import { logger } from "./logger.ts";

const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID");
const twilioAuthToken = Deno.env.get("TWILIO_AUTH_TOKEN");
const twilioPhone = Deno.env.get("TWILIO_PHONE_NUMBER");

const sendgridKey = Deno.env.get("SENDGRID_API_KEY");
const sendgridFrom = Deno.env.get("SENDGRID_FROM_EMAIL");

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
 * Sends a secure SMS alert via Twilio REST API.
 */
export async function sendSMSNotification(payload: SMSPayload): Promise<boolean> {
  const { toPhone, verificationUrl, tokenId } = payload;
  const messageBody = `A new secure billing statement is available for review. Access your secure portal here: ${verificationUrl} . This verification link will expire in 72 hours.`;

  logger.info("Preparing secure SMS notification dispatch", { tokenId });

  if (twilioSid && twilioAuthToken && twilioPhone) {
    try {
      const basicAuth = btoa(`${twilioSid}:${twilioAuthToken}`);
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            "Authorization": `Basic ${basicAuth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            Body: messageBody,
            From: twilioPhone,
            To: toPhone,
          }),
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Twilio HTTP ${response.status}: ${errText}`);
      }

      const resData = await response.json();
      logger.info("Successfully sent SMS via Twilio API", { tokenId, messageSid: resData.sid });
      return true;
    } catch (error: any) {
      logger.error("Failed to send SMS via Twilio API", { tokenId, error: error.message });
      return false;
    }
  } else {
    // Simulator Mode
    logger.warn("Twilio credentials not configured in Deno. Simulating SMS transmission.", {
      tokenId,
      recipient: toPhone,
      bodyPreview: messageBody,
    });
    return true;
  }
}

/**
 * Sends a secure Email alert via SendGrid REST API.
 */
export async function sendEmailNotification(payload: EmailPayload): Promise<boolean> {
  const { toEmail, verificationUrl, tokenId } = payload;
  const fromEmail = sendgridFrom || "billing-alerts@example.com";

  const textBody = `Dear Patient,\n\nWe have generated a new billing statement for your recent medical visit.\n\nTo securely view your statement details, please verify your identity by visiting the link below:\n\n${verificationUrl}\n\nFor your privacy, this verification link will expire in 72 hours and contains no Personal Health Information (PHI).\n\nIf you did not expect this statement, please ignore this email.\n\nThank you,\nBilling Services Team`;

  const htmlBody = `
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
  `;

  logger.info("Preparing secure Email notification dispatch", { tokenId });

  if (sendgridKey) {
    try {
      const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${sendgridKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: toEmail }] }],
          from: { email: fromEmail },
          subject: "New Secure Billing Statement Available",
          content: [
            { type: "text/plain", value: textBody },
            { type: "text/html", value: htmlBody },
          ],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`SendGrid HTTP ${response.status}: ${errText}`);
      }

      logger.info("Successfully sent Email via SendGrid API", { tokenId });
      return true;
    } catch (error: any) {
      logger.error("Failed to send Email via SendGrid API", { tokenId, error: error.message });
      return false;
    }
  } else {
    // Simulator Mode
    logger.warn("SendGrid credentials not configured in Deno. Simulating Email transmission.", {
      tokenId,
      recipient: toEmail,
    });
    return true;
  }
}
