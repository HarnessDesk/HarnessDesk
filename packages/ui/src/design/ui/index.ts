/**
 * The shadcn component layer.
 *
 * Each file here is vendored shadcn/ui source — added by hand or by
 * `pnpm dlx shadcn@latest add <component>` (components.json points the CLI
 * at this folder) — styled by Tailwind utilities that resolve to the app's
 * own `--hd-` tokens through styles/shadcn.css. Three local rules every
 * file follows, so a fresh vendor knows what to re-apply:
 *
 *   Icons come from the façade.   `@/components/Icons`, never lucide-react
 *                                 directly — one place to change the set.
 *   Heights come from measure.    `h-(--hd-control-h)`, not `h-9`, so a
 *                                 density change reaches these too.
 *   One focus ring.               app.css draws the desk's `:focus-visible`
 *                                 outline; the ring utilities that would
 *                                 double it are dropped.
 *
 * Two kinds of file live here now, and the difference is worth naming.
 *
 *   PRIMITIVES are the vendored registry components — button, input, dialog,
 *   table. They answer "what is a button here", and a screen that needed a
 *   different one would be wrong.
 *
 *   COMPOSITIONS are ours: Stat, Section, ListRow, Board, EmptyState, Field,
 *   Delta, IconTile, AvatarStack, KeyValue, Progress, Stepper, Sparkline, and
 *   the chart kit. They answer the question one step up — "what does a figure
 *   on a dashboard look like", "what does a titled region of a page look
 *   like" — which is the question every screen used to answer for itself,
 *   slightly differently, in a `<div className="flex flex-col gap-1">` that
 *   nobody could grep for.
 *
 *   The charts come in two sizes and the split is deliberate. `spark` holds
 *   the marks small enough to sit inside a sentence — no axis, no legend, no
 *   tooltip. `chart` holds the ones that are the subject of their own panel:
 *   the matted frame, the segment meter, the burn-down, the stacked day
 *   columns, the legend and the tooltip that goes with them. A screen reaching
 *   for a `title` attribute on a bar is reaching for the wrong file.
 *
 *   They are written in the same idiom and hold to the same rules, plus one of
 *   their own: a composition never reaches for a colour directly. It takes a
 *   `tone` (a judgement) or a `tint` (an identity) from ./tone, which is the
 *   distinction the token layer already drew and the references collapsed.
 *
 * ---------------------------------------------------------------------------
 * Which build of the registry a file is on
 *
 * shadcn ships three builds of most components — Base UI, React Aria, Radix —
 * and they are NOT interchangeable: parts are named differently and state
 * arrives on different attributes. A file half-migrated between them compiles
 * and renders unstyled. **Read the import at the top of a file before editing
 * it.** `button`, `switch`, `tabs`, `radio-group` and `alert-dialog` are on
 * `@base-ui/react`; the rest are Radix or have no primitive at all.
 *
 * One thing the published Base UI snippets get wrong, found by reading the
 * live DOM: Base UI 1.7 emits `data-orientation="horizontal"` and no
 * `data-horizontal` attribute, so the registry's `data-horizontal:` classes
 * never match. `tabs.tsx` uses `data-[orientation=…]` and says why.
 *
 * ---------------------------------------------------------------------------
 * Adopted rather than written (the 2026-08-30 pass)
 *
 * Eleven components were taken from the registry instead of being invented or
 * kept. Four were outright gaps — `marker` had one variant of three,
 * `attachment` had no upload state, `breadcrumb` existed only in the mock
 * pages, `field` had no grouping layer. Four replaced a hand-rolled
 * equivalent while the app's own rule survived on top: `radio-group` is now
 * the behaviour under `Kit.Segmented` (which kept its look and gained arrow
 * keys), `alert` is the shell under `Banner` (which kept the neutral card and
 * the dismissal policy), `alert-dialog` is the shell under `ConfirmDialog`
 * (which kept "nothing is focused"), and `input-group` replaced a three-part
 * version outright. `toast` is Sonner, mounted beside `Notices` rather than
 * replacing it, because the four-lifetime policy is a product decision.
 *
 * The last two were taken as capability rather than code, and the reasoning is
 * in their files: `data-table`'s recipe wants TanStack for a need no screen
 * has yet, and `resizable`'s library wants to own the sizes the layout store
 * owns. So the sortable heading, the selection and the pagination are here,
 * and the resize handle is here with the keyboard support that was the point.
 *
 * What is NOT adopted, deliberately, is in the audit: `command`, `context-menu`
 * and `message-scroller` overlap surfaces of ours that do more, and swapping
 * them would lose features. `message-scroller` is the one worth prototyping.
 */
export * from './alert'
export * from './alert-dialog'
export * from './avatar'
export * from './attachment'
export * from './avatar-stack'
export * from './badge'
export * from './board'
export * from './breadcrumb'
export * from './button'
export * from './browser-chrome'
export * from './card'
export * from './chart'
export * from './commit'
export * from './composer'
export * from './data-table'
export * from './checkbox'
export * from './dialog'
export * from './delta'
export * from './dropdown-menu'
export * from './empty-state'
export * from './field'
export * from './hover-card'
export * from './icon-tile'
export * from './input'
export * from './input-group'
export * from './key-value'
export * from './label'
export * from './list-row'
export * from './marker'
export * from './native-select'
export * from './popover'
export * from './progress'
export * from './radio-group'
export * from './rail'
export * from './resize-handle'
export * from './scroll-area'
export * from './section'
export * from './select'
export * from './separator'
export * from './spark'
export * from './stat'
export * from './stepper'
export * from './switch'
export * from './table'
export * from './tabs'
export * from './textarea'
export * from './toast'
export * from './toggle-group'
export * from './tool-pane'
export * from './tone'
export * from './turn'
export * from './tooltip'
