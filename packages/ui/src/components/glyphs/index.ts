/**
 * The animated glyphs: the sixty-nine Lucide icons that have a motion, drawn
 * by lucide-animated (https://lucide-animated.com, MIT, pqoqubbw — see
 * THIRD_PARTY_NOTICES.md) and played by `Animated`.
 *
 * Vendored source, one file per icon, changed in the same four ways each time
 * so a fresh vendor knows what to re-apply:
 *
 *   One frame.        `Glyph` / `MotionGlyph` own the `<svg>`, its box and its
 *                     stroke; a file keeps only its paths and its motion.
 *   No handle.        The upstream `startAnimation`/`stopAnimation` ref, its
 *                     two mouse handlers and the wrapper `<div>` are gone: what
 *                     triggers a glyph is `animate.tsx`, once, for all of them.
 *   Our style.        Single quotes and no semicolons, like the rest of the app.
 *   Controlled.       `controls` arrives as a prop from `Animated` instead of
 *                     being made inside each file.
 *
 * Fetch's `cloud-download` variants use our `normal` / `animate` names and
 * rest at zero offset, matching its plain drawing before the lazy swap.
 * Everything else — the paths, the variants, the timings — is upstream's.
 * Components import the icon by meaning from `../Icons`, never from here.
 */

export { ActivityGlyph } from './activity'
export { ArchiveGlyph } from './archive'
export { ArrowUpGlyph } from './arrow-up'
export { AtSignGlyph } from './at-sign'
export { BellGlyph } from './bell'
export { BlocksGlyph } from './blocks'
export { BookTextGlyph } from './book-text'
export { BookmarkGlyph } from './bookmark'
export { BotGlyph } from './bot'
export { BrainGlyph } from './brain'
export { CalendarDaysGlyph } from './calendar-days'
export { CheckCheckGlyph } from './check-check'
export { CheckGlyph } from './check'
export { ChevronDownGlyph } from './chevron-down'
export { ChevronLeftGlyph } from './chevron-left'
export { ChevronRightGlyph } from './chevron-right'
export { ChevronsDownUpGlyph } from './chevrons-down-up'
export { ChevronsUpDownGlyph } from './chevrons-up-down'
export { CircleCheckGlyph } from './circle-check'
export { CircleDollarSignGlyph } from './circle-dollar-sign'
export { CircleGaugeGlyph } from './circle-gauge'
export { ClockGlyph } from './clock'
export { CloudDownloadGlyph } from './cloud-download'
export { CopyGlyph } from './copy'
export { CpuGlyph } from './cpu'
export { DownloadGlyph } from './download'
export { ExternalLinkGlyph } from './external-link'
export { EyeOffGlyph } from './eye-off'
export { FileTextGlyph } from './file-text'
export { FolderGit2Glyph } from './folder-git-2'
export { FolderInputGlyph } from './folder-input'
export { FolderOpenGlyph } from './folder-open'
export { FolderXGlyph } from './folder-x'
export { GaugeGlyph } from './gauge'
export { GitBranchGlyph } from './git-branch'
export { GitCommitHorizontalGlyph } from './git-commit-horizontal'
export { GitForkGlyph } from './git-fork'
export { GitGraphGlyph } from './git-graph'
export { GitMergeGlyph } from './git-merge'
export { GripVerticalGlyph } from './grip-vertical'
export { HandGlyph } from './hand'
export { HistoryGlyph } from './history'
export { KeyboardGlyph } from './keyboard'
export { LoaderCircleGlyph } from './loader-circle'
export { LockOpenGlyph } from './lock-open'
export { LockGlyph } from './lock'
export { Maximize2Glyph } from './maximize-2'
export { MessageSquarePlusGlyph } from './message-square-plus'
export { MessageSquareGlyph } from './message-square'
export { PlusGlyph } from './plus'
export { RefreshCwGlyph } from './refresh-cw'
export { RotateCcwGlyph } from './rotate-ccw'
export { RotateCwGlyph } from './rotate-cw'
export { RouteGlyph } from './route'
export { SearchGlyph } from './search'
export { ServerGlyph } from './server'
export { SettingsGlyph } from './settings'
export { ShieldCheckGlyph } from './shield-check'
export { ShrinkGlyph } from './shrink'
export { SlidersHorizontalGlyph } from './sliders-horizontal'
export { SquareStackGlyph } from './square-stack'
export { UserGlyph } from './user'
export { UsersRoundGlyph } from './users-round'
export { UsersGlyph } from './users'
export { WebhookGlyph } from './webhook'
export { WorkflowGlyph } from './workflow'
export { WrenchGlyph } from './wrench'
export { XGlyph } from './x'
export { ZapGlyph } from './zap'
export { Animated } from './animate'
export type { GlyphProps } from './glyph'
