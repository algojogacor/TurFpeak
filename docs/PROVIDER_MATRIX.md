# Flash Peak TMS — AI Provider Capability Matrix & Telemetry Policy

**Document Status:** Production Reference
**Last Verified:** 22 Nov 2026 (refreshed against the code on branch `feat/ai-native-expansion-v1`; the previous revision still described the retired 3-provider era)
**Applicable Regulations:** D-010, O-010, FR-AI-001–003, FR-FAIL-001–002, PROMPT_CATALOG.md §10

---

## 1. Provider Capabilities Overview

The `ProviderRouter` rotates across every adapter that has a configured API key at startup (`src/cli/start.ts`), with circuit breakers, task-based priority ordering, and manual fallback when all providers fail. Seven adapters exist in code; **six are active in production** (each activated by its env key). Ollama Cloud is retained in code but currently inactive — no `OLLAMA_CLOUD_BASE_URL` is set on the VM — it is a dormant fallback path, not a removed provider.

All adapters declare vision capability (`capabilities.vision = true`); per-request model selection uses the adapter's vision model for image requests and its text model otherwise.

| Provider (enum `AIProviderName`) | Default text model (env override) | Default vision model (env override) | Multi-key rotation | Activation env | Status |
| :--- | :--- | :--- | :---: | :--- | :--- |
| `GROQ` | `qwen/qwen3.8-27b` (`GROQ_MODEL`) | `qwen/qwen3.8-27b` (`GROQ_VISION_MODEL`) | ✅ `GROQ_API_KEYS` (comma-separated) + `GROQ_API_KEY` | `GROQ_API_KEY` | **Active (prod)** |
| `DEEPSEEK` | `deepseek-flash` (`DEEPSEEK_MODEL`) | `deepseek-flash` (`DEEPSEEK_VISION_MODEL`) | ✅ `DEEPSEEK_API_KEYS` + `DEEPSEEK_API_KEY` | `DEEPSEEK_API_KEY` | **Active (prod)** |
| `GEMINI` | `gemini-3-flash-preview` (`GEMINI_MODEL`) | `gemini-3-flash-preview` (`GEMINI_VISION_MODEL`) | single key | `GEMINI_API_KEY` | **Active (prod)** |
| `NVIDIA_NIM` | `nvidia/nemotron-3.5-lightning-30b-a3b` (`NVIDIA_TEXT_MODEL` / `NVIDIA_MODEL`) | `nvidia/nemotron-3.5-super-vl-120b-a12b` (`NVIDIA_VISION_MODEL`) | ✅ `NVIDIA_API_KEYS` + `NVIDIA_API_KEY` | `NVIDIA_API_KEY` | **Active (prod)** |
| `COHERE` | `command-a-reasoning-08-2025` (`COHERE_TEXT_MODEL` / `COHERE_MODEL`) | `c4ai-aya-vision-32b` (`COHERE_VISION_MODEL`) | ✅ `COHERE_API_KEYS` + `COHERE_API_KEY` | `COHERE_API_KEY` | **Active (prod)** |
| `MISTRAL` | `codestral-latest` (`MISTRAL_TEXT_MODEL` / `MISTRAL_MODEL`) | `pixtral-12b-2409` (`MISTRAL_VISION_MODEL`) | ✅ `MISTRAL_API_KEYS` + `MISTRAL_API_KEY` | `MISTRAL_API_KEY` | **Active (prod)** |
| `OLLAMA_CLOUD` | `llama3.2-vision` (`OLLAMA_MODEL`) | (same) | single key | `OLLAMA_CLOUD_BASE_URL` (+ `OLLAMA_CLOUD_API_KEY`) | **Inactive — no env set** |

Startup logs the active set explicitly: `[AI] Initialized Multi-Provider Router with N provider(s): …` — check `pm2 logs flashpeak-bot` at boot to confirm which providers are live in a given deployment.

**Verified latency / quota figures:** none published for the current six-provider set. Per-request latency, token counts, and outcomes are recorded per call in `provider_usage` (see §6); publish p50/p95 numbers from that table only, never from estimates.

---

## 2. Task Types & Router Priority

Task types (enum `AITaskType`, mirrored by the `provider_usage.task_type` CHECK constraint):

| Group | Task | Typical consumer |
| :--- | :--- | :--- |
| Vision evidence | `CLASSIFY`, `EXTRACT_MATCH`, `EXTRACT_GOALKEEPER` | Screenshot evidence pipeline |
| Parsing | `PARSE_CORRECTION`, `PARSE_ROSTER` | NL correction parsing / roster extraction |
| AI-native (D-037..D-040) | `CHAT_OMAK_PEAK`, `PLAN_AGENT`, `EXTRACT_QNA`, `FORMAT_HYPE`, `GENERATE_PANTUN`, `REPHRASE_TRIVIA` | `!ai`, `!agent`, `!saveqna`, engagement hooks, `!trivia` |

With `prioritizeByTask: true` (production config), the router orders adapters per request (`src/ai/router.ts` `getOrderedAdapters`):

- **Vision requests:** `DEEPSEEK → GROQ → GEMINI → NVIDIA_NIM → MISTRAL → COHERE → OLLAMA_CLOUD`
- **Text requests:** `GROQ → DEEPSEEK → NVIDIA_NIM → COHERE → MISTRAL → GEMINI → OLLAMA_CLOUD`

In each case only adapters registered at startup participate; unavailable (breaker-tripped) adapters are deferred to the end of the chain rather than skipped entirely.

---

## 3. Image Input Specifications & Guardrails

1. **Supported MIME Types:**
   - `image/jpeg`
   - `image/png`
   - `image/webp`
2. **Payload Size Guardrails:**
   - Maximum raw image size: 10 MB per screenshot.
   - Recommended resolution: 1080p to 1440p (native mobile screenshot resolution).
   - Ingestion sanitization: Images below 1 KB or with empty byte buffers are rejected immediately as `UNREADABLE` without consuming provider tokens.
3. **Caption Isolation Rule (AI_PIPELINE.md §2):**
   - The classifier never determines screen type based on message caption alone. Visual inspection of scoreboard or player cards is mandatory.

---

## 4. Error Taxonomy & Circuit Breaker Policy

The `ProviderRouter` handles provider failures using a strict error taxonomy:

| Error Type | HTTP / Provider Codes | Circuit Breaker Action | Retry Policy |
| :--- | :--- | :--- | :--- |
| **AIAuthenticationError** | `401 Unauthorized`, `403 Forbidden` | Trips immediately to `OPEN` | **0 Retries** — Stop immediately to protect credentials |
| **AIQuotaExceededError** | `429 Too Many Requests` (Quota exhausted) | Trips immediately to `OPEN` for 60s cooldown | **0 Retries** — Rotate immediately to next healthy provider |
| **AIRateLimitError** | `429 Too Many Requests` (RPM burst) | Records 1 failure, cooldown applied | Exponential backoff (1 retry max) |
| **AITimeoutError** | Request exceeds the adapter's timeout (default 15 s) | Records 1 failure | 1 retry with exponential jitter |
| **AIMalformedResponseError** | Unparseable JSON or Zod schema violation | Records 1 failure | Fallback to next provider in chain |
| **AISafetyError** | Model content filter tripped | Trips to `OPEN` | Fail over immediately |
| **AIProviderUnavailableError** | `500`, `502`, `503`, `504` | 3 consecutive failures trips to `OPEN` | Rotate to next provider |

### Circuit Breaker States:
- **CLOSED:** Normal healthy operation. Requests are distributed across active providers.
- **OPEN:** After 3 consecutive network failures or 1 fatal quota/auth failure, provider is bypassed for 60 seconds (`cooldownWindowMs = 60000`).
- **HALF_OPEN:** After cooldown window expires, a single trial request is dispatched. If successful, state resets to `CLOSED`; if failed, state resets to `OPEN`.

---

## 5. Absolute Failure & Manual Mode Fallback (FR-FAIL-002)

If all configured providers in the router fail simultaneously (or trip their respective circuit breakers):
1. Router throws `AllProvidersFailedError`.
2. System **never** halts the tournament or deletes evidence.
3. System outputs the standardized message to the WhatsApp group:
   > *"Pemrosesan tangkapan layar otomatis sementara tidak tersedia. Laporan pertandingan belum dikonfirmasi atau diubah. Status pertandingan TIDAK resmi, TIDAK diterima, dan TIDAK ditolak. Silakan hubungi penyelenggara turnamen untuk verifikasi manual."*
4. Tournament administrator/organizer executes the authoritative fallback command:
   ```bash
   !manualreport <fixture_id>
   ```
5. Manual reports enter the exact same deterministic backend validation and three-party approval lifecycle (`Team A + Team B + Organizer -> LOCKED`). AI recovery processes do not overwrite manual data (`provenance = MANUAL_ENTRY`).

---

## 6. Telemetry & Audit Persistence

Every AI inference attempt records structured telemetry to the `provider_usage` table in Turso (migration 004 rebuilt the table to extend both CHECK constraints; existing rows were preserved):
- `id`: Stable UUID
- `provider`: `'GROQ' | 'DEEPSEEK' | 'GEMINI' | 'NVIDIA_NIM' | 'COHERE' | 'MISTRAL' | 'OLLAMA_CLOUD'`
- `model`: Exact model string used for the call (text or vision variant)
- `task_type`: `'CLASSIFY' | 'EXTRACT_MATCH' | 'EXTRACT_GOALKEEPER' | 'PARSE_CORRECTION' | 'PARSE_ROSTER' | 'CHAT_OMAK_PEAK' | 'PLAN_AGENT' | 'EXTRACT_QNA' | 'FORMAT_HYPE' | 'GENERATE_PANTUN' | 'REPHRASE_TRIVIA'`
- `request_status`: `'SUCCESS' | 'ERROR' | 'RATE_LIMITED' | 'TIMEOUT'`
- `input_units`: Input tokens count
- `output_units`: Output tokens count
- `latency_ms`: Total round-trip latency in milliseconds
- `error_code`: Sanitized error code or classification
