# Flash Peak TMS — AI Provider Capability Matrix & Telemetry Policy

**Document Status:** Production Reference  
**Last Verified:** November 2026  
**Applicable Regulations:** D-010, O-010, FR-AI-001–003, FR-FAIL-001–002, PROMPT_CATALOG.md §10

---

## 1. Provider Capabilities Overview

Flash Peak TMS utilizes a 3-provider load-balanced and fault-tolerant AI rotation architecture. All providers are utilized on compliant free-tier terms with strict rate limiting and circuit breakers to avoid evading quota limits.

| Provider | Production Model Identifier | Vision Input | Structured JSON Output | Verified Latency (p50) | Free-Tier Limits | Quota Handling & Fallback Priority |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| **Google Gemini** | `gemini-1.5-flash` | ✅ Yes | ✅ Native JSON Schema (`responseSchema`) | 1,200 ms | 15 RPM / 1M TPM / 1,500 RPD | **Primary (Rank 1)** for multimodal match classification & complex table extraction |
| **Groq Cloud** | `llama-3.2-11b-vision-preview` | ✅ Yes | ✅ JSON Mode (`response_format: { type: "json_object" }`) | 450 ms | 30 RPM / 7,000 TPM / 14,400 RPD | **Fast Secondary (Rank 2)** for ultra-fast OCR and natural language correction parsing |
| **Ollama Cloud** | `llama3.2-vision:latest` | ✅ Yes | ✅ Format JSON (`format: "json"`) | 2,100 ms | Provider-specific cloud tier | **Resilient Tertiary (Rank 3)** fallback when cloud rate limits are reached |

---

## 2. Model Capabilities & Task Matrix

| Task Type | Target Prompt ID | Input Artifacts | Gemini 1.5 Flash | Groq Llama 3.2 11B | Ollama 3.2 Vision |
| :--- | :--- | :--- | :---: | :---: | :---: |
| **CLASSIFY** | `image_classifier_v1` | Screenshot Binary | ✅ Grounded visual cues | ✅ Fast visual cues | ✅ Fallback visual cues |
| **EXTRACT_MATCH** | `main_match_extractor_v1` | Scoreboard Image + Context | ✅ Preserves Unicode raw nicknames | ✅ Low latency | ✅ Reliable tabular OCR |
| **EXTRACT_GOALKEEPER**| `gk_detail_extractor_v1` | Detail Screen Image | ✅ Detects cap/gloves/ball | ✅ Extracts summary metrics | ✅ Fallback |
| **PARSE_CORRECTION** | `correction_parser_v1` | Indonesian/English Text | ✅ Full schema validation | ✅ Fast NL patch extraction | ✅ Heuristic reconciliation |

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
| **AITimeoutError** | Request exceeds 30,000 ms | Records 1 failure | 1 retry with exponential jitter |
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

Every AI inference attempt records structured telemetry to the `provider_usage` table in Turso:
- `id`: Stable UUID
- `provider`: `'GEMINI' | 'GROQ' | 'OLLAMA_CLOUD'`
- `model`: Exact model string (e.g. `gemini-1.5-flash`)
- `task_type`: `'CLASSIFY' | 'EXTRACT_MATCH' | 'EXTRACT_GOALKEEPER' | 'PARSE_CORRECTION'`
- `request_status`: `'SUCCESS' | 'ERROR' | 'RATE_LIMITED' | 'TIMEOUT'`
- `input_units`: Input tokens count
- `output_units`: Output tokens count
- `latency_ms`: Total round-trip latency in milliseconds
- `error_code`: Sanitized error code or classification
