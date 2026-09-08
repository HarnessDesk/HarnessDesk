/**
 * Who and what appears in a screenshot.
 *
 * One file, because the same facts have to agree in four places — the agent
 * roster, the seeded conversation stores, the git history the repository pane
 * draws, and the account rows on the dashboard. When they drifted apart in the
 * site rig the sidebar said one thing and the board header another, which is
 * the kind of mistake that is invisible until it is published.
 *
 * Nothing here is real. The people are invented, the repositories are
 * generated, and every agent is the same fake ACP fixture wearing a different
 * brand. That is the point: a screenshot of the real app must not carry the
 * machine it was taken on.
 */

/** The addresses are on `harnessdesk.app` on purpose — an invented company
 *  domain in an account row reads as a real customer's. This one is ours. */
const person = (name) => ({ name, email: `${name.toLowerCase()}@harnessdesk.app` })

export const SHANE = person('Shane')
export const OLIVIA = person('Olivia')

/** Whose desk the reader is looking at. */
export const PRIMARY = SHANE

/**
 * The cast.
 *
 * Twelve agents rather than the three a working desk usually holds, because
 * the screenshot has one sentence to make and it is *this desk drives whatever
 * you installed*. Three rows read as a demo of three integrations; twelve rows
 * read as a property of the product.
 *
 * `brand` must be a member of `BRANDS` in `packages/ui/src/lib/brands.ts` or
 * the row falls back to reading the name, and a fallback mark in a hero image
 * is a bug nobody will report. Every one of these was checked against that
 * list.
 */
export const CAST = [
  { id: 'codex', name: 'Codex', brand: 'codex', tagline: "OpenAI's coding agent.", models: 'gpt-5.6-sol:GPT-5.6-Sol,gpt-5.6:GPT-5.6' },
  { id: 'claude-code', name: 'Claude', brand: 'claudecode', tagline: "Anthropic's coding agent.", models: 'opus:Opus,sonnet:Sonnet,haiku:Haiku' },
  { id: 'cursor', name: 'Cursor', brand: 'cursor', tagline: "Cursor's CLI agent.", models: 'composer-2:Composer 2,gemini-3.8-flash:Gemini 3.8 Flash' },
  { id: 'gemini-cli', name: 'Gemini', brand: 'geminicli', tagline: "Google's CLI agent.", models: 'gemini-3.8-pro:Gemini 3.8 Pro,gemini-3.8-flash:Gemini 3.8 Flash' },
  { id: 'copilot', name: 'Copilot', brand: 'githubcopilot', tagline: "GitHub's coding agent.", models: 'gpt-5.6:GPT-5.6,claude-opus:Claude Opus' },
  { id: 'antigravity', name: 'Antigravity', brand: 'antigravity', tagline: 'Antigravity, over ACP.', models: 'gemini-3.8-pro:Gemini 3.8 Pro' },
  { id: 'amp', name: 'Amp', brand: 'amp', tagline: "Sourcegraph's agent.", models: 'amp-default:Default' },
  { id: 'opencode', name: 'OpenCode', brand: 'opencode', tagline: 'OpenCode, over ACP.', models: 'qwen3-coder:Qwen3 Coder' },
  { id: 'goose', name: 'Goose', brand: 'goose', tagline: "Block's agent.", models: 'gpt-5.6:GPT-5.6' },
  { id: 'cline', name: 'Cline', brand: 'cline', tagline: 'Cline, over ACP.', models: 'claude-sonnet:Claude Sonnet' },
  { id: 'windsurf', name: 'Windsurf', brand: 'windsurf', tagline: 'Windsurf, over ACP.', models: 'swe-2:SWE-2' },
  { id: 'openclaw', name: 'OpenClaw', brand: 'openclaw', tagline: 'OpenClaw, over ACP.', models: 'kimi-k2:Kimi K2' },
]

/**
 * The repositories on the desk.
 *
 * Three, so the sidebar's project grouping has something to group — a single
 * folder draws one heading and proves nothing about it. `storefront` is the
 * one every scene opens in.
 */
export const REPOS = [
  { dir: 'storefront', name: 'storefront', blurb: 'The shop.' },
  { dir: 'atlas-api', name: 'atlas-api', blurb: 'The public API.' },
  { dir: 'pricing-service', name: 'pricing-service', blurb: 'Pricing and promotions.' },
]

/**
 * Seeded conversations, by agent id.
 *
 * Written as real work rather than as lorem: a reader who stops to read a
 * sidebar row should find a sentence an engineer would have typed. Ages are
 * minutes ago, spread so the list is not obviously generated — every row
 * saying "2 minutes ago" is the tell.
 */
export const CONVERSATIONS = {
  codex: [
    ['Make the webhook receiver idempotent', 14, 'storefront', 'Keyed on the delivery id with a 24h window, so a redelivery is a no-op rather than a second charge.'],
    ['Why does the cart total drift by a cent?', 96, 'storefront', 'The subtotal is summed as floats and rounded once at the end, so three items at 19.99 land a cent low. Totals are in minor units now, with the rounding test that found it.'],
    ['Port the rate limiter to the new clock', 340, 'atlas-api', 'The limiter took Date.now() directly, which made every test sleep. It takes a clock now, and the suite is 4s faster.'],
  ],
  'claude-code': [
    ['Migrate webhook signatures to v2', 38, 'atlas-api', 'v2 signatures are computed and sent alongside v1, and both are accepted for the grace window. The cutover is one constant when you are ready.'],
    ['Pin the flaky inventory test', 190, 'storefront', 'It shared a module-level cache with the reservation test, so order decided the result. The cache is per-test now and it passed 200 runs.'],
    ['Write the runbook for a failed payout', 620, 'pricing-service', 'Written, with the three states a payout can be stuck in and the one that needs finance rather than an engineer.'],
  ],
  cursor: [
    ['Split the payments spec into stages', 65, 'pricing-service', 'Split into capture, refund and dispute, each with its own state table. The dispute section had two contradictory paragraphs; I kept the one the code agrees with and flagged it.'],
    ['Rename Money to Amount across the tree', 410, 'pricing-service', 'Renamed in 34 files. The public export keeps a deprecated alias so downstream builds do not break on this release.'],
  ],
  'gemini-cli': [
    ['Audit the promo-code expiry rules', 120, 'pricing-service', 'Three rules disagree about whether expiry is inclusive of the last day. Two say yes, the checkout path says no, so a code expires a day early in practice.'],
    ['Summarise last week of API errors', 900, 'atlas-api', '61% are one client retrying a 400 without backing off. The rest is the known 502 during deploys.'],
  ],
  copilot: [['Add fixtures for the refund path', 260, 'storefront', 'Six fixtures: full, partial, over-refund, expired, already-refunded, and the one where the gateway times out mid-call.']],
  antigravity: [['Trace the slow cold start', 480, 'atlas-api', 'Two thirds of it is loading the currency table eagerly at import. Lazy, it is 1.9s to 640ms.']],
  amp: [['Find every unguarded parseFloat', 150, 'pricing-service', '11 of them, 4 on user input. Those four are the ones that turn a bad request into NaN and then into a zero charge.']],
  opencode: [['Draft the 2.5 migration notes', 720, 'storefront', 'Drafted. The breaking change worth leading with is Money to Amount; everything else is additive.']],
  goose: [['Bump the SDK and run the suite', 1_100, 'atlas-api', 'Bumped to 4.2. One snapshot moved because the SDK now sorts headers; the diff is only ordering.']],
  cline: [['Extract the address form', 300, 'storefront', 'Extracted with its validation intact. Checkout and account settings both use it now, which removes a copy that had drifted.']],
  windsurf: [['Cache the currency table', 540, 'pricing-service', 'Cached for an hour with a manual invalidate. It was being fetched on every price calculation.']],
  openclaw: [['Check the webhook retry budget', 1_400, 'atlas-api', 'Six attempts over 24h, but the backoff resets on any 2xx, so a flapping endpoint can be retried indefinitely. Worth a total cap.']],
}

/**
 * The git history the repository pane draws.
 *
 * Shaped for the graph rather than for the log: two branches off one trunk and
 * a merge back, so the lane renderer has lanes to draw and a merge point to
 * join. A straight line of commits makes a correct graph and a dull picture.
 */
export const HISTORY = [
  { branch: 'main', message: 'storefront at 2.4.1' },
  { branch: 'main', message: 'checkout: split the retry policy out of the client' },
  { branch: 'main', message: 'deps: vitest 3.2, and the two snapshots it moved' },
  { branch: 'feat/promo-stacking', from: 'main', message: 'pricing: allow two promos to stack' },
  { branch: 'feat/promo-stacking', message: 'pricing: cap a stacked promo at the item price' },
  { branch: 'main', message: 'checkout: name the 502 path in the error' },
  { branch: 'fix/cart-drift', from: 'main', message: 'cart: total in minor units, not floats' },
  { branch: 'fix/cart-drift', message: 'cart: the rounding test that found it' },
  { merge: 'fix/cart-drift', into: 'main', message: 'Merge: cart totals in minor units' },
  { branch: 'main', message: 'checkout: retry on 502 with a capped backoff' },
]
