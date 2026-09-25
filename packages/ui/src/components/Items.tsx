import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import type {
  AgentItem,
  AssistantMessageItem,
  CommandItem,
  CompactionItem,
  ErrorItem,
  FileChangeItem,
  ImageItem,
  ItemStatus,
  NoticeItem,
  PlanItem,
  PublicationItem,
  ReasoningItem,
  ReviewItem,
  SessionId,
  SubagentItem,
  ToolCallItem,
  UserMessageItem,
  WebSearchItem,
} from '@harnessdesk/protocol'

import { stripAnsi } from '../lib/ansi'
import { ActionError, Button, ChangeStats, CodeBlock, CopyButton, Lightbox, TurnItem, type LightboxImage } from '../design'
import { instant } from '../lib/clock'
import { openExternal } from '../lib/desktop'
import { formatTokensWithFloor } from '../lib/context-usage'
import { countFileChange, wholeFileOf } from '../lib/diff'
import {
  describedTitle,
  isSilentReasoning,
  PATH_KEYS,
  reasoningBody,
  reasoningHeadline,
  shellCommandOf as toolCallCommandOf,
  toolCallVerb,
  type ToolCallVerb,
} from '../lib/group-items'
import { editOf } from '../lib/handoff'
import { findTodos, type Todo } from '../lib/todos'
import { effectiveItemStatus } from '../lib/turn-view'
import {
  shellCommandOf,
  shortestUniquePathLabels,
  toolSentence,
  toolSentences,
  wireNameOf,
  type ToolSentenceDetail,
} from '../lib/tool-names'
import { DiffView } from './Diff'
import {
  AgentIcon,
  AlertIcon,
  BrainIcon,
  ChevronIcon,
  TeamIcon,
  DiffIcon,
  ExternalIcon,
  FileIcon,
  GlobeIcon,
  ImageIcon,
  InfoIcon,
  PencilIcon,
  PlanIcon,
  SearchIcon,
  SparkIcon,
  TerminalIcon,
  TodoActiveIcon,
  TodoDoneIcon,
  TodoPendingIcon,
  ToolIcon,
} from './Icons'
import { useActiveSession, useSnapshot, useStore } from '../state/context'
import { isAgentMessageSource, splitContext, wrapContext } from '../lib/context-envelope'
import { drawsAsImage, isRenderableImageUrl, unshownImage } from '../lib/images'
import { Markdown } from './Markdown'
import { Publication } from './Publication'
import styles from './Items.module.css'

/**
 * Transcript item views.
 *
 * One component per `AgentItem` variant. Nothing here knows which runtime
 * produced the item, which is the whole point of the protocol layer — a Codex
 * command card and a future Claude command card are the same card.
 */

/**
 * An image part: drawn when an `<img>` can draw it, and named when it can't,
 * including when it turns out not to draw after all, a link that 404s or leads
 * to something other than an image (review of #187, round 2).
 */
const ResultImage = ({ url, mimeType }: { url: string; mimeType?: string | undefined }) => {
  const [failed, setFailed] = useState(false)
  return !failed && drawsAsImage(url, mimeType) ? (
    <img src={url} alt="" style={{ maxWidth: '100%' }} onError={() => setFailed(true)} />
  ) : (
    <CodeBlock output={unshownImage(url, mimeType)} />
  )
}

/**
 * Absolute paths are mostly the user's home directory repeated on every row.
 * Showing them relative to the session's working directory is both shorter and
 * closer to how people talk about their own files.
 */
const relativeTo = (path: string, root: string | undefined): string => {
  if (!root) return path
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

const EMPTY_SENTENCES = new Map<string, string>()

/** A path argument shared by the adapters' read, search, and edit tools. */
const pathArgument = (args: unknown): string | null => {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  const record = args as Record<string, unknown>
  return (
    PATH_KEYS.map((key) => record[key]).find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    ) ?? null
  )
}

/** A file path named by one step, when the row can speak about one file. */
const filePathOf = (item: AgentItem): string | null => {
  if (item.type === 'fileChange') {
    return item.changes.length === 1 ? (item.changes[0]?.path ?? null) : null
  }
  if (item.type === 'command') {
    const action = item.actions.length === 1 ? item.actions[0] : undefined
    return action?.type === 'read' ? action.path : null
  }
  if (item.type !== 'toolCall') return null
  const verb = toolCallVerb(item)
  return verb === 'read' || verb === 'fileChange' ? pathArgument(item.args) : null
}

const StepPathLabels = createContext<ReadonlyMap<string, string> | null>(null)
const ItemRegister = createContext<'light' | undefined>(undefined)

/** File labels shared by every step in one turn, including folded groups. */
export const StepNameScope = ({
  items,
  root,
  children,
}: {
  items: readonly AgentItem[]
  root?: string
  children: ReactNode
}) => {
  const labels = useMemo(
    () =>
      shortestUniquePathLabels(
        items.flatMap((item) => {
          const path = filePathOf(item)
          return path ? [relativeTo(path, root)] : []
        }),
      ),
    [items, root],
  )
  return <StepPathLabels.Provider value={labels}>{children}</StepPathLabels.Provider>
}

const fileLabel = (
  path: string,
  root: string | undefined,
  labels: ReadonlyMap<string, string> | null,
): string => {
  const relative = relativeTo(path, root)
  return labels?.get(relative) ?? shortestUniquePathLabels([relative]).get(relative) ?? relative
}

/**
 * How long a step took, when that is worth a glance. Sub-second steps — and
 * the `0ms` some backends report for anything they did not time — say nothing
 * a person would act on, so they stay out of the row.
 */
const formatDuration = (ms: number | undefined): string | null => {
  if (ms === undefined || ms === null || ms < 1000) return null
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m`
}

const StatusMark = ({ status }: { status: ItemStatus }) => {
  if (status === 'inProgress') return <span className="flex-none size-3 rounded-full border-[1.5px] border-(--hd-border-emphasis) border-t-(--hd-accent) animate-[hd-spin_0.7s_linear_infinite]" />
  if (status === 'completed') return null
  if (status === 'failed') return <span className="text-(--hd-danger-ink) text-xs font-medium">failed</span>
  return (
    <span className="flex-none inline-flex items-center h-(--hd-icon-target-sm) px-(--hd-space-1-5) rounded-full text-xs font-medium uppercase bg-(--hd-muted) text-(--hd-muted-foreground) data-[status=declined]:line-through" data-status={status}>
      declined
    </span>
  )
}

/** Shared disclosure row used by commands, tools, reasoning, and file changes. */
const Row = ({
  icon,
  title,
  hoverTitle,
  meta,
  status,
  defaultOpen = false,
  bareBody = false,
  children,
}: {
  icon: ReactNode
  title: ReactNode
  hoverTitle?: string
  meta?: ReactNode
  status?: ItemStatus
  defaultOpen?: boolean
  /** The child draws its own plate, so the disclosure body supplies alignment only. */
  bareBody?: boolean
  children?: ReactNode
}) => {
  const [open, setOpen] = useState(defaultOpen)
  const register = useContext(ItemRegister)
  const collapsible = Boolean(children)

  return (
    <div className={`${styles.row}${register === 'light' ? '' : ' rounded-(--hd-radius) bg-(--hd-card) shadow-(--hd-hairline)'}`}>
      <Button
        type="button" variant="quiet" size="row" className={styles.rowHeader}
        onClick={() => collapsible && setOpen((value) => !value)}
        aria-expanded={collapsible ? open : undefined}
        style={collapsible ? undefined : { cursor: 'default' }}
        title={hoverTitle}
      >
        <span className={`${styles.rowIcon} text-(--hd-muted-foreground)`}>{icon}</span>
        <span className={`${styles.rowTitle} font-(family-name:--hd-font-family) text-base leading-(--hd-line) text-(--hd-foreground)`}>{title}</span>
        <span className={`${styles.rowMeta} text-xs text-(--hd-muted-foreground) tabular-nums`}>
          {meta}
          {status && <StatusMark status={status} />}
        </span>
        {collapsible && (
          <ChevronIcon
            className={`${styles.chevron} text-(--hd-muted-foreground)`}
            size={14}
            {...(open ? { 'data-open': '' } : {})}
          />
        )}
      </Button>
      {collapsible && open && (
        <div className={bareBody ? styles.rowBodyBare : `${styles.rowBody} pt-(--hd-space-2) px-(--hd-space-3) pb-(--hd-space-3) ps-(--hd-space-6)`}>{children}</div>
      )}
    </div>
  )
}

/**
 * The images a user message carried, as the transcript can show them: a data
 * URL or an https link renders; a path on the runtime's own disk (`localImage`,
 * from Codex's CLI) or an unrenderable URL is named instead.
 */
const imagesOf = (item: UserMessageItem): readonly { readonly index: number; readonly image: LightboxImage }[] => {
  const found: { readonly index: number; readonly image: LightboxImage }[] = []
  item.content.forEach((part, index) => {
    if (part.type === 'image' && isRenderableImageUrl(part.url)) {
      found.push({ index, image: { url: part.url, name: part.name ?? `Image ${found.length + 1}` } })
    }
  })
  return found
}

/** "7:57 PM" today, "Aug 22, 7:57 PM" otherwise — nothing for a stamp that is not one. */
const sentAt = (at: number | undefined): string | null => {
  const stamp = instant(at)
  if (stamp === null) return null
  const date = new Date(stamp)
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const today = new Date()
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  return sameDay ? time : `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

/**
 * Under a sent message: when, copy, edit. Edit puts the text back in the
 * composer as the draft — the quickest way to ask again, differently.
 */

/** A failed copy, said the way the app says every failure it cannot fix for you. */
const useCopyFailed = () => {
  const store = useStore()
  return () => store.notice('warning', 'Could not copy to the clipboard.')
}

const UserMessageFooter = ({ text, at }: { text: string; at: number | undefined }) => {
  const when = sentAt(at)
  const copyFailed = useCopyFailed()
  return (
    <div className={`${styles.userFooter} min-h-(--hd-chip-h) pr-(--hd-space-0-5)`}>
      {when && <span className={"mr-(--hd-space-1-5) text-xs text-(--hd-muted-foreground) tabular-nums"}>{when}</span>}
      <CopyButton text={text} label="Copy this message" onError={copyFailed} />
      <Button
        variant="quiet" size="icon-xs"
        title="Edit — puts this message in the composer"
        aria-label="Edit this message"
        onClick={() =>
          window.dispatchEvent(new CustomEvent('harnessdesk:compose', { detail: { text, replace: true } }))
        }
      >
        <PencilIcon size={13} />
      </Button>
    </div>
  )
}

const WEB_URL = /\bhttps?:\/\/[^\s<>"'`]+/gi

/** Sentence punctuation belongs to the sentence, not to the link before it. */
const splitUrlEnd = (candidate: string): { readonly url: string; readonly suffix: string } => {
  let end = candidate.length
  while (end > 0 && /[.,;:!?]/.test(candidate[end - 1] ?? '')) end -= 1
  const pairs: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' }
  while (end > 0) {
    const close = candidate[end - 1] ?? ''
    const open = pairs[close]
    if (!open) break
    const body = candidate.slice(0, end)
    if (body.split(close).length <= body.split(open).length) break
    end -= 1
  }
  return { url: candidate.slice(0, end), suffix: candidate.slice(end) }
}

/**
 * The one exception to literal message text is a web address: it is a door,
 * so it says where it goes and opens through the desktop boundary.
 */
const linkedText = (text: string): ReactNode[] => {
  const parts: ReactNode[] = []
  let cursor = 0
  for (const match of text.matchAll(WEB_URL)) {
    const start = match.index ?? cursor
    const whole = match[0] ?? ''
    const { url, suffix } = splitUrlEnd(whole)
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      continue
    }
    parts.push(text.slice(cursor, start))
    parts.push(
      <a
        key={`${start}-${url}`}
        className={styles.bubbleLink}
        href={url}
        title={url}
        onClick={(event) => {
          event.preventDefault()
          openExternal(url)
        }}
      >
        <ExternalIcon size={12} />
        <span>{parsed.host}{parsed.pathname === '/' ? '' : parsed.pathname}</span>
      </a>,
    )
    parts.push(suffix)
    cursor = start + whole.length
  }
  parts.push(text.slice(cursor))
  return parts
}

/** Literal message text, folded only when its rendered box exceeds twelve lines. */
const UserText = ({ text }: { text: string }) => {
  const body = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowed, setOverflowed] = useState(false)

  useLayoutEffect(() => {
    const node = body.current
    if (!node || expanded) return
    const measure = (): void => setOverflowed(node.scrollHeight > node.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [expanded, text])

  return (
    <div className={`${styles.bubble} py-(--hd-space-2-5) px-(--hd-space-4) rounded-(--hd-radius-xl) bg-(--hd-muted) text-base leading-(--hd-line)`}>
      <div ref={body} className={`${styles.bubbleText} ${!expanded ? 'max-h-[calc(var(--hd-line)*12)] overflow-hidden' : ''}`}>
        {linkedText(text)}
      </div>
      {overflowed && (
        <Button variant="quiet" size="sm" className={`${styles.bubbleToggle} mt-(--hd-space-1)`} onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show less' : 'Show all'}
        </Button>
      )}
    </div>
  )
}

const UserMessage = ({ item, sentAt }: { item: UserMessageItem; sentAt?: number }) => {
  const raw = item.content
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n')
  const { injections, text } = splitContext(raw)
  const attachments = item.content.filter((part) => part.type !== 'text')
  const images = imagesOf(item)
  const singleImage = images.length === 1
  const [preview, setPreview] = useState<number | null>(null)

  return (
    <div className={`${styles.userRow} py-(--hd-space-3) pb-(--hd-space-1)`}>
      {(injections.length > 0 || (item.context?.length ?? 0) > 0) && (
        <div style={{ alignSelf: 'stretch' }}>
          {injections.map((injection, index) => (
            <ContextInjection key={index} label={injection.label} text={injection.text} />
          ))}
          {/* Peeled off by the adapter, because the shape of the wrapper is
              the agent's, not ours. See `peelContext`. */}
          {item.context?.map((block, index) => (
            <ContextInjection
              key={`agent-${index}`}
              label={block.label}
              text={block.text}
              origin="agent"
            />
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className={styles.images} role="list" aria-label="Attached images">
          {images.map(({ index, image }, position) => (
            <Button
              key={index}
              type="button"
              role="listitem"
              variant="quiet" size="content" className={styles.imageTile}
              title={image.name}
              aria-label={`View ${image.name}`}
              onClick={() => setPreview(position)}
            >
              <img className={`${styles.imageThumb} ${singleImage ? 'h-auto max-h-[280px]' : 'h-full'}`} src={image.url} alt={image.name} loading="lazy" draggable={false} />
            </Button>
          ))}
        </div>
      )}
      {preview != null && (
        <Lightbox images={images.map((entry) => entry.image)} index={preview} onClose={() => setPreview(null)} />
      )}
      {attachments.length > images.length && (
        <div className={styles.attachments}>
          {attachments.map((part, index) => {
            if (part.type === 'image' && isRenderableImageUrl(part.url)) return null
            if (part.type === 'skill') {
              // A skill is an instruction bundle, not a file: badging it as one
              // would hide that the agent was handed a procedure to follow.
              return (
                <span key={index} className={`${styles.chip} h-(--hd-chip-h) px-(--hd-space-2) rounded-full bg-(--hd-accent-dim) text-(--hd-primary-ink) text-xs`} title={part.path}>
                  <SparkIcon size={12} />
                  {part.name}
                  <span className="flex-none inline-flex items-center h-(--hd-icon-target-sm) px-(--hd-space-1-5) rounded-full text-xs font-medium uppercase bg-(--hd-muted) text-(--hd-muted-foreground)">skill</span>
                </span>
              )
            }
            if (part.type === 'mention') {
              return (
                <span key={index} className={`${styles.chip} h-(--hd-chip-h) px-(--hd-space-2) rounded-full bg-(--hd-accent-dim) text-(--hd-primary-ink) text-xs`} title={part.path}>
                  <FileIcon size={12} />
                  {part.name}
                </span>
              )
            }
            // A path on the runtime's machine, or a URL the transcript will
            // not load: the name is all there is to show.
            const name =
              part.type === 'localImage'
                ? part.path.split('/').pop() ?? part.path
                : part.type === 'image'
                  ? part.name ?? 'Image'
                  : 'Image'
            return (
              <span key={index} className={`${styles.chip} h-(--hd-chip-h) px-(--hd-space-2) rounded-full bg-(--hd-accent-dim) text-(--hd-primary-ink) text-xs`} title={part.type === 'localImage' ? part.path : undefined}>
                <ImageIcon size={12} />
                {name}
              </span>
            )
          })}
        </div>
      )}
      {text.length > 0 && <UserText text={text} />}
      {text.length > 0 && <UserMessageFooter text={text} at={item.startedAt ?? sentAt} />}
    </div>
  )
}

/**
 * A dim single row naming context that was folded into the turn, expandable to
 * show exactly what the model was given.
 */
/**
 * Context that travelled with a message but nobody typed.
 *
 * Two origins, one affordance. `app` is our own envelope — a plugin's
 * context, plan mode — which we wrapped on the way out. `agent` is the
 * agent's own client composing state into the prompt before it sent it:
 * Codex's in-app browser, Claude Code's reminders. The wording has to keep
 * them apart, because "Context added" over something Codex wrote would put
 * our name on someone else's text.
 */
const ContextInjection = ({
  label,
  text,
  origin = 'app',
}: {
  label: string
  text: string
  origin?: 'app' | 'agent'
}) => {
  const [open, setOpen] = useState(false)
  const snapshot = useSnapshot()
  // A third origin: another conversation's message, routed by the host. It
  // must never read as the user's words — the row says who sent it before it
  // says anything else. But the label alone is text anyone can type, so the
  // badge is granted only when this exact envelope appears in a team
  // channel the host itself wrote: the claim is checked against host-owned
  // state, never inferred from prose. An unverifiable lookalike renders as
  // ordinary context — failing closed loses a badge, not a boundary.
  const fromAgent =
    isAgentMessageSource(label) &&
    (() => {
      const envelope = wrapContext(label, text)
      for (const team of snapshot.teams.values()) {
        for (const entry of team.channel) {
          if (entry.kind === 'message' && entry.from.kind === 'agent' && entry.envelope === envelope) {
            return true
          }
        }
      }
      return false
    })()
  return (
    <div
      className={`${styles.injectionWrap} rounded-(--hd-radius) ${open ? 'bg-(--hd-card) shadow-(--hd-hairline) overflow-hidden' : ''} ${fromAgent ? 'shadow-[inset_2px_0_0_0_var(--hd-primary)] bg-(--hd-primary-muted)' : ''}`}
      {...(open ? { 'data-open': '' } : {})}
      {...(fromAgent ? { 'data-peer': '' } : {})}
    >
      <Button type="button" variant={fromAgent ? 'quiet' : 'row'} size="row" className={styles.injection} onClick={() => setOpen((value) => !value)}>
        <ChevronIcon size={11} {...(open ? { 'data-open': '' } : {})} className={`${styles.chevron} text-(--hd-muted-foreground)`} />
        {fromAgent ? <TeamIcon size={12} /> : <FileIcon size={12} />}
        {fromAgent ? 'From another agent' : origin === 'agent' ? 'Sent with your message' : 'Context added'}
        <span className="text-xs font-medium text-(--hd-secondary-foreground)">{fromAgent ? label.replace(/^Message from /, '') : label}</span>
      </Button>
      {/* The body is prose, not terminal output: a git note, a hand-off
          packet, a plugin's summary — all written in Markdown by whoever
          composed them. A <pre> here printed that authoring as source. */}
      {open && (
        <div className="py-(--hd-space-2) px-(--hd-space-3) pb-(--hd-space-2-5) border-t border-(--hd-border) max-h-[380px] overflow-auto [&>div]:text-sm [&>div]:leading-(--hd-line) [&>div]:text-(--hd-secondary-foreground) [&_h1]:text-base [&_h2]:text-base [&_h3]:text-sm [&_h4]:text-sm">
          <Markdown text={text} />
        </div>
      )}
    </div>
  )
}

const AssistantMessage = ({
  item,
  streaming,
}: {
  item: AssistantMessageItem
  streaming: boolean
}) => (
  <div className={`py-(--hd-space-1-5) ${item.phase === 'commentary' ? 'text-(--hd-secondary-foreground)' : ''}`}>
    <Markdown text={item.text} />
    {streaming && <span className={`${styles.caret} h-[1.15em] ms-(--hd-space-0-5) rounded-full bg-(--hd-accent) animate-[hd-blink_1.1s_steps(2,start)_infinite]`} />}
    {/* No actions here: they sit once at the end of the turn (TurnTail), for
        the whole answer, rather than under every paragraph of it. */}
  </div>
)

const Reasoning = ({ item }: { item: ReasoningItem }) => {
  const headline = reasoningHeadline(item)
  const body = reasoningBody(item)
  // Nothing to read: no line. The fold it sits in already says the agent
  // was working, and while it runs the live line says "Thinking".
  if (isSilentReasoning(item)) return null
  return (
    <Row
      icon={<BrainIcon size={14} />}
      title={headline}
      meta={item.content.length > 0 ? 'reasoning' : undefined}
    >
      {body.length > 0 && (
        <div className="py-(--hd-space-2) px-(--hd-space-3) pb-(--hd-space-3) text-base leading-(--hd-line) text-(--hd-secondary-foreground)">
          {body.map((paragraph, index) => (
            <p key={index} className={styles.reasoningSummary}>
              {paragraph}
            </p>
          ))}
        </div>
      )}
    </Row>
  )
}

/** A command's transcript sentence and the path disclosed on hover. */
const describeCommand = (
  item: CommandItem,
  root: string | undefined,
  labels: ReadonlyMap<string, string> | null,
): { readonly sentence: string; readonly path?: string } => {
  const first = item.actions[0]
  if (!first || item.actions.length !== 1) {
    return {
      sentence: toolSentence('command', EMPTY_SENTENCES, {
        kind: 'command',
        command: shellCommandOf(item.command),
      }),
    }
  }
  switch (first.type) {
    case 'read':
      return {
        sentence: toolSentence('read', EMPTY_SENTENCES, {
          kind: 'read',
          target: fileLabel(first.path, root, labels),
        }),
        path: relativeTo(first.path, root),
      }
    case 'listFiles':
      return {
        sentence: toolSentence('list', EMPTY_SENTENCES, {
          kind: 'list',
          ...(first.path ? { target: relativeTo(first.path, root) } : {}),
        }),
        ...(first.path ? { path: relativeTo(first.path, root) } : {}),
      }
    case 'search':
      return first.query
        ? {
            sentence: toolSentence('search', EMPTY_SENTENCES, {
              kind: 'search',
              pattern: first.query,
              ...(first.path ? { folder: relativeTo(first.path, root) } : {}),
            }),
            ...(first.path ? { path: relativeTo(first.path, root) } : {}),
          }
        : {
            sentence: toolSentence('search', EMPTY_SENTENCES),
            ...(first.path ? { path: relativeTo(first.path, root) } : {}),
          }
    case 'unknown':
      return {
        sentence: toolSentence('command', EMPTY_SENTENCES, {
          kind: 'command',
          command: shellCommandOf(item.command),
        }),
      }
  }
}

const Command = ({ item, root }: { item: CommandItem; root?: string }) => {
  const copyFailed = useCopyFailed()
  const labels = useContext(StepPathLabels)
  const described = describeCommand(item, root, labels)
  return (
    <Row
      icon={<TerminalIcon size={14} />}
      title={described.sentence}
      hoverTitle={described.path}
      meta={
        <>
          {item.origin === 'user' && <span className="flex-none inline-flex items-center h-(--hd-icon-target-sm) px-(--hd-space-1-5) rounded-full text-xs font-medium uppercase bg-(--hd-muted) text-(--hd-muted-foreground)">you</span>}
          {formatDuration(item.durationMs)}
        </>
      }
      status={effectiveItemStatus(item)}
      defaultOpen={item.status === 'inProgress'}
      bareBody
    >
      <CodeBlock
        command={shellCommandOf(item.command)}
        output={item.output ? stripAnsi(item.output) : item.status === 'inProgress' ? '' : '(no output)'}
        exitCode={item.exitCode}
        onCopyError={copyFailed}
      />
    </Row>
  )
}

const FileChange = ({ item, root }: { item: FileChangeItem; root?: string }) => {
  const labels = useContext(StepPathLabels)
  const totals = item.changes.reduce(
    (accumulator, change) => {
      const counts = countFileChange(change)
      return {
        added: accumulator.added + counts.added,
        removed: accumulator.removed + counts.removed,
      }
    },
    { added: 0, removed: 0 },
  )
  const only = item.changes.length === 1 ? item.changes[0] : undefined
  const created = item.changes.length > 0 && item.changes.every((change) => change.kind.type === 'add')
  const target = only
    ? fileLabel(only.path, root, labels)
    : `${item.changes.length} files`

  return (
    <Row
      icon={<DiffIcon size={14} />}
      title={toolSentence(created ? 'write' : 'edit', EMPTY_SENTENCES, {
        kind: created ? 'write' : 'edit',
        target,
      })}
      hoverTitle={only ? relativeTo(only.path, root) : undefined}
      meta={
        <ChangeStats added={totals.added} removed={totals.removed} />
      }
      status={item.status}
      defaultOpen={item.changes.length === 1}
      bareBody
    >
      {only ? (
        <DiffView diff={only.diff} wholeFile={wholeFileOf(only.kind.type)} inline />
      ) : (
        <div className={styles.fileList}>
          {item.changes.map((change) => (
            <FileEntry
              key={change.path}
              change={change}
              root={root}
            />
          ))}
        </div>
      )}
    </Row>
  )
}

const FileEntry = ({
  change,
  root,
}: {
  change: FileChangeItem['changes'][number]
  root?: string
}) => {
  const [open, setOpen] = useState(false)
  // The rule the view below draws by — the whole file, added or removed, unless
  // the payload is a diff — so the badge is what is drawn. See `countFileChange`.
  const counts = countFileChange(change)
  const added = counts.added

  return (
    <div className="border-t border-(--hd-border) first:border-t-0">
      <Button type="button" variant="quiet" size="content" className={styles.fileHeader} onClick={() => setOpen((v) => !v)}>
        <ChevronIcon className={`${styles.chevron} text-(--hd-muted-foreground)`} size={12} {...(open ? { 'data-open': '' } : {})} />
        <span className={`${styles.filePath} font-(family-name:--hd-font-code) text-sm`} title={change.path}>
          {relativeTo(change.path, root)}
        </span>
        <ChangeStats added={added} removed={counts.removed} />
      </Button>
      {open && (
        <div className="px-(--hd-space-2-5) pb-(--hd-space-2-5)">
          <DiffView diff={change.diff} wholeFile={wholeFileOf(change.kind.type)} inline />
        </div>
      )}
    </div>
  )
}

/**
 * A unified diff hiding inside a tool result, wherever the vendor nested it.
 * Only named keys are trusted — a string that merely looks diff-ish is not
 * one — so an agent's structured edit result renders as a real diff instead
 * of JSON with escaped newlines.
 */
const findDiff = (value: unknown): string | null => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findDiff(entry)
      if (found) return found
    }
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  for (const key of ['diffString', 'unifiedDiff', 'diff', 'patch']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.includes('\n')) return candidate
  }
  for (const entry of Object.values(record)) {
    const found = findDiff(entry)
    if (found) return found
  }
  return null
}

const TodoListView = ({ todos }: { todos: readonly Todo[] }) => (
  <ul className="m-0 py-(--hd-space-2) px-(--hd-space-3) list-none flex flex-col gap-(--hd-space-0-5)">
    {todos.map((todo, index) => (
      <li
        key={index}
        className={`flex gap-(--hd-space-2) items-start text-base leading-(--hd-line) ${todo.done ? 'text-(--hd-muted-foreground) line-through' : ''} ${todo.active ? 'text-(--hd-foreground) font-medium' : ''}`}
      >
        <span className={`flex-none inline-flex items-center w-3.5 h-(--hd-line) ${todo.active ? 'text-(--hd-accent)' : 'text-(--hd-muted-foreground)'}`} aria-hidden="true">
          {todo.done ? <TodoDoneIcon size={13} /> : todo.active ? <TodoActiveIcon size={13} /> : <TodoPendingIcon size={13} />}
        </span>
        {todo.label}
      </li>
    ))}
  </ul>
)

/** The one argument worth showing beside a call's title, shortened to the repo. */
const headlineArg = (args: unknown, root: string | undefined): string | null => {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  const record = args as Record<string, unknown>
  for (const key of ['file_path', 'path', 'filePath', 'command', 'query', 'url', 'pattern']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      const shown = relativeTo(value, root)
      return shown.length > 64 ? `${shown.slice(0, 61)}…` : shown
    }
  }
  return null
}

/**
 * Arguments as labelled values, not a JSON dump. Structure stays visible for
 * nested values, but the common case — a path, a command, a flag — reads as
 * a sentence fragment rather than syntax.
 */
const ArgsView = ({ args, root }: { args: unknown; root?: string }) => {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return args === null || args === undefined ? null : (
      <pre data-role="json" className="m-0 py-(--hd-space-2-5) px-(--hd-space-3) max-h-[300px] overflow-auto font-(family-name:--hd-font-code) text-xs leading-(--hd-line-sm) whitespace-pre-wrap text-(--hd-secondary-foreground)">{JSON.stringify(args, null, 2)}</pre>
    )
  }
  const argTodos = findTodos(args)
  if (argTodos) return <TodoListView todos={argTodos} />
  const entries = Object.entries(args as Record<string, unknown>)
  if (entries.length === 0) return null
  return (
    <dl className="m-0 py-(--hd-space-2) px-(--hd-space-3) grid grid-cols-[max-content_minmax(0,1fr)] gap-x-(--hd-space-2-5) gap-y-(--hd-space-0-5) items-baseline border-b border-(--hd-border)">
      {entries.map(([key, value]) => (
        <div key={key} className={styles.argRow}>
          <dt className="text-xs text-(--hd-muted-foreground) font-(family-name:--hd-font-code)">{key}</dt>
          <dd className="m-0 min-w-0 max-h-[132px] overflow-auto font-(family-name:--hd-font-code) text-xs leading-(--hd-line-sm) whitespace-pre-wrap break-anywhere text-(--hd-secondary-foreground)">
            {typeof value === 'string' ? relativeTo(value, root) : JSON.stringify(value, null, 1)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** The glyph for what a tool call was, not which tool it went through. */
const VERB_ICON: Record<ToolCallVerb, typeof ToolIcon> = {
  command: TerminalIcon,
  read: FileIcon,
  search: SearchIcon,
  fileChange: PencilIcon,
  toolCall: ToolIcon,
}

/**
 * A step, as a sentence.
 *
 * The wire name is what you need to write a permission rule against, so it
 * belongs inside the opened step and on the Permissions page. In the row it
 * would be a symbol where a reader wants a history, so the row says what the
 * plugin says its tool does.
 *
 * A call that carries its own description — Claude Code's shell tool asks
 * for one on every call — reads as *that* sentence, set in the text face, the
 * way the agent's own app titles the step. The command it ran is not glued
 * to the sentence: it is the first thing inside the opened row, under a
 * prompt mark, with the output beneath. A sentence in monospace with a
 * command hanging off it is a tool call dressed as a shell line, and the
 * reader learns a CLI that does not exist.
 */
const ToolCall = ({ item, root }: { item: ToolCallItem; root?: string }) => {
  const copyFailed = useCopyFailed()
  const snapshot = useSnapshot()
  const labels = useContext(StepPathLabels)
  const sentences = useMemo(() => toolSentences(snapshot.contributions), [snapshot.contributions])
  const described = describedTitle(item)
  const verb = toolCallVerb(item)
  // Null when the adapter's "tool name" was already the sentence above.
  const wire = wireNameOf(item.tool)
  const record =
    typeof item.args === 'object' && item.args !== null && !Array.isArray(item.args)
      ? (item.args as Record<string, unknown>)
      : null
  const path = pathArgument(item.args)
  const relativePath = path ? relativeTo(path, root) : null
  const target = path ? fileLabel(path, root, labels) : null
  const command = toolCallCommandOf(item)
  const commandOutputParts = command ? item.result?.map((part) => {
    if (part.type === 'text') return stripAnsi(part.text)
    if (part.type === 'json' && typeof part.value === 'string') return stripAnsi(part.value)
    return null
  }) : undefined
  const commandOutput = commandOutputParts && commandOutputParts.length > 0
    && commandOutputParts.every((part): part is string => part !== null)
    ? commandOutputParts.join('\n')
    : undefined
  const pattern = [record?.['pattern'], record?.['query']].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  )
  const detail: ToolSentenceDetail | undefined = (() => {
    switch (verb) {
      case 'read':
        return target ? { kind: 'read', target } : undefined
      case 'search':
        return pattern
          ? {
              kind: 'search',
              pattern,
              ...(relativePath ? { folder: relativePath } : {}),
            }
          : undefined
      case 'fileChange':
        if (!target) return undefined
        return { kind: 'fileChange', target }
      case 'command':
        return command ? { kind: 'command', command: shellCommandOf(command) } : undefined
      case 'toolCall':
        return undefined
    }
  })()
  const said = toolSentence(item.tool, sentences, detail)
  // An MCP tool's server is the one word that says whose tool ran.
  const label = described ?? (item.source.kind === 'mcp' ? `${item.source.server} · ${said}` : said)
  // A call the lookup has no grammar for carries no object in its sentence,
  // so its one telling argument — the page, the query — stands beside it.
  const argument = !described && !detail ? headlineArg(item.args, root) : null
  const headline = argument && !label.includes(argument.split('/').pop() ?? argument) ? argument : null
  const change = verb === 'fileChange' ? editOf(item) : null
  const counts = change ? countFileChange(change) : null
  const Icon = VERB_ICON[verb]

  return (
    <Row
      icon={<Icon size={14} />}
      title={
        headline ? (
          <>
            {label}
            <span className="ms-(--hd-space-2) text-sm font-(family-name:--hd-font-code) text-(--hd-muted-foreground) font-normal">{headline}</span>
          </>
        ) : (
          label
        )
      }
      hoverTitle={relativePath ?? undefined}
      meta={
        counts ? (
          <ChangeStats added={counts.added} removed={counts.removed} />
        ) : (
          formatDuration(item.durationMs)
        )
      }
      status={effectiveItemStatus(item)}
      defaultOpen={Boolean(change) || item.status === 'inProgress'}
      bareBody={Boolean(change) || Boolean(command)}
    >
      {wire && <div data-role="wire-name" className="py-(--hd-space-2) px-(--hd-space-3) border-b border-(--hd-border) font-(family-name:--hd-font-code) text-xs leading-(--hd-line-sm) break-anywhere text-(--hd-muted-foreground)">{wire}</div>}
      {item.error ? (
        <CodeBlock output={stripAnsi(item.error)} />
      ) : change ? (
        <DiffView diff={change.diff} wholeFile={wholeFileOf(change.kind.type)} inline />
      ) : (
        <>
          {/* A shell call opens onto the command it ran, the way a command
              step does; every other call lists its arguments. The
              description is the row's title and the background flag is the
              panel's business, so neither is repeated here as a field. */}
          {command ? (
            <CodeBlock command={shellCommandOf(command)} output={commandOutput} onCopyError={copyFailed} />
          ) : (
            <ArgsView args={item.args} root={root} />
          )}
          {commandOutput === undefined && item.result?.map((part, index) => {
            if (part.type === 'text') {
              return (
                <CodeBlock key={index} output={stripAnsi(part.text)} />
              )
            }
            if (part.type === 'image') {
              // An <img> only for what one can draw: a PDF in one was a broken
              // image (#79), and so was a link that declares a PDF (review,
              // round 1). Anything else is named, with its type and size.
              return <ResultImage key={index} url={part.url} mimeType={part.mimeType} />
            }
            // A JSON part carrying a bare string is output, not a document.
            // Encoding it turns every newline into a literal \n and every
            // quote into \" — the shell transcript arrives as its own source.
            if (typeof part.value === 'string') {
              return (
                <CodeBlock key={index} output={stripAnsi(part.value)} />
              )
            }
            const todos = findTodos(part.value)
            if (todos) {
              return <TodoListView key={index} todos={todos} />
            }
            const diff = findDiff(part.value)
            if (diff) {
              return (
                <div key={index} className="px-(--hd-space-2-5) pb-(--hd-space-2-5)">
                  <DiffView diff={diff} inline />
                </div>
              )
            }
            return (
              <pre key={index} data-role="json" className="m-0 py-(--hd-space-2-5) px-(--hd-space-3) max-h-[300px] overflow-auto font-(family-name:--hd-font-code) text-xs leading-(--hd-line-sm) whitespace-pre-wrap break-anywhere text-(--hd-secondary-foreground)">
                {JSON.stringify(part.value, null, 2)}
              </pre>
            )
          })}
        </>
      )}
    </Row>
  )
}

const ACTION_LABEL: Record<string, string> = {
  spawn: 'Started a sub-agent',
  send: 'Sent to a sub-agent',
  wait: 'Waiting on a sub-agent',
  cancel: 'Cancelled a sub-agent',
}

const Subagent = ({ item }: { item: SubagentItem }) => {
  const store = useStore()
  // The sub-agent is the same agent's conversation; opening it needs that
  // runtime named, not the active one (see AppStore.openSession).
  const session = useActiveSession()
  const title =
    ACTION_LABEL[item.action] ??
    `Sub-agent ${item.action}`

  return (
    <Row
      icon={<AgentIcon size={14} />}
      title={
        item.members.length === 1
          ? `${title}: ${item.members[0]?.nickname ?? 'agent'}`
          : `${title} · ${item.members.length}`
      }
      // What it ran on and what it cost, where the runtime says. A delegation
      // has its own model and its own bill; those are the two facts that make
      // it not a tool row, and the row header is where they belong.
      meta={
        [item.model, item.usage && item.usage.totalTokens > 0 ? `${formatTokensWithFloor(item.usage)} tokens` : null]
          .filter(Boolean)
          .join(' · ') || undefined
      }
      status={item.status}
      defaultOpen={item.status === 'inProgress'}
    >
      {item.prompt && <CodeBlock output={item.prompt} />}
      {item.members.length > 0 && (
        <div className={styles.fileList}>
          {item.members.map((member) => {
            // A child with a conversation of its own can be opened; one whose
            // id is only the handle of the call that spawned it cannot, and a
            // button that fails after the press is worse than a row.
            const openable = member.openable !== false
            return (
              <Button
                key={member.sessionId}
                type="button"
                variant="quiet" size="content" className={styles.fileHeader}
                {...(openable
                  ? {
                      title: `Open ${member.sessionId}`,
                      onClick: () => {
                        if (session) void store.openSession(member.sessionId as SessionId, { runtime: session.runtime })
                      },
                    }
                  : {
                      disabled: true,
                      title: 'This sub-agent ran inside the conversation; it has none of its own to open.',
                    })}
              >
                <AgentIcon size={12} />
                <span className={`${styles.filePath} font-(family-name:--hd-font-code) text-sm`}>
                  {member.nickname ?? member.sessionId.slice(0, 8)}
                </span>
                {member.role && <span className="flex-none inline-flex items-center h-(--hd-icon-target-sm) px-(--hd-space-1-5) rounded-full text-xs font-medium uppercase bg-(--hd-muted) text-(--hd-muted-foreground)">{member.role}</span>}
                {member.state && <span className="flex-none inline-flex items-center h-(--hd-icon-target-sm) px-(--hd-space-1-5) rounded-full text-xs font-medium uppercase bg-(--hd-muted) text-(--hd-muted-foreground)">{member.state}</span>}
                {member.usage && member.usage.totalTokens > 0 && (
                  <span
                    className="flex-none inline-flex items-center h-(--hd-icon-target-sm) px-(--hd-space-1-5) rounded-full text-xs font-medium uppercase bg-(--hd-muted) text-(--hd-muted-foreground)"
                    {...(member.usage.outputExact === false
                      ? { title: 'At least this much: the child was still streaming when its last count was taken.' }
                      : {})}
                  >
                    {formatTokensWithFloor(member.usage)} tokens
                  </span>
                )}
              </Button>
            )
          })}
        </div>
      )}
    </Row>
  )
}

const WebSearch = ({ item }: { item: WebSearchItem }) => (
  <Row
    icon={<GlobeIcon size={14} />}
    title={toolSentence('web_search', EMPTY_SENTENCES, { kind: 'webSearch', query: item.query })}
    status={item.status}
  />
)

const Plan = ({ item }: { item: PlanItem }) => {
  const steps = item.text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s*/, '').trim())
    .filter(Boolean)

  return (
    <Row icon={<PlanIcon size={14} />} title="Plan" defaultOpen>
      <ol className="m-0 py-(--hd-space-2) px-(--hd-space-3) pb-(--hd-space-3) list-none flex flex-col gap-(--hd-space-0-5)">
        {steps.map((step, index) => (
          <li key={index} className={`${styles.planStep} py-(--hd-space-0-5) text-base leading-(--hd-line)`} data-status="pending">
            <span className={`${styles.planBullet} h-3.5 mt-(--hd-space-1) rounded-full border-[1.5px] border-(--hd-border-heavy)`} />
            {step}
          </li>
        ))}
      </ol>
    </Row>
  )
}

const Compaction = (_: { item: CompactionItem }) => (
  <div className={`${styles.marker} py-(--hd-space-2-5) text-(--hd-muted-foreground) text-xs`}>
    <span className={`${styles.markerLine} h-px bg-(--hd-border-strong)`} />
    Earlier messages were summarised to free up context
    <span className={`${styles.markerLine} h-px bg-(--hd-border-strong)`} />
  </div>
)

/**
 * The runtime's own housekeeping on one dim line — a command it ran for us, a
 * background task reporting back, a turn that was stopped. Quiet on purpose:
 * it is the setting for what follows, not something to read.
 */
const Notice = ({ item }: { item: NoticeItem }) => (
  <div className={`${styles.notice} min-h-(--hd-chip-h) py-(--hd-space-0-5) text-(--hd-muted-foreground) text-xs leading-(--hd-line-sm)`}>
    <InfoIcon size={12} className={`${styles.noticeIcon} mt-(--hd-space-1)`} />
    <span>{item.text}</span>
  </div>
)

const Review = ({ item }: { item: ReviewItem }) => (
  <div className={`${styles.marker} py-(--hd-space-2-5) text-(--hd-muted-foreground) text-xs`}>
    <span className={`${styles.markerLine} h-px bg-(--hd-border-strong)`} />
    {item.phase === 'entered' ? `Started review: ${item.review}` : 'Finished review'}
    <span className={`${styles.markerLine} h-px bg-(--hd-border-strong)`} />
  </div>
)

const ErrorRow = ({ item }: { item: ErrorItem }) => (
  <ActionError>{item.message}</ActionError>
)

const ImageRow = ({ item }: { item: ImageItem }) => (
  <Row
    icon={<ImageIcon size={14} />}
    title={item.generated ? 'Generated an image' : item.path.split('/').pop() ?? 'Image'}
  />
)

export const ItemView = ({
  item,
  root,
  streaming = false,
  sentAt,
  register,
}: {
  item: AgentItem
  /** Session working directory, used to shorten absolute paths. */
  root?: string
  streaming?: boolean
  /** When the turn began, for a user message that does not carry its own time. */
  sentAt?: number
  /** The compact turn-work register passes its density explicitly. */
  register?: 'light'
}) => {
  const body = ((): ReactNode => {
    switch (item.type) {
      case 'userMessage':
        return <UserMessage item={item} sentAt={sentAt} />
      case 'assistantMessage':
        return <AssistantMessage item={item} streaming={streaming} />
      case 'reasoning':
        return <Reasoning item={item} />
      case 'command':
        return <Command item={item} root={root} />
      case 'fileChange':
        return <FileChange item={item} root={root} />
      case 'toolCall':
        return <ToolCall item={item} root={root} />
      case 'subagent':
        return <Subagent item={item} />
      case 'webSearch':
        return <WebSearch item={item} />
      case 'plan':
        return <Plan item={item} />
      case 'image':
        return <ImageRow item={item} />
      case 'compaction':
        return <Compaction item={item} />
      case 'notice':
        return <Notice item={item} />
      case 'review':
        return <Review item={item} />
      case 'publication':
        return <Publication item={item as PublicationItem} root={root} />
      case 'error':
        return <ErrorRow item={item} />
    }
  })()

  if (body === null) return null
  return (
    <ItemRegister.Provider value={register}>
      <TurnItem register={register} className={styles.item}>{body}</TurnItem>
    </ItemRegister.Provider>
  )
}
