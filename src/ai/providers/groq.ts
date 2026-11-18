/**
 * Flash Peak TMS - Groq Provider Adapter
 * 
 * Supports Groq multimodal models (e.g. llama-3.2-11b-vision-preview, llama-3.2-90b-vision-preview)
 * with strict JSON object output mode.
 * 
 * Rules:
 * - Never log or expose API keys.
 * - Handles 401/403 (fatal), 429 (rate limit vs quota), timeouts, and JSON parsing.
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

export interface GroqAdapterConfig {
  apiKey?: string;
  model?: string;
  endpoint?: string;
  defaultTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class GroqAdapter implements ProviderAdapter {
  public readonly name: AIProviderName = 'GROQ';
  public readonly model: string;
  public readonly capabilities: ProviderCapabilities = {
    vision: true,
    text: true,
    structured_output: true,
    max_image_dimensions: { width: 4096, height: 4096 },
    max_image_bytes: 20 * 1024 * 1024,
    supported_mime_types: ['image/jpeg', 'image/png', 'image/webp'],
  };

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly defaultTimeoutMs: number;
  private readonly customFetch: typeof fetch;

  constructor(config: GroqAdapterConfig = {}) {
    this.apiKey = config.apiKey || process.env.GROQ_API_KEY || '';
    this.model = config.model || process.env.GROQ_MODEL || 'llama-3.2-11b-vision-preview';
    this.endpoint = config.endpoint || process.env.GROQ_ENDPOINT || 'https://api.groq.com/openai/v1/chat/completions';
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 15000;
    this.customFetch = config.fetchFn ?? fetch;
  }

  public async healthCheck(): Promise<boolean> {
    if (!this.apiKey) {
      return false;
    }
    return true;
  }

  public async execute<T = unknown>(request: AIRequest): Promise<AIResponse<T>> {
    if (!this.apiKey) {
      throw new AIAuthenticationError(this.name, 'GROQ_API_KEY is not configured');
    }

    const timeoutMs = request.timeout_ms ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Build multimodal messages payload
    const messages: Array<{ role: string; content: unknown }> = [];

    if (request.system_prompt) {
      messages.push({
        role: 'system',
        content: request.system_prompt,
      });
    }

    if (request.images && request.images.length > 0) {
      const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
        { type: 'text', text: request.prompt },
      ];

      for (const img of request.images) {
        const mime = img.mime_type || 'image/jpeg';
        userContent.push({
          type: 'image_url',
          image_url: {
            url: `data:${mime};base64,${img.base64}`,
          },
        });
      }

      messages.push({
        role: 'user',
        content: userContent,
      });
    } else {
      messages.push({
        role: 'user',
        content: request.prompt,
      });
    }

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
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startTime;

      if (!res.ok) {
        const rawErrorBody = await res.text().catch(() => '');
        const sanitizedBody = sanitizeSensitiveString(rawErrorBody, [this.apiKey]);

        if (res.status === 401 || res.status === 403) {
          throw new AIAuthenticationError(this.name, `Groq authentication failed (${res.status}): ${sanitizedBody}`, res.status);
        }

        if (res.status === 429) {
          const lowerBody = sanitizedBody.toLowerCase();
          if (lowerBody.includes('quota') || lowerBody.includes('insufficient_quota') || lowerBody.includes('exceeded your current quota')) {
            throw new AIQuotaExceededError(this.name, `Groq quota exhausted: ${sanitizedBody}`, res.status);
          }
          throw new AIRateLimitError(this.name, `Groq rate limit: ${sanitizedBody}`, res.status);
        }

        if (res.status === 400 && (sanitizedBody.includes('safety') || sanitizedBody.includes('policy'))) {
          throw new AISafetyError(this.name, `Groq safety policy rejection: ${sanitizedBody}`);
        }

        throw new AIProviderUnavailableError(this.name, `Groq returned status ${res.status}: ${sanitizedBody}`, res.status);
      }

      const resJson = await res.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const rawText = resJson.choices?.[0]?.message?.content ?? '';
      if (!rawText) {
        throw new AIMalformedResponseError(this.name, 'Groq returned empty response content');
      }

      let parsedJson: T | undefined;
      try {
        parsedJson = JSON.parse(rawText) as T;
      } catch {
        throw new AIMalformedResponseError(this.name, `Groq JSON parsing failed: ${rawText.slice(0, 100)}`);
      }

      return {
        raw_text: rawText,
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
        throw new AITimeoutError(this.name, 'Groq request timed out', timeoutMs);
      }
      if (err instanceof Error) {
        // Ensure sensitive tokens are not leaked in message
        err.message = sanitizeSensitiveString(err.message, [this.apiKey]);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
