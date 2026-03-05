# AI & Automations Integration Specialist — Skills Assessment

## About This Submission

This is my skills assessment for the AI & Automations Integration Specialist role at **Lion Head**. I've designed a complete AI-powered lead intake system for law firm clients, presenting two implementation approaches to demonstrate both no-code automation and coding skills.

---

## What's Inside

```
Lion Head/
├── README.md                          ← You're here
├── assessment-document.md             ← Main written document (all 3 parts)
├── diagrams/
│   └── architecture.md                ← 5 Mermaid diagrams (render at mermaid.live)
├── code/
│   ├── ai-intake-prompt.json          ← Voice AI agent + n8n AI node configuration
│   ├── n8n-workflow.json              ← n8n workflow (importable)
│   ├── server.js                      ← Node.js coded approach (Express)
│   ├── server.py                      ← Python coded approach (FastAPI)
│   ├── qualification-logic.js         ← Two-layer qualification engine
│   └── error-handler.js              ← Retry, dead letter queue, circuit breaker
└── sop/
    └── system-maintenance-sop.md      ← Full maintenance SOP
```

---

## How to Review

**Start with** `assessment-document.md` — it covers everything:
- **Part 1**: System design, automation logic, AI prompts, error handling
- **Part 2**: Debugging an existing automation
- **Part 3**: SOP, change log, security, scaling

**Then check the diagrams** — paste the Mermaid code from `diagrams/architecture.md` into [mermaid.live](https://mermaid.live) to render them.

**Then browse the code** — the `code/` directory has working implementations in both n8n (visual) and code (JS + Python).

---

## Two Approaches

| | Approach 1: n8n Workflow | Approach 2: Coded (JS + Python) |
|---|---|---|
| **Tools** | n8n + Google Sheets + Gmail | Express/FastAPI + Google APIs + OpenAI |
| **Deployed** | Self-hosted n8n | Vercel + GitHub |
| **Best for** | Most law firm clients | Complex requirements, dev teams |

Both use the same qualification logic, error handling, and data model. The difference is the execution layer.

---

## Key Design Decisions

1. **n8n over Zapier/Make** — Self-hostable for law firm data privacy, no per-task pricing, built-in AI nodes.

2. **Two-layer qualification** — Deterministic rules handle obvious cases (no AI hallucination risk), AI handles gray areas. System defaults to qualifying leads — losing a lead is worse than a false positive.

3. **Google Workspace for the demo, GHL for production** — I'm transparent in the docs that the ideal production stack includes GoHighLevel, Twilio, Slack, and Vapi/Bland.ai. The Google Workspace approach demonstrates the same logic with available tools.

4. **Voice-provider-agnostic design** — The webhook interface is standardized, so swapping Bland.ai for Retell.ai or Vapi.ai requires zero workflow changes.

5. **OpenAI function calling** — Guarantees structured JSON output from the AI. No free-text parsing, no inconsistent data formats.

---

## Tools Used

| Tool | Role |
|------|------|
| n8n (self-hosted) | Automation orchestration |
| Google Sheets | CRM + lead database (demo) |
| Gmail | Notifications + follow-ups (demo) |
| Google Calendar | Follow-up scheduling |
| OpenAI GPT-4o | AI reasoning + qualification |
| Bland.ai | Voice AI (recommended for production) |
| Vercel | Deployment for coded approach |
| GitHub | Source code + version control |

**Recommended production stack:** GoHighLevel + Vapi.ai/Bland.ai + Airtable + Twilio + Slack + n8n
