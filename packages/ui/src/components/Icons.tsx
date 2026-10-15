// The shared glyph facade is below patterns: importing their barrel here
// makes notice and flow glyph tables capture icons before they initialize.
import { IconTile } from '../design/ui/icon-tile'
import type { ReactNode } from 'react'
import type { LucideIcon, LucideProps } from 'lucide-react'
import { Animated, type GlyphProps, ActivityGlyph, ArchiveGlyph, ArrowUpGlyph, AtSignGlyph, BellGlyph, BlocksGlyph, BookTextGlyph, BookmarkGlyph, BotGlyph, BrainGlyph, CalendarDaysGlyph, CheckGlyph, CheckCheckGlyph, ChevronDownGlyph, ChevronLeftGlyph, ChevronRightGlyph, ChevronsDownUpGlyph, ChevronsUpDownGlyph, CircleCheckGlyph, CircleDollarSignGlyph, CircleGaugeGlyph, ClockGlyph, CloudDownloadGlyph, CopyGlyph, CpuGlyph, DownloadGlyph, ExternalLinkGlyph, EyeOffGlyph, FileTextGlyph, FolderGit2Glyph, FolderInputGlyph, FolderOpenGlyph, FolderXGlyph, GaugeGlyph, GitBranchGlyph, GitCommitHorizontalGlyph, GitForkGlyph, GitGraphGlyph, GitMergeGlyph, GripVerticalGlyph, HandGlyph, HistoryGlyph, KeyboardGlyph, LoaderCircleGlyph, LockGlyph, LockOpenGlyph, Maximize2Glyph, MessageSquareGlyph, MessageSquarePlusGlyph, PlusGlyph, RefreshCwGlyph, RotateCcwGlyph, RotateCwGlyph, RouteGlyph, SearchGlyph, ServerGlyph, SettingsGlyph, ShieldCheckGlyph, ShrinkGlyph, SlidersHorizontalGlyph, SquareStackGlyph, UserGlyph, UsersGlyph, UsersRoundGlyph, WebhookGlyph, WorkflowGlyph, WrenchGlyph, XGlyph, ZapGlyph } from './glyphs'
import {
  Activity,
  Archive,
  ArrowUp,
  AtSign,
  Bell,
  Blocks,
  BookText,
  Bookmark,
  Bot,
  Brain,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleCheck,
  CircleDollarSign,
  CircleGauge,
  Clock,
  CloudDownload,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  EyeOff,
  FileText,
  FolderGit2,
  FolderInput,
  FolderOpen,
  FolderX,
  Gauge,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  GitGraph,
  GitMerge,
  GripVertical,
  Hand,
  History,
  Keyboard,
  LoaderCircle,
  Lock,
  LockOpen,
  Maximize2,
  MessageSquare,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Route,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Shrink,
  SlidersHorizontal,
  SquareStack,
  User,
  Users,
  UsersRound,
  Webhook,
  Workflow,
  Wrench,
  X,
  Zap,
  AppWindow as DesktopIconGlyph,
  ArrowDownAZ,
  ArrowDownToLine,
  ArrowUpFromLine,
  Eraser,
  House,
  Laptop,
  GitPullRequestArrow,
  BellOff,
  LibraryBig,
  Camera,
  ChartNoAxesGantt,
  Circle,
  CircleDot,
  ClockAlert,
  Code,
  Columns2,
  Table2,
  Database,
  Dot,
  Ellipsis,
  File,
  FileCode2,
  FileDiff,
  Flag,
  Folder,
  FoldVertical,
  Forward,
  Funnel,
  GitBranchPlus,
  Globe,
  Image,
  Import,
  Info,
  LayoutDashboard,
  LayoutPanelLeft,
  ListPlus,
  ListTodo,
  KeyRound,
  LogIn,
  LogOut,
  Minimize2,
  MessageSquareOff,
  MessagesSquare,
  MoveDown,
  MoveUp,
  Monitor,
  MonitorSmartphone,
  PanelLeft,
  PanelRight,
  SquareMenu,
  FilePlus2,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Puzzle,
  Redo2,
  Tag,
  Rows3,
  Rows4,
  ScanSearch,
  ScrollText,
  ShieldAlert,
  ShieldOff,
  Signal,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Smartphone,
  Sparkle,
  StickyNote,
  Square,
  SquareSlash,
  SquareTerminal,
  Tablet,
  Target,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  TriangleAlert,
  Undo2,
  MousePointer2,
  Scan,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'

/**
 * Every icon in the renderer, drawn by Lucide.
 *
 * Components import an icon by what it *means* (`PluginIcon`), never by what it
 * *draws* (`Puzzle`): the meaning is the contract with the rest of the UI, and
 * the glyph behind it can change here without a sweep through thirty files.
 * One meaning, one glyph — when two concepts shared a drawing (tool calls and
 * plugins both wore the wrench) it read as a relationship that was not there.
 *
 * Lucide renders inline SVG on `currentColor`, so every icon sits on the theme
 * without a second palette, and nothing is fetched — the renderer runs under a
 * CSP that forbids external requests. The stroke is Lucide's own 2/24, which
 * stays a crisp 1px down at the 12px this UI uses in chips and rows.
 *
 * Where lucide-animated has a motion for the glyph (`./glyphs`), the icon is
 * that one: the same Lucide paths, played while the pointer is over the control
 * that holds it, and plain Lucide until then. The rest are Lucide's own, still.
 * Either way it is one meaning, one glyph, and the same `IconProps`, so a
 * screen cannot tell which it got.
 */

export type IconProps = Omit<LucideProps, 'ref'> & { readonly size?: number }

const icon = (Glyph: LucideIcon, name: string) => {
  const Component = ({ size = 16, ...rest }: IconProps) => <Glyph size={size} focusable="false" {...rest} />
  Component.displayName = name
  return Component
}

/**
 * A glyph with a motion: the same icon, played by the control around it.
 * Drawn as plain Lucide until a pointer first reaches that control, so an icon
 * nobody hovers costs what a static one does.
 */
const animated = (draw: (props: GlyphProps) => ReactNode, still: LucideIcon, name: string) => {
  const Component = ({ size = 16, ...rest }: IconProps) => <Animated draw={draw} still={still} size={size} focusable="false" {...rest} />
  Component.displayName = name
  return Component
}

// --- Navigation and layout -------------------------------------------------

export const PlusIcon = animated(PlusGlyph, Plus, 'PlusIcon')
export const SearchIcon = animated(SearchGlyph, Search, 'SearchIcon')
export const SettingsIcon = animated(SettingsGlyph, Settings, 'SettingsIcon')
export const SlidersIcon = animated(SlidersHorizontalGlyph, SlidersHorizontal, 'SlidersIcon')
export const FlagIcon = icon(Flag, 'FlagIcon')
/** Narrowing a list you can already see — not searching for what you cannot. */
export const FilterIcon = icon(Funnel, 'FilterIcon')
export const MoreIcon = icon(Ellipsis, 'MoreIcon')
/** Disclosure — points right, rotate it for open or other directions. */
export const ChevronIcon = animated(ChevronRightGlyph, ChevronRight, 'ChevronIcon')
export const ArrowLeftIcon = animated(ChevronLeftGlyph, ChevronLeft, 'ArrowLeftIcon')
/**
 * The glyph on a closed picker: what it points at is the menu that will open
 * under it. Distinct from the disclosure chevron above, which points at
 * content that expands in place.
 */
export const CaretIcon = animated(ChevronDownGlyph, ChevronDown, 'CaretIcon')
export const ArrowRightIcon = animated(ChevronRightGlyph, ChevronRight, 'ArrowRightIcon')
export const CanvasSelectIcon = icon(MousePointer2, 'CanvasSelectIcon')
export const CanvasHandIcon = animated(HandGlyph, Hand, 'CanvasHandIcon')
export const CanvasFitIcon = icon(Scan, 'CanvasFitIcon')
/** Zoom the current page or canvas view in. */
export const ZoomInIcon = icon(ZoomIn, 'ZoomInIcon')
/** Zoom the current page or canvas view out. */
export const ZoomOutIcon = icon(ZoomOut, 'ZoomOutIcon')
export const SidebarIcon = icon(PanelLeft, 'SidebarIcon')
/** Watch the Team's conversations side by side. */
export const SideBySideIcon = icon(Columns2, 'SideBySideIcon')
/** A plugin's panel contribution. */
export const PanelIcon = icon(LayoutPanelLeft, 'PanelIcon')
export const PanelRightIcon = icon(PanelRight, 'PanelRightIcon')
export const SquareMenuIcon = icon(SquareMenu, 'SquareMenuIcon')
export const FilePlusIcon = icon(FilePlus2, 'FilePlusIcon')

// --- Status ----------------------------------------------------------------

export const CheckIcon = animated(CheckGlyph, Check, 'CheckIcon')
export const CrossIcon = animated(XGlyph, X, 'CrossIcon')
export const AlertIcon = icon(TriangleAlert, 'AlertIcon')
/** A statement about the app's own state, rather than a warning about it. */
export const InfoIcon = icon(Info, 'InfoIcon')
/** The messages the app makes outside a conversation, as a settings page. */
export const BellIcon = animated(BellGlyph, Bell, 'BellIcon')
/** Silencing one kind of those messages — never muting an agent. */
export const BellOffIcon = icon(BellOff, 'BellOffIcon')

// --- The composer ----------------------------------------------------------

export const SendIcon = animated(ArrowUpGlyph, ArrowUp, 'SendIcon')
export const StopIcon = ({ size = 16, ...rest }: IconProps) => (
  <Square size={size} fill="currentColor" focusable="false" {...rest} />
)
/** An image, attached or generated. */
export const ImageIcon = icon(Image, 'ImageIcon')
/** Mention a file — the `@` the composer understands. */
export const AtIcon = animated(AtSignGlyph, AtSign, 'AtIcon')
/** A slash command. */
export const SlashIcon = icon(SquareSlash, 'SlashIcon')
/** Context a plugin attached to the prompt. */
export const PaperclipIcon = icon(Paperclip, 'PaperclipIcon')
/** A conversation handed from one agent to another. */
export const HandoffIcon = icon(Forward, 'HandoffIcon')
/** A message written while the agent was busy, waiting for its turn. */
export const QueueIcon = icon(ListPlus, 'QueueIcon')
/** Move a queued message earlier or later. Ordering, never navigation. */
export const MoveUpIcon = icon(MoveUp, 'MoveUpIcon')
export const MoveDownIcon = icon(MoveDown, 'MoveDownIcon')
/** The handle a queued message is dragged by. Never a control on its own. */
export const GripIcon = animated(GripVerticalGlyph, GripVertical, 'GripIcon')

// --- Files and folders -----------------------------------------------------

export const FileIcon = icon(File, 'FileIcon')
export const FolderIcon = icon(Folder, 'FolderIcon')
/** Choosing a different folder. */
export const FolderOpenIcon = animated(FolderOpenGlyph, FolderOpen, 'FolderOpenIcon')
/** A folder that is no longer on the machine. */
export const FolderGoneIcon = animated(FolderXGlyph, FolderX, 'FolderGoneIcon')
/** Bringing something in from elsewhere on the machine. */
export const ImportIcon = icon(Import, 'ImportIcon')
/** Copying text or a path to the clipboard. */
export const CopyIcon = animated(CopyGlyph, Copy, 'CopyIcon')

/** The copy control's Lucide marks for trusted HTML that React does not own. */
export const copyIconMarkup = (copied: boolean): string =>
  copied
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>'
    : '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>'
export const TrashIcon = icon(Trash2, 'TrashIcon')
export const PencilIcon = icon(Pencil, 'PencilIcon')
export const ArchiveIcon = animated(ArchiveGlyph, Archive, 'ArchiveIcon')

// --- Git -------------------------------------------------------------------

/** What changed, as a diff. */
export const DiffIcon = icon(FileDiff, 'DiffIcon')
/** A branch, or the worktree checked out on one. */
export const BranchIcon = animated(GitBranchGlyph, GitBranch, 'BranchIcon')
/* The repository *as a panel* — distinct from `BranchIcon`, which the history
   toolbar already spends on its Branch button. A tab and a control in the same
   header wearing one glyph is a header you have to read twice. */
export const RepositoryIcon = animated(GitGraphGlyph, GitGraph, 'RepositoryIcon')
/** A conversation that starts from another's history. */
export const ForkIcon = animated(GitForkGlyph, GitFork, 'ForkIcon')
export const CommitIcon = animated(GitCommitHorizontalGlyph, GitCommitHorizontal, 'CommitIcon')
/** A review pass over the working tree. */
export const ReviewIcon = icon(ScanSearch, 'ReviewIcon')
/** A round whose Seats cannot read one another until it closes. */
export const BlindIcon = animated(EyeOffGlyph, EyeOff, 'BlindIcon')
/** Bringing the tracked branch's commits down into the checkout. */
export const PullIcon = icon(ArrowDownToLine, 'PullIcon')
/** Sending the branch's commits up to its remote. */
export const PushIcon = icon(ArrowUpFromLine, 'PushIcon')
/** Reading the remotes without touching the working tree. */
export const FetchIcon = animated(CloudDownloadGlyph, CloudDownload, 'FetchIcon')
/** Two histories joined. */
export const MergeIcon = animated(GitMergeGlyph, GitMerge, 'MergeIcon')
/** The forge's compare page for a branch, and a pull request itself. */
export const PullRequestIcon = icon(GitPullRequestArrow, 'PullRequestIcon')
/** An issue on the forge — the open dot GitHub itself draws. */
export const IssueIcon = icon(CircleDot, 'IssueIcon')
/** A comment on the forge. */
export const CommentIcon = animated(MessageSquareGlyph, MessageSquare, 'CommentIcon')
/** Messages held at the board — a room's messaging turned off. */
export const MessageOffIcon = icon(MessageSquareOff, 'MessageOffIcon')
/** A branch wound back to an earlier commit. */
export const ResetIcon = animated(RotateCcwGlyph, RotateCcw, 'ResetIcon')
/** One checkout of the repository — a folder the repository is open in. */
export const WorktreeIcon = animated(FolderGit2Glyph, FolderGit2, 'WorktreeIcon')
/** The main checkout as a place to work — "Local", beside a worktree. */
export const LocalIcon = icon(Laptop, 'LocalIcon')
/** A worktree's branch brought back to the main checkout. */
export const HomeIcon = icon(House, 'HomeIcon')
/** A worktree still to be made — the draft's place until its first message. */
export const NewWorktreeIcon = icon(GitBranchPlus, 'NewWorktreeIcon')
/** A worktree pinned against pruning. */
export const LockIcon = animated(LockGlyph, Lock, 'LockIcon')
export const UnlockIcon = animated(LockOpenGlyph, LockOpen, 'UnlockIcon')
/** Dropping the records of worktrees whose folders are gone. */
export const PruneIcon = icon(Eraser, 'PruneIcon')
/** A folder relocated, git's record of it following along. */
export const MoveFolderIcon = animated(FolderInputGlyph, FolderInput, 'MoveFolderIcon')

// --- What the agent does ---------------------------------------------------

export const TerminalIcon = icon(SquareTerminal, 'TerminalIcon')
/** Work that keeps running after the turn that started it. */
export const BackgroundIcon = animated(ActivityGlyph, Activity, 'BackgroundIcon')
/** A tool call. */
export const ToolIcon = animated(WrenchGlyph, Wrench, 'ToolIcon')
/** The agent's own reasoning. */
export const BrainIcon = animated(BrainGlyph, Brain, 'BrainIcon')
/** A saved Agent: its brief, ceiling and preferred seats. Sub-agents qualify this robot with ↳; runtimes use their own marks. */
export const AgentIcon = animated(BotGlyph, Bot, 'AgentIcon')
/** The robot with its delegation qualifier, including at navigation size. */
export const SubagentIcon = ({ size = 16, className, style, ...rest }: IconProps) => (
  <IconTile size="navigation" shape="face" badge="↳" title="Sub-agent of this conversation" className={className} style={{ width: size, height: size, color: 'inherit' }}>
    <AgentIcon size={size} {...rest} style={{ ...style, width: size, height: size }} />
  </IconTile>
)
/** An Agent's written brief — its instructions, distinct from the Agent itself. */
export const BriefIcon = animated(BookTextGlyph, BookText, 'BriefIcon')
/** A skill, or anything else the agent is handed to work with. */
export const SparkIcon = icon(Sparkle, 'SparkIcon')
export const GlobeIcon = icon(Globe, 'GlobeIcon')
/** A conversation, as a thing to find and open. */
export const SessionIcon = icon(MessagesSquare, 'SessionIcon')
/** Marking up a page: a comment left on the thing it is about. */
export const AnnotateIcon = animated(MessageSquarePlusGlyph, MessageSquarePlus, 'AnnotateIcon')
/** A block of context the desk composed and put on a message — never a plugin's. */
export const NoteIcon = icon(StickyNote, 'NoteIcon')
/** The objective a session is working towards. */
export const GoalIcon = icon(Target, 'GoalIcon')
/** A plan or task list the agent is working through. */
export const PlanIcon = icon(ListTodo, 'PlanIcon')
export const TodoDoneIcon = animated(CircleCheckGlyph, CircleCheck, 'TodoDoneIcon')
export const TodoActiveIcon = animated(LoaderCircleGlyph, LoaderCircle, 'TodoActiveIcon')
export const TodoPendingIcon = icon(Circle, 'TodoPendingIcon')
/** A plain list item, with no state to report. */
export const BulletIcon = icon(Dot, 'BulletIcon')
export const RetryIcon = animated(RotateCwGlyph, RotateCw, 'RetryIcon')
export const UndoIcon = icon(Undo2, 'UndoIcon')
/** Putting back what an undo took away. */
export const RedoIcon = icon(Redo2, 'RedoIcon')
export const ThumbsUpIcon = icon(ThumbsUp, 'ThumbsUpIcon')
export const ThumbsDownIcon = icon(ThumbsDown, 'ThumbsDownIcon')
/** Summarising older turns to free up context. */
export const CompactIcon = icon(FoldVertical, 'CompactIcon')
/** Where the time and tokens went, turn by turn. */
export const TrajectoryIcon = icon(ChartNoAxesGantt, 'TrajectoryIcon')

// --- Capabilities and settings ---------------------------------------------

export const PluginIcon = icon(Puzzle, 'PluginIcon')
/** A runtime's own extension store — apps and connectors. */
export const ExtensionIcon = animated(BlocksGlyph, Blocks, 'ExtensionIcon')
export const HookIcon = animated(WebhookGlyph, Webhook, 'HookIcon')
export const ResourceIcon = icon(Database, 'ResourceIcon')
/** The cross-agent library: what exists on this machine, and who can load it. */
export const LibraryIcon = icon(LibraryBig, 'LibraryIcon')
/** A model route. */
export const RouteIcon = animated(RouteGlyph, Route, 'RouteIcon')
/** An editable flow: a policy that routes cards between Agent, check and person steps. */
export const FlowIcon = animated(WorkflowGlyph, Workflow, 'FlowIcon')
export const PresetIcon = animated(BookmarkGlyph, Bookmark, 'PresetIcon')
export const ShieldIcon = animated(ShieldCheckGlyph, ShieldCheck, 'ShieldIcon')

// --- Account ---------------------------------------------------------------

export const UserIcon = animated(UserGlyph, User, 'UserIcon')
/** Key bindings — the keys themselves, never a single modifier's symbol. */
export const KeyboardIcon = animated(KeyboardGlyph, Keyboard, 'KeyboardIcon')
export const SignInIcon = icon(LogIn, 'SignInIcon')
export const SignOutIcon = icon(LogOut, 'SignOutIcon')
export const KeyIcon = icon(KeyRound, 'KeyIcon')

// --- Workspace menu ---------------------------------------------------------

/** Keep a project at the top of the list. */
export const PinIcon = icon(Pin, 'PinIcon')
export const UnpinIcon = icon(PinOff, 'UnpinIcon')

// --- Controls and lists ----------------------------------------------------

/** A model — the thing that thinks. */
export const ModelIcon = animated(CpuGlyph, Cpu, 'ModelIcon')
/** Acting directly, without a plan first. */
export const ZapIcon = animated(ZapGlyph, Zap, 'ZapIcon')
/** A permission that widens what the agent may do without asking. */
export const ShieldAlertIcon = icon(ShieldAlert, 'ShieldAlertIcon')
/** No guard at all — full access. */
export const ShieldOffIcon = icon(ShieldOff, 'ShieldOffIcon')
/** Every agent, or every one of something. */
export const EveryoneIcon = animated(UsersGlyph, Users, 'EveryoneIcon')
/** The plan strip's roster token — everyone else's standing on quota, at a glance. */
export const RosterIcon = animated(CircleGaugeGlyph, CircleGauge, 'RosterIcon')
/** The conversations of one workspace working together — the board and the channel. */
export const TeamIcon = animated(UsersRoundGlyph, UsersRound, 'TeamIcon')
/** Fold every group in a list shut, and open every one again. */
export const CollapseAllIcon = animated(ChevronsDownUpGlyph, ChevronsDownUp, 'CollapseAllIcon')
export const ExpandAllIcon = animated(ChevronsUpDownGlyph, ChevronsUpDown, 'ExpandAllIcon')
/** A ruled matrix; the loose and tight rows offer two list densities. */
export const MatrixIcon = icon(Table2, 'MatrixIcon')
export const RowsLooseIcon = icon(Rows3, 'RowsLooseIcon')
export const RowsTightIcon = icon(Rows4, 'RowsTightIcon')
export const ClockIcon = animated(ClockGlyph, Clock, 'ClockIcon')
/** What a plan has left, and what it cost. */
export const UsageIcon = animated(GaugeGlyph, Gauge, 'UsageIcon')
/** Money already spent, as distinct from a plan's remaining share. */
export const CostIcon = animated(CircleDollarSignGlyph, CircleDollarSign, 'CostIcon')
/** The Dashboard's Overview row — the whole story on one screen. */
export const OverviewIcon = icon(LayoutDashboard, 'OverviewIcon')
/** The Dashboard's Activity row — "when it ran", drawn as a calendar heatmap. */
export const ActivityIcon = animated(CalendarDaysGlyph, CalendarDays, 'ActivityIcon')
export const SortNameIcon = icon(ArrowDownAZ, 'SortNameIcon')
/** What happened, in order. */
export const HistoryIcon = animated(HistoryGlyph, History, 'HistoryIcon')
/** A fact recorded before what is there now — a stale chip's leading mark. */
export const StaleIcon = icon(ClockAlert, 'StaleIcon')
export const ServerIcon = animated(ServerGlyph, Server, 'ServerIcon')
export const DownloadIcon = animated(DownloadGlyph, Download, 'DownloadIcon')
/** Approved, and for the rest of the session too. */
export const CheckAllIcon = animated(CheckCheckGlyph, CheckCheck, 'CheckAllIcon')
/** A written summary. */
export const SummaryIcon = animated(FileTextGlyph, FileText, 'SummaryIcon')
/** The whole transcript. */
export const TranscriptIcon = icon(ScrollText, 'TranscriptIcon')
export const ThemeSystemIcon = icon(Monitor, 'ThemeSystemIcon')
/** How hard the model thinks: four steps, low to max. */
export const EffortLowIcon = icon(SignalLow, 'EffortLowIcon')
export const EffortMediumIcon = icon(SignalMedium, 'EffortMediumIcon')
export const EffortHighIcon = icon(SignalHigh, 'EffortHighIcon')
export const EffortMaxIcon = icon(Signal, 'EffortMaxIcon')

// --- The browser pane ------------------------------------------------------

/**
 * How large a page is shown. Responsive is drawn as the two sizes at once,
 * because that is what it means: whatever the pane happens to be. Desktop
 * wears a window rather than a monitor — the monitor already means "follow
 * the system" in the appearance menu, and one meaning gets one glyph.
 */
export const ResponsiveIcon = icon(MonitorSmartphone, 'ResponsiveIcon')
export const MobileIcon = icon(Smartphone, 'MobileIcon')
export const TabletIcon = icon(Tablet, 'TabletIcon')
export const DesktopIcon = icon(DesktopIconGlyph, 'DesktopIcon')
/** Editor mode: the file and code view beside a conversation. */
export const EditorIcon = icon(FileCode2, 'EditorIcon')
/** Chromium's own inspector, on the page in the pane. */
export const DevToolsIcon = icon(Code, 'DevToolsIcon')
/** The same thing, in a full window. */
export const ExpandIcon = animated(Maximize2Glyph, Maximize2, 'ExpandIcon')
/** Return a tile from its expanded view to the grid. */
export const CollapseIcon = animated(ShrinkGlyph, Shrink, 'CollapseIcon')
/** Back from the full pane area to the split it came from. */
export const RestoreIcon = icon(Minimize2, 'RestoreIcon')
/** Read the repository again; distinct from RetryIcon, which re-runs a thing that failed. */
export const RefreshIcon = animated(RefreshCwGlyph, RefreshCw, 'RefreshIcon')
/** A git tag, on history rows and the refs rail. */
export const TagIcon = icon(Tag, 'TagIcon')
/** A stash: work set aside in a stack. */
export const StashIcon = animated(SquareStackGlyph, SquareStack, 'StashIcon')
/** Away from this window, to whatever the OS opens links with. */
export const ExternalIcon = animated(ExternalLinkGlyph, ExternalLink, 'ExternalIcon')
/** A picture of the page, saved. */
export const CameraIcon = icon(Camera, 'CameraIcon')
