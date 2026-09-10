import type { LucideIcon, LucideProps } from 'lucide-react'
import {
  Activity,
  AppWindow,
  Archive,
  ArrowDownAZ,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUp,
  ArrowUpFromLine,
  CloudDownload,
  Eraser,
  FolderGit2,
  FolderInput,
  House,
  Laptop,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  RotateCcw,
  AtSign,
  Bell,
  BellOff,
  Blocks,
  Bookmark,
  LibraryBig,
  Lock,
  LockOpen,
  Bot,
  Brain,
  Camera,
  ChartNoAxesGantt,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
  GripVertical,
  Circle,
  CircleCheck,
  CircleDot,
  Clock,
  Code,
  Columns2,
  Rows2,
  LayoutGrid,
  Table2,
  Copy,
  Cpu,
  Database,
  Dot,
  Download,
  Ellipsis,
  ExternalLink,
  File,
  FileDiff,
  FileDown,
  FileText,
  Folder,
  FolderOpen,
  FoldVertical,
  Funnel,
  GitBranch,
  GitCommitHorizontal,
  GitGraph,
  GitFork,
  Gauge,
  CircleDollarSign,
  CircleGauge,
  Globe,
  History,
  Image,
  Import,
  Info,
  LayoutPanelLeft,
  ListPlus,
  ListTodo,
  KeyRound,
  Keyboard,
  LogIn,
  LogOut,
  Maximize2,
  Minimize2,
  MessageCircleQuestionMark,
  MessageSquare,
  MessageSquarePlus,
  Monitor,
  MonitorSmartphone,
  Moon,
  PanelLeft,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Puzzle,
  Redo2,
  RefreshCw,
  RotateCw,
  SquareStack,
  Tag,
  Route,
  Rows3,
  Rows4,
  ScanSearch,
  ScrollText,
  Search,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Signal,
  SignalHigh,
  SignalLow,
  SignalMedium,
  SlidersHorizontal,
  Smartphone,
  Sparkle,
  StickyNote,
  Square,
  SquareSlash,
  SquareTerminal,
  Sun,
  Tablet,
  Target,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  TriangleAlert,
  Undo2,
  User,
  Users,
  UsersRound,
  Webhook,
  Wrench,
  X,
  Zap,
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
 */

export type IconProps = Omit<LucideProps, 'ref'> & { readonly size?: number }

const icon = (Glyph: LucideIcon, name: string) => {
  const Component = ({ size = 16, ...rest }: IconProps) => <Glyph size={size} focusable="false" {...rest} />
  Component.displayName = name
  return Component
}

// --- Navigation and layout -------------------------------------------------

export const PlusIcon = icon(Plus, 'PlusIcon')
export const SearchIcon = icon(Search, 'SearchIcon')
export const SettingsIcon = icon(Settings, 'SettingsIcon')
export const SlidersIcon = icon(SlidersHorizontal, 'SlidersIcon')
/** Narrowing a list you can already see — not searching for what you cannot. */
export const FilterIcon = icon(Funnel, 'FilterIcon')
export const MoreIcon = icon(Ellipsis, 'MoreIcon')
/** Disclosure — points right, rotate it for open or other directions. */
export const ChevronIcon = icon(ChevronRight, 'ChevronIcon')
export const ArrowLeftIcon = icon(ChevronLeft, 'ArrowLeftIcon')
/**
 * The glyph on a closed picker: what it points at is the menu that will open
 * under it. Distinct from the disclosure chevron above, which points at
 * content that expands in place.
 */
export const CaretIcon = icon(ChevronDown, 'CaretIcon')
export const ArrowRightIcon = icon(ChevronRight, 'ArrowRightIcon')
/** Page zoom, in the browser pane — the page's scale, never a search. */
export const ZoomInIcon = icon(ZoomIn, 'ZoomInIcon')
export const ZoomOutIcon = icon(ZoomOut, 'ZoomOutIcon')
export const SidebarIcon = icon(PanelLeft, 'SidebarIcon')
/** Two panes side by side. */
export const SplitIcon = icon(Columns2, 'SplitIcon')
/* Splitting has two directions and they are different verbs, so they are two
   glyphs: columns for side by side, rows for one above the other. */
export const SplitDownIcon = icon(Rows2, 'SplitDownIcon')
/** A plugin's panel contribution. */
export const PanelIcon = icon(LayoutPanelLeft, 'PanelIcon')

// --- Status ----------------------------------------------------------------

export const CheckIcon = icon(Check, 'CheckIcon')
export const CrossIcon = icon(X, 'CrossIcon')
export const AlertIcon = icon(TriangleAlert, 'AlertIcon')
/** The agent stopped to ask something. */
export const QuestionIcon = icon(MessageCircleQuestionMark, 'QuestionIcon')
/** A statement about the app's own state, rather than a warning about it. */
export const InfoIcon = icon(Info, 'InfoIcon')
/** The messages the app makes outside a conversation, as a settings page. */
export const BellIcon = icon(Bell, 'BellIcon')
/** Silencing one kind of those messages — never muting an agent. */
export const BellOffIcon = icon(BellOff, 'BellOffIcon')

// --- The composer ----------------------------------------------------------

export const SendIcon = icon(ArrowUp, 'SendIcon')
export const StopIcon = ({ size = 16, ...rest }: IconProps) => (
  <Square size={size} fill="currentColor" focusable="false" {...rest} />
)
/** An image, attached or generated. */
export const ImageIcon = icon(Image, 'ImageIcon')
/** Mention a file — the `@` the composer understands. */
export const AtIcon = icon(AtSign, 'AtIcon')
/** A slash command. */
export const SlashIcon = icon(SquareSlash, 'SlashIcon')
/** Context a plugin attached to the prompt. */
export const PaperclipIcon = icon(Paperclip, 'PaperclipIcon')
/** A conversation handed from one agent to another. */
export const HandoffIcon = icon(ArrowLeftRight, 'HandoffIcon')
/** A message written while the agent was busy, waiting for its turn. */
export const QueueIcon = icon(ListPlus, 'QueueIcon')
/** Move a queued message earlier or later. Ordering, never navigation. */
export const MoveUpIcon = icon(ChevronUp, 'MoveUpIcon')
export const MoveDownIcon = icon(ChevronDown, 'MoveDownIcon')
/** The handle a queued message is dragged by. Never a control on its own. */
export const GripIcon = icon(GripVertical, 'GripIcon')

// --- Files and folders -----------------------------------------------------

export const FileIcon = icon(File, 'FileIcon')
export const FolderIcon = icon(Folder, 'FolderIcon')
/** Choosing a different folder. */
export const FolderOpenIcon = icon(FolderOpen, 'FolderOpenIcon')
/** Bringing something in from elsewhere on the machine. */
export const ImportIcon = icon(Import, 'ImportIcon')
/* Saving something out of the app. Was `FileIcon`, which is what a *file* is
   — and sat a few pixels from a tab wearing the same glyph for that reason. */
export const ExportIcon = icon(FileDown, 'ExportIcon')
export const CopyIcon = icon(Copy, 'CopyIcon')
export const TrashIcon = icon(Trash2, 'TrashIcon')
export const PencilIcon = icon(Pencil, 'PencilIcon')
export const ArchiveIcon = icon(Archive, 'ArchiveIcon')

// --- Git -------------------------------------------------------------------

/** What changed, as a diff. */
export const DiffIcon = icon(FileDiff, 'DiffIcon')
/** A branch, or the worktree checked out on one. */
export const BranchIcon = icon(GitBranch, 'BranchIcon')
/* The repository *as a panel* — distinct from `BranchIcon`, which the history
   toolbar already spends on its Branch button. A tab and a control in the same
   header wearing one glyph is a header you have to read twice. */
export const RepositoryIcon = icon(GitGraph, 'RepositoryIcon')
/** A conversation that starts from another's history. */
export const ForkIcon = icon(GitFork, 'ForkIcon')
export const CommitIcon = icon(GitCommitHorizontal, 'CommitIcon')
/** A review pass over the working tree. */
export const ReviewIcon = icon(ScanSearch, 'ReviewIcon')
/** Bringing the tracked branch's commits down into the checkout. */
export const PullIcon = icon(ArrowDownToLine, 'PullIcon')
/** Sending the branch's commits up to its remote. */
export const PushIcon = icon(ArrowUpFromLine, 'PushIcon')
/** Reading the remotes without touching the working tree. */
export const FetchIcon = icon(CloudDownload, 'FetchIcon')
/** Two histories joined. */
export const MergeIcon = icon(GitMerge, 'MergeIcon')
/** The forge's compare page for a branch, and a pull request itself. */
export const PullRequestIcon = icon(GitPullRequestArrow, 'PullRequestIcon')
export const PullRequestDraftIcon = icon(GitPullRequestDraft, 'PullRequestDraftIcon')
export const PullRequestClosedIcon = icon(GitPullRequestClosed, 'PullRequestClosedIcon')
/** An issue on the forge — the open dot GitHub itself draws. */
export const IssueIcon = icon(CircleDot, 'IssueIcon')
/** A comment on the forge. */
export const CommentIcon = icon(MessageSquare, 'CommentIcon')
/** A branch wound back to an earlier commit. */
export const ResetIcon = icon(RotateCcw, 'ResetIcon')
/** One checkout of the repository — a folder the repository is open in. */
export const WorktreeIcon = icon(FolderGit2, 'WorktreeIcon')
/** The main checkout as a place to work — "Local", beside a worktree. */
export const LocalIcon = icon(Laptop, 'LocalIcon')
/** A worktree's branch brought back to the main checkout. */
export const HomeIcon = icon(House, 'HomeIcon')
/** A worktree pinned against pruning. */
export const LockIcon = icon(Lock, 'LockIcon')
export const UnlockIcon = icon(LockOpen, 'UnlockIcon')
/** Dropping the records of worktrees whose folders are gone. */
export const PruneIcon = icon(Eraser, 'PruneIcon')
/** A folder relocated, git's record of it following along. */
export const MoveFolderIcon = icon(FolderInput, 'MoveFolderIcon')

// --- What the agent does ---------------------------------------------------

export const TerminalIcon = icon(SquareTerminal, 'TerminalIcon')
/** Work that keeps running after the turn that started it. */
export const BackgroundIcon = icon(Activity, 'BackgroundIcon')
/** A tool call. */
export const ToolIcon = icon(Wrench, 'ToolIcon')
/** The agent's own reasoning. */
export const BrainIcon = icon(Brain, 'BrainIcon')
/** An agent — a runtime, or a sub-agent it spawned. */
export const AgentIcon = icon(Bot, 'AgentIcon')
/** A skill, or anything else the agent is handed to work with. */
export const SparkIcon = icon(Sparkle, 'SparkIcon')
export const GlobeIcon = icon(Globe, 'GlobeIcon')
/** A conversation, as a thing to find and open. */
export const SessionIcon = icon(MessageSquare, 'SessionIcon')
/** Marking up a page: a comment left on the thing it is about. */
export const AnnotateIcon = icon(MessageSquarePlus, 'AnnotateIcon')
/** A block of context the desk composed and put on a message — never a plugin's. */
export const NoteIcon = icon(StickyNote, 'NoteIcon')
/** The objective a session is working towards. */
export const GoalIcon = icon(Target, 'GoalIcon')
/** A plan or task list the agent is working through. */
export const PlanIcon = icon(ListTodo, 'PlanIcon')
export const TodoDoneIcon = icon(CircleCheck, 'TodoDoneIcon')
export const TodoActiveIcon = icon(CircleDot, 'TodoActiveIcon')
export const TodoPendingIcon = icon(Circle, 'TodoPendingIcon')
/** A plain list item, with no state to report. */
export const BulletIcon = icon(Dot, 'BulletIcon')
export const RetryIcon = icon(RotateCw, 'RetryIcon')
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
export const ExtensionIcon = icon(Blocks, 'ExtensionIcon')
export const HookIcon = icon(Webhook, 'HookIcon')
export const ResourceIcon = icon(Database, 'ResourceIcon')
/** The cross-agent library: what exists on this machine, and who can load it. */
export const LibraryIcon = icon(LibraryBig, 'LibraryIcon')
/** A model route. */
export const RouteIcon = icon(Route, 'RouteIcon')
export const PresetIcon = icon(Bookmark, 'PresetIcon')
export const ShieldIcon = icon(ShieldCheck, 'ShieldIcon')

// --- Account ---------------------------------------------------------------

export const UserIcon = icon(User, 'UserIcon')
/** Key bindings — the keys themselves, never a single modifier's symbol. */
export const KeyboardIcon = icon(Keyboard, 'KeyboardIcon')
export const SignInIcon = icon(LogIn, 'SignInIcon')
export const SignOutIcon = icon(LogOut, 'SignOutIcon')
export const KeyIcon = icon(KeyRound, 'KeyIcon')

// --- Workspace menu ---------------------------------------------------------

/** Keep a project at the top of the list. */
export const PinIcon = icon(Pin, 'PinIcon')
export const UnpinIcon = icon(PinOff, 'UnpinIcon')

// --- Controls and lists ----------------------------------------------------

/** A model — the thing that thinks. */
export const ModelIcon = icon(Cpu, 'ModelIcon')
/** Acting directly, without a plan first. */
export const ZapIcon = icon(Zap, 'ZapIcon')
/** A permission that widens what the agent may do without asking. */
export const ShieldAlertIcon = icon(ShieldAlert, 'ShieldAlertIcon')
/** No guard at all — full access. */
export const ShieldOffIcon = icon(ShieldOff, 'ShieldOffIcon')
/** Every agent, or every one of something. */
export const EveryoneIcon = icon(Users, 'EveryoneIcon')
/** The plan strip's roster token — everyone else's standing on quota, at a glance. */
export const RosterIcon = icon(CircleGauge, 'RosterIcon')
/** The conversations of one workspace working together — the board and the channel. */
export const TeamIcon = icon(UsersRound, 'TeamIcon')
/** Fold every group in a list shut, and open every one again. */
export const CollapseAllIcon = icon(ChevronsDownUp, 'CollapseAllIcon')
export const ExpandAllIcon = icon(ChevronsUpDown, 'ExpandAllIcon')
/**
 * The two ways to show the same list, as a pair.
 *
 * Both live in view switchers where the alternative is the other one, so the
 * glyphs have to be distinguishable at 13px side by side — a grid of four
 * squares against a ruled table. Anything subtler than that reads as one
 * button pressed twice.
 */
export const CardsIcon = icon(LayoutGrid, 'CardsIcon')
export const MatrixIcon = icon(Table2, 'MatrixIcon')
export const RowsLooseIcon = icon(Rows3, 'RowsLooseIcon')
export const RowsTightIcon = icon(Rows4, 'RowsTightIcon')
export const ClockIcon = icon(Clock, 'ClockIcon')
/** What a plan has left, and what it cost. */
export const UsageIcon = icon(Gauge, 'UsageIcon')
/** Money already spent, as distinct from a plan's remaining share. */
export const CostIcon = icon(CircleDollarSign, 'CostIcon')
export const SortNameIcon = icon(ArrowDownAZ, 'SortNameIcon')
/** What happened, in order. */
export const HistoryIcon = icon(History, 'HistoryIcon')
export const ServerIcon = icon(Server, 'ServerIcon')
export const DownloadIcon = icon(Download, 'DownloadIcon')
/** Approved, and for the rest of the session too. */
export const CheckAllIcon = icon(CheckCheck, 'CheckAllIcon')
/** A written summary. */
export const SummaryIcon = icon(FileText, 'SummaryIcon')
/** The whole transcript. */
export const TranscriptIcon = icon(ScrollText, 'TranscriptIcon')
export const ThemeSystemIcon = icon(Monitor, 'ThemeSystemIcon')
export const ThemeLightIcon = icon(Sun, 'ThemeLightIcon')
export const ThemeDarkIcon = icon(Moon, 'ThemeDarkIcon')
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
export const DesktopIcon = icon(AppWindow, 'DesktopIcon')
/** Chromium's own inspector, on the page in the pane. */
export const DevToolsIcon = icon(Code, 'DevToolsIcon')
/** The same thing, in a full window. */
export const ExpandIcon = icon(Maximize2, 'ExpandIcon')
/** Back from the full pane area to the split it came from. */
export const RestoreIcon = icon(Minimize2, 'RestoreIcon')
/** Read the repository again; distinct from RetryIcon, which re-runs a thing that failed. */
export const RefreshIcon = icon(RefreshCw, 'RefreshIcon')
/** A git tag, on history rows and the refs rail. */
export const TagIcon = icon(Tag, 'TagIcon')
/** A stash: work set aside in a stack. */
export const StashIcon = icon(SquareStack, 'StashIcon')
/** Away from this window, to whatever the OS opens links with. */
export const ExternalIcon = icon(ExternalLink, 'ExternalIcon')
/** A picture of the page, saved. */
export const CameraIcon = icon(Camera, 'CameraIcon')
