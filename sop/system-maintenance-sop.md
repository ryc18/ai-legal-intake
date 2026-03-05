# Standard Operating Procedure: AI Intake System Maintenance

**Version:** 1.0
**Last Updated:** March 2026
**Owner:** AI & Automations Team

---

## System Overview

The AI Intake Automation handles inbound phone calls for law firm clients, collects lead information via a Voice AI agent, qualifies leads, and routes them to the intake team. Components:

- **Bland.ai** (or equivalent) — Voice AI Agent
- **n8n** (self-hosted) — Automation Orchestrator
- **Google Sheets** — CRM + Lead Database (production: GoHighLevel)
- **Gmail** — Notifications + Follow-ups (production: Slack + Twilio SMS)
- **Google Calendar** — Follow-up scheduling
- **OpenAI GPT-4o** — AI qualification logic

---

## Daily Health Checks (5 minutes)

**Who:** On-call engineer or automation manager
**When:** Every morning, 9 AM

### Checklist

- [ ] Open n8n → Executions. Any red (failed) in the last 24 hours? If yes, check the error and jump to Troubleshooting below.
- [ ] Open Google Sheets → "Error Log" tab. Any rows with status "pending_review" or "escalated"? Investigate and resolve.
- [ ] Check Gmail for any automated system alerts. Acknowledge and address.
- [ ] Quick look at Voice AI dashboard (Bland.ai) — calls coming in and completing normally?
- [ ] Spot-check: does yesterday's lead count in the "Leads" sheet match what you'd expect?

---

## Weekly Review (30 minutes)

**Who:** Automation lead
**When:** Monday morning

### What to Review

| Metric | Where to find it | When to worry |
|--------|-----------------|---------------|
| Total leads this week | Sheets: count new rows in Leads | Big changes from previous weeks |
| Qualification rate | Qualified / Total in Lead Log | Below 40% or above 90% = review AI prompt |
| Avg call duration | Voice AI dashboard | Over 5 min avg = prompt may need tightening |
| n8n success rate | n8n → Executions → stats | Below 98% = investigate |
| Error Log entries | Error Log sheet | Should be near zero |

### Actions

- Clear resolved items from Error Log
- Review any new error patterns
- Compare Voice AI call count vs Sheets lead count (should match)
- Update this SOP if you found and fixed a new issue type

---

## Monthly Maintenance (1 hour)

**Who:** Automation lead
**When:** First Monday of each month

- [ ] **API key check:** Verify nothing is expired or expiring soon (OpenAI, Google service account, Voice AI, webhook secrets)
- [ ] **AI prompt review:** Listen to or read 10 random call transcripts. Is the AI following the script? Good caller experience? Any gaps?
- [ ] **n8n updates:** Check for new stable version. Plan update during off-hours if available.
- [ ] **Backup:** Export n8n workflow JSON to GitHub. Export Google Sheets as CSV backup.
- [ ] **Disaster recovery test:** Temporarily disable Sheets connection → trigger test lead → verify backup JSON file is created → re-enable → verify recovery sync picks it up
- [ ] **Cost review:** Check monthly spend across all platforms. Flag surprises.

---

## Change Management

### Before Making Changes

1. Document the change in the Change Log (see main assessment doc)
2. Test on a copy of the workflow (n8n: duplicate workflow, test with sample data)
3. AI prompt changes need sign-off from the intake team lead
4. Deploy during low-traffic hours (before 8 AM or after 6 PM)
5. Watch the first 10 executions after deployment

### Rolling Back

1. Deactivate the changed workflow in n8n
2. Activate the backup copy
3. Verify webhook is working
4. Notify the team
5. Investigate before retrying

### Who Approves What

| Change type | Who signs off |
|-------------|--------------|
| Bug fix | Automation lead |
| AI prompt update | Automation lead + intake team |
| New integration | Automation lead + IT |
| Qualification logic change | Automation lead + managing partner |
| Infrastructure change | IT lead |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| No leads coming in | Webhook URL changed or n8n down | Check n8n is running. Verify webhook URL in Voice AI settings. |
| Leads in Sheets but no emails sent | Gmail API issue or email template error | Check n8n execution log for Gmail node error. Verify Gmail credentials. |
| Duplicate leads | Dedup tracker not working or race condition | Check Dedup Tracker sheet. Verify n8n dedup logic. |
| AI qualifying everything | Prompt too permissive or rules engine bypassed | Review recent transcripts. Check qualification function. |
| SMS not sending (production) | Twilio account issue or phone format | Check Twilio console. Verify E.164 format. |

### Escalation

| Severity | Response time | Who |
|----------|--------------|-----|
| No leads at all | 15 minutes | Automation lead → IT → vendor support |
| Leads partially failing | 1 hour | Automation lead |
| Non-critical feature down | 4 hours | On-call engineer |
| Cosmetic / minor issue | Next business day | Any engineer |

---

## Access & Credentials

- All API keys live in n8n's encrypted credential store — never in workflow JSON or documentation
- n8n admin: limited to automation team (2 people max)
- Google Sheets: shared with authorized intake staff only
- Credential changes get logged in the Change Log
- Keys rotated quarterly

## Compliance Reminders

- **Call recording disclosure**: The Voice AI must announce recording at the start of every call (California two-party consent). Do NOT remove this from the prompt.
- **No legal advice**: The AI is configured to never give legal advice. Any prompt changes must keep this guardrail.
- **Data retention**: Call recordings auto-delete after 90 days. Lead data retained per firm policy.
