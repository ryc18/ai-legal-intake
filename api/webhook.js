/**
 * Vercel Serverless Function — Legal Intake Webhook
 *
 * This is the Vercel-deployed version of the coded approach.
 * Receives webhooks from Bland.ai (or any Voice AI) and processes leads.
 *
 * Deploy: Push to GitHub → Vercel auto-deploys
 * Endpoint: POST /api/webhook
 */

// Note: In production, this would use the full server.js logic with
// Google Sheets, Gmail, and OpenAI integrations. For this demo deployment,
// we show the webhook endpoint, validation, and qualification logic.

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // Authenticate webhook
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const callData = req.body;

  try {
    // Step 1: Validate payload
    const validated = validatePayload(callData);

    // Step 2: Qualification engine
    const qualification = qualifyLead(validated);

    // Step 3: Determine routing
    const routing = qualification.qualified
      ? {
          action: 'route_to_intake',
          pipeline_stage: validated.urgency === 'high' ? 'Urgent Review' : 'New Qualified Lead',
          notification: validated.urgency === 'high' ? 'urgent_email' : 'standard_email',
          calendar_event: true,
        }
      : {
          action: 'send_decline',
          pipeline_stage: 'Declined',
          notification: 'decline_email',
          calendar_event: false,
        };

    // Acknowledge with full processing result
    return res.status(200).json({
      received: true,
      call_id: validated.call_id,
      lead: {
        name: validated.caller_name,
        phone: validated.phone,
        case_type: validated.case_type,
        urgency: validated.urgency,
      },
      qualification: {
        qualified: qualification.qualified,
        reason: qualification.reason,
        source: qualification.source,
      },
      routing,
      processed_at: new Date().toISOString(),
      note: 'In production, this would also write to Google Sheets, send Gmail notifications, and create Calendar events. See code/server.js for the full implementation.',
    });
  } catch (error) {
    return res.status(400).json({
      error: error.message,
      call_id: callData?.call_id || 'unknown',
    });
  }
}

// --- Validation ---

function validatePayload(data) {
  const required = ['caller_name', 'phone', 'case_type'];
  const missing = required.filter((f) => !data[f]);
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }

  let phone = (data.phone || '').replace(/[^\d+]/g, '');
  if (!phone.startsWith('+')) phone = '+1' + phone;

  return {
    call_id: data.call_id || `demo_${Date.now()}`,
    caller_name: (data.caller_name || '').trim(),
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
  };
}

// --- Qualification Engine ---

function qualifyLead(data) {
  const practiceAreas = ['personal_injury', 'family_law', 'criminal_defense', 'employment_law'];
  const serviceAreas = ['california', 'ca'];

  // HARD DISQUALIFIERS
  if (!practiceAreas.includes(data.case_type)) {
    return { qualified: false, reason: `Case type "${data.case_type}" outside practice areas`, source: 'rules_engine' };
  }
  if (data.existing_representation === true) {
    return { qualified: false, reason: 'Caller already has legal representation', source: 'rules_engine' };
  }
  const jurisdiction = (data.jurisdiction || '').toLowerCase();
  if (jurisdiction && !serviceAreas.some((a) => jurisdiction.includes(a))) {
    return { qualified: false, reason: `Outside service jurisdiction: ${data.jurisdiction}`, source: 'rules_engine' };
  }

  // HARD QUALIFIERS
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
  return { qualified: data.qualified ?? true, reason: data.qualification_reason || 'AI assessment', source: 'ai_assessment' };
}
