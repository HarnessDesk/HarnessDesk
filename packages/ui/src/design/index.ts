/**
 * The design system.
 *
 * Import UI from here, not from a sibling screen's stylesheet. Everything
 * exported is unaware of the app — no store, no session, no context — so it
 * works on the sign-in screen, in a dialog, and in the design explorer alike.
 *
 *   Foundation   ./foundation/tokens.css — every editable design decision
 *   Primitives   ./ui — the only generic control vocabulary, on Base UI
 *   Patterns     ./patterns — typed HarnessDesk presentation contracts
 *   Screens      product code, which composes these and adds nothing shared
 *
 * Changes flow down and never up. A screen may not reach sideways into
 * another screen; that is what `pnpm design:audit` checks.
 *
 * There is one answer per generic UI question. `./ui` is shadcn-authored
 * component source backed only by Base UI, styled through semantic utilities
 * that resolve to the foundation. `./patterns` preserves product-specific
 * contracts such as SettingsRow, Menu, Composer, and ApprovalDialog without
 * creating a second Button, Input, Switch, or overlay engine. The retired Kit,
 * local Menu/Popover, and hand-built Dialog APIs have no production consumers
 * and the architecture gate rejects their return.
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
  Search,
  Field,
  type FieldControl,
  FormStack,
  Note,
  Segmented,
  PageHead,
  SectionHead,
  Rows,
  Row,
  RowButton,
  RowChoice,
  BackLink,
  DetailHead,
  Clipped,
  Face,
  FileButton,
  AccountMark,
  CodeText,
  DetailMark,
  PageDescription,
  RowMark,
  RowValue,
  SectionToggle,
  WireText,
} from './patterns/Settings'
export { Button, buttonVariants } from './ui/button'
export { Input } from './ui/input'
export { Textarea } from './ui/textarea'
export { Switch } from './ui/switch'
export { NativeSelect } from './ui/native-select'
export { Dialog } from './patterns/ModalDialog'
export {
  Dialog as DialogRoot,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPopup,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  DialogViewport,
} from './ui/dialog'
export { Banner, BannerAction, BannerStack, type BannerTone } from './primitives/Banner'

export { ConfirmDialog } from './patterns/ConfirmDialog'
export { RefusedAction } from './patterns/RefusedAction'
export { Lightbox, type LightboxImage } from './patterns/Lightbox'
export {
  ApprovalDialog,
  type ApprovalDialogAction,
} from './patterns/ApprovalDialog'
export {
  ContextMenu,
  Menu,
  MenuItem,
  MenuLabel,
  MenuNote,
  MenuSeparator,
  MenuToggle,
  Submenu,
  useContextMenu,
  useMenuClose,
  type MenuPoint,
} from './patterns/Menu'
export {
  DISMISS_OVERLAYS,
  Popover,
  dismissOverlays,
  PopoverGroupLabel,
  PopoverDim,
  PopoverFilterInput,
  PopoverOption,
  PopoverOptionBody,
  PopoverOptionHint,
  PopoverOptionLabel,
  PopoverOptionLive,
  PopoverOptionMark,
  PopoverStrong,
  PopoverUpdateNote,
  useDismissOverlays,
  useEscapeSurface,
  type DismissDetail,
} from './patterns/Popover'
export * from './ui'
export {
  ChannelMessage,
  ChannelNotice,
  ChannelSignal,
  type ChannelDensity,
  type ChannelMessageProps,
  type ChannelState,
} from './patterns/ChannelMessage'
export { AgentCard, type AgentCardAction, type AgentCardSubject } from './patterns/AgentCard'
export * from './patterns/DockPanel'
export { KindGlyph, PublicationCard, StatePill, publicationVerb } from './patterns/PublicationCard'
