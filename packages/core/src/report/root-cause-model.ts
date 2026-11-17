import { OhosPerfError } from '../errors';
import type { AgentModel, AgentTurn } from '../scenario/agent';
import type {
  RootCauseAnalysis,
  RootCauseDocument,
  RootCauseSuspect,
} from './root-cause';

/**
 * The model turn for the root-cause report (HapRay parity row 36).
 *
 * One `decide()` call, not a loop: the document is already the question, and
 * the answer is prose attached to it. Two things differ from HapRay's version,
 * and both are about making the answer checkable:
 *
 * 1. **The model cites evidence ids.** HapRay hands over its report JSON and
 *    asks for a root cause; nothing ties the answer to a measured item, so an
 *    invented finding reads like a real one. Here the prompt carries the ranked
 *    observations *with their ids*, and an id the run did not produce is moved
 *    to {@link RootCauseSuspect.ungrounded}.
 * 2. **The names are looked up.** A suspect that mentions `aboutToAppear`,
 *    `libfoo.so` or a thread name is checked against what the evidence actually
 *    carried. HapRay has no such check, and its `with_source` mode needs a
 *    source tree and a symbol index to get anywhere close.
 *
 * Neither check is semantic: they answer one question — "did the model name
 * something this run measured?" — and leave interpretation to the reader.
 */

/** The most evidence items a prompt carries, most urgent first. */
export const PROMPT_EVIDENCE_LIMIT = 40;

const BAD_RESPONSE = 'ROOT_CAUSE_BAD_RESPONSE';

function badResponse(message: string): OhosPerfError {
  return new OhosPerfError(message, { code: BAD_RESPONSE });
}

/** The answer shape, stated literally: a model that invents a key fails here. */
const ANSWER_SHAPE = [
  '{',
  '  "summary": "one sentence naming the dominant cause",',
  '  "suspects": [',
  '    {',
  '      "evidenceIds": ["the ids you reasoned from"],',
  '      "rootCause": "1-2 sentences",',
  '      "fix": "what to change",',
  '      "confidence": "high | medium | low",',
  '      "triggerChain": "optional: A -> B -> C"',
  '    }',
  '  ],',
  '  "caveats": ["what limits this conclusion"],',
  '  "needsMoreData": ["what would raise confidence"]',
  '}',
].join('\n');

/**
 * The prompt for one root-cause turn.
 *
 * A plain string, like `agentPrompt`: whatever client a caller brings turns it
 * into its own request shape. The observations are rendered rather than
 * `JSON.stringify`-ed so the ids are impossible to miss — a model that cannot
 * see them cannot cite them.
 */
export function rootCausePrompt(document: RootCauseDocument): string {
  const observations = document.observations.slice(0, PROMPT_EVIDENCE_LIMIT);
  const omitted = document.observations.length - observations.length;
  const lines = observations.map((item) => {
    const subject = item.subject.thread === undefined
      ? item.subject.process
      : `${item.subject.process}/${item.subject.thread}`;
    const signals = Object.keys(item.signals)
      .sort()
      .map((key) => `${key}=${String(item.signals[key])}`)
      .join(', ');
    return `- [${item.evidenceId}] ${item.severity} ${item.kind} ${subject}: ${item.explain}`
      + (signals === '' ? '' : ` {${signals}}`);
  });

  return [
    'You are explaining the measured performance evidence for one app run.',
    'Every observation below was produced by an analyzer in this package; the',
    'bracketed id is what you must cite.',
    '',
    `app ${document.scene.app} on ${document.scene.device}`,
    `verdict ${document.summary.verdict}`,
    '',
    'Observations:',
    ...(lines.length === 0 ? ['(none)'] : lines),
    ...(omitted <= 0 ? [] : [`(${omitted} lower-severity observations omitted)`]),
    '',
    'Answer with one JSON object and nothing else:',
    ANSWER_SHAPE,
    '',
    'Rules:',
    '- Cite only ids that appear above; an id you invent is rejected and recorded.',
    '- Name a file, symbol, library or thread only if it appears above.',
    '- If the evidence does not support a cause, say so in caveats rather than guessing.',
  ].join('\n');
}

/** The `AgentTurn` a one-shot client needs: a task, no steps, no history. */
function turnFor(document: RootCauseDocument): AgentTurn {
  return {
    task: 'explain the root cause of the measured performance evidence',
    app: document.scene.app,
    step: 0,
    maxSteps: 1,
    screen: rootCausePrompt(document),
    history: [],
  };
}

/** Strip a markdown fence a model added around its JSON. */
function unfence(text: string): string {
  const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  return match === null ? text : match[1]!;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badResponse(`the model's ${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim());
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const CONFIDENCE = new Set(['high', 'medium', 'low']);

function confidenceOf(value: unknown): 'high' | 'medium' | 'low' {
  return typeof value === 'string' && CONFIDENCE.has(value) ? value as 'high' | 'medium' | 'low' : 'low';
}

/**
 * Read a model's answer.
 *
 * The answer is data from outside this package, so every field is checked: a
 * non-object, a non-JSON string, or a suspect that is not an object is a
 * refusal naming what was wrong. An id the run did not produce is not a
 * refusal — it is recorded in `ungrounded`, because the reader needs to see
 * what the model claimed as much as what it got right.
 */
export function parseRootCauseAnswer(
  content: string,
  document: RootCauseDocument,
  model: string,
): RootCauseAnalysis {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(content));
  } catch {
    throw badResponse(
      `the model's answer is not JSON: ${JSON.stringify(content.slice(0, 200))}`,
    );
  }
  const record = asRecord(parsed, 'answer');
  const known = new Set(document.observations.map((item) => item.evidenceId));

  const rawSuspects = record['suspects'];
  const suspects: RootCauseSuspect[] = [];
  if (rawSuspects !== undefined && !Array.isArray(rawSuspects)) {
    throw badResponse('the model\'s "suspects" must be an array');
  }
  for (const [index, entry] of (rawSuspects as unknown[] | undefined ?? []).entries()) {
    const suspect = asRecord(entry, `suspects[${index}]`);
    const cited = strings(suspect['evidenceIds']);
    const evidenceIds = cited.filter((id) => known.has(id));
    const ungrounded = cited.filter((id) => !known.has(id));
    suspects.push({
      rank: suspects.length + 1,
      evidenceIds,
      rootCause: text(suspect['rootCause']),
      fix: text(suspect['fix']),
      confidence: confidenceOf(suspect['confidence']),
      ungrounded,
      ...(text(suspect['triggerChain']) === '' ? {} : { triggerChain: text(suspect['triggerChain']) }),
    });
  }

  return {
    model,
    summary: text(record['summary']),
    suspects,
    caveats: strings(record['caveats']),
    needsMoreData: strings(record['needsMoreData']),
  };
}

/**
 * Every string the evidence actually carried: process, thread, and any string
 * signal value.
 *
 * A set rather than a list because the check is membership, and the vocabulary
 * of one run is small.
 */
export function groundingVocabulary(document: RootCauseDocument): Set<string> {
  const vocabulary = new Set<string>();
  for (const item of document.observations) {
    vocabulary.add(item.subject.process);
    if (item.subject.thread !== undefined) vocabulary.add(item.subject.thread);
    for (const value of Object.values(item.signals)) {
      if (typeof value === 'string') vocabulary.add(value);
      else if (Array.isArray(value)) for (const entry of value) vocabulary.add(entry);
    }
  }
  return vocabulary;
}

/**
 * Names a suspect mentions that the run never measured.
 *
 * Only *identifier-shaped* tokens are candidates: a token with a dot, an
 * underscore, a hyphen, an embedded capital, or a file extension. Ordinary
 * prose is not checked, because "the main thread was busy" is an interpretation
 * and not a claim about a measured entity — flagging its words would make the
 * check noise and train a reader to ignore it.
 *
 * A citation id is not a name: it is checked separately by
 * {@link parseRootCauseAnswer}, and a suspect whose only "unknown" is an id it
 * already had rejected would report the same problem twice.
 */
export function ungroundedNames(suspect: RootCauseSuspect, vocabulary: Set<string>): string[] {
  const text = [suspect.rootCause, suspect.fix, suspect.triggerChain ?? ''].join(' ');
  const candidates = text.match(/[A-Za-z_][A-Za-z0-9_.\-]{2,}/g) ?? [];
  const found = new Set<string>();
  for (const token of candidates) {
    const trimmed = token.replace(/[.\-]+$/, '');
    if (trimmed === '' || vocabulary.has(trimmed)) continue;
    if (!looksLikeIdentifier(trimmed)) continue;
    found.add(trimmed);
  }
  return [...found].sort();
}

/**
 * Whether a token is the kind of name a reader would check against a run.
 *
 * A file extension, an underscore, a hyphen, or an interior capital. A plain
 * lowercase word is prose.
 */
function looksLikeIdentifier(token: string): boolean {
  if (/\.(?:so|ets|ts|js|json|hap|hsp|db|abc)$/i.test(token)) return true;
  if (/[_\-]/.test(token)) return true;
  if (/[a-z][A-Z]/.test(token)) return true;
  return false;
}

/**
 * Ask the model once, and attach its answer to the document.
 *
 * The deterministic half is copied unchanged: the model adds a section, it does
 * not replace the ranking. A suspect naming something unmeasured keeps its
 * citation check and gains the names in `ungrounded`, so one field answers
 * "which ids were real" and the other "which names were real".
 */
export async function askRootCause(
  model: AgentModel,
  document: RootCauseDocument,
  options: { model: string },
): Promise<RootCauseDocument> {
  const decision = await model.decide(turnFor(document));
  const content = 'done' in decision ? decision.reason : '';
  const analysis = parseRootCauseAnswer(content, document, options.model);
  const vocabulary = groundingVocabulary(document);
  return {
    ...document,
    observations: document.observations.map((item) => ({ ...item, signals: { ...item.signals } })),
    summary: { ...document.summary, totals: { ...document.summary.totals } },
    scene: { ...document.scene, window: { ...document.scene.window } },
    generator: { ...document.generator },
    analysis: {
      ...analysis,
      suspects: analysis.suspects.map((suspect) => {
        const names = ungroundedNames(suspect, vocabulary);
        return names.length === 0 ? suspect : { ...suspect, ungrounded: [...suspect.ungrounded, ...names] };
      }),
    },
  };
}
