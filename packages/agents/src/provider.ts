import type { AgentConfig, AgentRole } from '@aftermath/contracts';

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ModelInput {
  role: AgentRole;
  instructions: string;
  context: unknown;
  history: Array<{ name: string; arguments: unknown; result: unknown }>;
  tools: AgentTool[];
  maxOutputTokens: number;
}
export interface ModelReply {
  raw: unknown;
  calls: Array<{ name: string; arguments: unknown }>;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
  // Only transport/availability failures may trigger a separately audited backup request.
  retryable?: boolean;
}
export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  buildRequest(input: ModelInput): unknown;
  invoke(request: unknown, signal: AbortSignal): Promise<ModelReply>;
}
export const LEGACY_PROMPT_VERSION = 'aftermath-agents-v1';
export const DIAGNOSTIC_PROMPT_VERSION = 'aftermath-agents-v2';
export const SUPPORT_NOTICE_PROMPT_VERSION = 'aftermath-agents-v3';
export const PROMPT_VERSION = 'aftermath-agents-v4';
export const SUPPORTED_PROMPT_VERSIONS = [
  LEGACY_PROMPT_VERSION,
  DIAGNOSTIC_PROMPT_VERSION,
  SUPPORT_NOTICE_PROMPT_VERSION,
  PROMPT_VERSION,
];

// Provider output is untrusted, including any reflected credentials in an error or tool argument.
function redact(value: unknown, secret: string): unknown {
  if (typeof value === 'string') return secret ? value.replaceAll(secret, '[redacted]') : value;
  if (Array.isArray(value)) return value.map((v) => redact(v, secret));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [String(redact(k, secret)), redact(v, secret)]),
    );
  return value;
}

async function boundedResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Provider returned an empty response');
  const parts: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > 1_000_000) {
      await reader.cancel();
      throw new Error('Provider response exceeded the byte limit');
    }
    parts.push(next.value);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

// No SDK retries: SQL owns the task budget, including unsuccessful provider calls.
export class OpenAIProvider implements ModelProvider {
  readonly name = 'openai';
  readonly #apiKey: string;
  constructor(
    readonly model: string,
    apiKey: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.#apiKey = apiKey;
  }
  buildRequest(input: ModelInput) {
    return {
      model: this.model,
      store: false,
      instructions: input.instructions,
      input: [
        {
          role: 'user',
          content: JSON.stringify({ context: input.context, toolHistory: input.history }),
        },
      ],
      tools: input.tools.map((tool) => ({ type: 'function', ...tool, strict: true })),
      tool_choice: 'required',
      parallel_tool_calls: false,
      max_output_tokens: input.maxOutputTokens,
    };
  }
  async invoke(request: unknown, signal: AbortSignal): Promise<ModelReply> {
    const response = await this.transport('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    // Keep error bodies out of user-facing logs; never include credentials or headers in audit.
    if (!response.ok) {
      await response.body?.cancel();
      return {
        raw: { httpStatus: response.status },
        calls: [],
        inputTokens: null,
        outputTokens: null,
        error: `OpenAI request failed (HTTP ${response.status}). Check the server configuration or provider quota.`,
      };
    }
    const raw = redact(await boundedResponse(response), this.#apiKey);
    const data = raw as {
      status?: string;
      output?: Array<{ type?: string; name?: string; arguments?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const inputTokens = Number.isInteger(data?.usage?.input_tokens)
      ? data.usage!.input_tokens!
      : null;
    const outputTokens = Number.isInteger(data?.usage?.output_tokens)
      ? data.usage!.output_tokens!
      : null;
    const functions = Array.isArray(data?.output)
      ? data.output.filter((item) => item.type === 'function_call')
      : [];
    let error =
      data?.status !== 'completed' ? 'Provider response was incomplete or refused.' : null;
    const calls: ModelReply['calls'] = [];
    if (functions.length !== 1) error = 'Provider must return exactly one allowed tool call.';
    if (!error) {
      try {
        const fn = functions[0];
        if (typeof fn.name !== 'string' || typeof fn.arguments !== 'string') throw new Error();
        calls.push({ name: fn.name, arguments: JSON.parse(fn.arguments) });
      } catch {
        error = 'Provider returned invalid tool arguments.';
      }
    }
    return { raw, calls, inputTokens, outputTokens, error };
  }
}

// Use Gemini's native OpenAPI parameter shape, including nullable fields.
// Text/array bounds and additional-property checks remain enforced by Zod locally.
function geminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(schema.anyOf)) {
    const variants = schema.anyOf as Array<Record<string, unknown>>;
    const nonNull = variants.filter((variant) => variant.type !== 'null');
    if (variants.length !== 2 || nonNull.length !== 1)
      throw new Error('Gemini tool schemas support only nullable unions.');
    return { ...geminiSchema(nonNull[0]), nullable: true };
  }
  if (
    typeof schema.type !== 'string' ||
    !['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(schema.type)
  )
    throw new Error('Unsupported Gemini tool schema type');
  const result: Record<string, unknown> = { type: schema.type.toUpperCase() };
  if (schema.description) result.description = schema.description;
  if (schema.enum) result.enum = schema.enum;
  if (schema.required) result.required = schema.required;
  if (schema.properties)
    result.properties = Object.fromEntries(
      Object.entries(schema.properties as Record<string, Record<string, unknown>>).map(
        ([name, child]) => [name, geminiSchema(child)],
      ),
    );
  if (schema.items) result.items = geminiSchema(schema.items as Record<string, unknown>);
  return result;
}

function geminiTransportFailure(error: unknown): ModelReply {
  if (
    !(error instanceof TypeError) &&
    !(error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
  )
    throw error;
  return {
    raw: { transportError: 'connection_or_timeout' },
    calls: [],
    inputTokens: null,
    outputTokens: null,
    error: 'Gemini connection failed or timed out. No fixture output was substituted.',
    retryable: true,
  };
}

export class GeminiProvider implements ModelProvider {
  readonly name = 'gemini';
  readonly #apiKey: string;
  constructor(
    readonly model: string,
    apiKey: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.#apiKey = apiKey;
  }
  buildRequest(input: ModelInput) {
    // Each bounded decision is a new request containing its explicit tool journal.
    // There is no synthetic Gemini model-turn history or discarded thought signature.
    return {
      systemInstruction: { parts: [{ text: input.instructions }] },
      contents: [
        {
          role: 'user',
          parts: [{ text: JSON.stringify({ context: input.context, toolHistory: input.history }) }],
        },
      ],
      tools: [
        {
          functionDeclarations: input.tools.map(({ parameters, ...tool }) => ({
            ...tool,
            ...(Object.keys((parameters.properties ?? {}) as object).length
              ? { parameters: geminiSchema(parameters) }
              : {}),
          })),
        },
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: input.tools.map((t) => t.name),
        },
      },
      generationConfig: { maxOutputTokens: input.maxOutputTokens, candidateCount: 1 },
    };
  }
  async invoke(request: unknown, signal: AbortSignal): Promise<ModelReply> {
    let response: Response;
    try {
      response = await this.transport(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
        {
          method: 'POST',
          signal,
          headers: { 'x-goog-api-key': this.#apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
      );
    } catch (error) {
      return geminiTransportFailure(error);
    }
    if (!response.ok) {
      let schemaError: string | undefined;
      if (response.status === 400) {
        const body = (await boundedResponse(response).catch(() => null)) as {
          error?: { message?: unknown };
        } | null;
        if (typeof body?.error?.message === 'string')
          schemaError = body.error.message.replaceAll(this.#apiKey, '[redacted]').slice(0, 2000);
      } else await response.body?.cancel();
      return {
        raw: { httpStatus: response.status, ...(schemaError ? { schemaError } : {}) },
        calls: [],
        inputTokens: null,
        outputTokens: null,
        error:
          response.status === 429
            ? 'Gemini quota or rate limit reached (HTTP 429). Check your free-tier quota in Google AI Studio before retrying.'
            : `Gemini request failed (HTTP ${response.status}). Check the configured model and API key.`,
        retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
      };
    }
    let raw: unknown;
    try {
      raw = redact(await boundedResponse(response), this.#apiKey);
    } catch (error) {
      return geminiTransportFailure(error);
    }
    const data = raw as {
      candidates?: Array<{
        finishReason?: string;
        content?: { parts?: Array<{ functionCall?: { name?: string; args?: unknown } }> };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        totalTokenCount?: number;
      };
    };
    const usage = data?.usageMetadata;
    const inputTokens = Number.isInteger(usage?.promptTokenCount) ? usage!.promptTokenCount! : null;
    // Include thinking tokens in output usage; retain all raw provider counters for inspection.
    const outputTokens =
      Number.isInteger(usage?.totalTokenCount) && inputTokens !== null
        ? Math.max(0, usage!.totalTokenCount! - inputTokens)
        : Number.isInteger(usage?.candidatesTokenCount)
          ? usage!.candidatesTokenCount! + (usage!.thoughtsTokenCount ?? 0)
          : null;
    const candidate = data?.candidates?.[0];
    const functions =
      candidate?.content?.parts?.flatMap((p) => (p.functionCall ? [p.functionCall] : [])) ?? [];
    const valid =
      data?.candidates?.length === 1 &&
      candidate?.finishReason === 'STOP' &&
      functions.length === 1 &&
      typeof functions[0].name === 'string';
    return {
      raw,
      inputTokens,
      outputTokens,
      calls: valid ? [{ name: functions[0].name!, arguments: functions[0].args ?? {} }] : [],
      error: valid
        ? null
        : `Gemini returned no single complete tool call (${candidate?.finishReason ?? 'blocked or empty response'}). No fixture output was substituted.`,
    };
  }
}

export interface AgentRuntimeConfig {
  config: AgentConfig;
  provider: ModelProvider;
  fallbackProvider?: ModelProvider;
}
export function configuredAgents(
  env: NodeJS.ProcessEnv = process.env,
): AgentRuntimeConfig | undefined {
  if (!env.LLM_PROVIDER) return undefined;
  if (!['gemini', 'openai'].includes(env.LLM_PROVIDER))
    throw new Error('LLM_PROVIDER must be gemini or openai.');
  const key =
    env.LLM_PROVIDER === 'gemini' ? env.GEMINI_API_KEY?.trim() : env.OPENAI_API_KEY?.trim();
  const fallbackKey =
    env.LLM_PROVIDER === 'gemini' ? env.GEMINI_API_KEY_FALLBACK?.trim() : undefined;
  if (fallbackKey && !key)
    throw new Error('GEMINI_API_KEY_FALLBACK requires a primary GEMINI_API_KEY.');
  if (fallbackKey && fallbackKey === key)
    throw new Error('GEMINI_API_KEY_FALLBACK must differ from GEMINI_API_KEY.');
  const model =
    env.LLM_MODEL?.trim() || (env.LLM_PROVIDER === 'gemini' ? 'gemini-3.5-flash-lite' : undefined);
  if (!key) return undefined;
  if (!model)
    throw new Error('Live agents require LLM_MODEL (Gemini defaults to gemini-3.5-flash-lite).');
  function integer(name: string, fallback: number, min: number, max: number) {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`${name} must be an integer between ${min} and ${max}.`);
    return value;
  }
  const config: AgentConfig = {
    provider: env.LLM_PROVIDER,
    model,
    promptVersion: PROMPT_VERSION,
    maxCalls: integer('AGENT_MAX_CALLS', 12, 4, 20),
    maxOutputTokens: integer('AGENT_MAX_OUTPUT_TOKENS', 4096, 256, 8192),
    maxContextBytes: integer('AGENT_MAX_CONTEXT_BYTES', 64000, 8000, 128000),
    timeoutMs: integer('AGENT_CALL_TIMEOUT_MS', 45000, 1000, 120000),
  };
  return {
    config,
    provider:
      env.LLM_PROVIDER === 'gemini'
        ? new GeminiProvider(model, key)
        : new OpenAIProvider(model, key),
    ...(fallbackKey ? { fallbackProvider: new GeminiProvider(model, fallbackKey) } : {}),
  };
}
