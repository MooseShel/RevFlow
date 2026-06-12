// Deno HIPAA-Compliant Logger
// Strips PHI and dollar amounts in Deno environment logs.

const SSN_REGEX = /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g;
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
const PHONE_REGEX = /\b(?:\+?1[-. ]?)?\(?([0-9]{3})\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})\b/g;
const AMOUNT_REGEX = /\$?\b\d+\.\d{2}\b/g;

export function sanitizeString(message: string): string {
  let sanitized = message;
  sanitized = sanitized.replace(SSN_REGEX, "[SSN REDACTED]");
  sanitized = sanitized.replace(EMAIL_REGEX, "[EMAIL REDACTED]");
  sanitized = sanitized.replace(PHONE_REGEX, "[PHONE REDACTED]");
  sanitized = sanitized.replace(AMOUNT_REGEX, "[AMOUNT REDACTED]");
  return sanitized;
}

export function sanitizeMetadata(metadata: any): any {
  if (metadata === null || metadata === undefined) {
    return metadata;
  }

  if (typeof metadata !== "object") {
    if (typeof metadata === "string") {
      return sanitizeString(metadata);
    }
    return metadata;
  }

  if (Array.isArray(metadata)) {
    return metadata.map((item) => sanitizeMetadata(item));
  }

  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const lowerKey = key.toLowerCase();
    
    if (
      lowerKey.includes("name") ||
      lowerKey.includes("ssn") ||
      lowerKey.includes("social") ||
      lowerKey.includes("zip") ||
      lowerKey.includes("phone") ||
      lowerKey.includes("email") ||
      lowerKey.includes("due") ||
      lowerKey.includes("amount") ||
      lowerKey.includes("balance") ||
      lowerKey.includes("cost") ||
      lowerKey.includes("total") ||
      lowerKey.includes("address") ||
      lowerKey.includes("birth") ||
      lowerKey.includes("dob") ||
      (lowerKey.includes("key") && !lowerKey.includes("token"))
    ) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = sanitizeMetadata(value);
    }
  }

  return sanitized;
}

function log(level: "INFO" | "WARN" | "ERROR" | "DEBUG", message: string, metadata?: any) {
  const logPayload = {
    timestamp: new Date().toISOString(),
    level,
    message: sanitizeString(message),
    ...(metadata ? { metadata: sanitizeMetadata(metadata) } : {}),
  };
  
  if (level === "ERROR") {
    console.error(JSON.stringify(logPayload));
  } else if (level === "WARN") {
    console.warn(JSON.stringify(logPayload));
  } else {
    console.log(JSON.stringify(logPayload));
  }
}

export const logger = {
  info: (message: string, metadata?: any) => log("INFO", message, metadata),
  warn: (message: string, metadata?: any) => log("WARN", message, metadata),
  error: (message: string, metadata?: any) => log("ERROR", message, metadata),
  debug: (message: string, metadata?: any) => log("DEBUG", message, metadata),
};
