import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  configuredAgents,
  GeminiProvider,
  OpenAIProvider,
  type ModelInput,
  findingsArguments,
  deferDiagnosticArguments,
} from '@aftermath/agents';
const input: ModelInput = {
  role: 'investigator',
  instructions: 'test',
  context: {},
  history: [],
  maxOutputTokens: 512,
  tools: [
    {
      name: 'getEvidenceBundle',
      description: 'read',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  ],
};
it('uses native Responses function calls, bounded output, and server-only credentials', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      status: 'completed',
      output: [{ type: 'function_call', name: 'getEvidenceBundle', arguments: '{}' }],
      usage: { input_tokens: 70, output_tokens: 20 },
    }),
  );
  const provider = new OpenAIProvider('explicit-model', 'test-key', fetcher);
  const body = provider.buildRequest(input);
  expect(body).toMatchObject({
    store: false,
    parallel_tool_calls: false,
    tool_choice: 'required',
    max_output_tokens: 512,
  });
  expect(JSON.stringify(body)).not.toContain('test-key');
  const reply = await provider.invoke(body, AbortSignal.timeout(1000));
  expect(reply.calls).toEqual([{ name: 'getEvidenceBundle', arguments: {} }]);
  expect(reply.inputTokens).toBe(70);
  expect(fetcher.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
});
it('retains incomplete/refused results and does not treat them as successful proposals', async () => {
  const provider = new OpenAIProvider('explicit-model', 'test-key', async () =>
    Response.json({
      status: 'incomplete',
      output: [],
      usage: { input_tokens: 40, output_tokens: 512 },
    }),
  );
  const reply = await provider.invoke(provider.buildRequest(input), AbortSignal.timeout(1000));
  expect(reply.error).toBeTruthy();
  expect(reply.calls).toEqual([]);
  expect(reply.outputTokens).toBe(512);
});
it('does not expose authentication failure bodies or assume unreported usage is zero', async () => {
  const provider = new OpenAIProvider(
    'explicit-model',
    'test-key',
    async () => new Response('private account details', { status: 401 }),
  );
  const reply = await provider.invoke(provider.buildRequest(input), AbortSignal.timeout(1000));
  expect(reply.error).toContain('401');
  expect(JSON.stringify(reply)).not.toContain('private account');
  expect(reply.inputTokens).toBeNull();
});
it('requires explicit live configuration and validates hard budget bounds', () => {
  expect(configuredAgents({})).toBeUndefined();
  expect(configuredAgents({ LLM_PROVIDER: 'gemini' })).toBeUndefined();
  expect(() => configuredAgents({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'test' })).toThrow(
    'LLM_MODEL',
  );
  expect(() =>
    configuredAgents({
      LLM_PROVIDER: 'openai',
      LLM_MODEL: 'explicit',
      OPENAI_API_KEY: 'test',
      AGENT_MAX_CALLS: '200',
    }),
  ).toThrow('AGENT_MAX_CALLS');
});
it('uses Gemini native functions and counts output thinking tokens', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              { functionCall: { name: 'getEvidenceBundle', args: {} }, thoughtSignature: 'opaque' },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 70,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 5,
        totalTokenCount: 95,
      },
    }),
  );
  const provider = new GeminiProvider('gemini-3.5-flash-lite', 'test-key', fetcher);
  const body = provider.buildRequest(input);
  expect(body.toolConfig.functionCallingConfig).toEqual({
    mode: 'ANY',
    allowedFunctionNames: ['getEvidenceBundle'],
  });
  expect(body.tools[0].functionDeclarations[0]).not.toHaveProperty('parameters');
  expect(JSON.stringify(body)).not.toContain('test-key');
  const reply = await provider.invoke(body, AbortSignal.timeout(1000));
  expect(reply.calls).toEqual([{ name: 'getEvidenceBundle', arguments: {} }]);
  expect(reply.outputTokens).toBe(25);
  expect(fetcher.mock.calls[0][0]).toBe(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
  );
  expect(configuredAgents({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'test' })?.config.model).toBe(
    'gemini-3.5-flash-lite',
  );
});
it('surfaces Gemini free-tier quota exhaustion without fallback or hidden HTTP retries', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response('private quota details', { status: 429 }),
  );
  const provider = new GeminiProvider('gemini-3.5-flash-lite', 'test-key', fetcher);
  const reply = await provider.invoke(provider.buildRequest(input), AbortSignal.timeout(1000));
  expect(reply.error).toContain('free-tier quota');
  expect(reply.retryable).toBe(true);
  expect(reply.calls).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(reply)).not.toContain('private quota details');
});
it('configures an optional distinct backup without putting credentials into persisted configuration', () => {
  const runtime = configuredAgents({
    LLM_PROVIDER: 'gemini',
    GEMINI_API_KEY: ' primary-secret ',
    GEMINI_API_KEY_FALLBACK: ' backup-secret ',
  })!;
  expect(runtime.fallbackProvider?.name).toBe('gemini');
  expect(runtime.fallbackProvider?.model).toBe(runtime.provider.model);
  expect(JSON.stringify(runtime.config)).not.toContain('secret');
  expect(JSON.stringify(runtime.fallbackProvider!.buildRequest(input))).not.toContain('secret');
  expect(
    configuredAgents({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'one' })?.fallbackProvider,
  ).toBeUndefined();
  expect(() =>
    configuredAgents({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY_FALLBACK: 'backup-secret' }),
  ).toThrow('requires a primary');
  expect(() =>
    configuredAgents({
      LLM_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'same',
      GEMINI_API_KEY_FALLBACK: ' same ',
    }),
  ).toThrow('must differ');
});
it.each([408, 429, 500, 502, 503, 504])(
  'marks HTTP %s eligible for audited failover without making a hidden retry',
  async (status) => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response('private project quota', { status }),
    );
    const provider = new GeminiProvider('test-model', 'secret', fetcher);
    const reply = await provider.invoke(provider.buildRequest(input), AbortSignal.timeout(1000));
    expect(reply.retryable).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(reply)).not.toContain('private project');
  },
);
it.each([400, 401, 402, 403, 404])(
  'does not switch keys for HTTP %s configuration or authorization errors',
  async (status) => {
    const provider = new GeminiProvider(
      'test-model',
      'secret',
      async () => new Response('', { status }),
    );
    const reply = await provider.invoke(provider.buildRequest(input), AbortSignal.timeout(1000));
    expect(reply.retryable).toBe(false);
  },
);
it.each([
  new TypeError('private network detail'),
  new DOMException('private timeout', 'TimeoutError'),
])('marks network failures eligible for failover while hiding transport details', async (error) => {
  const provider = new GeminiProvider('test-model', 'secret', async () => {
    throw error;
  });
  const reply = await provider.invoke(provider.buildRequest(input), AbortSignal.timeout(1000));
  expect(reply.retryable).toBe(true);
  expect(reply.inputTokens).toBeNull();
  expect(JSON.stringify(reply)).not.toContain('private');
});
it('rejects Gemini truncated and blocked generations', async () => {
  const provider = new GeminiProvider('gemini-3.5-flash-lite', 'test-key', async () =>
    Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }),
  );
  const reply = await provider.invoke(provider.buildRequest(input), AbortSignal.timeout(1000));
  expect(reply.error).toContain('MAX_TOKENS');
  expect(reply.retryable).not.toBe(true);
  expect(reply.inputTokens).toBeNull();
});
it('distinguishes an interrupted response stream from malformed response JSON', async () => {
  const disconnected = new GeminiProvider(
    'test-model',
    'secret',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('private socket detail'));
          },
        }),
      ),
  );
  const reply = await disconnected.invoke(
    disconnected.buildRequest(input),
    AbortSignal.timeout(1000),
  );
  expect(reply.retryable).toBe(true);
  expect(JSON.stringify(reply)).not.toContain('private');
  const malformed = new GeminiProvider(
    'test-model',
    'secret',
    async () => new Response('not JSON'),
  );
  await expect(
    malformed.invoke(malformed.buildRequest(input), AbortSignal.timeout(1000)),
  ).rejects.toBeInstanceOf(SyntaxError);
});
it('lowers nested argument schemas to Gemini’s supported subset without weakening local validation', () => {
  const provider = new GeminiProvider('gemini-3.5-flash-lite', 'test-key');
  const parameters = z.toJSONSchema(findingsArguments);
  const body = provider.buildRequest({
    ...input,
    tools: [{ name: 'proposeClaims', description: 'claims', parameters }],
  });
  const schema = body.tools[0].functionDeclarations[0].parameters;
  expect(JSON.stringify(schema)).not.toContain('minLength');
  expect(JSON.stringify(schema)).not.toContain('maxLength');
  expect(JSON.stringify(schema)).not.toContain('anyOf');
  expect(JSON.stringify(schema)).toContain('nullable');
  expect(JSON.stringify(parameters)).toContain('maxLength');
  expect(
    findingsArguments.safeParse({
      findings: [
        { claimId: 'C1-v1', summary: '', supportGroupIds: [], citationIds: [], uncertainty: null },
      ],
    }).success,
  ).toBe(false);
});
it('records useful schema rejection details with the API key redacted', async () => {
  const provider = new GeminiProvider('gemini-3.5-flash-lite', 'test-key', async () =>
    Response.json({ error: { message: 'Invalid schema test-key' } }, { status: 400 }),
  );
  const reply = await provider.invoke(provider.buildRequest(input), AbortSignal.timeout(1000));
  expect(reply.raw).toEqual({ httpStatus: 400, schemaError: 'Invalid schema [redacted]' });
  expect(JSON.stringify(reply)).not.toContain('test-key');
});
it('sends the diagnostic deferral schema to Gemini and rejects a blank local reason', () => {
  const provider = new GeminiProvider('gemini-3.5-flash-lite', 'test-key');
  const body = provider.buildRequest({
    ...input,
    tools: [
      {
        name: 'deferDiagnostics',
        description: 'Record explicit deferral',
        parameters: z.toJSONSchema(deferDiagnosticArguments),
      },
    ],
  });
  const fn = body.tools[0].functionDeclarations[0];
  expect(fn.name).toBe('deferDiagnostics');
  expect(fn.parameters?.required).toEqual(['recipeIds', 'reason']);
  expect(
    deferDiagnosticArguments.safeParse({ recipeIds: ['production-pool'], reason: ' ' }).success,
  ).toBe(false);
});

it.each(['gemini', 'openai'])(
  'redacts reflected credentials in %s responses and provider serialization',
  async (name) => {
    const key = 'private-provider-key';
    const call = { name: 'getEvidenceBundle', args: { reflected: key } };
    const fetcher: typeof fetch = async () =>
      Response.json(
        name === 'gemini'
          ? {
              candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: call }] } }],
              reflected: key,
            }
          : {
              status: 'completed',
              output: [
                { type: 'function_call', name: call.name, arguments: JSON.stringify(call.args) },
              ],
              reflected: key,
            },
      );
    const provider =
      name === 'gemini'
        ? new GeminiProvider('test-model', key, fetcher)
        : new OpenAIProvider('test-model', key, fetcher);
    expect(JSON.stringify(provider)).not.toContain(key);
    const reply = await provider.invoke(provider.buildRequest(input), AbortSignal.timeout(1000));
    expect(JSON.stringify(reply)).not.toContain(key);
    expect(reply.calls[0].arguments).toEqual({ reflected: '[redacted]' });
  },
);
