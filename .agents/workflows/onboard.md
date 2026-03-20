---
description: Onboard the local agent to Cortex Hub (Sync rules, auth, and audit)
---

This workflow configures your local environment to connect to the Cortex Hub. It will sync project rules (AGENTS.md), inject your API key, and perform a local audit.

## Pre-requisites
- [ ] Ensure you have a Hub API Key from `https://hub.jackle.dev/keys`.
- [ ] Check if `cortex-hub` is already in your `mcp_config.json` with a valid `HUB_API_KEY`.

## Execution
1. If already configured, you may skip this step unless you need to rotate keys.
// turbo
2. Run the onboarding script (provide your key if missing from environment):
```bash
# Provide the key as an argument to avoid interactive prompt
bash ./scripts/onboard.sh YOUR_HUB_API_KEY
```

3. Acknowledge the Mission Brief and standards (SOLID, Clean Architecture) in `AGENTS.md`.
4. Run `gitnexus audit --local` if prompted to calibrate context.
