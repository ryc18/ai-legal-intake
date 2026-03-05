/**
 * Lead Qualification Engine
 *
 * Two-layer qualification system:
 *   Layer 1: Deterministic rules (hard qualifiers/disqualifiers)
 *   Layer 2: AI assessment (for nuanced cases)
 *
 * Design principle: Err on the side of qualifying.
 *   False positives → intake team reviews (minor cost)
 *   False negatives → lost leads (major cost)
 *
 * Used in: n8n Function Node ("Qualification Engine")
 */

// --- Configuration (update per firm) ---

const FIRM_CONFIG = {
  practiceAreas: [
    'personal_injury',
    'family_law',
    'criminal_defense',
    'employment_law',
  ],
  serviceJurisdictions: ['california', 'ca', 'los angeles', 'san francisco', 'san diego'],
  statueOfLimitationsYears: {
    personal_injury: 2,
    family_law: null, // varies
    criminal_defense: null, // varies
    employment_law: 3,
  },
};

// --- Qualification Function ---

function qualifyLead(data) {
  const result = {
    qualified: null,
    reason: '',
    source: 'rules_engine',
    confidence: 'high',
    flags: [],
  };

  // ──────────────────────────────────────────
  // HARD DISQUALIFIERS (always override AI)
  // ──────────────────────────────────────────

  // Case type outside practice areas
  if (!FIRM_CONFIG.practiceAreas.includes(data.case_type)) {
    result.qualified = false;
    result.reason = `Case type "${data.case_type}" is outside firm practice areas`;
    return result;
  }

  // Already has legal representation
  if (data.existing_representation === true) {
    result.qualified = false;
    result.reason = 'Caller already has legal representation';
    return result;
  }

  // Outside service jurisdiction (if jurisdiction was collected)
  if (data.jurisdiction) {
    const jurisdictionLower = data.jurisdiction.toLowerCase();
    const inServiceArea = FIRM_CONFIG.serviceJurisdictions.some(
      (area) => jurisdictionLower.includes(area)
    );
    if (!inServiceArea) {
      result.qualified = false;
      result.reason = `Outside service jurisdiction: ${data.jurisdiction}`;
      return result;
    }
  }

  // ──────────────────────────────────────────
  // HARD QUALIFIERS (override AI if it missed)
  // ──────────────────────────────────────────

  // Urgent case in a valid practice area
  if (data.urgency === 'high') {
    result.qualified = true;
    result.reason = data.qualification_reason || 'Urgent case within practice area';
    result.source = 'rules_engine_override';
    result.flags.push('urgent');
    return result;
  }

  // Personal injury with reported injuries
  if (data.case_type === 'personal_injury' && data.injuries === true) {
    result.qualified = true;
    result.reason = data.qualification_reason || 'PI case with reported injuries';
    result.source = 'rules_engine_override';
    return result;
  }

  // Criminal case with upcoming court date
  if (data.case_type === 'criminal_defense' && data.court_date) {
    result.qualified = true;
    result.reason = data.qualification_reason || 'Criminal case with pending court date';
    result.source = 'rules_engine_override';
    result.flags.push('court_date_pending');
    return result;
  }

  // ──────────────────────────────────────────
  // DEFAULT: Trust AI's judgment
  // ──────────────────────────────────────────

  result.qualified = data.qualified;
  result.reason = data.qualification_reason || 'AI assessment';
  result.source = 'ai_assessment';
  result.confidence = 'medium';
  return result;
}

// --- Deduplication Check ---

async function checkDuplicate(phone, callId, airtableClient) {
  const formula = `AND(
    {phone} = '${phone}',
    {call_id} != '${callId}',
    DATETIME_DIFF(NOW(), {created_time}, 'hours') < 24
  )`;

  const existing = await airtableClient.search('Lead Intake Log', {
    filterByFormula: formula,
    maxRecords: 1,
  });

  if (existing.length > 0) {
    return {
      isDuplicate: true,
      existingRecordId: existing[0].id,
      existingCallCount: existing[0].fields.call_count || 1,
    };
  }

  return { isDuplicate: false };
}

// --- Data Normalization ---

function normalizeLeadData(raw) {
  return {
    call_id: raw.call_id || raw.id || `unknown_${Date.now()}`,
    caller_name: (raw.caller_name || 'Unknown').trim(),
    phone: normalizePhone(raw.phone || raw.phone_number),
    email: (raw.email || '').trim().toLowerCase(),
    case_type: raw.case_type || 'other',
    case_description: (raw.case_description || '').trim(),
    urgency: raw.urgency || 'low',
    jurisdiction: (raw.jurisdiction || '').trim(),
    injuries: raw.injuries || false,
    court_date: raw.court_date || null,
    existing_representation: raw.existing_representation || false,
    qualified: raw.qualified,
    qualification_reason: raw.qualification_reason || '',
    additional_notes: raw.additional_notes || '',
    recording_url: raw.recording_url || '',
    transcript: raw.transcript || '',
    duration_seconds: raw.duration_seconds || 0,
    source: 'ai-phone-intake',
    processed_at: new Date().toISOString(),
  };
}

function normalizePhone(phone) {
  if (!phone) return '';
  let cleaned = phone.replace(/[^\d+]/g, '');
  if (!cleaned.startsWith('+')) {
    cleaned = '+1' + cleaned;
  }
  return cleaned;
}

// --- n8n Function Node Entry Point ---
// (Paste this into the n8n Function node)

/*
const data = $input.first().json;
const result = qualifyLead(data);

return [{
  json: {
    ...data,
    qualified: result.qualified,
    qualification_reason: result.reason,
    qualification_source: result.source,
    qualification_confidence: result.confidence,
    qualification_flags: result.flags || [],
  }
}];
*/

module.exports = { qualifyLead, checkDuplicate, normalizeLeadData, normalizePhone };
