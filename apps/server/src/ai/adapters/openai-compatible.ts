import { ProviderCallError } from '../errors.js';
import { PROMPT_VERSIONS, buildMessages } from '../prompts.js';
import { readCapped } from '../transport/http-json.js';
import {
  AI_CAPABILITIES,
  INTERVIEWER_CAPABILITIES,
  type AiCapability,
  type CapabilityAdapter,
} from '../types.js';

/**
 * Adapter for OpenAI-compatible chat-completion APIs, used for Groq
 * (https://api.groq.com/openai/v1) and for self-hosted servers that expose the same API
 * (e.g. vLLM or llama.cpp serving an open-weight model). JSON mode is requested where the model
 * supports it; the reply is parsed as JSON and strict schema validation happens in
 * invokeCapability.
 *
 * The base URL and key come only from server configuration. Redirects are refused, responses
 * are size-capped, and nothing about the request or response body is logged.
 */

export const OPENAI_COMPATIBLE_ADAPTER_VERSION = 'openai-compatible-v1';

const MAX_COMPLETION_TOKENS: Readonly<Record<AiCapability, number>> = {
  // GPT-OSS uses part of the completion budget for reasoning tokens.
  resume_context: 3_000,
  question_plan: 6_000,
  interview_turn: 700,
  coding_task_selection: 200,
  answer_evaluation: 1_600,
  communication_evaluation: 1_300,
  code_review: 1_300,
};

/** Low temperature for evaluation (repeatability); a little variety for questions. */
const TEMPERATURE: Readonly<Record<AiCapability, number>> = {
  resume_context: 0,
  question_plan: 0.4,
  interview_turn: 0.4,
  coding_task_selection: 0,
  answer_evaluation: 0,
  communication_evaluation: 0,
  code_review: 0,
};

function supportsJsonMode(model: string): boolean {
  // Groq's GPT-OSS endpoint rejects response_format=json_object with json_validate_failed.
  return !/^openai\/gpt-oss(?:-|$)/i.test(model);
}

function parseJsonContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
    if (fenced) {
      try {
        return JSON.parse(fenced);
      } catch {
        // Try the bounded object extraction below.
      }
    }
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start < 0 || end <= start) {
      throw new ProviderCallError('invalid_output', 'Model reply was not valid JSON.');
    }
    try {
      return JSON.parse(content.slice(start, end + 1));
    } catch {
      throw new ProviderCallError('invalid_output', 'Model reply was not valid JSON.');
    }
  }
}

export interface OpenAiCompatibleOptions {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  interviewerModel: string;
  evaluatorModel: string;
  allowInsecureHttp?: boolean;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function createOpenAiCompatibleAdapters(options: OpenAiCompatibleOptions): {
  [C in AiCapability]: CapabilityAdapter<C>;
} {
  const base = new URL(options.baseUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(options.allowInsecureHttp && loopback)) {
    throw new Error('LLM_BASE_URL must use https (http is allowed only for localhost).');
  }
  if (base.username || base.password)
    throw new Error('Put credentials in LLM_API_KEY, not the URL.');
  const endpoint = new URL(
    `${base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`}chat/completions`,
    base.origin,
  );
  const doFetch = options.fetchImpl ?? fetch;
  const maxBytes = options.maxResponseBytes ?? 512 * 1024;

  const make = <C extends AiCapability>(capability: C): CapabilityAdapter<C> => {
    const model = INTERVIEWER_CAPABILITIES.has(capability)
      ? options.interviewerModel
      : options.evaluatorModel;
    return {
      descriptor: {
        capability,
        providerId: options.providerId,
        model,
        adapterVersion: OPENAI_COMPATIBLE_ADAPTER_VERSION,
        promptVersion: PROMPT_VERSIONS[capability],
      },
      async run(input, ctx) {
        const { system, user } = buildMessages(capability, input);
        let response: Response;
        try {
          response = await doFetch(endpoint, {
            method: 'POST',
            redirect: 'error',
            signal: ctx.signal,
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              authorization: `Bearer ${options.apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
              temperature: TEMPERATURE[capability],
              max_completion_tokens: MAX_COMPLETION_TOKENS[capability],
              ...(supportsJsonMode(model) ? { response_format: { type: 'json_object' } } : {}),
              ...(supportsJsonMode(model)
                ? {}
                : { reasoning_effort: 'low' }),
              stream: false,
            }),
          });
        } catch {
          if (ctx.signal.aborted) {
            const reason: unknown = ctx.signal.reason;
            throw reason instanceof ProviderCallError
              ? reason
              : new ProviderCallError('cancelled', 'Request cancelled.');
          }
          throw new ProviderCallError('upstream_failed', 'Model provider unreachable.');
        }

        if (response.status === 429) {
          await response.body?.cancel().catch(() => undefined);
          const retryAfterMs = parseRetryAfter(response.headers);
          throw new ProviderCallError('rate_limited', 'Model provider rate limit reached.', {
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          });
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new ProviderCallError(
            'upstream_failed',
            `Model provider returned ${response.status}.`,
          );
        }

        const text = await readCapped(response, maxBytes);
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          throw new ProviderCallError('invalid_output', 'Model provider returned non-JSON output.');
        }
        const body = payload as {
          choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
          usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
        };
        const choice = body.choices?.[0];
        if (choice?.finish_reason === 'length') {
          throw new ProviderCallError('invalid_output', 'Model output was truncated.');
        }
        const content = choice?.message?.content;
        if (typeof content !== 'string') {
          throw new ProviderCallError('invalid_output', 'Model reply had no content.');
        }
        const output = parseJsonContent(content);
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
        const inputTokens = num(body.usage?.prompt_tokens);
        const outputTokens = num(body.usage?.completion_tokens);
        return {
          output,
          usage: {
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          },
        };
      },
    };
  };

  return Object.fromEntries(AI_CAPABILITIES.map((c) => [c, make(c)])) as {
    [C in AiCapability]: CapabilityAdapter<C>;
  };
}
