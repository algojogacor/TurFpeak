/**
 * Flash Peak TMS - NVIDIA NIM Provider Adapter
 * 
 * Supports NVIDIA NIM OpenAI-compatible models (e.g. z-ai/glm-5.3-flash,
 * nvidia/nemotron-3.5-lightning-30b-a3b, moonshotai/kimi-k3.1-pro)
 * with multi-key rotation and JSON response format.
 */

import {
  AIProviderName,
  ProviderAdapter,
  ProviderCapabilities,
  AIRequest,
  AIResponse,
  AIAuthenticationError,
  AIRateLimitError,
  AIQuotaExceededError,
  AITimeoutError,
  AISafetyError,
  AIMalformedResponseError,
  AIProviderUnavailableError,
  sanitizeSensitiveString,
} from '../adapter.js';

export interface NvidiaAdapterConfig {
  apiKey?: string;
  apiKeys?: string[];
  model?: string;
  endpoint?: string;
  defaultTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class NvidiaAdapter implements ProviderAdapter {
  public readonly name: AIProviderName = 'NVIDIA_NIM';
  public readonly model: string;
  public readonly capabilities: ProviderCapabilities = {
    vision: false,
    text: true,
    structured_output: true,
    supported_mime_types: [],
  };

  private readonly apiKeys: string[];
  private keyIndex = 0;
  private readonly endpoint: string;
  private readonly defaultTimeoutMs: number;
  private readonly customFetch: typeof fetch;

  constructor(config: NvidiaAdapterConfig = {}) {
    let rawKeys: string[] = [];
    if (config.apiKeys && config.apiKeys.length > 0) {
      rawKeys = [...config.apiKeys];
      if (config.apiKey && !rawKeys.includes(config.apiKey.trim())) {
        rawKeys.unshift(config.apiKey.trim());
      }
    } else if (config.apiKey) {
      rawKeys = [config.apiKey.trim()];
    } else {
      if (process.env.NVIDIA_API_KEYS) {
        rawKeys = process.env.NVIDIA_API_KEYS.split(',').map(k => k.trim()).filter(Boolean);
      }
      if (process.env.NVIDIA_API_KEY && !rawKeys.includes(process.env.NVIDIA_API_KEY.trim())) {
        rawKeys.unshift(process.env.NVIDIA_API_KEY.trim());
      }
    }
    this.apiKeys = rawKeys.filter(Boolean);

    this.model = config.model || process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b';
    this.endpoint = config.endpoint || process.env.NVIDIA_ENDPOINT || 'https://integrate.api.nvidia.com/v1/chat/completions';
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 15000;
    this.customFetch = config.fetchFn ?? fetch;
  }

  public getActiveApiKey(): string {
    if (this.apiKeys.length === 0) return '';
    return this.apiKeys[this.keyIndex % this.apiKeys.length];
  }

  public rotateKey(): string {
    if (this.apiKeys.length <= 1) return this.getActiveApiKey();
    this.keyIndex = (this.keyIndex + 1) % this.apiKeys.length;
    return this.getActiveApiKey();
  }

  public async healthCheck(): Promise<boolean> {
    return this.apiKeys.length > 0;
  }

  public async execute<T = unknown>(request: AIRequest): Promise<AIResponse<T>> {
    const activeKey = this.getActiveApiKey();
    if (!activeKey) {
      throw new AIAuthenticationError(this.name, 'NVIDIA_API_KEY is not configured');
    }

    const timeoutMs = request.timeout_ms ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const messages: Array<{ role: string; content: string }> = [];

    if (request.system_prompt) {
      messages.push({ role: 'system', content: request.system_prompt });
    }
    messages.push({ role: 'user', content: request.prompt });

    const payload = {
      model: this.model,
      messages,
      response_format: { type: 'json_object' },
      temperature: request.temperature ?? 0.1,
    };

    const startTime = Date.now();

    try {
      const res = await this.customFetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${activeKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startTime;

      if (!res.ok) {
        const rawErrorBody = await res.text().catch(() => '');
        const sanitizedBody = sanitizeSensitiveString(rawErrorBody, this.apiKeys);

        if (res.status === 401 || res.status === 403) {
          throw new AIAuthenticationError(this.name, `NVIDIA NIM authentication failed (${res.status}): ${sanitizedBody}`, res.status);
        }

        if (res.status === 429) {
          this.rotateKey();
          const lower = sanitizedBody.toLowerCase();
          if (lower.includes('quota') || lower.includes('insufficient_quota')) {
            throw new AIQuotaExceededError(this.name, `NVIDIA NIM quota exhausted: ${sanitizedBody}`, res.status);
          }
          throw new AIRateLimitError(this.name, `NVIDIA NIM rate limit: ${sanitizedBody}`, res.status);
        }

        throw new AIProviderUnavailableError(this.name, `NVIDIA NIM returned status ${res.status}: ${sanitizedBody}`, res.status);
      }

      const resJson = await res.json() as {
        choices?: Array<{
          message?: { content?: string };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const choice = resJson.choices?.[0];
      if (!choice || !choice.message || choice.message.content === undefined) {
        throw new AIMalformedResponseError(this.name, 'NVIDIA NIM response contained no choice or content');
      }

      const rawContent = choice.message.content;

      let parsedJson: T | undefined;
      try {
        const cleaned = rawContent.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        parsedJson = JSON.parse(cleaned) as T;
      } catch {
        throw new AIMalformedResponseError(
          this.name,
          `Failed to parse JSON response from NVIDIA NIM: ${rawContent.slice(0, 100)}`
        );
      }

      return {
        raw_text: rawContent,
        parsed_json: parsedJson,
        telemetry: {
          provider: this.name,
          model: this.model,
          task_type: request.task,
          latency_ms: latencyMs,
          input_tokens: resJson.usage?.prompt_tokens ?? null,
          output_tokens: resJson.usage?.completion_tokens ?? null,
          status: 'SUCCESS',
          error_code: null,
        },
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AITimeoutError(this.name, 'NVIDIA NIM request timed out', timeoutMs);
      }
      if (err instanceof Error) {
        err.message = sanitizeSensitiveString(err.message, this.apiKeys);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
