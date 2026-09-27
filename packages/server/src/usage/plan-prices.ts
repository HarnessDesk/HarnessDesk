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
 * A row also has to show its exact `planMatch` against the reader that would
 * produce it — never a guess at the vendor's own field spelling
 * (`matchPlanSuggestion` is exact once lower-cased, so a wrong guess would
 * silently never fire, or worse, fire for the wrong plan). Two runtimes are
 * left out entirely on that ground:
 * - GitHub Copilot: the only `copilot_plan` value this repo has ever
 *   observed is `'business'` (`copilot.ts`'s own `planName`, capitalized to
 *   `'Business'`) — nothing here shows what a Pro or Pro+ seat's field
 *   value actually is, so those two rows are left out rather than guessed.
 * - Gemini: `gemini.ts` reads `assist.currentTier?.name` straight from
 *   Google's `loadCodeAssist` response with no fixture or observed value at
 *   all, so there is nothing to pin "Google AI Pro" against.
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
    // cursor.ts's `planName` title-cases only the first character, so
    // Cursor's own `pro_plus` membership value reads back exactly as
    // `planName` produces it — proved directly against the exported
    // function in `cursor-plan-name.test.ts` — never as the vendor page's
    // own two-word "Pro Plus".
    runtime: 'cursor' as RuntimeId,
    planMatch: 'Pro_plus',
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
]

/** The one suggestion for this account's plan, when its runtime and plan string match one on file. */
export const suggestionFor = (runtime: RuntimeId, plan: string | null): PlanSuggestion | null =>
  matchPlanSuggestion(PLAN_SUGGESTIONS, runtime, plan)
