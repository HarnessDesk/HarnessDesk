/**
 * The design system.
 *
 * Import UI from here, not from a sibling screen's stylesheet. Everything
 * exported is unaware of the app — no store, no session, no context — so it
 * works on the sign-in screen, in a dialog, and in the design explorer alike.
 *
 *   Foundation   design/tokens.css — every value the system decides
 *   Primitives   the pieces below, and the shadcn layer in ./ui
 *   Patterns     compositions that encode a rule (ConfirmDialog)
 *   Screens      product code, which composes these and adds nothing shared
 *
 * Changes flow down and never up. A screen may not reach sideways into
 * another screen; that is what `pnpm design:audit` checks.
 *
 * Three sources now, still one answer per question. `./ui` holds two kinds of
 * file — vendored registry components, and compositions of our own — and as of
 * 2026-08-30 eleven of the vendored ones were *adopted to replace* something
 * this app had written for itself. The pattern that adoption followed is worth
 * stating, because it is the one to repeat: **take the registry's anatomy and
 * behaviour, keep the app's rule on top.** `Kit.Segmented` kept its segmented
 * look and gained a real radio group's arrow keys; `Banner` kept its neutral
 * card and gained `role="alert"`; `ConfirmDialog` kept "nothing is focused"
 * and gained an overlay that cannot be dismissed by a stray click. A component
 * is not a set of opinions to swallow whole. See design/ui/index.ts for the
 * ledger and the two that were taken as capability rather than code.
 *
 * Two component layers, one answer per question. `./ui` is the shadcn/ui
 * layer — vendored component source, styled by Tailwind utilities that
 * resolve to the same tokens (styles/shadcn.css is the bridge) — and it is
 * the idiom new and rebuilt surfaces are written in; the Team channel and
 * its patterns already are. `Kit` remains the settings-surface primitives
 * (rows, page furniture, the controls twelve settings pages share) until a
 * surface is rebuilt, at which point the shadcn spelling wins. What stays
 * forbidden is the thing that was always forbidden: a THIRD spelling, or a
 * screen answering "what is a button here" for itself. An earlier pass
 * wrote a private second set and the result was two answers on one screen —
 * the exact failure this system exists to prevent.
 *
 * One rule the system holds that no token can hold: **a row's second line is
 * earned, not default**. That small grey line under a label costs height on
 * every screen forever, and a menu where every row explains itself has
 * explained nothing — the one row warning about a real consequence looks like
 * the five around it saying nothing. Three things earn a visible line: a
 * consequence the label cannot carry, a fact that varies (a path, a count, a
 * reason), and a name that carries no meaning of its own. Everything else goes
 * on hover, as `title` — same string, later. The tests, the exceptions (a
 * refused row keeps its reason on screen; Settings is a document, not a menu)
 * and the ledger of what moved are docs/design.md.
 */
export {
  Dot,
  Chip,
  Btn,
  IconBtn,
  Input,
  Textarea,
  Search,
  Field,
  type FieldControl,
  FormStack,
  Note,
  Toggle,
  Select,
  Segmented,
  PageHead,
  SectionHead,
  Rows,
  Row,
  RowButton,
  RowChoice,
  BackLink,
  DetailHead,
  Face,
} from './primitives/Kit'
export { Dialog } from './primitives/Dialog'
export { Banner, BannerAction, bannerStyles, type BannerTone } from './primitives/Banner'

export { ConfirmDialog } from './patterns/ConfirmDialog'
export {
  ChannelMessage,
  ChannelNotice,
  ChannelSignal,
  type ChannelDensity,
  type ChannelMessageProps,
  type ChannelState,
} from './patterns/ChannelMessage'
