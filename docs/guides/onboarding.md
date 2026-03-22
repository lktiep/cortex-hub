# Onboarding Guide — Cortex Hub

> Get started with Cortex Hub in under 5 minutes. Zero API keys needed.

---

## How It Works

Cortex Hub uses **CLIProxy** as the LLM gateway. CLIProxy wraps your existing AI subscriptions (ChatGPT Plus, Gemini, Claude) via OAuth — **no API key required**. All services (mem9, dashboard, MCP) route through this proxy automatically.

```
Your Browser → OAuth Login → CLIProxy → OpenAI/Gemini/Claude
                                ↓
                         mem9, Dashboard API, MCP Server
                         (all route through CLIProxy)
```

---

## First-Time Setup

### 1. Open Cortex Hub

Navigate to **https://hub.jackle.dev**

On first visit, the **Setup Wizard** launches automatically:

```
┌─────────────────────────────────────────┐
│         Welcome to Cortex Hub           │
│                                         │
│  Let's connect your AI provider.        │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │ ● OpenAI (ChatGPT Plus)        │    │
│  │ ○ Google Gemini                 │    │
│  │ ○ Claude (Anthropic)           │    │
│  │ ○ Custom OpenAI-compatible     │    │
│  └─────────────────────────────────┘    │
│                                         │
│              [ Connect → ]              │
└─────────────────────────────────────────┘
```

### 2. OAuth Authentication

Click **Connect** — you'll be redirected to your provider's login page. Sign in with your existing subscription. No API key to copy-paste.

| Provider | Auth | What You Need |
|----------|------|---------------|
| **OpenAI** | OAuth | ChatGPT Plus subscription |
| **Gemini** | Google OAuth | Google account |
| **Claude** | Anthropic OAuth | Claude subscription |
| **Custom** | API Key | Any OpenAI-compatible endpoint |

### 3. Select & Test Models

After OAuth, the wizard shows available models. Select which ones to enable and test the connection:

```
┌─────────────────────────────────────────┐
│  ✓ Connected to OpenAI                  │
│                                         │
│  Available Models:                      │
│  ☑ GPT-4o          ☑ GPT-4o-mini       │
│  ☑ o3              ☐ o4-mini           │
│  ☑ text-embedding-3-small              │
│                                         │
│  Test: "Hello" → "Hi! How can I help?" │
│  ✓ Connection verified                  │
│                                         │
│          [ Enter Dashboard → ]          │
└─────────────────────────────────────────┘
```

### 4. Create Organization & Projects

Once inside, create your organization structure:

```
┌─────────────────────────────────────────┐
│  Organization: Yulgang                  │
│  ├── Project: yulgang-bot               │
│  ├── Project: yulgang-analytics         │
│  └── Project: yulgang-docs              │
│                                         │
│  Organization: Personal                 │
│  └── Project: cortex-hub                │
└─────────────────────────────────────────┘
```

### 5. Generate Scoped API Keys

Create API keys with granular permissions:

```
┌─────────────────────────────────────────┐
│  New API Key                            │
│                                         │
│  Name: agent-yulgang-prod               │
│  Scope: ○ All projects                  │
│         ● Organization: Yulgang/*       │
│         ○ Single project                │
│                                         │
│  Permissions:                           │
│  ☑ code.search    ☑ memory.store        │
│  ☑ knowledge.get  ☐ admin.*             │
│                                         │
│  Expires: ○ Never  ● 90 days           │
│                                         │
│          [ Generate Key → ]             │
│                                         │
│  cortex_sk_Yg7x...Kp2m                  │
│  ⚠ Copy now — won't be shown again     │
└─────────────────────────────────────────┘
```

### 6. Connect Your AI Agent

```json
{
  "mcpServers": {
    "cortex-hub": {
      "url": "https://mcp.hub.jackle.dev",
      "headers": {
        "Authorization": "Bearer cortex_sk_Yg7x...Kp2m"
      }
    }
  }
}
```

---

## Infrastructure Endpoints

| Service | URL | Port |
|---------|-----|------|
| Dashboard | https://hub.jackle.dev | 3000 |
| API | https://api.hub.jackle.dev | 4000 |
| MCP Server | https://mcp.hub.jackle.dev | 8787 |
| LLM Proxy | https://llm.hub.jackle.dev | 8317 |
| GitNexus (internal) | http://gitnexus:4848 | 4848 |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `502 Bad Gateway` | Services not started — `docker compose up -d` |
| OAuth login fails | Check CLIProxy logs: `docker logs cortex-llm-proxy` |
| API key rejected | Verify key scope includes the target project |
| Models not available | Re-authenticate at LLM Proxy management |
