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
 *
 * Menus fit their rows within 200–340px: a 6px plate inset, shared 16px
 * content edges, and 12px between row text and a one-line trailing value.
 * Action menus give every row an icon, including destructive rows in danger
 * ink; choice menus have no row icons and put the selected check at the end.
 * Agent/account lists show each entry's mark. Labels are unique and group
 * labels have no icons. Permissions keep visible reasons only for Full access
 * and Never ask; a model update is one row with its command in the title.
 * The popup-wall contract enforces the full rule in docs/design.md.
 */
import './foundation/focus-input'

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
  SegmentedReadout,
  SectionHead,
  Rows,
  Row,
  RowButton,
  RowChoice,
  Clipped,
  Face,
  FileButton,
  AccountMark,
  CodeText,
  Monogram,
  MetaList,
  InlineParts,
  DetailMark,
  RowInput,
  RowMark,
  RowValue,
  Text,
  TextMark,
  type TextProps,
  type TextRole,
} from './patterns/Settings'
export { SettingsRowMenu } from './patterns/SettingsRowMenu'
export { SidebarMenuState, type SidebarMenuStateProps } from './patterns/SidebarMenuState'
export { MiddleTruncate } from './ui/key-value'
export { Button, buttonVariants, buttonEdge } from './ui/button'
export { Bar } from './ui/bar'
export {
  SidebarGroup, SidebarGroupContent, SidebarMenu,
  SidebarMenuAction, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem,
} from './ui/sidebar'
export { DisclosureChevron } from './ui/disclosure-chevron'
export { Input } from './ui/input'
export { Textarea } from './ui/textarea'
export { Switch } from './ui/switch'
export { NativeSelect } from './ui/native-select'
export { Dialog, DialogBody, DialogFooter as ModalDialogFooter, DialogHead } from './patterns/ModalDialog'
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
  renderShellSlot,
  DialogTitle,
  DialogTrigger,
  DialogViewport,
} from './ui/dialog'
export { Notice, NoticeStatus, NoticeList, NoticeRow, NoticeHost, type NoticeProps, type NoticeAction } from './primitives/Notice'
export { Banner, BannerAction, BannerStack, type BannerTone } from './primitives/Banner'
export {
  ComposerNotice,
  ComposerNoticeStack,
  ComposerTail,
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
export { FlowGraph, type FlowGraphProps } from './patterns/FlowGraph'
export { FlowCard, FlowMiniGraph, FlowCardGrid, type FlowCardProps } from './patterns/FlowCards'
export { FlowCanvasToolbar } from './patterns/FlowCanvasToolbar'
export { FlowCanvasWorkspace, FlowCanvasSurface, FlowCanvasContent } from './patterns/FlowCanvasWorkspace'
export { FlowStepRow, RunStateChip } from './patterns/FlowStepRow'
export { CopyButton, copyButtonIconMarkup } from './patterns/CopyButton'
export { ActionError } from './patterns/ActionError'
export * from './patterns/InspectorPanel'
export { Page, type PageWidth } from './patterns/Page'
export { FRAME, FRAME_TOKENS } from './frame'
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
export { PaneColumn, ReadingMeasure, useComposerHeightVar, type PaneColumnProps, type PaneColumnInset } from './patterns/PaneColumn'
export { ComposerTrack, type ComposerTrackName } from './patterns/ComposerTrack'
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
  MenuAccountRow,
  MenuLabel,
  MenuNote,
  MenuSeparator,
  MenuToggle,
  Submenu,
  useContextMenu,
  useMenuClose,
  type MenuAccountFigure,
  type MenuItemProps,
  type MenuPoint,
} from './patterns/Menu'
export {
  DISMISS_OVERLAYS,
  Popover,
  dismissOverlays,
  PopoverGroupLabel,
  PopoverSurface,
  useDismissOverlays,
  useEscapeSurface,
  type DismissDetail,
} from './patterns/Popover'
export {
  CommandPalettePanel,
  CommandPaletteSearch,
  CommandPaletteControls,
  CommandPaletteDivider,
  CommandPaletteResults,
  CommandPaletteResult,
  CommandPaletteEmpty,
  CommandPaletteFooter,
  CommandPaletteKeyHint,
} from './patterns/CommandPalette'
export * from './ui'
export {
  ChannelMessage,
  ChannelNotice,
  ChannelSignal,
  type ChannelMessageProps,
  type ChannelState,
} from './patterns/ChannelMessage'
export { AgentCard, MemberName, CardBand, CardCrest, CardCrestBody, CardShell, type AgentCardAction, type AgentCardCaution, type AgentCardSubject } from './patterns/AgentCard'
export * from './patterns/DockPanel'
export { TerminalShellTabs, type TerminalShellTab } from './patterns/TerminalShellTabs'
export { Checklist, ChecklistItem, type ChecklistState } from './patterns/Checklist'
export { KindGlyph, StatePill, publicationVerb, stateTone, type StateToneState } from './patterns/PublicationCard'
export { PlanCard, type PlanCardProps } from './patterns/PlanCard'

export { UsageMeterRow } from './patterns/UsageMeterRow'

export { FlowCanvas, FLOW_CANVAS_CARD_WIDTH, FLOW_CANVAS_RUN_CARD_HEIGHT, type FlowCanvasStep, type FlowCanvasNode, type FlowCanvasEdge, type FlowCanvasNodeChange, type FlowCanvasEdgeChange, type FlowCanvasNodeProps, type FlowCanvasProps } from './patterns/FlowCanvas'

export { HeaderStatusGroup, HeaderStatusReading, useHeaderStatusGroup } from './patterns/HeaderStatusGroup'
export { ComparisonNotice } from './patterns/ComparisonNotice'
export { ComparisonDecision } from './patterns/ComparisonDecision'
export { ComparisonSummary } from './patterns/ComparisonSummary'

export { MergeDialog, DiffRangeDialog } from './patterns/GitComparisonDialogs'

export { TopBar, TopBarToolButton, type TopBarProps, type TopBarAction, type TopBarTab } from './patterns/TopBar'

export { ToolBody, ToolBodySections, ToolBodyControls, ToolSection, ToolProse, ToolRow, ToolFold } from './patterns/ToolBody'
export { ToolFooterProvider, ToolFooterScope, ToolFooterPublisher, ToolFooterOutlet, ToolFooterSuppressed, type ToolFoot } from './patterns/ToolFooter'

export { SeatList, type SeatListRow } from './patterns/SeatList'
export { LeftColumn, LeftColumnBody, LeftColumnGroup, LeftColumnHead, LeftColumnRow, LeftColumnSeat, LeftColumnTop,
  type LeftColumnRowProps, type LeftColumnTrail, type LeftColumnAction, type LeftColumnTopProps } from './patterns/LeftColumn'

export type { LeftColumnMenu } from './patterns/LeftColumn'

export { LeftColumnList, LeftColumnRename, LeftColumnNavigation, LeftColumnProjectsHead, LeftColumnListOptions, LeftColumnEmpty } from './patterns/LeftColumn'
import './ui/popup.css'
export { MenuPresentation, MenuRowContent, MenuListboxOption, menuRowAttributes, useMenuPresentation, type MenuRowData, type MenuIcons } from './ui/menu-row'

export { FixedShell, ShellNoticeHost, type FixedShellProps } from './patterns/FixedShell'



export { LeftColumnModeHead } from './patterns/LeftColumn'
export { WideMenu, WideMenuRows, MenuSearch, MenuFacts, type WideMenuItem, type MenuMeterData, type MenuSearchProps } from './patterns/WideMenu'

export { InfoCard, InfoCardBody, type InfoFact, type InfoNote, type InfoCardData, type InfoComposition } from './patterns/InfoCard'
export { useMenusOpen } from './ui/popup-state'

export { AgentCardModeContext } from './patterns/AgentCard'
export { SubjectActionRows, SubjectActionsMenu } from './patterns/SubjectActionsMenu'

export { InboxMenu } from './patterns/InboxMenu'

export { MainDestination, DestinationBody } from './patterns/MainDestination'

export { PageControls, ShortcutKeys, PageExplanation, PreservedText, InlineQualifier, PageNotes, type PageChoice } from './patterns/PageControls'
export { PageOptions, type PageOption } from './patterns/PageOptions'
export { PictureChoices, AccentChoices, RingChoices } from './patterns/SettingsChoices'

export { DashboardOverviewStats, DashboardBands, DashboardColumns, DashboardAccounts, DashboardAccountHead, DashboardAccountBody, DashboardAccountFoot, DashboardFigure, DashboardLanes, DashboardReadingNote, DashboardFact, DashboardMoney, DashboardTable, DashboardPlanName, DashboardPlanReading, DashboardAgentReading, DashboardStats, DashboardBurn, DashboardAccountActivity, type DashboardBand } from './patterns/DashboardBands'
export { PageRecords, PageRecordViews, type RecordColumn, type PageRecord, type RecordGroup } from './patterns/PageRecords'
export { TeamsBoard, TeamsBoardColumn, TeamsBoardCard, TeamsBoardToolbar, TeamsBoardWrapped } from './patterns/TeamsBoard'
export { BoardCard as CompactBoardCard, BoardCardGrid as CompactBoardCardGrid } from './patterns/BoardCard'
export { LibraryMatrix, type LibraryMatrixColumn, type LibraryMatrixCell, type LibraryMatrixRow, type LibraryMatrixFooter } from './patterns/LibraryMatrix'
export { SignInRail } from './patterns/SignInRail'

export { LeftColumnExplorerHead, LeftColumnExplorerFoot } from './patterns/LeftColumn'

export { SelectionAction } from './patterns/SelectionAction'
