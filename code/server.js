/**
 * AI Legal Intake Server — Node.js (Express)
 *
 * Approach 2: Coded solution for the law firm intake automation.
 * Receives webhooks from Bland.ai (or any Voice AI), processes leads,
 * stores in Google Sheets, sends notifications via Gmail.
 *
 * Dependencies:
 *   npm install express googleapis openai dotenv
 *
 * Environment variables (.env):
 *   PORT=3000
 *   WEBHOOK_SECRET=your_shared_secret
 *   OPENAI_API_KEY=sk-...
 *   GOOGLE_SERVICE_ACCOUNT_KEY=path/to/service-account.json
 *   GOOGLE_SHEETS_ID=your_spreadsheet_id
 *   INTAKE_TEAM_EMAIL=intake-team@firm.com
 *   ADMIN_EMAIL=admin@firm.com
 *   FIRM_NAME=Smith & Associates
 */

require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

// --- Configuration ---

const CONFIG = {
  port: process.env.PORT || 3000,
  webhookSecret: process.env.WEBHOOK_SECRET,
  sheetsId: process.env.GOOGLE_SHEETS_ID,
  intakeEmail: process.env.INTAKE_TEAM_EMAIL,
  adminEmail: process.env.ADMIN_EMAIL,
  firmName: process.env.FIRM_NAME || '[Firm Name]',
  practiceAreas: ['personal_injury', 'family_law', 'criminal_defense', 'employment_law'],
  serviceJurisdictions: ['california', 'ca'],
  dedupWindowHours: 24,
};

// --- Initialize Clients ---

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getGoogleAuth() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar',
    ],
  });
  return auth;
}

// --- Middleware: Webhook Authentication ---

function authenticate(req, res, next) {
  const secret = req.headers['x-webhook-secret'];
  if (secret !== CONFIG.webhookSecret) {
    console.error('[AUTH] Invalid webhook secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --- Main Webhook Endpoint ---

app.post('/webhook/legal-intake', authenticate, async (req, res) => {
  const callData = req.body;

  // Acknowledge immediately (don't make Voice AI wait)
  res.status(200).json({ received: true, call_id: callData.call_id });

  // Process asynchronously
  processLead(callData).catch((error) => {
    console.error('[FATAL] Unhandled error in processLead:', error);
  });
});

async function processLead(callData) {
  const startTime = Date.now();
  console.log(`[PROCESS] Starting lead processing for call_id: ${callData.call_id}`);

  try {
    // Step 1: Validate
    const validated = validatePayload(callData);
    console.log(`[VALIDATE] Payload valid for: ${validated.caller_name}`);

    // Step 2: Dedup check
    const dedup = await checkDuplicate(validated.phone, validated.call_id);
    if (dedup.isDuplicate) {
      console.log(`[DEDUP] Duplicate detected for ${validated.phone}, updating existing`);
      await updateExistingLead(validated, dedup);
      return;
    }

    // Step 3: AI enrichment (if raw data needs structuring)
    const enriched = await enrichWithAI(validated);
    console.log(`[AI] Enrichment complete. Case type: ${enriched.case_type}`);

    // Step 4: Qualification engine
    const qualification = qualifyLead(enriched);
    console.log(`[QUALIFY] Result: ${qualification.qualified ? 'QUALIFIED' : 'NOT QUALIFIED'} — ${qualification.reason}`);

    // Step 5: Write to Google Sheets (CRM + Lead Log) — parallel
    const leadWithQual = { ...enriched, ...qualification };
    await Promise.all([
      writeToLeadsSheet(leadWithQual),
      writeToLeadLogSheet(leadWithQual),
      updateDedupTracker(leadWithQual),
    ]);
    console.log('[SHEETS] All sheets updated');

    // Step 6: Route notifications — parallel
    if (qualification.qualified) {
      await Promise.all([
        sendQualifiedAlert(leadWithQual),
        createCalendarFollowUp(leadWithQual),
      ]);
      console.log('[NOTIFY] Qualified lead — intake team notified + calendar event created');
    } else {
      await Promise.all([
        sendDeclineEmail(leadWithQual),
        sendInternalFYI(leadWithQual),
      ]);
      console.log('[NOTIFY] Not qualified — decline email sent');
    }

    const duration = Date.now() - startTime;
    console.log(`[COMPLETE] Lead processed in ${duration}ms`);

  } catch (error) {
    await handleError(error, callData);
  }
}

// --- Step 1: Validate Payload ---

function validatePayload(data) {
  const required = ['caller_name', 'phone', 'case_type'];
  const missing = required.filter((f) => !data[f]);

  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }

  // Normalize phone
  let phone = (data.phone || '').replace(/[^\d+]/g, '');
  if (!phone.startsWith('+')) phone = '+1' + phone;

  return {
    call_id: data.call_id || `manual_${Date.now()}`,
    caller_name: data.caller_name.trim(),
    phone,
    email: (data.email || '').trim().toLowerCase(),
    case_type: data.case_type,
    case_description: (data.case_description || '').trim(),
    urgency: data.urgency || 'low',
    jurisdiction: (data.jurisdiction || '').trim(),
    injuries: data.injuries || false,
    court_date: data.court_date || null,
    existing_representation: data.existing_representation || false,
    qualified: data.qualified,
    qualification_reason: data.qualification_reason || '',
    transcript: data.transcript || '',
    duration_seconds: data.duration_seconds || 0,
    additional_notes: data.additional_notes || '',
    processed_at: new Date().toISOString(),
  };
}

// --- Step 2: Dedup Check ---

async function checkDuplicate(phone, callId) {
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.sheetsId,
    range: 'Dedup Tracker!A:C', // call_id, phone, timestamp
  });

  const rows = response.data.values || [];
  const now = Date.now();
  const windowMs = CONFIG.dedupWindowHours * 60 * 60 * 1000;

  // Check for exact call_id match
  const callIdMatch = rows.find((row) => row[0] === callId);
  if (callIdMatch) {
    return { isDuplicate: true, reason: 'duplicate_call_id' };
  }

  // Check for same phone within time window
  const phoneMatch = rows.find((row) => {
    return row[1] === phone && (now - new Date(row[2]).getTime()) < windowMs;
  });

  if (phoneMatch) {
    return { isDuplicate: true, reason: 'recent_phone_match', existingCallId: phoneMatch[0] };
  }

  return { isDuplicate: false };
}

// --- Step 3: AI Enrichment ---

async function enrichWithAI(data) {
  // If data is already structured with all fields, skip AI
  if (data.case_type && data.urgency && data.qualified !== undefined) {
    return data;
  }

  // Use OpenAI to extract structured data from raw transcript/description
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: `You are a legal intake data processor. Extract structured information from call data for a law firm specializing in: ${CONFIG.practiceAreas.join(', ')}. Service area: California. When unsure about qualification, default to qualified: true.`,
      },
      {
        role: 'user',
        content: `Extract structured lead info from this call data:\n\n${JSON.stringify(data)}`,
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'collectLeadInfo',
          description: 'Collect structured lead information',
          parameters: {
            type: 'object',
            properties: {
              case_type: { type: 'string', enum: ['personal_injury', 'family_law', 'criminal_defense', 'employment_law', 'other'] },
              case_description: { type: 'string' },
              urgency: { type: 'string', enum: ['high', 'medium', 'low'] },
              jurisdiction: { type: 'string' },
              injuries: { type: 'boolean' },
              existing_representation: { type: 'boolean' },
              qualified: { type: 'boolean' },
              qualification_reason: { type: 'string' },
            },
            required: ['case_type', 'urgency', 'qualified', 'qualification_reason'],
          },
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'collectLeadInfo' } },
  });

  const toolCall = completion.choices[0].message.tool_calls?.[0];
  if (toolCall) {
    const aiData = JSON.parse(toolCall.function.arguments);
    return { ...data, ...aiData };
  }

  // Fallback: return data as-is, flag for review
  return { ...data, needs_review: true };
}

// --- Step 4: Qualification Engine ---

function qualifyLead(data) {
  // HARD DISQUALIFIERS (override AI)
  if (!CONFIG.practiceAreas.includes(data.case_type)) {
    return { qualified: false, reason: `Case type "${data.case_type}" outside practice areas`, source: 'rules_engine' };
  }
  if (data.existing_representation === true) {
    return { qualified: false, reason: 'Caller already has legal representation', source: 'rules_engine' };
  }
  if (data.jurisdiction) {
    const j = data.jurisdiction.toLowerCase();
    if (!CONFIG.serviceJurisdictions.some((area) => j.includes(area))) {
      return { qualified: false, reason: `Outside service jurisdiction: ${data.jurisdiction}`, source: 'rules_engine' };
    }
  }

  // HARD QUALIFIERS (override AI if it missed)
  if (data.urgency === 'high') {
    return { qualified: true, reason: data.qualification_reason || 'Urgent case in practice area', source: 'rules_override' };
  }
  if (data.case_type === 'personal_injury' && data.injuries === true) {
    return { qualified: true, reason: data.qualification_reason || 'PI with reported injuries', source: 'rules_override' };
  }
  if (data.case_type === 'criminal_defense' && data.court_date) {
    return { qualified: true, reason: data.qualification_reason || 'Criminal case with court date', source: 'rules_override' };
  }

  // DEFAULT: Trust AI
  return { qualified: data.qualified, reason: data.qualification_reason || 'AI assessment', source: 'ai_assessment' };
}

// --- Step 5: Google Sheets Writes ---

async function writeToLeadsSheet(lead) {
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  await retryWithBackoff(async () => {
    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.sheetsId,
      range: 'Leads!A:N',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          lead.caller_name,
          lead.phone,
          lead.email,
          lead.case_type,
          lead.case_description,
          lead.urgency,
          lead.qualified ? 'Qualified' : 'Not Qualified',
          lead.reason,
          lead.qualified ? (lead.urgency === 'high' ? 'Urgent Review' : 'New Qualified Lead') : 'Declined',
          'AI Phone Intake',
          lead.processed_at,
          lead.processed_at, // last_contact
          1, // call_count
          lead.call_id,
        ]],
      },
    });
  }, 'sheets');
}

async function writeToLeadLogSheet(lead) {
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  await retryWithBackoff(async () => {
    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.sheetsId,
      range: 'Lead Log!A:Q',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          lead.call_id,
          lead.caller_name,
          lead.phone,
          lead.email,
          lead.case_type,
          lead.case_description,
          lead.urgency,
          lead.jurisdiction,
          lead.injuries,
          lead.existing_representation,
          lead.qualified,
          lead.reason,
          lead.source,
          lead.duration_seconds,
          lead.transcript ? 'Yes' : 'No',
          'complete',
          lead.processed_at,
        ]],
      },
    });
  }, 'sheets');
}

async function updateDedupTracker(lead) {
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: CONFIG.sheetsId,
    range: 'Dedup Tracker!A:C',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[lead.call_id, lead.phone, lead.processed_at]],
    },
  });
}

// --- Step 6: Gmail Notifications ---

async function sendQualifiedAlert(lead) {
  const auth = await getGoogleAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const urgencyTag = lead.urgency === 'high' ? 'URGENT ' : '';
  const subject = `${urgencyTag}New Qualified Lead: ${lead.caller_name} — ${formatCaseType(lead.case_type)}`;

  const body = `
<h2>${urgencyTag}New Qualified Lead</h2>
<table style="border-collapse: collapse; width: 100%;">
  <tr><td><strong>Name:</strong></td><td>${lead.caller_name}</td></tr>
  <tr><td><strong>Phone:</strong></td><td>${lead.phone}</td></tr>
  <tr><td><strong>Email:</strong></td><td>${lead.email || 'Not provided'}</td></tr>
  <tr><td><strong>Case Type:</strong></td><td>${formatCaseType(lead.case_type)}</td></tr>
  <tr><td><strong>Urgency:</strong></td><td>${lead.urgency.toUpperCase()}</td></tr>
  <tr><td><strong>Description:</strong></td><td>${lead.case_description}</td></tr>
  <tr><td><strong>Qualification:</strong></td><td>${lead.reason}</td></tr>
</table>
<p><a href="https://docs.google.com/spreadsheets/d/${CONFIG.sheetsId}">View in Lead Tracker</a></p>
<hr><small>AI Intake System | Call ID: ${lead.call_id}</small>`;

  await sendEmail(gmail, CONFIG.intakeEmail, subject, body);
}

async function sendDeclineEmail(lead) {
  if (!lead.email) return; // Can't send decline without email

  const auth = await getGoogleAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const subject = `Thank you for contacting ${CONFIG.firmName}`;
  const body = `
<p>Dear ${lead.caller_name.split(' ')[0]},</p>
<p>Thank you for reaching out to ${CONFIG.firmName}. We appreciate you taking the time to contact us about your legal matter.</p>
<p>After reviewing the details of your inquiry, we've determined that your matter falls outside our firm's current practice areas. We want to make sure you get the right help.</p>
<p>We recommend contacting the <strong>California State Bar Lawyer Referral Service</strong> at <strong>1-866-442-2529</strong>. They can connect you with an attorney who specializes in your type of case.</p>
<p>We wish you the very best in resolving your matter.</p>
<p>Warm regards,<br>${CONFIG.firmName}</p>`;

  await sendEmail(gmail, lead.email, subject, body);
}

async function sendInternalFYI(lead) {
  const auth = await getGoogleAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const subject = `Non-Qualified Lead: ${lead.caller_name} — ${formatCaseType(lead.case_type)}`;
  const body = `
<p><strong>Non-Qualified Lead (FYI)</strong></p>
<p>Name: ${lead.caller_name} | Phone: ${lead.phone} | Case: ${formatCaseType(lead.case_type)}</p>
<p>Reason: ${lead.reason}</p>
<p>Decline email ${lead.email ? 'sent' : 'NOT sent (no email on file)'}.</p>
<hr><small>Call ID: ${lead.call_id}</small>`;

  await sendEmail(gmail, CONFIG.intakeEmail, subject, body);
}

async function sendEmail(gmail, to, subject, htmlBody) {
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${htmlBody}`
  ).toString('base64url');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
}

// --- Google Calendar Follow-Up ---

async function createCalendarFollowUp(lead) {
  const auth = await getGoogleAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const startTime = new Date();
  startTime.setMinutes(startTime.getMinutes() + (lead.urgency === 'high' ? 30 : 60));

  const endTime = new Date(startTime);
  endTime.setMinutes(endTime.getMinutes() + 15);

  await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: `Follow up: ${lead.caller_name} — ${formatCaseType(lead.case_type)}`,
      description: `Phone: ${lead.phone}\nEmail: ${lead.email || 'N/A'}\nCase: ${lead.case_description}\nUrgency: ${lead.urgency}\n\nCall ID: ${lead.call_id}`,
      start: { dateTime: startTime.toISOString() },
      end: { dateTime: endTime.toISOString() },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }] },
    },
  });
}

// --- Error Handling ---

async function handleError(error, callData) {
  console.error(`[ERROR] ${error.message}`, { call_id: callData?.call_id });

  try {
    // Log to Error Log sheet
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.sheetsId,
      range: 'Error Log!A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          new Date().toISOString(),
          callData?.call_id || 'unknown',
          error.message,
          error.stack?.substring(0, 500) || '',
          JSON.stringify(callData || {}).substring(0, 1000),
          'pending_review',
        ]],
      },
    });

    // Alert admin via Gmail
    const gmail = google.gmail({ version: 'v1', auth });
    await sendEmail(
      gmail,
      CONFIG.adminEmail,
      `[ALERT] Intake Automation Error — ${error.message.substring(0, 50)}`,
      `<h3>Intake Automation Error</h3>
       <p><strong>Error:</strong> ${error.message}</p>
       <p><strong>Call ID:</strong> ${callData?.call_id || 'unknown'}</p>
       <p><strong>Time:</strong> ${new Date().toISOString()}</p>
       <p><a href="https://docs.google.com/spreadsheets/d/${CONFIG.sheetsId}">View Error Log</a></p>`
    );
  } catch (metaError) {
    // If even error handling fails, write to local file
    const fs = require('fs');
    const backup = {
      timestamp: new Date().toISOString(),
      original_error: error.message,
      meta_error: metaError.message,
      call_data: callData,
    };
    fs.appendFileSync(
      './data/backup/emergency-errors.jsonl',
      JSON.stringify(backup) + '\n'
    );
  }
}

// --- Retry Utility ---

async function retryWithBackoff(fn, serviceName, maxRetries = 3) {
  const delays = [5000, 30000, 120000]; // 5s, 30s, 2min

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      const delay = delays[attempt] || 120000;
      console.warn(`[RETRY] ${serviceName} attempt ${attempt + 1} failed, retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// --- Helpers ---

function formatCaseType(type) {
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// --- Health Check ---

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Start Server ---

app.listen(CONFIG.port, () => {
  console.log(`Legal Intake Server running on port ${CONFIG.port}`);
  console.log(`Webhook endpoint: POST /webhook/legal-intake`);
});

module.exports = { app, qualifyLead, validatePayload }; // For testing
