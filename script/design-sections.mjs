/**
 * Every finding the design audit reports, said once.
 *
 * The audit prints these, the generated doc tabulates them, and `--strict`
 * uses the fix line to tell whoever tripped the gate where to go instead.
 * They lived in two places until one of them quietly fell behind: the doc kept
 * its own copy of the costs, so three new checks landed in the table with an
 * empty column and nothing failed. A design system whose own tooling keeps a
 * second copy of its vocabulary is not in a position to lecture anyone.
 *
 * A note on the fix lines, which are read by agents and acted on literally.
 * Where a rule has a legitimate exception, the fix must SAY SO and name the
 * way through — `--baseline`, deliberately, with a reason in the commit. A
 * guardrail that admits no exception does not prevent the exception; it
 * produces a confident wrong answer, which is worse than no guidance. The
 * clearest case: a chart is not an icon, and "add it to Icons.tsx" would put a
 * sparkline in the icon module.
 *
 *   [key, title, what it costs, the way out]
 */
export const SECTIONS = [
  [
    'wrongVariant',
    'Controls in a slot the design system has a rule for',
    'The same slot ends up drawn four different ways, one screen at a time.',
    "Every variant's scenario is in packages/ui/src/design/usage.ts — read the `when` column and pick the one that matches. A header's action needs an edge or a fill because nothing encloses it: `outline`, or `default` for the one action a page exists to perform. An unqualified Btn paints grey and a ghost paints nothing, and both disappear on a page's own ground.",
  ],
  [
    'missingClass',
    'Styles referenced that do not exist',
    'Renders with no styling at all, and nothing fails.',
    'The class was renamed or deleted in the stylesheet. Fix the reference, or add the class.',
  ],
  [
    'forkedToken',
    'System tokens defined outside the system',
    'Forks the source of truth: the generated doc and the token snapshot both miss it.',
    'A new token goes in packages/ui/src/design/tokens.css, and you var() it here. A component\'s own private property is fine — just not under the --hd- prefix. And if you are building an alternate look or a theme, you are not adding a token at all: that is a FOUNDATION, a tokens.<name>.css of overrides applied last (see design/explorer/foundation.ts), and it is exempt from this check by name.',
  ],
  [
    'handRolledOverlay',
    'Overlays built beside the system',
    'Five decisions — buttons, Escape, focus, click-outside, surface — made again, usually one by omission.',
    'Use Dialog from packages/ui/src/design. If it genuinely is not a dialog — pane-scoped, top-aligned, a whole window — it still takes --hd-surface-* and --hd-scrim, and you raise the ceiling on purpose: --baseline, and say why in the commit.',
  ],
  [
    'looseTarget',
    'Glyph controls under the target floor',
    'A 20px close button is a miss on a trackpad, and WCAG 2.2 asks for 24 unless it has clearance.',
    'Give it `--hd-icon-target` (24px) or `--hd-icon-target-sm` with clearance. If it genuinely has clearance — a 24px circle on it meeting no other target\'s circle, measured, not assumed — raise the baseline with --baseline and say so in the commit.',
  ],
  [
    'looseIcon',
    'Icons drawn in place',
    'Makes "change the icon set" a search across the app instead of one edit.',
    'If it is an icon: add it to components/Icons.tsx (or BrandIcons.tsx for a brand mark) and import it. If it is a drawing — a chart, a sparkline, an illustration — it is NOT an icon and does not belong there: leave it where it is and raise the baseline on purpose with --baseline, saying why in the commit.',
  ],
  [
    'danglingToken',
    'Tokens that resolve to nothing',
    'A silent no-op: the declaration does nothing.',
    'Check the spelling against design/tokens.css.',
  ],
  [
    'crossImport',
    'Screens used as component libraries',
    'Rebuilding one screen changes another.',
    'If two screens need the same thing, it belongs in design/primitives.',
  ],
  [
    'rawRadius',
    'Radii the system has no name for',
    'Will not follow a shape change.',
    'Use a --hd-radius-* token, or add the step to design/tokens.css if the system truly lacks it.',
  ],
  [
    'offGrid',
    'Spacing off the scale',
    'Will not follow a density change.',
    'Use a --hd-space-* step.',
  ],
  [
    'rawColour',
    'Colours written out rather than named',
    'Will not follow a palette or theme change.',
    'Use a semantic token from design/tokens.css.',
  ],
  [
    'arbitraryUtility',
    'Arbitrary values in the design system',
    'Will not follow a foundation, a type scale or a density change — and the CSS rules cannot see them.',
    'Use a --hd-text-*, --hd-radius-* or --hd-space-* token, or state the measure in the file and raise the baseline deliberately.',
  ],
]
