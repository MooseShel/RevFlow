# HIPAA Compliance & Security Audit Report

**System Name:** RevFlow Patient Billing Access & Verification Gate  
**Audit Date:** June 12, 2026  
**Status:** **Compliant** (Technical Safeguards Active)

---

## Executive Summary

The RevFlow Billing Verification system provides patient-facing secure portals to retrieve billing statements. Because these statements contain Protected Health Information (PHI) under HIPAA, the system implements rigorous technical safeguards, access controls, audit logging, transmission security, and log sanitization.

This report evaluates system adherence to the **HIPAA Security Rule (45 CFR Part 164, Subpart C)**.

---

## 1. Access Control (§164.312(a)(1))

**Requirement:** Implement technical policies and procedures for electronic information systems that maintain EPHI to allow access only to those persons or software programs that have been granted access rights.

### Technical Controls in RevFlow:
- **UUID v4 Tokenization:** Statement URLs are tokenized using cryptographically secure random UUID v4 identifiers (e.g., `/?token=3a8f6d72-9b21-4f08-b765-df0a256193b2`). Patients cannot guess other statement URLs by enumerating IDs.
- **PostgreSQL Row-Level Security (RLS):** RLS is enabled on the `billing_statements` and `verification_tokens` tables. By default, standard API requests cannot read any statements. Access is permitted *only* after verification, where the server configures a transaction-local setting (`app.current_verified_token_id`) to temporarily authorize reading the single record associated with that token.
- **Private Storage & Temporary Signed URLs:** Ingested statement PDFs are stored in a private Supabase Storage Bucket with no public read permissions. Upon successful patient identity verification, the Edge Function generates a secure signed URL (`createSignedUrl`) valid for **exactly 1 hour** for the specific statement PDF, ensuring the file is never exposed publicly.

---

## 2. Audit Controls (§164.312(b))

**Requirement:** Implement hardware, software, and/or procedural mechanisms that record and examine activity in systems that contain or use electronic protected health information.

### Technical Controls in RevFlow:
- **Comprehensive Immutable Access Logs:** The `access_audit_logs` table records every lifecycle event for verification tokens. The schema enforces a check on allowed events:
  - `GENERATED`: The statement is ingested and the secure token is created.
  - `VERIFIED`: The patient enters the correct identity key.
  - `VIEWED`: The secure statement PDF is accessed.
  - `ATTEMPT_FAIL`: An incorrect verification key is entered or an invalid token is used.
- **Forensic Details:** Each log entry captures the IP address, user-agent, and timestamp.
- **Immutable Log Policies:** RLS rules on `access_audit_logs` allow standard application roles to only `INSERT` and `SELECT` log entries, preventing modification or deletion of the audit trail.

---

## 3. Transmission Security / Minimum Necessary PHI (§164.312(e)(1), §164.502(b))

**Requirement:** Guard against unauthorized access to EPHI that is being transmitted over an electronic communications network, and limit disclosure of PHI to the minimum necessary.

### Technical Controls in RevFlow:
- **Zero PHI in SMS/Email Notifications:** Verification alerts dispatched via Twilio SMS (`sendSMSNotification`) and Resend Email (`sendEmailNotification`) contain **strictly zero PHI**. 
  - Messages never contain patient names, doctor names, medical codes, facility names, or balance amounts.
  - They only notify the recipient that a secure statement is ready and provide the cryptographically randomized portal link.
- **Secure Gate Tunneling:** Patient identity verification is completed over HTTPS before any statement details or PDF files are returned to the client browser.

---

## 4. Data Integrity / Key Hashing (§164.312(c)(1))

**Requirement:** Implement policies and procedures to protect electronic protected health information from improper alteration or destruction.

### Technical Controls in RevFlow:
- **One-Way Cryptographic Hashing (SHA-256):** Patient identity verification keys (specifically the 5-digit ZIP Code) are hashed using SHA-256 before being stored in the database.
- **No Cleartext Storage:** Cleartext ZIP Codes are never stored. The system compares the SHA-256 hash of the patient's input at runtime with the stored hash.
- **SSN Omission:** Social Security Numbers are completely excluded from the database schema and application processing layer.
- **Phone Omission Heuristics:** In the batch PDF parsing stage, phone numbers found in statement files (which represent the billing firm rather than the patient) are discarded and mapped to blank values. This prevents storing and exposing incorrect phone details.

---

## 5. Log Sanitization & Scrubbing (§164.514)

**Requirement:** Prevent the accidental exposure of EPHI/PHI in diagnostic logs.

### Technical Controls in RevFlow:
- **Regex-Based Sanitization:** The central logger (`src/services/logger.ts` / `supabase/functions/shared/logger.ts`) employs a pattern-matching filter.
- **Automatic Redaction:** Sensitive details such as phone numbers (`PHONE_REGEX`) are scrubbed and replaced with `[PHONE REDACTED]` before stdout/stderr logging, preventing transmission of PHI to cloud log aggregators (e.g., Railway logs, Supabase logs).

---

## HIPAA Security Rule Compliance Matrix

| Regulation Section | Standard | Implementation Status | RevFlow Implementation |
| :--- | :--- | :--- | :--- |
| **§164.312(a)(1)** | Access Control | **Compliant** | UUID v4 link tokens, PostgreSQL RLS transactional isolation, private Supabase Storage, and 1-hour signed PDF links. |
| **§164.312(b)** | Audit Controls | **Compliant** | Immutable append-only audit trail logging token creation, views, verifications, and failures. |
| **§164.312(c)(1)** | Integrity | **Compliant** | One-way SHA-256 hashing of verification keys (ZIP Code). Cleartext keys are never stored. |
| **§164.312(e)(1)** | Transmission Security | **Compliant** | End-to-end HTTPS. Twilio and Resend notification payloads contain zero PHI. |
| **§164.514** | De-identification / Sanitization | **Compliant** | Logger regex sanitizer to scrub phone and sensitive numbers from stdout. |
