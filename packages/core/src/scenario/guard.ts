/**
 * The irreversible-action guard, shared by the GUI agent and model-guided
 * exploration.
 *
 * It lives in its own module because `agent.ts` and `explore.ts` both need it,
 * and an import in either direction between those two would make a cycle:
 * `agent.ts` already imports `hashTree` from `explore.ts`.
 *
 * The rule is the same on both paths: a label that names an act is refused,
 * while a screen that merely mentions a topic is not. `Payment settings` is a
 * page a walk may open; `立即支付` is money leaving an account.
 */

import type { UiNode } from '../query/ui';

/** One irreversible action the guard recognises. */
export interface IrreversiblePattern {
  readonly pattern: RegExp;
  /** Why the action is refused; the text a refusal records. */
  readonly why: string;
  /** A label that matches `pattern`, so a test can prove the row is live. */
  readonly sample: string;
}

/**
 * The actions the guard refuses.
 *
 * Each pattern names an act, not a topic: `Payment settings` is a screen a
 * walk may legitimately open, while `立即支付` is money leaving an account.
 * Matching on a bare substring would block the settings page a task needs.
 */
export const IRREVERSIBLE_PATTERNS: readonly IrreversiblePattern[] = [
  {
    pattern: /\bpay\b|\bpay now\b|立即支付|确认支付|去支付|立即购买/i,
    why: 'payment is irreversible',
    sample: '立即支付',
  },
  {
    pattern: /\b(?:confirm order|place order|submit order|buy now)\b|提交订单|确认下单/i,
    why: 'placing an order is irreversible',
    sample: 'Confirm order',
  },
  {
    pattern: /\btransfer\b|\bsend money\b|\bremit\b|转账/i,
    why: 'a transfer moves money and cannot be undone',
    sample: 'Transfer',
  },
  {
    pattern: /\b(?:log ?in|sign ?in|register|sign ?up)\b|登录|注册/i,
    why: 'signing in changes the account state',
    sample: 'Log in',
  },
  {
    pattern: /\b(?:delete|unsubscribe|publish|post|share)\b|删除|注销|发布/i,
    why: 'the action destroys or publishes content',
    sample: 'Delete',
  },
];

/**
 * The labels a node is recognised by: its text and its id.
 *
 * Both are checked, because the two disagree in the common case — a button
 * labelled `立即支付` may have the id `btn_confirm`, and a button with no text
 * at all is often called `pay_button`. An id's separators are read as spaces,
 * so `pay_button` is the word `pay` followed by another word rather than one
 * long token that a `\b` boundary never ends.
 */
function labelsOf(node: UiNode): string[] {
  const labels = [node.text.trim(), node.id.replace(/[_-]+/g, ' ').trim()];
  return labels.filter((label) => label !== '');
}

/** Why tapping this node is irreversible, or `undefined` when it is safe. */
export function irreversibleReason(node: UiNode): string | undefined {
  for (const label of labelsOf(node)) {
    for (const entry of IRREVERSIBLE_PATTERNS) {
      if (entry.pattern.test(label)) return entry.why;
    }
  }
  return undefined;
}
