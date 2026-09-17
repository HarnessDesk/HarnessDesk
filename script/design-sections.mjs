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
 * The saved baseline is permanently zero, so a legitimate exception must be
 * expressed in the audit's narrowly documented specialized/native boundary,
 * never accepted as debt by changing the baseline. The clearest case: a chart
 * is not an icon, and "add it to Icons.tsx" would put a sparkline in the icon
 * module.
 *
 *   [key, title, what it costs, the way out]
 */
export const SECTIONS = [
  [
    'rawType',
    'Type sizes written out rather than named',
    'The one axis of the scale with no gate: a token edit moves the controls and leaves these behind.',
    'Use a step: --hd-text-xs/-sm/--hd-text/--hd-text-lg/--hd-heading. If the value you want is not a step, the answer is almost never a new step — 11px and 12.5px were each one screen deciding alone. This category is a burn-down: its ceiling may only fall.',
  ],
  [
    'patternClass',
    'Patterns re-declared in a screen stylesheet',
    'Fourteen screens draw their own page header and ten their own empty state, at different paddings and different sizes, while PageHead and EmptyState sit unused in the design system. It is why two pages that do the same thing do not look alike.',
    'Compose the pattern instead of re-declaring it: Row/Rows, ListRow/ListRows, EmptyState, Section, PageHead/SectionHead, Note, Field — all exported from packages/ui/src/design. This category is a burn-down: its ceiling may only fall.',
  ],
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
    'A new token goes in packages/ui/src/design/foundation/tokens.css, and you var() it here. A component\'s own private property is fine — just not under the --hd- prefix. A preference preset may override the complete semantic contract under a data-hd-* selector; it must not become another component tree.',
  ],
  [
    'handRolledOverlay',
    'Overlays built beside the system',
    'Five decisions — buttons, Escape, focus, click-outside, surface — made again, usually one by omission.',
    'Use Dialog from packages/ui/src/design. If it genuinely is not a dialog — pane-scoped, top-aligned, a whole window — record that exact boundary in the audit and keep its first-party chrome on --hd-surface-* and --hd-scrim. The saved baseline stays zero.',
  ],
  [
    'looseTarget',
    'Glyph controls under the target floor',
    'A 20px close button is a miss on a trackpad, and WCAG 2.2 asks for 24 unless it has clearance.',
    'Give it `--hd-icon-target` (24px) or `--hd-icon-target-sm` with clearance. A genuinely cleared target must be encoded in the audit\'s explicit clearance rule; the saved baseline stays zero.',
  ],
  [
    'looseIcon',
    'Icons drawn in place',
    'Makes "change the icon set" a search across the app instead of one edit.',
    'If it is an icon: add it to components/Icons.tsx (or BrandIcons.tsx for a brand mark) and import it. If it is a drawing — a chart, a sparkline, an illustration — it is NOT an icon and does not belong there; keep it behind the audit\'s explicit data-geometry boundary.',
  ],
  [
    'danglingToken',
    'Tokens that resolve to nothing',
    'A silent no-op: the declaration does nothing.',
    'Check the spelling against design/foundation/tokens.css.',
  ],
  [
    'crossImport',
    'Screens used as component libraries',
    'Rebuilding one screen changes another.',
    'If two screens need the same thing, it belongs in design/ui or a named design/patterns contract.',
  ],
  [
    'rawRadius',
    'Radii the system has no name for',
    'Will not follow a shape change.',
    'Use a --hd-radius-* token, or add the step to design/foundation/tokens.css if the system truly lacks it.',
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
    'Use a semantic token from design/foundation/tokens.css.',
  ],
  [
    'arbitraryUtility',
    'Arbitrary values in the design system',
    'Will not follow a foundation, a type scale or a density change — and the CSS rules cannot see them.',
    'Use a --hd-text-*, --hd-radius-* or --hd-space-* token. Genuine data geometry belongs behind the audit\'s explicit specialized boundary; the saved baseline stays zero.',
  ],
]
