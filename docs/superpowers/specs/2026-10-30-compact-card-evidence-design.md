# Compact card evidence: proposal for issue 828

Status: ready for owner review; no implementation started.
Baseline: 795f00431b9645f2b3e44c7241260c891d570038.

## Problem and recommended anatomy

A fresh synthetic native check at 700 CSS pixels reproduced the density problem: seven facts take six rows and 162 pixels of a 267-pixel card. Single-line individual pills have not solved the group height.

Replace the collection of card chips with one short status chip inside the existing inline ghost Button. Keep this evidence trigger to one row at narrow and regular widths. Do not place fact names, revisions, distances, counts, commands or history in that row. Clicking it, or pressing Enter/Space, opens the existing What the desk observed dialog. Preserve its focus return and dismissal behavior. Untouched cards with no displayed observations keep omitting the trigger.

The summary describes recorded observations; it does not certify the work or replace the card's workflow state.

## Truthful status mapping

Use the latest card facts and existing freshness classification, in this priority order:

1. **Failed:** a current check failed or timed out, or current CI has aggregate verdict failed. A running retry suppresses the earlier result for that same named check; a different current failure still wins.
2. **Changes requested:** a current review requests changes.
3. **Finding open:** a current finding is open.
4. **Running:** a card check is running, or current CI is pending.
5. **Out of date:** an otherwise relevant check, CI result, changes request or open finding is behind, moved or uncommitted. This does not turn a historical failure into a current failure.
6. **Unknown:** a relevant observation's freshness is unknown; its reason stays in details.
7. **Incomplete:** a current check did not start, or the aggregate CI verdict is cancelled or skipped.
8. **Checks recorded:** current passing checks or CI exist, without a higher-priority condition. Keep this neutral; it does not mean every required check passed.
9. **Observed:** other facts exist.

Use the existing ciVerdict aggregate: a mix of passed and intentionally skipped jobs is passed; all-skipped or empty CI is skipped. Keep individual job states in details. A later pass does not erase earlier attempts from history. Arbitrary review strings are retained as observations, not reinterpreted as an approval.

Neither CardEvidence nor BoardEvidence.checks defines a card's complete verification requirements. Do not introduce a Verified or All checks passed claim. Project-wide refused/unreadable check configuration remains in the existing board controls and reasons; do not label every card as needing setup merely because an optional project check is refused.

## Boundaries and implementation scope

Use existing Button, Chip and status tones. Derive the summary in packages/ui/src/lib/evidence.ts and replace the trigger rendering in components/EvidenceChips.tsx. Preserve ObservedDialog and its latest facts, commands, output, timestamps and full stale explanations. No protocol or host change, new generic control, screen appearance CSS, font change or backend-name check is needed.

Preserve the existing board loading/error banners, retries and withheld completed-card behavior. Do not invent a per-card unavailable badge when the card cannot render or treat a fallback empty check list as a successful read.

The current dialog shows latest observations, not all attempts. Preserve the separate Flow inspector history and its keyboard access to prior failure output, including incomplete and refused-history states.

## Alternatives

- One neutral Observed button: less state logic, but current failures and review requests require opening each card.
- One prioritized named fact: keeps the selected check's name visible, but long names compete for width and other facts become less clear.

The recommended short status keeps the board scannable without losing the detailed observations.

## Validation and landing

Test mixed current/stale failures, review requests, open findings, retries, passed-plus-skipped CI, cancelled/all-skipped CI and unknown freshness. Render the dense seven-fact case in both themes at 700 pixels and regular widths: one evidence row with no truncated status and all details retained. Verify keyboard opening, focus return and Flow history access. Preserve loading/error/refusal semantics.

Verify the launched fake-agent app and privacy-audit every original frame. The existing history screenshot was refused for full-revision title attributes; do not weaken that audit or claim a saved history frame. Then run applicable push checks, complete local verification, full-tier CI, fresh Sonnet High and Terra 6.1 High reviews, and land-safe on the exact reviewed head. One implementation PR for issue 828.
