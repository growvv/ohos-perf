import { describe, it, expect } from 'vitest';
import { agentPrompt, type AgentTurn } from '../src/scenario/agent';
import { httpAgentModel, httpChatModel, readAgentConfig } from '../src/scenario/agent-client';
import { ROOT_CAUSE_TURN } from '../src/report/root-cause-model';

/*
 * The model client (HapRay parity row 5).
 *
 * HapRay wraps the external `phone_agent` package and its GLM client. This is
 * the same wire protocol — an OpenAI-compatible `/chat/completions` call —
 * written against an injected `fetch`, so a test never opens a socket and a
 * caller can substitute any endpoint that speaks it.
 *
 * The one thing it does that HapRay's client does not: it refuses to send an
 * answer it cannot parse. A client that passed prose through would make the
 * loop's parse error point at the model instead of at the step.
 */

const turn: AgentTurn = {
  task: 'open settings',
  app: 'com.demo',
  step: 0,
  maxSteps: 5,
  screen: 'Button "Settings" clickable',
  history: [],
};

/** A fetch double that records the request and answers with one body. */
function fakeFetch(body: unknown, init: { status?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = async (url: string, requestInit: RequestInit): Promise<Response> => {
    calls.push({ url, init: requestInit });
    const status = init.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response;
  };
  return { fetch, calls };
}

function completion(content: string) {
  return { choices: [{ message: { role: 'assistant', content } }] };
}

describe('httpChatModel', () => {
  it('posts the prompt and returns the content', async () => {
    const { fetch, calls } = fakeFetch(completion('{"action":"tap","element":0}'));
    const model = httpChatModel({
      baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm', fetch,
    });
    expect(await model.complete('which element?')).toBe('{"action":"tap","element":0}');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    const messages = body['messages'] as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).toBe('which element?');
    expect(body['response_format']).toEqual({ type: 'json_object' });
  });

  it('refuses an HTTP error, a non-JSON body and an empty answer', async () => {
    const failing = httpChatModel({
      baseUrl: 'https://e.test', apiKey: 'k', model: 'm',
      fetch: fakeFetch('{"error":"quota"}', { status: 429 }).fetch,
    });
    await expect(failing.complete('x')).rejects.toThrow(/429/);

    const notJson = httpChatModel({
      baseUrl: 'https://e.test', apiKey: 'k', model: 'm',
      fetch: fakeFetch('<html>').fetch,
    });
    await expect(notJson.complete('x')).rejects.toThrow(/not JSON/);

    const empty = httpChatModel({
      baseUrl: 'https://e.test', apiKey: 'k', model: 'm',
      fetch: fakeFetch(completion('  ')).fetch,
    });
    await expect(empty.complete('x')).rejects.toThrow(/empty/);
  });
});

describe('httpAgentModel', () => {
  it('posts the prompt to the chat completions endpoint', async () => {
    const { fetch, calls } = fakeFetch(completion('{"done": true, "reason": "x"}'));
    const model = httpAgentModel({
      baseUrl: 'https://example.test/v1', apiKey: 'sk-test', model: 'some-model', fetch,
    });
    await model.decide(turn);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://example.test/v1/chat/completions');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body['model']).toBe('some-model');
    const messages = body['messages'] as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toBe(agentPrompt(turn));
  });

  it('sends the key as a bearer token and never in the body', async () => {
    const { fetch, calls } = fakeFetch(completion('{"done": true}'));
    const model = httpAgentModel({
      baseUrl: 'https://example.test/v1', apiKey: 'sk-secret', model: 'm', fetch,
    });
    await model.decide(turn);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-secret');
    expect(String(calls[0]!.init.body)).not.toContain('sk-secret');
  });

  it('parses the answer the model returned', async () => {
    const { fetch } = fakeFetch(completion('{"action": {"action": "click", "x": 5, "y": 6}, "reason": "tap"}'));
    const model = httpAgentModel({ baseUrl: 'https://e.test', apiKey: 'k', model: 'm', fetch });
    expect(await model.decide(turn))
      .toEqual({ action: { action: 'click', x: 5, y: 6 }, reason: 'tap' });
  });

  it('refuses a non-2xx answer with the status and an excerpt', async () => {
    const { fetch } = fakeFetch('{"error": "invalid api key"}', { status: 401 });
    const model = httpAgentModel({ baseUrl: 'https://e.test', apiKey: 'k', model: 'm', fetch });
    await expect(model.decide(turn)).rejects.toThrow(/401.*invalid api key/s);
  });

  it('refuses a 200 whose body is not a completion', async () => {
    const { fetch } = fakeFetch({ error: { message: 'quota' } });
    const model = httpAgentModel({ baseUrl: 'https://e.test', apiKey: 'k', model: 'm', fetch });
    await expect(model.decide(turn)).rejects.toThrow(/choices/i);
  });

  it('refuses an empty answer rather than treating it as done', async () => {
    const { fetch } = fakeFetch(completion('   '));
    const model = httpAgentModel({ baseUrl: 'https://e.test', apiKey: 'k', model: 'm', fetch });
    await expect(model.decide(turn)).rejects.toThrow(/empty/i);
  });

  it('trims a trailing slash from the base URL instead of doubling it', async () => {
    const { fetch, calls } = fakeFetch(completion('{"done": true}'));
    const model = httpAgentModel({ baseUrl: 'https://e.test/v1/', apiKey: 'k', model: 'm', fetch });
    await model.decide(turn);
    expect(calls[0]!.url).toBe('https://e.test/v1/chat/completions');
  });

  it('refuses to build a client with no base URL or no model', () => {
    expect(() => httpAgentModel({ baseUrl: '', apiKey: 'k', model: 'm', fetch }))
      .toThrow(/base URL/i);
    expect(() => httpAgentModel({ baseUrl: 'https://e.test', apiKey: 'k', model: '', fetch }))
      .toThrow(/model/i);
  });
});

describe('readAgentConfig', () => {
  it('reads the package\'s own variables', () => {
    const config = readAgentConfig({
      OHOS_PERF_AGENT_BASE_URL: 'https://e.test/v1',
      OHOS_PERF_AGENT_API_KEY: 'k',
      OHOS_PERF_AGENT_MODEL: 'm',
    });
    expect(config).toEqual({ baseUrl: 'https://e.test/v1', apiKey: 'k', model: 'm' });
  });

  it('falls back to the GLM variables HapRay reads', () => {
    // A host already configured for HapRay should work without a second set of
    // variables; that is the whole point of parity on this row.
    const config = readAgentConfig({
      GLM_BASE_URL: 'https://glm.test/v1',
      GLM_API_KEY: 'gk',
      GLM_MODEL: 'autoglm-phone-9b',
    });
    expect(config).toEqual({ baseUrl: 'https://glm.test/v1', apiKey: 'gk', model: 'autoglm-phone-9b' });
  });

  it('prefers its own variables over the fallback', () => {
    const config = readAgentConfig({
      OHOS_PERF_AGENT_BASE_URL: 'https://mine.test/v1',
      GLM_BASE_URL: 'https://glm.test/v1',
      GLM_API_KEY: 'gk',
      GLM_MODEL: 'glm',
    });
    expect(config?.baseUrl).toBe('https://mine.test/v1');
  });

  it('returns undefined when nothing is configured, rather than guessing an endpoint', () => {
    // Guessing a default endpoint would send a task description to a host the
    // user never named. Silence is the right answer here.
    expect(readAgentConfig({})).toBeUndefined();
  });

  it('defaults the model name the way HapRay does', () => {
    const config = readAgentConfig({
      OHOS_PERF_AGENT_BASE_URL: 'https://e.test/v1',
      OHOS_PERF_AGENT_API_KEY: 'k',
    });
    expect(config?.model).toBe('autoglm-phone-9b');
  });

  it('returns undefined when the base URL is set but the key is not', () => {
    expect(readAgentConfig({ OHOS_PERF_AGENT_BASE_URL: 'https://e.test/v1' })).toBeUndefined();
  });
});

describe('httpAgentModel with a non-GUI turn shape', () => {
  /*
   * The root-cause turn is not a screen to drive. Measured defect: the client
   * rendered every turn with `agentPrompt` and parsed every answer with
   * `parseDecision`, so a root-cause request told the model to answer with a
   * gesture and an `expect` block, and then rejected the JSON answer it had
   * actually asked for. The shape is one value so the two halves cannot drift.
   */
  const evidenceTurn: AgentTurn = {
    task: 'explain the root cause of the measured performance evidence',
    app: 'com.demo',
    step: 0,
    maxSteps: 1,
    screen: 'Observations:\n- [ev-1] critical jank com.demo/main: frame 42 took 118.5 ms',
    history: [],
  };

  it('sends the turn\'s screen as the prompt and accepts a JSON answer', async () => {
    const answer = '{"summary":"the main thread stalls","suspects":[],"caveats":[],"needsMoreData":[]}';
    const { fetch, calls } = fakeFetch(completion(answer));
    const model = httpAgentModel({
      baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm', fetch, shape: ROOT_CAUSE_TURN,
    });
    const decision = await model.decide(evidenceTurn);

    const body = JSON.parse(String(calls[0]!.init.body)) as {
      messages: Array<{ content: string }>;
    };
    const prompt = body.messages[0]!.content;
    expect(prompt).toContain('[ev-1]');
    // The GUI instructions must not be in a prompt that is not a screen.
    expect(prompt).not.toContain('{"action": {"action": "click"');
    expect('done' in decision && decision.reason).toBe(answer);
  });

  it('refuses an answer that is not JSON, naming it', async () => {
    const { fetch } = fakeFetch(completion('I think it is the main thread.'));
    const model = httpAgentModel({
      baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm', fetch, shape: ROOT_CAUSE_TURN,
    });
    await expect(model.decide(evidenceTurn)).rejects.toThrow(/not JSON/);
  });

  it('still uses the GUI prompt and parser when no shape is given', async () => {
    const { fetch, calls } = fakeFetch(completion('{"done": true, "reason": "x"}'));
    const model = httpAgentModel({
      baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm', fetch,
    });
    const decision = await model.decide(turn);
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0]!.content).toBe(agentPrompt(turn));
    expect(decision).toEqual({ done: true, reason: 'x' });
  });
});
