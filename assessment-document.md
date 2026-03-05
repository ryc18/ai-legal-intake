# AI & Automations Integration Specialist — Skills Assessment

**Candidate:** [Your Name]
**Date:** March 2026
**Position:** AI & Automations Integration Specialist — Lion Head

---

## Part 1: AI Intake System Design

### My Approach

Before diving into the details, I want to be upfront about how I approached this.

I know Lion Head is a law firm marketing company, so I designed this system with that context in mind — this needs to work for your law firm clients, be easy to white-label or replicate across multiple firms, and be something a marketing team (not just developers) can manage and monitor.

**If I were building this for a client with full budget and tool access**, my production stack would be:
- **Vapi.ai** or **Bland.ai** for Voice AI (purpose-built for AI phone agents)
- **GoHighLevel** for CRM (it's the industry standard for marketing agencies serving law firms — pipeline management, built-in SMS, appointment booking, the works)
- **Airtable** for the lead database and audit trail
- **Twilio** for SMS
- **Slack** for internal notifications
- **n8n** as the automation orchestrator tying it all together

That stack gives you the most robust, scalable, and client-friendly solution. GHL alone handles half the pipeline — CRM, SMS, pipeline stages, follow-ups — and most law firm marketing agencies already have it.

**For this assessment**, I'm demonstrating with n8n and Google Workspace to show the core logic and system thinking. The important thing is that the architecture, qualification logic, error handling, and routing all stay exactly the same regardless of which tools you plug in. Swapping Google Sheets for GHL or Gmail for Twilio SMS is just changing the output nodes — the brain of the system doesn't change.

I'm presenting **two approaches** to show both sides of my skill set:

| | Approach 1: n8n Workflow | Approach 2: Coded Solution |
|---|---|---|
| **Stack** | n8n + Google Sheets + Gmail | Node.js / Python + Google APIs + OpenAI (deployed on Vercel) |
| **Best for** | Fast deployment, easy handoff to non-devs | Full control, custom logic, easier testing |
| **My recommendation** | For most law firm clients — faster to build and hand off | When the firm has dev resources or complex needs |

The coded approach is deployed on **Vercel** with source code on **GitHub**, so you can see it live and review the code.

---

### 1.1 System Architecture

#### Tools I'm Using (and Why)

**n8n (self-hosted)** — This is the backbone of Approach 1. I chose n8n over Zapier or Make for a few reasons that matter specifically for law firms: it's open-source and self-hostable, which is huge for client data privacy and compliance. There's no per-execution pricing, so costs stay predictable as you scale across multiple firm clients. And it has built-in AI Agent nodes that talk directly to OpenAI, which I need for the qualification logic.

**Google Sheets** — Acting as both my CRM and lead database for this demo. I've structured it with separate sheets: "Leads" (CRM view), "Lead Log" (full audit trail), "Dedup Tracker" (duplicate prevention), and "Error Log" (failed jobs). In production, this would be GHL — but the data model is the same.

**Gmail** — Handles internal notifications (alerting the intake team) and external follow-ups (polite decline emails to non-qualified leads). In production, internal alerts would go through Slack and follow-ups through SMS via Twilio — way more effective for lead engagement.

**Google Calendar** — Creates follow-up events so no lead slips through the cracks.

**OpenAI GPT-4o** — Powers the AI qualification logic. I use function calling to guarantee structured JSON output — no messy text parsing, no inconsistent data.

**Bland.ai** (Voice AI) — For the phone answering piece, I'd go with Bland.ai in production. Simple API, ~$0.07/min, supports call transfers for human handoff. My system is designed to be **voice-provider-agnostic** — the n8n workflow just needs a webhook with structured JSON. You could swap Bland for Retell.ai or Vapi.ai without changing a single node.

**Vercel + GitHub** (Approach 2) — The coded solution is deployed as a serverless function on Vercel. Fast, scalable, zero server management. Source code lives on GitHub for version control and review.

#### How Everything Connects

```
Inbound Call
    │
    ▼
┌─────────────────┐   Webhook    ┌─────────────────────────────────┐
│  Bland.ai       │─────────────▶│          n8n Orchestrator        │
│  Voice AI Agent │  (structured │  ┌───────────┐  ┌────────────┐  │
│                 │   call data) │  │ AI Agent  │  │ Qualific.  │  │
│                 │              │  │ (OpenAI)  │  │ Engine     │  │
└─────────────────┘              │  └───────────┘  └────────────┘  │
                                 └──────────┬──────────────────────┘
                                            │
                      ┌─────────────────────┼──────────────────┐
                      │                     │                    │
                      ▼                     ▼                    ▼
              ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
              │ Google Sheets │    │ Google Sheets │    │    Gmail     │
              │  "Leads" CRM  │    │  "Lead Log"  │    │ Notifications│
              └──────┬───────┘    └──────────────┘    └──────────────┘
                     │
            ┌────────┴────────┐
            │                 │
      ┌─────▼─────┐    ┌─────▼──────┐
      │ Qualified  │    │    Not     │
      │ → Email    │    │ Qualified  │
      │   Intake   │    │ → Decline  │
      │   Team     │    │   Email    │
      └───────────┘    └────────────┘
```

> Full Mermaid diagrams with color-coded flows are in `diagrams/architecture.md` — render them at [mermaid.live](https://mermaid.live)

Here's the flow:
1. Lead calls the firm's number → routes to Bland.ai Voice AI
2. AI has a natural conversation, collects info, makes a preliminary qualification call
3. Call ends → Bland fires a webhook with structured data to n8n (or to the Vercel endpoint for Approach 2)
4. n8n takes over: dedup check → qualification engine → store in Sheets → route notifications
5. Qualified leads → intake team gets emailed + calendar event. Non-qualified → polite decline email with referral

**In the ideal GHL production setup**, step 4-5 would route through GoHighLevel instead — contact goes into a pipeline stage, SMS goes out via Twilio, Slack lights up. Same logic, better tooling.

---

### 1.2 Step-by-Step Automation Logic

#### What Triggers Everything

When a call ends, Bland.ai fires a webhook to: `POST /webhook/legal-intake`

The payload includes everything I need:
```json
{
  "call_id": "call_abc123",
  "caller_name": "Jane Smith",
  "phone": "+15551234567",
  "email": "jane@example.com",
  "case_type": "personal_injury",
  "case_description": "Car accident on Highway 101, 3 weeks ago. Other driver ran a red light.",
  "urgency": "high",
  "jurisdiction": "California",
  "injuries": true,
  "existing_representation": false,
  "qualified": true,
  "qualification_reason": "PI case within statute, injuries reported, no existing counsel"
}
```

#### The Processing Pipeline

**Step 1 — Validate.** Check that name, phone, and case type are present. If something's missing, log the error and alert admin. No point processing incomplete data.

**Step 2 — Dedup check.** Two checks against my Dedup Tracker: has this exact `call_id` been processed before? Has this phone number called in the last 24 hours? If duplicate, update the existing record instead of creating a new one.

**Step 3 — AI enrichment.** If the Voice AI sent clean structured data, I validate it. If it's raw or incomplete, n8n's AI Agent node runs it through OpenAI with function calling to extract structured fields. Either way, the output is always a clean, predictable JSON object.

**Step 4 — Qualification engine.** This is the core logic. I run a **two-layer system**:
- **Layer 1: Deterministic rules** — Checks for obvious cases. Outside our practice areas? Disqualified. Already has an attorney? Disqualified. Urgent PI with injuries? Qualified. These rules can't hallucinate and they run in milliseconds.
- **Layer 2: AI judgment** — For everything in the gray area, I trust the AI's assessment from the call.

Key design principle: **always err on the side of qualifying.** A false positive costs 2 minutes of intake team time. A false negative loses a potential client worth thousands. The math is obvious.

**Step 5 — Store the lead.** Two parallel writes to Google Sheets:
- "Leads" (CRM) — contact info, case details, pipeline stage
- "Lead Log" (audit trail) — everything above plus call metadata and processing timestamps

**Step 6 — Route notifications.** This is where it branches:

**Qualified leads:**
- Email to intake team with full details + link to the Sheets row
- If urgent → subject says "URGENT" and calendar event is 30 min out
- If standard → calendar event is 1 hour out
- *Production version: Slack alert + GHL pipeline move + SMS confirmation to lead*

**Non-qualified leads:**
- Polite decline email to the lead with California State Bar referral
- FYI email to intake team for their records
- *Production version: SMS decline via Twilio (way better engagement than email)*

**Step 7 — Clean up.** Update the Dedup Tracker, mark Lead Log as "complete."

---

### 1.3 AI Prompt Design

#### The Conversation Prompt

I put real thought into this because for a law firm marketing agency like Lion Head, the phone experience IS the product. If the AI sounds robotic or pushes people through a form, you lose leads. The full prompt config is in `code/ai-intake-prompt.json`.

The conversation flow is natural:
1. **Warm greeting** — "Thank you for calling [Firm Name]. I'm Alex, I'm here to help connect you with the right attorney." Also mentions call recording (California law requires it).
2. **Collect basics** — Name, confirm phone, ask for email
3. **Open-ended question** — "Can you tell me what's going on?" Not "What is your case type?" People don't think in categories.
4. **Targeted follow-ups** — Based on what they describe, the AI asks the right questions. For PI: when, injuries, fault? For criminal: charges filed, court date?
5. **Urgency assessment** — Court dates or danger = high. Recent incident = medium. Exploring = low.
6. **Clear wrap-up** — Qualified: "Someone will call you within [timeframe]." Not qualified: referral to State Bar.

The non-negotiable rules:
- **Never give legal advice.** This is a hard line.
- **Never guarantee outcomes.** No "you definitely have a case."
- **Default to qualified when unsure.** Let the human make the close call.
- **Human handoff** for distressed callers, hostility, or emergencies.

#### Getting Structured Output

I use **OpenAI function calling** — the AI gets a `collectLeadInfo` function with enums for case type and urgency, required fields for the essentials, and boolean flags for injuries and existing representation.

Why function calling? Because I need `"personal_injury"` every time, not `"PI"` one time and `"Personal Injury"` the next. Enum fields enforce consistency. Required fields guarantee I get the minimum data. My downstream systems always get a predictable shape — whether that's Google Sheets columns today or GHL custom fields tomorrow.

#### The Qualification Logic

```javascript
function qualifyLead(data) {
  // Hard disqualifiers — override AI, no exceptions
  if (data.case_type === 'other') return { qualified: false, reason: 'Outside practice areas' };
  if (data.existing_representation) return { qualified: false, reason: 'Already represented' };

  // Hard qualifiers — catch leads the AI might undervalue
  if (data.urgency === 'high') return { qualified: true, reason: 'Urgent case in practice area' };
  if (data.case_type === 'personal_injury' && data.injuries)
    return { qualified: true, reason: 'PI with reported injuries' };

  // Gray area — trust the AI
  return { qualified: data.qualified, reason: data.qualification_reason };
}
```

Two layers: deterministic rules for obvious cases, AI for nuanced ones. The full implementation is in `code/qualification-logic.js`.

---

### 1.4 Approach 2: Coded Solution

For teams that prefer full control, I built the same logic as a standalone webhook server. Full source code:
- **Node.js**: `code/server.js` (~400 lines, Express)
- **Python**: `code/server.py` (~400 lines, FastAPI)
- **Deployed on Vercel**, source on **GitHub**

The logic is identical — same validation, dedup, qualification, error handling. Just running as code instead of visual nodes.

| | n8n Workflow | Coded Solution |
|---|---|---|
| Deploy time | Hours | A day or two |
| Non-dev can maintain? | Yes | No |
| Custom logic | Limited | Unlimited |
| Unit testing | Hard | Easy (Jest/pytest) |
| My take | Start here for most clients | Migrate if you outgrow n8n |

I built both JS and Python to show versatility — in practice I'd pick one based on what the team knows.

---

### 1.5 Error Handling & Reliability

This is where most automations quietly fail. I've seen systems where one API hiccup at 3 AM means leads vanish until someone notices Monday morning. Here's how I prevent that.

#### Retry Strategy

Every external API call gets exponential backoff: 5s → 30s → 2min. Three retries total. If all fail, the lead gets logged to the Error Log sheet and admin gets an email.

Different steps get different priority:
- **Data storage (Sheets)**: Critical path — 3 retries. If completely down, backup to local JSON file.
- **Notifications (Gmail)**: Non-critical — 2 retries. Lead is already safely stored.
- **AI processing (OpenAI)**: 3 retries. If down, use raw data, flag for human review.

#### Duplicate Prevention (4 layers)

1. **Call ID** — Same webhook delivered twice? Skip the second.
2. **Phone + 24hr window** — Same number called today? Update existing, don't create new.
3. **n8n webhook dedup** — Rejects duplicate deliveries within 60 seconds.
4. **Sheets safety net** — Script flags duplicate phone numbers created within 5 minutes.

#### When Things Really Go Wrong

If Sheets goes down: n8n writes to a local backup file. A recovery workflow checks every 15 minutes and syncs when Sheets comes back. Admin gets alerted via direct SMTP (not Gmail API — that might be down too).

In the GHL production setup, the fallback is cleaner: if GHL is down, leads go to a backup store with `crm_sync = pending`, and a cron job syncs when it recovers.

#### Human Handoff

| Situation | What happens |
|-----------|-------------|
| Caller wants a real person | Voice AI transfers to intake team |
| AI can't understand caller | Transfers to receptionist after 2 tries |
| Caller is upset or distressed | AI offers immediate transfer |
| Emergency mentioned | AI says "call 911," then transfers to staff |
| After-hours call | AI completes intake, creates urgent follow-up |

---

## Part 2: Debug & Optimization Scenario

### The Problem
An existing automation (Web Form → CRM → SMS → Slack) fails randomly 1 in 50 submissions and occasionally duplicates leads.

### 2.1 How I'd Diagnose This

**First thing:** Pull the last 200 execution logs. I need to see *which step* is failing. Failures concentrated on one step tells a different story than failures spread evenly.

**Then pattern-hunt.** Time of day? (Rate limiting during peaks.) Specific form values? (Special characters breaking validation.) Bursty or even? (Bursty = the service had downtime. Even = something systemic.)

**Test integrations individually.** Hit the CRM API directly. Send a test SMS. Post to Slack. If all work fine alone, the problem is in how they work together — concurrency, timeouts, or cascading failures.

**Check for race conditions.** My top suspect for the duplicates. Two submissions arrive simultaneously → both check CRM → "no duplicate" → both create → duplicate. Classic.

### 2.2 What Logs I'd Check

| Where | What I'm looking for |
|-------|---------------------|
| Automation execution logs | Error codes, which node failed, timing |
| CRM API responses | 429 (rate limit), 409 (conflict), 500 (server error) |
| SMS delivery reports | Actually delivered? Carrier blocks? Invalid numbers? |
| Slack webhook responses | 200 OK or rate limiting? |
| Form submission logs | Double-clicks? Bot spam? Bad data? |

I'd also query the CRM for duplicate phone numbers created within 5 minutes of each other — that tells me exactly how bad the problem is.

### 2.3 Fixing the Duplicates

Fix at multiple levels:
1. **Frontend** — Disable submit button after first click
2. **Idempotency key** — Unique ID per submission, check before processing
3. **CRM dedup** — Search by email/phone before creating
4. **Sequential processing** — Atomic dedup-check-then-create to kill race conditions

### 2.4 Improving Reliability

**Quick wins:**
- Retries with exponential backoff on every API call
- Increase timeouts (30s → 60s for CRM)
- Run CRM, SMS, and Slack **in parallel** — one failure shouldn't kill the others

**Structural:**
- Error branching — catch, log, retry, alert instead of crash
- Separate critical (CRM write) from non-critical (Slack). Don't let nice-to-have kill the must-have.
- Circuit breaker — if an API fails 5x in 10 min, queue everything instead of hammering it

### 2.5 Metrics I'd Track

| Metric | Target | Red flag |
|--------|--------|----------|
| End-to-end success rate | >99% | <97% |
| Duplicate rate | <0.5% | >1% |
| Processing time | <30s | >60s |
| Retry rate | <5% | >10% |
| Error log entries | <1/day | >5/day |

A simple Google Sheets dashboard with COUNTIFS formulas works fine for monitoring. The important thing is that someone looks at it regularly.

---

## Part 3: Documentation & Maintainability

### 3.1 System Maintenance SOP

> Full SOP in `sop/system-maintenance-sop.md`

**Daily (5 min):** Check n8n for failed executions. Check Error Log sheet. Skim Gmail alerts.

**Weekly (30 min):** Pull the numbers — lead count, qualification rate, failure rate. If qualification rate is weird (>90% or <40%), the AI prompt needs tuning. Clear resolved errors.

**Monthly (1 hour):** Review 10 random call transcripts. Check API key expirations. Run disaster recovery test. Export n8n workflow backup.

### 3.2 Change Log Example

```markdown
# Change Log — AI Intake Automation

## [1.2.1] - 2026-03-15
### Fixed
- Duplicate leads when caller calls back within 60 seconds
  (expanded dedup window to 24 hours)
- Gmail notification missing for employment law cases (routing typo)

### Changed
- AI prompt now asks about court dates for all case types

## [1.2.0] - 2026-03-01
### Added
- Google Calendar follow-up events
- Weekly digest email to managing partner
- Dedup Tracker sheet

### Changed
- Two-layer qualification (rules + AI)
- Increased OpenAI timeout to 60s

## [1.0.0] - 2026-02-01
### Added
- Initial launch: Voice AI → n8n → Google Sheets + Gmail
- AI qualification with OpenAI function calling
- Retry logic with exponential backoff
```

### 3.3 Security Considerations

For a law firm, security isn't optional. Here's what I'd implement:

**Data privacy:** Everything stays in firm-controlled systems. Google Workspace encrypts at rest and in transit. Self-hosted n8n on encrypted storage. Voice AI provider must be SOC 2 compliant.

**Access control:** Sheets shared with authorized staff only. n8n admin access for 2 people max. With GHL, you'd use role-based access.

**Webhook security:** Shared secret header validation on every inbound webhook. IP allowlisting for the Voice AI provider.

**Compliance:** AI announces call recording at the start (California two-party consent). System prompt explicitly prevents legal advice. Audit trail in Lead Log sheet.

**Prompt injection defense:** The AI is instructed never to reveal internal processes or other client info. The deterministic rules layer catches things even if the AI gets confused.

### 3.4 Scaling to 10x Volume

If a firm goes from ~50 to ~500 leads/day:

**Google Sheets** is the first bottleneck (10k+ rows = slow). Migrate to PostgreSQL, keep Sheets as a dashboard. With GHL, this isn't an issue — it handles the volume natively.

**n8n** needs horizontal scaling — queue mode with Redis and 2-3 workers.

**Notifications** switch from per-lead to batched digests to avoid inbox fatigue.

**Cost comparison:**

| | ~50 leads/day | ~500 leads/day |
|---|---|---|
| Current stack (Sheets/Gmail) | ~$195/mo (~$0.13/lead) | ~$1,250/mo (~$0.08/lead) |
| Ideal stack (GHL/Vapi/Twilio) | ~$570/mo (~$0.38/lead) | ~$2,200/mo (~$0.15/lead) |

The current stack is cheaper, but the ideal stack delivers a much better client experience (SMS > email, GHL pipelines > spreadsheets). For a marketing agency like Lion Head serving law firms, the client experience matters more than saving a few hundred bucks a month. I'd recommend the GHL stack for production and use the Google Workspace approach as a proof-of-concept or for budget-conscious clients.
