import { matchPlanSuggestion, type PlanSuggestion, type RuntimeId } from '@harnessdesk/protocol'

/**
 * Suggested public prices, never bundled rates.
 *
 * Every row here was read from the vendor's own official pricing page on the
 * date it carries, with a link back to it (`docs/usage-dashboard.md`'s
 * pricing paragraph: "a wrong price is worse than no price"). A person still
 * has to click to apply one — `usage/plan/set` is the only thing that ever
 * writes a fee — so this is a list of citations, not a price list.
 *
 * A plan whose vendor page did not give an unambiguous single number for it
 * is left out rather than guessed: Claude's Max 5x and Max 20x share one
 * "From $100" card on `claude.com/pricing` with no per-tier figure, so
 * neither is listed here, and ChatGPT Pro is the same "From $100" shape on
 * `chatgpt.com/pricing` — one card, no per-seat number — so it is left out
 * too.
 *
 * Kept as a TypeScript module rather than the plain data file the design
 * first reached for (`plan-prices.json`) because `tsc -b`'s output only ever
 * holds what it compiled — a JSON asset beside a compiled `.ts` file is not
 * copied into `dist` the way `script/copy-fixtures.mjs` copies test fixtures,
 * and this file ships with the server, not the tests. A literal array here
 * compiles the same as any other module and needs no separate copy step.
 */
export const PLAN_SUGGESTIONS: readonly PlanSuggestion[] = [
  {
    runtime: 'claude-code' as RuntimeId,
    planMatch: 'Pro',
    amount: 20,
    currency: 'USD',
    period: 'month',
    sourceUrl: 'https://claude.com/pricing',
    checkedAt: '2026-09-26',
  },
  {
    runtime: 'codex' as RuntimeId,
    planMatch: 'plus',
    amount: 20,
    currency: 'USD',
    period: 'month',
    sourceUrl: 'https://chatgpt.com/pricing',
    checkedAt: '2026-09-26',
  },
  {
    runtime: 'cursor' as RuntimeId,
    planMatch: 'Pro',
    amount: 20,
    currency: 'USD',
    period: 'month',
    sourceUrl: 'https://cursor.com/docs/account/pricing',
    checkedAt: '2026-09-26',
  },
  {
    runtime: 'cursor' as RuntimeId,
    planMatch: 'Pro+',
    amount: 60,
    currency: 'USD',
    period: 'month',
    sourceUrl: 'https://cursor.com/docs/account/pricing',
    checkedAt: '2026-09-26',
  },
  {
    runtime: 'cursor' as RuntimeId,
    planMatch: 'Ultra',
    amount: 200,
    currency: 'USD',
    period: 'month',
    sourceUrl: 'https://cursor.com/docs/account/pricing',
    checkedAt: '2026-09-26',
  },
  {
    runtime: 'github-copilot-cli' as RuntimeId,
    planMatch: 'Pro',
    amount: 10,
    currency: 'USD',
    period: 'month',
    sourceUrl: 'https://github.com/features/copilot/plans',
    checkedAt: '2026-09-26',
  },
  {
    runtime: 'github-copilot-cli' as RuntimeId,
    planMatch: 'Pro+',
    amount: 39,
    currency: 'USD',
    period: 'month',
    sourceUrl: 'https://github.com/features/copilot/plans',
    checkedAt: '2026-09-26',
  },
  {
    runtime: 'gemini' as RuntimeId,
    planMatch: 'Google AI Pro',
    amount: 19.99,
    currency: 'USD',
    period: 'month',
    sourceUrl: 'https://one.google.com/about/plans',
    checkedAt: '2026-09-26',
  },
]

/** The one suggestion for this account's plan, when its runtime and plan string match one on file. */
export const suggestionFor = (runtime: RuntimeId, plan: string | null): PlanSuggestion | null =>
  matchPlanSuggestion(PLAN_SUGGESTIONS, runtime, plan)
