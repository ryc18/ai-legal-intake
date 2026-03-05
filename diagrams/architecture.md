# System Architecture Diagrams

Render these Mermaid diagrams at https://mermaid.live or in any Markdown editor that supports Mermaid.

---

## Diagram 1: High-Level System Architecture

```mermaid
flowchart TB
    subgraph External["External Touchpoints"]
        CALLER["Inbound Caller"]
        EMAIL_OUT["Decline Email\nto Lead"]
    end

    subgraph VoiceAI["Voice AI Layer (Provider-Agnostic)"]
        VOICE["Voice AI Agent\n(Bland.ai / Retell.ai /\nany provider)"]
        LLM_VOICE["LLM\n(during call)"]
    end

    subgraph Orchestration["n8n — Automation Orchestrator"]
        WEBHOOK["Webhook\nReceiver"]
        AI_NODE["AI Agent Node\n(OpenAI GPT-4o)"]
        DEDUP["Dedup Check\n(Sheets lookup)"]
        QUALIFY["Qualification\nEngine"]
        RETRY["Retry Handler\n& Error Logger"]
    end

    subgraph Google["Google Workspace"]
        SHEETS_CRM["Google Sheets\n'Leads' (CRM)"]
        SHEETS_LOG["Google Sheets\n'Lead Log'"]
        SHEETS_ERR["Google Sheets\n'Error Log'"]
        GMAIL_TEAM["Gmail\nIntake Team Alert"]
        GMAIL_DECLINE["Gmail\nDecline Email"]
        GCAL["Google Calendar\nFollow-up Events"]
    end

    CALLER -->|"Calls phone number"| VOICE
    VOICE <-->|"Conversation"| LLM_VOICE
    VOICE -->|"Webhook POST\n(structured call data)"| WEBHOOK

    WEBHOOK --> DEDUP
    DEDUP -->|"New lead"| AI_NODE
    AI_NODE --> QUALIFY
    DEDUP -->|"Duplicate"| SHEETS_LOG

    QUALIFY -->|"All leads"| SHEETS_CRM
    QUALIFY -->|"All leads"| SHEETS_LOG
    QUALIFY -->|"Qualified"| GMAIL_TEAM
    QUALIFY -->|"Qualified"| GCAL
    QUALIFY -->|"Not Qualified"| GMAIL_DECLINE

    GMAIL_DECLINE --> EMAIL_OUT

    WEBHOOK --> RETRY
    RETRY -->|"Failures"| SHEETS_ERR
    RETRY -->|"Critical failures"| GMAIL_TEAM

    style VOICE fill:#4A90D9,stroke:#333,color:#fff
    style WEBHOOK fill:#FF6D5A,stroke:#333,color:#fff
    style AI_NODE fill:#10A37F,stroke:#333,color:#fff
    style QUALIFY fill:#FF6D5A,stroke:#333,color:#fff
    style SHEETS_CRM fill:#0F9D58,stroke:#333,color:#fff
    style SHEETS_LOG fill:#0F9D58,stroke:#333,color:#fff
    style SHEETS_ERR fill:#DB4437,stroke:#333,color:#fff
    style GMAIL_TEAM fill:#D93025,stroke:#333,color:#fff
    style GMAIL_DECLINE fill:#D93025,stroke:#333,color:#fff
    style GCAL fill:#4285F4,stroke:#333,color:#fff
```

---

## Diagram 2: Call Flow Sequence

```mermaid
sequenceDiagram
    participant C as Caller
    participant V as Voice AI Agent
    participant AI as GPT-4o (via Voice AI)
    participant N as n8n Orchestrator
    participant S as Google Sheets
    participant G as Gmail
    participant Cal as Google Calendar

    C->>V: Inbound call
    V->>C: "Thank you for calling [Firm]. I'm Alex..."

    loop Intake Conversation
        C->>V: Provides information
        V->>AI: Process response + extract data
        AI->>V: Structured response
        V->>C: Follow-up question
    end

    V->>AI: Final qualification check
    AI->>V: collectLeadInfo function call
    V->>C: Closing statement
    V-->>C: Call ends

    V->>N: POST webhook (structured call data)

    N->>S: Check Dedup Tracker sheet
    S-->>N: No duplicate found

    N->>N: Run qualification engine

    par Parallel Processing
        N->>S: Append to "Leads" sheet (CRM)
        S-->>N: 200 OK
        N->>S: Append to "Lead Log" sheet
        S-->>N: 200 OK
    end

    alt Qualified Lead
        N->>G: Email to intake-team@firm.com
        G-->>N: Sent
        N->>Cal: Create follow-up event
        Cal-->>N: Created
    else Not Qualified Lead
        N->>G: Decline email to lead
        G-->>N: Sent
        N->>G: FYI to intake-log@firm.com
        G-->>N: Sent
    end

    N->>S: Update Dedup Tracker
    N->>S: Update Lead Log → status: complete
```

---

## Diagram 3: Error Handling Flow

```mermaid
flowchart TD
    START["n8n Receives Webhook"] --> VALIDATE{"Valid\nPayload?"}

    VALIDATE -->|No| LOG_ERR["Log to Google Sheets\n'Error Log'"]
    LOG_ERR --> ALERT_ADMIN["Gmail Alert\nto Admin"]

    VALIDATE -->|Yes| DEDUP{"Duplicate\nCheck"}

    DEDUP -->|Duplicate| UPDATE["Update Existing\nSheets Row"]
    DEDUP -->|New| PROCESS["Process Lead"]

    PROCESS --> SHEETS_WRITE["Write to\nGoogle Sheets"]

    SHEETS_WRITE -->|Success| NEXT_STEP["Continue to\nNotifications"]
    SHEETS_WRITE -->|Failure| RETRY1{"Retry\n#1 (5s)"}

    RETRY1 -->|Success| NEXT_STEP
    RETRY1 -->|Failure| RETRY2{"Retry\n#2 (30s)"}

    RETRY2 -->|Success| NEXT_STEP
    RETRY2 -->|Failure| RETRY3{"Retry\n#3 (2m)"}

    RETRY3 -->|Success| NEXT_STEP
    RETRY3 -->|Failure| FALLBACK["Sheets API\nFallback"]

    FALLBACK --> JSON_BACKUP["Write to Local\nJSON Backup File"]
    FALLBACK --> ERR_LOG["Log to\nError Log Sheet"]
    FALLBACK --> ADMIN_ALERT["Gmail: Admin Alert\n'Sheets write failed\nafter 3 retries'"]

    NEXT_STEP --> GMAIL_SEND["Send Gmail\nNotification"]
    GMAIL_SEND -->|Failure after 2x| EMAIL_ERR["Log failed email\nto Error Log\nfor manual send"]

    subgraph Recovery["Recovery Workflow (every 15 min)"]
        CRON["Scheduled\nTrigger"] --> CHECK_BACKUP["Check for\nbackup JSON files"]
        CHECK_BACKUP -->|"Files found"| SYNC["Push to\nGoogle Sheets"]
        SYNC -->|Success| ARCHIVE["Archive\nbackup file"]
        SYNC -->|"5 failures"| ESCALATE["Escalate:\nManual intervention"]
    end

    style START fill:#4A90D9,stroke:#333,color:#fff
    style FALLBACK fill:#DB4437,stroke:#333,color:#fff
    style NEXT_STEP fill:#0F9D58,stroke:#333,color:#fff
    style ADMIN_ALERT fill:#DB4437,stroke:#333,color:#fff
    style ESCALATE fill:#DB4437,stroke:#333,color:#fff
    style JSON_BACKUP fill:#F4B400,stroke:#333,color:#000
```

---

## Diagram 4: n8n Workflow Overview

```mermaid
flowchart LR
    subgraph Trigger
        WH["Webhook\nPOST /legal-intake"]
    end

    subgraph Validation
        VAL["Validate\nPayload"]
        SECRET["Verify\nShared Secret"]
    end

    subgraph Dedup
        DD["Read Dedup\nTracker Sheet"]
        CHECK["Check call_id\n& phone match"]
        MERGE["Skip or\nUpdate if Dup"]
    end

    subgraph AI["AI Processing"]
        AI_NODE["n8n AI Agent\n(OpenAI GPT-4o)"]
        STRUCT["Extract\nStructured Data"]
    end

    subgraph Qualification
        QUAL["Qualification\nEngine"]
        ROUTE{"Route by\nResult"}
    end

    subgraph qualified_path["Qualified Path"]
        SHEETS_Q["Sheets: Append Lead\nPipeline: Qualified"]
        GMAIL_Q["Gmail: Notify\nIntake Team"]
        CAL_Q["Calendar: Create\nFollow-up Event"]
    end

    subgraph not_qualified_path["Not Qualified Path"]
        SHEETS_NQ["Sheets: Append Lead\nPipeline: Declined"]
        GMAIL_NQ["Gmail: Send\nDecline Email"]
        GMAIL_FYI["Gmail: FYI to\nIntake Log"]
    end

    subgraph logging["Logging (Always)"]
        LOG["Sheets: Append\nto Lead Log"]
        DEDUP_UPDATE["Sheets: Update\nDedup Tracker"]
    end

    WH --> SECRET --> VAL --> DD --> CHECK
    CHECK -->|"New"| AI_NODE --> STRUCT --> QUAL --> ROUTE
    CHECK -->|"Duplicate"| MERGE --> LOG

    ROUTE -->|"Qualified"| SHEETS_Q & GMAIL_Q & CAL_Q
    ROUTE -->|"Not Qualified"| SHEETS_NQ & GMAIL_NQ & GMAIL_FYI

    SHEETS_Q & SHEETS_NQ --> LOG --> DEDUP_UPDATE

    style WH fill:#FF6D5A,stroke:#333,color:#fff
    style AI_NODE fill:#10A37F,stroke:#333,color:#fff
    style QUAL fill:#FF6D5A,stroke:#333,color:#fff
    style ROUTE fill:#F4B400,stroke:#333,color:#000
```

---

## Diagram 5: Scaling Architecture (10x Volume)

```mermaid
flowchart TB
    subgraph Input["Inbound Layer"]
        V1["Voice AI Agent #1\n(English)"]
        V2["Voice AI Agent #2\n(Spanish)"]
        V3["Voice AI Agent #3\n(Overflow)"]
    end

    subgraph Queue["Message Queue"]
        REDIS["Redis\nMessage Broker"]
    end

    subgraph Workers["n8n Worker Cluster"]
        W1["Worker 1\nSheets + DB Writes"]
        W2["Worker 2\nGmail Notifications"]
        W3["Worker 3\nCalendar + AI Processing"]
    end

    subgraph Data["Data Layer"]
        PG["PostgreSQL\n(Primary Database)"]
        SHEETS_DASH["Google Sheets\n(Dashboard View)"]
        GMAIL2["Gmail\n(Notifications)"]
    end

    subgraph Monitor["Monitoring"]
        GRAF["Grafana\nDashboard"]
        PD["PagerDuty\nAlerts"]
    end

    V1 & V2 & V3 -->|"Webhooks"| REDIS
    REDIS --> W1 & W2 & W3
    W1 --> PG
    W1 -->|"Sync"| SHEETS_DASH
    W2 --> GMAIL2
    W3 --> PG
    W1 & W2 & W3 -->|"Metrics"| GRAF
    GRAF -->|"Threshold alerts"| PD

    style REDIS fill:#DC382D,stroke:#333,color:#fff
    style PG fill:#336791,stroke:#333,color:#fff
    style SHEETS_DASH fill:#0F9D58,stroke:#333,color:#fff
    style GRAF fill:#F46800,stroke:#333,color:#fff
    style GMAIL2 fill:#D93025,stroke:#333,color:#fff
```
