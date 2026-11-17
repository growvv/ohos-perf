/**
 * The HTTP model client for the GUI agent (HapRay parity row 5).
 *
 * HapRay's `gui-agent` imports the external `phone_agent` package, whose client
 * reads `GLM_BASE_URL` / `GLM_API_KEY` / `GLM_MODEL` and posts to an
 * OpenAI-compatible `/chat/completions` endpoint. This is that protocol,
 * written here so the package does not depend on `phone_agent`, and with
 * `fetch` injected so a test never opens a socket and a caller can point it at
 * any endpoint that speaks the same shape.
 *
 * Two things differ from HapRay's client:
 *
 * - **An unparseable answer is refused here.** HapRay passes the model's prose
 *   through to the loop, so a formatting mistake surfaces as an agent failure.
 *   Here {@link parseDecision} runs inside the client, so the error names the
 *   answer that caused it.
 * - **Nothing is defaulted silently.** No base URL is guessed and no key is
 *   invented: a host with no configuration gets a refusal naming the variables
 *   to set, not a request to a host the user never named.
 */

import { OhosPerfError } from '../errors';
import { agentPrompt, parseDecision, type AgentDecision, type AgentModel, type AgentTurn } from './agent';

/** The slice of `fetch` this client needs. Injected, never imported. */
export type AgentFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpAgentModelOptions {
  /** The endpoint root, without `/chat/completions`. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetch: AgentFetch;
  /** Request timeout in ms. Defaults to 60 s. */
  readonly timeoutMs?: number;
}

export interface AgentConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

/** The variables this package reads first. */
const OWN_BASE_URL = 'OHOS_PERF_AGENT_BASE_URL';
const OWN_API_KEY = 'OHOS_PERF_AGENT_API_KEY';
const OWN_MODEL = 'OHOS_PERF_AGENT_MODEL';

/** The variables HapRay's client reads; a host set up for it works unchanged. */
const FALLBACK_BASE_URL = 'GLM_BASE_URL';
const FALLBACK_API_KEY = 'GLM_API_KEY';
const FALLBACK_MODEL = 'GLM_MODEL';

/** HapRay's default model name, kept so a host that sets only a key works. */
const DEFAULT_MODEL = 'autoglm-phone-9b';

const DEFAULT_TIMEOUT_MS = 60_000;

/** How much of a failed body to show; enough to diagnose, short enough to read. */
const EXCERPT_CHARS = 200;

function pick(env: Record<string, string | undefined>, own: string, fallback: string): string | undefined {
  const value = env[own];
  if (value !== undefined && value.trim() !== '') return value.trim();
  const other = env[fallback];
  return other !== undefined && other.trim() !== '' ? other.trim() : undefined;
}

/**
 * Read the client configuration from the environment.
 *
 * `undefined` when no endpoint is configured: a caller then refuses with a
 * message naming the variables, which is better than a request to a guessed
 * host. A base URL without a key is also `undefined` — half a configuration is
 * a mistake, not a default.
 */
export function readAgentConfig(env: Record<string, string | undefined>): AgentConfig | undefined {
  const baseUrl = pick(env, OWN_BASE_URL, FALLBACK_BASE_URL);
  const apiKey = pick(env, OWN_API_KEY, FALLBACK_API_KEY);
  if (baseUrl === undefined || apiKey === undefined) return undefined;
  return {
    baseUrl,
    apiKey,
    model: pick(env, OWN_MODEL, FALLBACK_MODEL) ?? DEFAULT_MODEL,
  };
}

function badClient(message: string): OhosPerfError {
  return new OhosPerfError(message, { code: 'AGENT_BAD_CONFIG' });
}

/** The one shape a completion response must have, checked rather than assumed. */
function contentOf(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    throw new OhosPerfError('the model endpoint returned a body that is not an object', {
      code: 'AGENT_BAD_RESPONSE',
    });
  }
  const choices = (body as Record<string, unknown>)['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new OhosPerfError(
      'the model endpoint returned no choices; expected an OpenAI-compatible' +
        ' /chat/completions response',
      { code: 'AGENT_BAD_RESPONSE' },
    );
  }
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.['message'] as Record<string, unknown> | undefined;
  const content = message?.['content'];
  if (typeof content !== 'string') {
    throw new OhosPerfError('the model endpoint returned a choice with no message content', {
      code: 'AGENT_BAD_RESPONSE',
    });
  }
  return content;
}

/**
 * A model client over an OpenAI-compatible endpoint.
 *
 * The options are validated once, at construction, so a misconfiguration fails
 * before a device is touched rather than on the first decision.
 */
export function httpAgentModel(options: HttpAgentModelOptions): AgentModel {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
  const model = options.model.trim();
  if (baseUrl === '') throw badClient('the agent base URL must not be empty');
  if (model === '') throw badClient('the agent model name must not be empty');

  const url = `${baseUrl}/chat/completions`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async decide(turn: AgentTurn): Promise<AgentDecision> {
      const body = {
        model,
        messages: [{ role: 'user', content: agentPrompt(turn) }],
        // The answer is JSON the loop parses, so the endpoint is asked for JSON
        // rather than for prose that happens to contain some.
        response_format: { type: 'json_object' },
      };

      let response: Response;
      try {
        response = await options.fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new OhosPerfError(
          `the agent endpoint could not be reached: ${(err as Error).message}`,
          { code: 'AGENT_UNREACHABLE', cause: err },
        );
      }

      const text = await response.text();
      if (!response.ok) {
        throw new OhosPerfError(
          `the agent endpoint answered ${response.status}: ${text.slice(0, EXCERPT_CHARS)}`,
          { code: 'AGENT_HTTP_ERROR' },
        );
      }

      const content = contentOf(safeJson(text));
      if (content.trim() === '') {
        throw new OhosPerfError('the model returned an empty answer', {
          code: 'AGENT_BAD_RESPONSE',
        });
      }
      // Parsed here, not in the loop: the error then names the answer rather
      // than the step, which is where the cause actually is.
      return parseDecision(content);
    },
  };
}

/** A body that is not JSON at all is a bad response, not a crash. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new OhosPerfError(
      `the agent endpoint answered with something that is not JSON: ${text.slice(0, EXCERPT_CHARS)}`,
      { code: 'AGENT_BAD_RESPONSE' },
    );
  }
}
