# Compact Card Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task after the parent checkpoint. Steps use checkbox syntax for tracking. The parent owns integration and reviews; do not dispatch agents or publish.

**Goal:** Replace the board card's multi-row evidence chips with one truthful, compact status that opens the existing observations.

**Architecture:** Derive a single status from the card's latest `CardEvidence` in the existing pure UI evidence library, preserving `cardChips`' display/omission contract. The existing inline Button and Chip open the unchanged observed dialog; Flow inspector attempt history remains separate.

**Tech Stack:** TypeScript, React, existing HarnessDesk design system, Vitest, Playwright, Electron fake-agent rig.

## Global Constraints

- The approved design is `docs/superpowers/specs/2026-10-30-compact-card-evidence-design.md`. It takes precedence over any example here.
- Use the existing checkout and branch; do not rebase, switch branches, push, merge or alter the preserved terminal-regression branch. Parent controls integration.
- No protocol, host, new visual primitive, screen appearance CSS, font, or backend-name change. Do not infer complete verification requirements or claim Verified or all checks passed.
- Do not turn optional project-check refusal/unreadability into per-card setup status. Keep board loading, retry, error and withheld completed-card behavior.
- No-observations omission includes the existing zero-diff-only working-card rule. Keep all observations and stale reasons in the dialog, and prior attempts in Flow history.
- All heavy build/test/capture workflows use a single whole-driver slot: `node "$HEAVY_DRIVER" -- COMMAND ARGS`; the parent supplies the approved driver path. Limit is two globally. Do not reserve separate server and browser slots or cancel a queued slot to finish a turn.
- Use a throwaway staged desk and fake agents only, never the owner's desk, real account, credentials or vendor endpoints. Audit every original frame using the unchanged full text and attribute privacy audit before retaining it. Never place home paths or raw private proof JSON in public documents. The previous history frame failed the audit on SHA title attributes; do not weaken the audit or claim that frame was saved.
- The parent runs full verification, fresh Sonnet High and Terra 6.1 High reviews, full-tier CI and land-safe. No publication by the implementer.

## File map

- `packages/ui/src/lib/evidence.ts`: pure status derivation, existing `cardChips`, `ciVerdict`, freshness and details helpers.
- `packages/ui/src/lib/evidence.test.ts`: priority, retry, freshness and omission cases.
- `packages/ui/src/components/EvidenceChips.tsx`: one Button/Chip trigger; `ObservedDialog` and `Fact` remain unchanged.
- `packages/ui/src/components/EvidenceChips.test.tsx` and `packages/ui/src/components/TeamBoardPane.test.tsx`: rendered behavior, details, omission, loading and refusal regressions; revise outdated per-chip expectations.
- `packages/ui/src/preview/evidence-fixture.ts`: synthetic dense seven-fact card for real layout coverage, with only placeholder identities.
- `e2e/ui-system/evidence-layout.spec.ts`: replace old per-fact layout assertions with measured one-row density, themes, widths and keyboard details; extend existing spec instead of adding a shard.
- `packages/ui/src/components/RunInspector.test.tsx`: existing attempt, incomplete and failed-read coverage; add focused regression only if existing tests do not prove keyboard access and old output.
- `docs/interface.md` and `docs/multi-agent.md`: update shipped interface descriptions as part of implementation, keeping the distinction between latest facts and history.

---

### Task 1: Define truthful summary and exercise the priority

**Files:** Modify `packages/ui/src/lib/evidence.ts`; test `packages/ui/src/lib/evidence.test.ts`.

**Interfaces:** Consumes `CardEvidence | undefined`, `finished: boolean`, `cardChips`, `isCurrent`, `isStale`, `ciVerdict`. Produces `evidenceSummary(card: CardEvidence | undefined, finished?: boolean): EvidenceSummary | null`, with labels and tones below. `null` means the existing display rules omit the trigger.

- [x] **Write failing behavioral cases.** Add tests using the existing `cardEvidence`, `checkView`, `ciView`, `factView` fixtures. At minimum, implement this table as independent assertions (with `review` and `finding` fixtures created with `factView` using a 40-character synthetic revision):

```ts
const review = (verdict: string, freshness: Freshness = { state: 'fresh' }) =>
  factView({ kind: 'review', verdict, by: 'seat-judge', at: 'a'.repeat(40) }, { freshness })
const finding = (state: 'open' | 'repaired' | 'withdrawn', freshness: Freshness = { state: 'fresh' }) =>
  factView({ kind: 'finding', id: 'finding-1', state, at: 'a'.repeat(40) }, { freshness })
expect(evidenceSummary(cardEvidence(1, [checkView({ exit: 1 }), review('request-changes')]))?.label).toBe('Failed')
expect(evidenceSummary(cardEvidence(1, [checkView({ exit: 1 })], [{ name: 'verify', since: 1 }]))?.label).toBe('Running')
expect(evidenceSummary(cardEvidence(1, [checkView({ exit: 1 }), checkView({ name: 'lint', exit: 1 })], [{ name: 'verify', since: 1 }]))?.label).toBe('Failed')
expect(evidenceSummary(cardEvidence(1, [review('request-changes'), finding('open')]))?.label).toBe('Changes requested')
expect(evidenceSummary(cardEvidence(1, [finding('open')]))?.label).toBe('Finding open')
expect(evidenceSummary(cardEvidence(1, [checkView({ exit: 1, freshness: { state: 'behind', commits: 2 } }), ciView(['pending'])]))?.label).toBe('Running')
expect(evidenceSummary(cardEvidence(1, [checkView({ exit: 1, freshness: { state: 'moved' } })]))?.label).toBe('Out of date')
expect(evidenceSummary(cardEvidence(1, [review('request-changes', { state: 'uncommitted' })]))?.label).toBe('Out of date')
expect(evidenceSummary(cardEvidence(1, [finding('open', { state: 'unknown', why: 'checkout gone' })]))?.label).toBe('Unknown')
expect(evidenceSummary(cardEvidence(1, [checkView({ exit: null })]))?.label).toBe('Incomplete')
expect(evidenceSummary(cardEvidence(1, [ciView(['passed', 'skipped'])]))?.label).toBe('Checks recorded')
expect(evidenceSummary(cardEvidence(1, [ciView(['cancelled'])]))?.label).toBe('Incomplete')
expect(evidenceSummary(cardEvidence(1, [ciView(['skipped'])]))?.label).toBe('Incomplete')
expect(evidenceSummary(cardEvidence(1, [ciView([])]))?.label).toBe('Incomplete')
expect(evidenceSummary(cardEvidence(1, [review('picked')]))?.label).toBe('Observed')
expect(evidenceSummary(cardEvidence(1, []))).toBeNull()
```

  Also cover timeout, fresh CI failure, final freshness, stale finding, unknown check/CI, all stale variants, stale versus unknown priority, current review/finding over running, incomplete versus passing, and zero diff alone both unfinished (`null`) and finished (`Observed`). Test that a stale or unknown PR/diff alone remains `Observed`, since it is not a relevant status-bearing observation. Check returned tones and permutations so result does not depend on fact order.

- [x] **Run red:** `pnpm --filter @harnessdesk/ui exec vitest run src/lib/evidence.test.ts`; expect failure because `evidenceSummary` does not exist. Run through the whole-driver wrapper above.
- [x] **Implement** the following complete derivation in `evidence.ts`, using the existing helpers; do not change `ciVerdict`:

```ts
export type EvidenceSummaryLabel = 'Failed' | 'Changes requested' | 'Finding open' | 'Running' | 'Out of date' | 'Unknown' | 'Incomplete' | 'Checks recorded' | 'Observed'
export interface EvidenceSummary {
  readonly label: EvidenceSummaryLabel
  readonly tone: 'danger' | 'warning' | 'info' | 'neutral'
}
export const evidenceSummary = (card: CardEvidence | undefined, finished = false): EvidenceSummary | null => {
  if (!card || cardChips(card, finished).length === 0) return null
  const running = new Set(card.running.map(one => one.name))
  const facts = card.facts.filter(view => !(view.record.fact.kind === 'check' && running.has(view.record.fact.name)))
  const relevant = facts.filter(({ record: { fact } }) => fact.kind === 'check' || fact.kind === 'ci' || (fact.kind === 'review' && fact.verdict === 'request-changes') || (fact.kind === 'finding' && fact.state === 'open'))
  const current = relevant.filter(view => isCurrent(view.freshness)).map(view => view.record.fact)
  if (current.some(fact => fact.kind === 'check' ? fact.timedOut || (fact.exit !== null && fact.exit !== 0) : fact.kind === 'ci' && ciVerdict(fact.checks) === 'failed')) return { label: 'Failed', tone: 'danger' }
  if (current.some(fact => fact.kind === 'review' && fact.verdict === 'request-changes')) return { label: 'Changes requested', tone: 'warning' }
  if (current.some(fact => fact.kind === 'finding' && fact.state === 'open')) return { label: 'Finding open', tone: 'warning' }
  if (running.size > 0 || current.some(fact => fact.kind === 'ci' && ciVerdict(fact.checks) === 'running')) return { label: 'Running', tone: 'info' }
  if (relevant.some(view => isStale(view.freshness))) return { label: 'Out of date', tone: 'neutral' }
  if (relevant.some(view => view.freshness.state === 'unknown')) return { label: 'Unknown', tone: 'neutral' }
  if (current.some(fact => fact.kind === 'check' ? fact.exit === null && !fact.timedOut : fact.kind === 'ci' && ['cancelled', 'skipped'].includes(ciVerdict(fact.checks)))) return { label: 'Incomplete', tone: 'neutral' }
  if (current.some(fact => fact.kind === 'check' ? checkPassed(fact) : fact.kind === 'ci' && ciVerdict(fact.checks) === 'passed')) return { label: 'Checks recorded', tone: 'neutral' }
  return { label: 'Observed', tone: 'neutral' }
}
```

- [x] **Run green:** repeat the red command; all cases pass. Run `pnpm --filter @harnessdesk/ui run typecheck` through the same wrapper and fix type errors without changing the protocol.

### Task 2: Render the one-row trigger and preserve details

**Files:** Modify `packages/ui/src/components/EvidenceChips.tsx`, `packages/ui/src/components/EvidenceChips.test.tsx`, `packages/ui/src/components/TeamBoardPane.test.tsx`.

**Interfaces:** Consumes `evidenceSummary(card, finished)`. Preserves `EvidenceChips` props and `ObservedDialog` signature.

- [x] **Write red component tests:** replace per-chip trigger assertions with one summary chip, a descriptive button name and a click that opens the full dialog. Retain direct dialog tests for commands, output, individual CI jobs, timestamp and freshness explanation. Preserve zero-diff and no-facts omission assertions. Example:

```ts
await mount(<EvidenceChips id={1} title="Retry on a 502" card={cardEvidence(1, [checkView({ exit: 1, tail: 'failed output' }), ciView(['passed', 'skipped'])])} />)
const button = container.querySelector<HTMLButtonElement>('button[aria-label="What the desk observed on #1: Failed"]')!
expect(button.querySelectorAll('[data-slot="chip"]')).toHaveLength(1)
expect(button.textContent).toBe('Failed')
act(() => button.click())
expect(document.querySelector('[role="dialog"]')?.textContent).toContain('failed output')
expect(document.querySelector('[role="dialog"]')?.textContent).toContain('build: passed · lint: skipped')
```

  Update existing board tests that assert individual chips or old accessible names to assert summary plus unchanged detail dialog; keep cold-read failure, retry and unplaced-card tests intact. Include optional refused project configuration with a passing card and assert `Checks recorded`, not setup status.
- [x] **Run red:** `pnpm --filter @harnessdesk/ui exec vitest run src/components/EvidenceChips.test.tsx src/components/TeamBoardPane.test.tsx`; expect old trigger behavior to fail the new assertions. Use the whole-driver wrapper.
- [x] **Implement trigger:** import `evidenceSummary`, remove trigger-only `cardChips` and `spokenChip` imports, retain `FactChipView` for details. Replace only the calculation and Button contents:

```tsx
const summary = evidenceSummary(card, finished)
if (summary === null) return null
// Inside the existing fragment, retain the existing Dialog conditional and onClick:
<Button variant="ghost" size="inline" data-board-row=""
  className="flex min-w-0 max-w-full basis-full shrink items-center justify-start"
  aria-label={`What the desk observed on #${id}: ${summary.label}`}
  onClick={() => setOpen(true)}>
  <Chip tone={summary.tone}>{summary.label}</Chip>
</Button>
```

  Keep the existing state and conditional `ObservedDialog` exactly; do not change its content, focus behavior or the board's placement.
- [x] **Run green:** repeat the red command, then run `pnpm --filter @harnessdesk/ui run typecheck` via the wrapper. Confirm existing `RunInspector.test.tsx` covers prior failure output, incomplete history and refused read; add a concrete regression there if a gap exists, and run that file through the wrapper.

### Task 3: Prove density, keyboard behavior and native surface

**Files:** Modify `packages/ui/src/preview/evidence-fixture.ts`, `e2e/ui-system/evidence-layout.spec.ts`; update `docs/interface.md` and `docs/multi-agent.md`.

**Interfaces:** Existing `EVIDENCE_BOARD` preview; existing accessible button `What the desk observed on #1: Failed`, dialog `What the desk observed on #1`, and existing Run inspector history. The dense fixture must have seven distinguishable facts, including current failure, passing/skipped CI, PR, diff, a request-changes review, open finding and another named check. Use synthetic revisions and placeholder identities.

- [x] **Write the browser regression before Task 2 implementation:** extend the existing spec to select the dense card in both light and dark themes at 700 and 1440 CSS pixels, and retain the 220px column/202px card fit-floor exercise. Assert exactly one chip and `Failed`; measure its button and chip rectangles, require chip inside the card, `scrollWidth <= clientWidth`, one line and button height no greater than 32 CSS px (the existing inline control height). Check all seven fact sections, check output, command, individual CI states and stale reason inside the dialog. Use keyboard focus plus Enter and Space in separate openings, Escape/Done close, and assert focus returns to the trigger. Example geometry assertion:

```ts
const button = card.getByRole('button', { name: 'What the desk observed on #1: Failed' })
await expect(button.locator('[data-slot="chip"]')).toHaveCount(1)
const geometry = await button.evaluate(el => {
  const chip = el.querySelector<HTMLElement>('[data-slot="chip"]')!
  const words = chip.querySelector<HTMLElement>('[data-slot="chip-words"]')!
  return { buttonHeight: el.getBoundingClientRect().height, chipHeight: chip.getBoundingClientRect().height, clipped: words.scrollWidth > words.clientWidth, lines: getComputedStyle(chip).whiteSpace }
})
expect(geometry.clipped).toBe(false)
expect(geometry.lines).toBe('nowrap')
expect(geometry.buttonHeight).toBeLessThanOrEqual(32)
await button.focus()
await page.keyboard.press('Enter')
await expect(page.getByRole('dialog', { name: 'What the desk observed on #1' })).toBeVisible()
await page.keyboard.press('Escape')
await expect(button).toBeFocused()
```

  Use the existing preview theme controls and actual fixture selectors; do not emulate layout in jsdom. Exercise Flow inspector by keyboard, opening a prior failed attempt after a later pass and asserting its output, then separately verify incomplete and refused-history states. Reuse the existing Flow preview/inspector fixtures or component tests if the preview does not expose a history scene; do not claim a screenshot for that path.
- [x] **Run red before Task 2 implementation:** `pnpm exec playwright test -c playwright.ui-system.config.ts evidence-layout.spec.ts` through the whole-driver wrapper after building its preview with `pnpm build:node` and `pnpm build:e2e` in the same driver invocation; expect the old multi-chip trigger to fail. After Task 2, run the same assertion green. Confirm the preview server configuration in `playwright.ui-system.config.ts` rather than launching a second separately reserved server.
- [x] **Add the seven-fact fixture** using `checkView`, `ciView`, `prView`, `diffView`, and `factView`; include one stale relevant fact with a readable reason, without overwriting the failure. Retain other preview scenarios used by board tests. Re-run the same browser command green.
- [x] **Native validation:** build and launch the real Electron app through the existing staged fake-agent rig described in `script/shots/README.md`, with an isolated throwaway profile; seed seven facts and a failed-then-passed Flow check. Run the entire driver, app and browser capture inside one heavy slot. At 700 CSS px and regular width, in both themes, measure card and evidence row, verify one complete status, open details with keyboard, and inspect old failure output via Flow history. Record measured dimensions and actual outcomes; compare with the current [baseline measurement](https://github.com/HarnessDesk/HarnessDesk/issues/828#issuecomment-6529990736) (seven facts, six rows, 162 of 267 px). Audit each original frame before retaining it; if history fails the unchanged audit, report the refusal and retain no frame for it. Do not represent browser preview as native proof.
- [x] **Update docs:** replace the old descriptions of multiple card chips in `docs/interface.md` and the “Evidence on a card” section of `docs/multi-agent.md` with the one-row status, its non-certifying meaning, the full latest-facts dialog and separate Flow attempt history. Leave placement and refresh semantics intact.
- [x] **Focused gates:** within whole-driver slots run the relevant Vitest files, the existing Playwright spec, `pnpm --filter @harnessdesk/ui run typecheck`, `node script/design-audit.mjs --strict` and `pnpm check:push`. Report the precise commands and outcomes to the parent; the parent owns full verification and publication. Review `git diff --check`, the complete diff and privacy of added lines before any local implementation commit.

## Self-review checklist

- [x] Every approved priority and mixed-state interaction is asserted; aggregate CI, same-name retry suppression, distinct failure, zero diff and unknown freshness are explicit.
- [x] Layout tests measure actual rendered density at both widths/themes and validate full details, keyboard dismissal and focus return; separate Flow history covers prior failure, incomplete and refused reads.
- [x] No setup claim, all-passed assertion, protocol/host change, new primitive or alteration of board loading/error/withholding exists.
- [x] `EvidenceSummary` types, labels and tones match all consumer examples. No public path, credential, real identity or unaudited frame enters the diff.


## Completion and handoff

The helper, component and browser regressions ran red before their respective implementation changes and passed afterward. Focused UI tests, typecheck, strict design audit and the development-base push selection passed. The dense browser cases covered both themes and widths; staged native measurements and keyboard details passed in both themes at narrow and regular widths. The separate Flow history exposed the earlier failure by keyboard; its frame was refused by the unchanged privacy audit and was not retained.

The parent inspected the canonical native originals. Full verification, full-tier CI, formal review, publication and landing remain with the parent and are not complete.
