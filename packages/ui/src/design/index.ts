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
  Spinner,
  type SpinnerProps,
  Chip,
  type ChipProps,
  Search,
  NavigationList,
  Keycap,
  NavigationGroupHeader,
  Field,
  type FieldControl,
  FormStack,
  Note,
  NoteList,
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
  Monogram,
  MetaList,
  DetailMark,
  PageDescription,
  RowInput,
  RowMark,
  RowValue,
  Text,
  TextMark,
  type TextProps,
  type TextRole,
} from './patterns/Settings'
export { Button, buttonVariants, buttonEdge } from './ui/button'
export { DisclosureChevron } from './ui/disclosure-chevron'
export { Input } from './ui/input'
export { Textarea } from './ui/textarea'
export { Switch } from './ui/switch'
export { NativeSelect } from './ui/native-select'
export { Dialog, DialogBody, DialogHead, DialogSubhead } from './patterns/ModalDialog'
export { ChoiceList, Fieldset } from './patterns/DialogForm'
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
export {
  ComposerNotice,
  ComposerNoticeStack,
  InboxList,
  InboxPanel,
  NoticeCard,
  NoticeStrip,
  showProgress,
  showToast,
  type InboxMessage,
  type NoticeAct,
  type NoticeMessage,
  type NoticeSurface,
  type NoticeTone,
} from './patterns/Notices'

export { ConfirmDialog } from './patterns/ConfirmDialog'
export { ConversationEmptyState } from './patterns/ConversationEmptyState'
export { CodeBlock, type CodeBlockProps } from './patterns/CodeBlock'
export { CopyButton, copyButtonIconMarkup } from './patterns/CopyButton'
export { ActionError } from './patterns/ActionError'
export {
  AppWindowPage,
  AppWindowRail,
  AppWindowRailScroll,
  AppWindowRailTop,
  AppWindowSurface,
} from './patterns/AppWindow'
export * from './patterns/InspectorPanel'
export { ChangeStats, FileState, PatchHeader, type FileStateValue } from './patterns/Change'
export { RefusedAction } from './patterns/RefusedAction'
export { Lightbox, type LightboxImage } from './patterns/Lightbox'
export {
  TurnItem,
  TurnWorkHeader,
  TurnWorkHeaderLabel,
  TurnWorkBody,
  TurnWorkLive,
  type TurnWorkState,
} from './patterns/TurnWork'
export {
  ApprovalChoiceHint,
  ApprovalCode,
  ApprovalDialog,
  ApprovalFilePath,
  ApprovalMeta,
  ApprovalPermissionList,
  ApprovalQuestionText,
  ApprovalReason,
  type ApprovalDialogAction,
} from './patterns/ApprovalDialog'
export {
  ContextMenu,
  Menu,
  MenuItem,
  MenuAccountGroup,
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
  PopoverOption,
  PopoverOptionBody,
  PopoverOptionHint,
  PopoverOptionLabel,
  PopoverOptionLive,
  PopoverOptionMark,
  PopoverSurface,
  useDismissOverlays,
  useEscapeSurface,
  type DismissDetail,
} from './patterns/Popover'
export * from './ui'
export {
  ChannelMessage,
  ChannelNotice,
  ChannelSignal,
  type ChannelMessageProps,
  type ChannelState,
} from './patterns/ChannelMessage'
export { AgentCard, CardBand, CardCrest, CardCrestBody, CardShell, type AgentCardAction, type AgentCardCaution, type AgentCardSubject } from './patterns/AgentCard'
export * from './patterns/DockPanel'
export { Checklist, ChecklistItem, type ChecklistState } from './patterns/Checklist'
export { KindGlyph, StatePill, publicationVerb, stateTone, type StateToneState } from './patterns/PublicationCard'
