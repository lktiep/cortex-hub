# Free LLM Provider Setup & Dynamic Routing Guide

This guide details how to configure and run all background pipelines in Cortex Hub (including the capture pipeline, knowledge evolution, and embedding indexing) completely **FREE** without requiring a paid OpenAI account.

---

## 1. Executive Summary

Cortex Hub is designed to be fully customizable and provider-agnostic. While initial integrations assumed a paid OpenAI account, the core services have been upgraded to support completely free execution using **Google Gemini** or **OpenRouter's Free Models**.

### How it Works
1. **Dynamic Model Resolution**: The capture pipeline (`recipe-capture.ts`) and evolution service (`knowledge-evolution.ts`) no longer hit hardcoded OpenAI endpoints on `llm-proxy`.
2. **Dashboard Routed API**: They make requests to the dashboard's unified Hono-routed endpoint (`http://localhost:4000/api/llm/v1/chat/completions`).
3. **Database Model Routing**: The API reads the current active "Chat Model" selection saved in the SQLite `model_routing` table (synced dynamically from your dashboard **Providers** UI) and resolves the appropriate provider key automatically.

---

## 2. Option A: Google Gemini (Active & Recommended)

Google Gemini offers an extremely generous free tier through **Google AI Studio** that is perfect for private deployments.

### 2.1 — Obtain a Free API Key
1. Go to [Google AI Studio](https://aistudio.google.com/).
2. Log in with your standard Google Account.
3. Click **Get API Key** and create a key in a new or existing project.
4. Copy the API key.

### 2.2 — Configure in Cortex Hub
1. Open the Cortex Hub Web Dashboard (e.g., `http://localhost:3000` or your tunnel URL).
2. Navigate to the **Providers** page.
3. Select **Google Gemini** from the provider options.
4. Paste your free Google AI Studio API key and click **Save/Configure**.
5. Go to the **Routing** panel or settings and set your default **Chat Model** to `gemini-2.5-flash` or `gemini-1.5-pro` (both of which are free).

### 2.3 — Embedding Configuration (Optional)
If you want embeddings (vector indexing) to be free via Gemini:
1. Set the environment variable `EMBEDDING_PROVIDER=gemini` in your `.env` file.
2. The system will automatically use Gemini's text embedding models (`text-embedding-004`) using the same active Gemini API key!

---

## 3. Option B: OpenRouter Free Models (OpenAI API Format)

If you require a completely free OpenAI-compatible API endpoint that doesn't charge for tokens, **OpenRouter** hosts multiple state-of-the-art open-weights models completely for free.

### 3.1 — Setup OpenRouter
1. Go to [OpenRouter](https://openrouter.ai/).
2. Create a free account.
3. Navigate to **Keys** and create a new API Key. OpenRouter keys do not require a credit card or prepaid balance to access free models.
4. Copy the API key (starts with `sk-or-...`).

### 3.2 — Configure in Cortex Hub
1. On the **Providers** dashboard page, click **Add Provider** and choose **OpenAI-Compat** (or **OpenRouter** if listed).
2. Set the API Base URL to: `https://openrouter.ai/api/v1`
3. Paste the `sk-or-...` API key.
4. In the model selection list, you can choose any model with the `:free` suffix. Examples include:
   - `meta-llama/llama-3-8b-instruct:free`
   - `mistralai/mistral-7b-instruct:free`
   - `microsoft/phi-3-medium-128k-instruct:free`
5. Save the configuration and route your default Chat Model to the selected free OpenRouter model.

---

## 4. Option C: Local Ollama (100% Offline & Private)

If you want absolute privacy and zero external dependency, you can run models locally on your server or desktop machine using **Ollama**.

### 4.1 — Setup Ollama
1. Install Ollama on your machine (`curl -fsSL https://ollama.com/install.sh` on Linux or via installer on Windows).
2. Pull your model of choice (e.g. `llama3` or `mistral`):
   ```bash
   ollama pull llama3
   ```

### 4.2 — Configure in Cortex Hub
1. In the **Providers** dashboard page, choose **Ollama**.
2. Set the endpoint to `http://localhost:11434` (or your host IP if Ollama is running outside the Docker network).
3. Select your pulled model (e.g. `llama3`) and set it as the active chat/routing model.

---

## 5. Verification Checklist

To confirm your free LLM routing is working correctly after configuring your key:

- [ ] Check the **Dashboard Overview** to verify the active chat provider is green/online.
- [ ] Trigger a recipe capture attempt (e.g., end a task or session).
- [ ] View the logs in `cortex-api` to ensure no 502/401 errors are thrown:
  ```bash
  docker compose logs -f cortex-api
  ```
- [ ] Verify the **Activity Feed** lists a new entry in `recipe_capture_log` with status `captured` or `skipped` (due to low action count) rather than `error`.
