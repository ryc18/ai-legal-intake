"""
AI Legal Intake Server — Python (FastAPI)

Approach 2: Coded solution for the law firm intake automation.
Receives webhooks from Bland.ai (or any Voice AI), processes leads,
stores in Google Sheets, sends notifications via Gmail.

Dependencies:
    pip install fastapi uvicorn google-api-python-client google-auth openai python-dotenv

Environment variables (.env):
    PORT=3000
    WEBHOOK_SECRET=your_shared_secret
    OPENAI_API_KEY=sk-...
    GOOGLE_SERVICE_ACCOUNT_KEY=path/to/service-account.json
    GOOGLE_SHEETS_ID=your_spreadsheet_id
    INTAKE_TEAM_EMAIL=intake-team@firm.com
    ADMIN_EMAIL=admin@firm.com
    FIRM_NAME=Smith & Associates

Run:
    uvicorn server:app --host 0.0.0.0 --port 3000
"""

import os
import json
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional
from base64 import urlsafe_b64encode
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request, BackgroundTasks, HTTPException, Header
from google.oauth2 import service_account
from googleapiclient.discovery import build
from openai import OpenAI

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# --- Configuration ---

CONFIG = {
    "webhook_secret": os.getenv("WEBHOOK_SECRET"),
    "sheets_id": os.getenv("GOOGLE_SHEETS_ID"),
    "intake_email": os.getenv("INTAKE_TEAM_EMAIL"),
    "admin_email": os.getenv("ADMIN_EMAIL"),
    "firm_name": os.getenv("FIRM_NAME", "[Firm Name]"),
    "practice_areas": ["personal_injury", "family_law", "criminal_defense", "employment_law"],
    "service_jurisdictions": ["california", "ca"],
    "dedup_window_hours": 24,
}

# --- Initialize Clients ---

openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar",
]
credentials = service_account.Credentials.from_service_account_file(
    os.getenv("GOOGLE_SERVICE_ACCOUNT_KEY"), scopes=SCOPES
)

sheets_service = build("sheets", "v4", credentials=credentials)
gmail_service = build("gmail", "v1", credentials=credentials)
calendar_service = build("calendar", "v3", credentials=credentials)

# --- FastAPI App ---

app = FastAPI(title="AI Legal Intake Server")


# --- Webhook Authentication ---

def verify_secret(x_webhook_secret: str = Header(None)):
    if x_webhook_secret != CONFIG["webhook_secret"]:
        raise HTTPException(status_code=401, detail="Unauthorized")


# --- Main Webhook Endpoint ---

@app.post("/webhook/legal-intake")
async def legal_intake(
    request: Request,
    background_tasks: BackgroundTasks,
    x_webhook_secret: str = Header(None),
):
    verify_secret(x_webhook_secret)
    call_data = await request.json()

    # Acknowledge immediately, process in background
    background_tasks.add_task(process_lead, call_data)
    return {"received": True, "call_id": call_data.get("call_id")}


async def process_lead(call_data: dict):
    """Main processing pipeline for a lead."""
    start_time = datetime.now()
    logger.info(f"Processing lead for call_id: {call_data.get('call_id')}")

    try:
        # Step 1: Validate
        validated = validate_payload(call_data)
        logger.info(f"Validated: {validated['caller_name']}")

        # Step 2: Dedup check
        dedup = check_duplicate(validated["phone"], validated["call_id"])
        if dedup["is_duplicate"]:
            logger.info(f"Duplicate for {validated['phone']}, updating existing")
            update_existing_lead(validated)
            return

        # Step 3: AI enrichment
        enriched = enrich_with_ai(validated)
        logger.info(f"AI enriched. Case type: {enriched['case_type']}")

        # Step 4: Qualification engine
        qualification = qualify_lead(enriched)
        logger.info(f"Qualification: {'QUALIFIED' if qualification['qualified'] else 'NOT QUALIFIED'} — {qualification['reason']}")

        # Step 5: Write to Google Sheets (CRM + Lead Log)
        lead = {**enriched, **qualification}
        write_to_leads_sheet(lead)
        write_to_lead_log_sheet(lead)
        update_dedup_tracker(lead)
        logger.info("All sheets updated")

        # Step 6: Route notifications
        if qualification["qualified"]:
            send_qualified_alert(lead)
            create_calendar_followup(lead)
            logger.info("Qualified — intake team notified + calendar event created")
        else:
            send_decline_email(lead)
            send_internal_fyi(lead)
            logger.info("Not qualified — decline email sent")

        duration = (datetime.now() - start_time).total_seconds()
        logger.info(f"Lead processed in {duration:.1f}s")

    except Exception as e:
        handle_error(e, call_data)


# --- Step 1: Validate Payload ---

def validate_payload(data: dict) -> dict:
    required = ["caller_name", "phone", "case_type"]
    missing = [f for f in required if not data.get(f)]
    if missing:
        raise ValueError(f"Missing required fields: {', '.join(missing)}")

    phone = "".join(c for c in data.get("phone", "") if c.isdigit() or c == "+")
    if not phone.startswith("+"):
        phone = "+1" + phone

    return {
        "call_id": data.get("call_id", f"manual_{int(datetime.now().timestamp())}"),
        "caller_name": data["caller_name"].strip(),
        "phone": phone,
        "email": data.get("email", "").strip().lower(),
        "case_type": data["case_type"],
        "case_description": data.get("case_description", "").strip(),
        "urgency": data.get("urgency", "low"),
        "jurisdiction": data.get("jurisdiction", "").strip(),
        "injuries": data.get("injuries", False),
        "court_date": data.get("court_date"),
        "existing_representation": data.get("existing_representation", False),
        "qualified": data.get("qualified"),
        "qualification_reason": data.get("qualification_reason", ""),
        "transcript": data.get("transcript", ""),
        "duration_seconds": data.get("duration_seconds", 0),
        "additional_notes": data.get("additional_notes", ""),
        "processed_at": datetime.now().isoformat(),
    }


# --- Step 2: Dedup Check ---

def check_duplicate(phone: str, call_id: str) -> dict:
    result = sheets_service.spreadsheets().values().get(
        spreadsheetId=CONFIG["sheets_id"],
        range="Dedup Tracker!A:C",
    ).execute()

    rows = result.get("values", [])
    now = datetime.now()
    window = timedelta(hours=CONFIG["dedup_window_hours"])

    for row in rows:
        if len(row) < 3:
            continue
        if row[0] == call_id:
            return {"is_duplicate": True, "reason": "duplicate_call_id"}
        try:
            row_time = datetime.fromisoformat(row[2])
            if row[1] == phone and (now - row_time) < window:
                return {"is_duplicate": True, "reason": "recent_phone_match"}
        except (ValueError, IndexError):
            continue

    return {"is_duplicate": False}


# --- Step 3: AI Enrichment ---

def enrich_with_ai(data: dict) -> dict:
    if data.get("case_type") and data.get("urgency") and data.get("qualified") is not None:
        return data  # Already structured

    completion = openai_client.chat.completions.create(
        model="gpt-4o",
        temperature=0.2,
        messages=[
            {
                "role": "system",
                "content": (
                    f"Extract structured legal intake data for a firm specializing in: "
                    f"{', '.join(CONFIG['practice_areas'])}. Service area: California. "
                    f"When unsure about qualification, default to qualified=true."
                ),
            },
            {
                "role": "user",
                "content": f"Extract structured lead info:\n\n{json.dumps(data)}",
            },
        ],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "collectLeadInfo",
                    "description": "Collect structured lead information",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "case_type": {"type": "string", "enum": CONFIG["practice_areas"] + ["other"]},
                            "case_description": {"type": "string"},
                            "urgency": {"type": "string", "enum": ["high", "medium", "low"]},
                            "jurisdiction": {"type": "string"},
                            "injuries": {"type": "boolean"},
                            "existing_representation": {"type": "boolean"},
                            "qualified": {"type": "boolean"},
                            "qualification_reason": {"type": "string"},
                        },
                        "required": ["case_type", "urgency", "qualified", "qualification_reason"],
                    },
                },
            }
        ],
        tool_choice={"type": "function", "function": {"name": "collectLeadInfo"}},
    )

    tool_call = completion.choices[0].message.tool_calls
    if tool_call:
        ai_data = json.loads(tool_call[0].function.arguments)
        return {**data, **ai_data}

    return {**data, "needs_review": True}


# --- Step 4: Qualification Engine ---

def qualify_lead(data: dict) -> dict:
    """Two-layer qualification: deterministic rules, then AI fallback."""

    # HARD DISQUALIFIERS
    if data.get("case_type") not in CONFIG["practice_areas"]:
        return {"qualified": False, "reason": f"Case type '{data.get('case_type')}' outside practice areas", "source": "rules_engine"}

    if data.get("existing_representation"):
        return {"qualified": False, "reason": "Caller already has legal representation", "source": "rules_engine"}

    jurisdiction = (data.get("jurisdiction") or "").lower()
    if jurisdiction and not any(area in jurisdiction for area in CONFIG["service_jurisdictions"]):
        return {"qualified": False, "reason": f"Outside service jurisdiction: {data.get('jurisdiction')}", "source": "rules_engine"}

    # HARD QUALIFIERS
    if data.get("urgency") == "high":
        return {"qualified": True, "reason": data.get("qualification_reason", "Urgent case in practice area"), "source": "rules_override"}

    if data.get("case_type") == "personal_injury" and data.get("injuries"):
        return {"qualified": True, "reason": data.get("qualification_reason", "PI with reported injuries"), "source": "rules_override"}

    if data.get("case_type") == "criminal_defense" and data.get("court_date"):
        return {"qualified": True, "reason": data.get("qualification_reason", "Criminal case with court date"), "source": "rules_override"}

    # DEFAULT: Trust AI
    return {"qualified": data.get("qualified", True), "reason": data.get("qualification_reason", "AI assessment"), "source": "ai_assessment"}


# --- Step 5: Google Sheets Writes ---

def write_to_leads_sheet(lead: dict):
    retry_with_backoff(lambda: sheets_service.spreadsheets().values().append(
        spreadsheetId=CONFIG["sheets_id"],
        range="Leads!A:N",
        valueInputOption="USER_ENTERED",
        body={"values": [[
            lead["caller_name"], lead["phone"], lead["email"],
            lead["case_type"], lead["case_description"], lead["urgency"],
            "Qualified" if lead["qualified"] else "Not Qualified",
            lead["reason"],
            "Urgent Review" if lead["qualified"] and lead["urgency"] == "high"
            else "New Qualified Lead" if lead["qualified"] else "Declined",
            "AI Phone Intake", lead["processed_at"], lead["processed_at"], 1, lead["call_id"],
        ]]},
    ).execute(), "sheets")


def write_to_lead_log_sheet(lead: dict):
    retry_with_backoff(lambda: sheets_service.spreadsheets().values().append(
        spreadsheetId=CONFIG["sheets_id"],
        range="Lead Log!A:Q",
        valueInputOption="USER_ENTERED",
        body={"values": [[
            lead["call_id"], lead["caller_name"], lead["phone"], lead["email"],
            lead["case_type"], lead["case_description"], lead["urgency"],
            lead.get("jurisdiction", ""), lead.get("injuries", False),
            lead.get("existing_representation", False), lead["qualified"],
            lead["reason"], lead["source"], lead.get("duration_seconds", 0),
            "Yes" if lead.get("transcript") else "No", "complete", lead["processed_at"],
        ]]},
    ).execute(), "sheets")


def update_dedup_tracker(lead: dict):
    sheets_service.spreadsheets().values().append(
        spreadsheetId=CONFIG["sheets_id"],
        range="Dedup Tracker!A:C",
        valueInputOption="USER_ENTERED",
        body={"values": [[lead["call_id"], lead["phone"], lead["processed_at"]]]},
    ).execute()


def update_existing_lead(lead: dict):
    """Update existing lead row when duplicate detected."""
    logger.info(f"Updating existing lead for phone: {lead['phone']}")
    write_to_lead_log_sheet({**lead, "source": "duplicate_update"})


# --- Step 6: Gmail Notifications ---

def send_qualified_alert(lead: dict):
    urgency_tag = "URGENT " if lead["urgency"] == "high" else ""
    subject = f"{urgency_tag}New Qualified Lead: {lead['caller_name']} — {format_case_type(lead['case_type'])}"
    body = f"""
    <h2>{urgency_tag}New Qualified Lead</h2>
    <table>
      <tr><td><b>Name:</b></td><td>{lead['caller_name']}</td></tr>
      <tr><td><b>Phone:</b></td><td>{lead['phone']}</td></tr>
      <tr><td><b>Email:</b></td><td>{lead.get('email') or 'Not provided'}</td></tr>
      <tr><td><b>Case Type:</b></td><td>{format_case_type(lead['case_type'])}</td></tr>
      <tr><td><b>Urgency:</b></td><td>{lead['urgency'].upper()}</td></tr>
      <tr><td><b>Description:</b></td><td>{lead['case_description']}</td></tr>
      <tr><td><b>Qualification:</b></td><td>{lead['reason']}</td></tr>
    </table>
    <p><a href="https://docs.google.com/spreadsheets/d/{CONFIG['sheets_id']}">View in Lead Tracker</a></p>
    <small>AI Intake System | Call ID: {lead['call_id']}</small>
    """
    _send_email(CONFIG["intake_email"], subject, body)


def send_decline_email(lead: dict):
    if not lead.get("email"):
        return
    subject = f"Thank you for contacting {CONFIG['firm_name']}"
    body = f"""
    <p>Dear {lead['caller_name'].split()[0]},</p>
    <p>Thank you for reaching out to {CONFIG['firm_name']}.</p>
    <p>After reviewing your inquiry, we've determined this matter falls outside our practice areas.</p>
    <p>We recommend contacting the <b>California State Bar Lawyer Referral Service</b>
    at <b>1-866-442-2529</b> for assistance.</p>
    <p>We wish you the best.</p>
    <p>Warm regards,<br>{CONFIG['firm_name']}</p>
    """
    _send_email(lead["email"], subject, body)


def send_internal_fyi(lead: dict):
    subject = f"Non-Qualified Lead: {lead['caller_name']} — {format_case_type(lead['case_type'])}"
    body = f"""
    <p><b>Non-Qualified (FYI)</b></p>
    <p>Name: {lead['caller_name']} | Phone: {lead['phone']} | Case: {format_case_type(lead['case_type'])}</p>
    <p>Reason: {lead['reason']}</p>
    <p>Decline email {'sent' if lead.get('email') else 'NOT sent (no email)'}.</p>
    <small>Call ID: {lead['call_id']}</small>
    """
    _send_email(CONFIG["intake_email"], subject, body)


def _send_email(to: str, subject: str, html_body: str):
    raw = urlsafe_b64encode(
        f"To: {to}\r\nSubject: {subject}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n{html_body}".encode()
    ).decode()
    gmail_service.users().messages().send(
        userId="me", body={"raw": raw}
    ).execute()


# --- Google Calendar Follow-Up ---

def create_calendar_followup(lead: dict):
    start = datetime.now() + timedelta(minutes=30 if lead["urgency"] == "high" else 60)
    end = start + timedelta(minutes=15)

    calendar_service.events().insert(
        calendarId="primary",
        body={
            "summary": f"Follow up: {lead['caller_name']} — {format_case_type(lead['case_type'])}",
            "description": f"Phone: {lead['phone']}\nEmail: {lead.get('email', 'N/A')}\nCase: {lead['case_description']}\nUrgency: {lead['urgency']}\n\nCall ID: {lead['call_id']}",
            "start": {"dateTime": start.isoformat(), "timeZone": "America/Los_Angeles"},
            "end": {"dateTime": end.isoformat(), "timeZone": "America/Los_Angeles"},
            "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": 5}]},
        },
    ).execute()


# --- Error Handling ---

def handle_error(error: Exception, call_data: dict):
    logger.error(f"Error: {error}", exc_info=True)

    try:
        sheets_service.spreadsheets().values().append(
            spreadsheetId=CONFIG["sheets_id"],
            range="Error Log!A:F",
            valueInputOption="USER_ENTERED",
            body={"values": [[
                datetime.now().isoformat(),
                call_data.get("call_id", "unknown"),
                str(error),
                "",
                json.dumps(call_data)[:1000],
                "pending_review",
            ]]},
        ).execute()

        _send_email(
            CONFIG["admin_email"],
            f"[ALERT] Intake Error — {str(error)[:50]}",
            f"<h3>Intake Automation Error</h3><p><b>Error:</b> {error}</p>"
            f"<p><b>Call ID:</b> {call_data.get('call_id', 'unknown')}</p>"
            f"<p><a href='https://docs.google.com/spreadsheets/d/{CONFIG['sheets_id']}'>View Error Log</a></p>",
        )
    except Exception as meta_error:
        Path("./data/backup").mkdir(parents=True, exist_ok=True)
        with open("./data/backup/emergency-errors.jsonl", "a") as f:
            f.write(json.dumps({
                "timestamp": datetime.now().isoformat(),
                "original_error": str(error),
                "meta_error": str(meta_error),
                "call_data": call_data,
            }) + "\n")


# --- Retry Utility ---

def retry_with_backoff(fn, service_name: str, max_retries: int = 3):
    import time
    delays = [5, 30, 120]

    for attempt in range(max_retries + 1):
        try:
            return fn()
        except Exception as e:
            if attempt == max_retries:
                raise
            delay = delays[attempt] if attempt < len(delays) else 120
            logger.warning(f"[RETRY] {service_name} attempt {attempt+1} failed, retrying in {delay}s")
            time.sleep(delay)


# --- Helpers ---

def format_case_type(case_type: str) -> str:
    return case_type.replace("_", " ").title()


# --- Health Check ---

@app.get("/health")
async def health():
    return {"status": "ok", "timestamp": datetime.now().isoformat()}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 3000)))
