import {
  Fragment,
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
  ToolResultContent,
  UserMessageItem,
  WebSearchItem,
} from '@harnessdesk/protocol'

import { stripAnsi } from '../lib/ansi'
import {
  ActionError,
  Bubble,
  BubbleContent,
  Button,
  Card,
  CardViewport,
  ChangeStats,
  Chip,
  CodeBlock,
  CodeText,
  ComposerChip,
  CopyButton,
  DisclosureChevron,
  Dot,
  KeyValue,
  KeyValueRow,
  Lightbox,
  ListRowDetail,
  Message,
  MessageContent,
  MessageFooter,
  Note,
  Separator,
  Spinner,
  Text,
  TextMark,
  TurnItem,
  type LightboxImage,
} from '../design'
import { instant } from '../lib/clock'
import { openExternal } from '../lib/desktop'
import { formatTokensWithFloor } from '../lib/context-usage'
import { countFileChange, wholeFileOf } from '../lib/diff'
import {
  describedTitle,
  isSilentReasoning,
  PATH_KEYS,
  reasoningBody,
  SHELL_TOOLS,
  reasoningHeadline,
  shellCommandOf as toolCallCommandOf,
  toolCallVerb,
  type ToolCallVerb,
} from '../lib/group-items'
import { editOf } from '../lib/handoff'
import { findTodos, planOf, type Todo } from '../lib/todos'
import { readToolResult } from '../lib/tool-result'
import { effectiveItemStatus } from '../lib/turn-view'
import {
  bareToolName,
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

/** A plain word for a sub-agent's own state, never the bridge's wire value. */
const MEMBER_STATE_WORDS: Readonly<Record<string, string>> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
}

/** A chip's own word, sentence case — never a phrase's own lowercase start. */
const capitalize = (text: string): string => (text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text)

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
  if (status === 'inProgress') return <Spinner size="sm" tone="brand" />
  if (status === 'completed') return null
  if (status === 'failed') return <Text role="meta" tone="danger">failed</Text>
  return <Chip tone="neutral" size="sm">Declined</Chip>
}

/**
 * Shared disclosure row used by commands, tools, reasoning, and file changes.
 *
 * An opened step hangs its body under its own title, one way: `ListRowDetail`
 * `inset="title"`, the same part a list uses to hang a row's own detail under
 * it, at the step under a title rather than a list's edge or inner line. The
 * body only places what it holds, and each thing in it — a code plate, a
 * diff, a list of arguments, a line of thought — is a design part that owns
 * its own box.
 *
 * `inset="title"` carries no end padding of its own (see `list-row.tsx`).
 * The end edge is the register's, never the body's kind: in a plain row every
 * body reaches the row's right edge; in a bordered card every body keeps the
 * card's inner edge. A plate, an argument panel, a result block and a line of
 * reasoning end at the same place either way. `bareBody` is purely a
 * *vertical* choice: a plate already carries its own visible edge right under
 * the header, so it keeps the inset's own tight step; text has none of its
 * own, so it takes the wider one and the gap between several parts.
 */
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
  /** The child draws its own plate, so the body only spaces it vertically. */
  bareBody?: boolean
  children?: ReactNode
}) => {
  const [open, setOpen] = useState(defaultOpen)
  const register = useContext(ItemRegister)
  const collapsible = Boolean(children)

  const inner = (
    <>
      <Button
        type="button" variant="quiet" size="row" className={styles.rowHeader}
        onClick={() => collapsible && setOpen((value) => !value)}
        aria-expanded={collapsible ? open : undefined}
        cursor={collapsible ? 'pointer' : 'default'}
        title={hoverTitle}
      >
        <Text role="meta" className={styles.rowIcon}>{icon}</Text>
        <Text role="prose" className={styles.rowTitle}>{title}</Text>
        <Text as="span" role="meta" numeric className={styles.rowMeta}>
          {meta}
          {status && <StatusMark status={status} />}
        </Text>
        {collapsible && <DisclosureChevron open={open} size="lg" />}
      </Button>
      {collapsible && open && (
        <ListRowDetail
          inset="title"
          within={register === 'light' ? 'row' : 'card'}
          className={bareBody ? undefined : 'grid gap-(--hd-space-2) pt-(--hd-space-2) pb-(--hd-space-3)'}
        >
          {children}
        </ListRowDetail>
      )}
    </>
  )

  return register === 'light' ? (
    <div className={styles.row}>{inner}</div>
  ) : (
    // Card's own default gap-4/py-4 is sized for a section's boxed content,
    // not a dense conversation row: without `spacing="flush"` every tool row
    // here grows from its intended ~30px to ~62px.
    <Card variant="plate" spacing="flush" className={styles.row}>{inner}</Card>
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
    <MessageFooter align="end" className="gap-(--hd-space-0-5)">
      {when && <Text as="span" role="meta" numeric className="mr-(--hd-space-1-5)">{when}</Text>}
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
    </MessageFooter>
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
    <Bubble variant="secondary">
      <BubbleContent ref={body} clampLines={12} expanded={expanded}>
        {linkedText(text)}
      </BubbleContent>
      {overflowed && (
        <Button
          variant="quiet" size="sm"
          className={`${styles.bubbleToggle} mt-(--hd-space-1)`}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : 'Show all'}
        </Button>
      )}
    </Bubble>
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
    /* `Message`'s own transcript rhythm: 12px above, 4px below — an explicit
       option rather than something `align="end"` did silently, since the
       room's `ChannelMessage` also aligns "start" and keeps a different look. */
    <Message align="end" rhythm="transcript">
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
                <ComposerChip key={index} tone="brand" title={part.path}>
                  <SparkIcon size={12} />
                  {part.name}
                  <Chip tone="neutral" size="sm">Skill</Chip>
                </ComposerChip>
              )
            }
            if (part.type === 'mention') {
              return (
                <ComposerChip key={index} tone="brand" title={part.path}>
                  <FileIcon size={12} />
                  {part.name}
                </ComposerChip>
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
              <ComposerChip key={index} tone="brand" {...(part.type === 'localImage' ? { title: part.path } : {})}>
                <ImageIcon size={12} />
                {name}
              </ComposerChip>
            )
          })}
        </div>
      )}
      {text.length > 0 && (
        // The surface and its footer, in the same MessageContent the room's
        // own body and trouble line stand in — genuine structure, not a
        // second box. `items-end` keeps both pinned to the row's own right
        // edge; the gap replaces the row's own, so the rhythm holds.
        <MessageContent className="items-end gap-(--hd-space-1-5)">
          <UserText text={text} />
          <UserMessageFooter text={text} at={item.startedAt ?? sentAt} />
        </MessageContent>
      )}
    </Message>
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
      className={styles.injectionWrap}
      {...(open ? { 'data-open': '' } : {})}
      {...(fromAgent ? { 'data-peer': '' } : {})}
    >
      <Button type="button" variant="row" size="row" className={styles.injection} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <DisclosureChevron open={open} size="xs" />
        {fromAgent ? <TeamIcon size={12} /> : <FileIcon size={12} />}
        {fromAgent ? (
          <Text role="navigation" tone="brand">From another agent</Text>
        ) : origin === 'agent' ? 'Sent with your message' : 'Context added'}
        <Text role="meta" ink="secondary">{fromAgent ? label.replace(/^Message from /, '') : label}</Text>
      </Button>
      {/* The body is prose, not terminal output: a git note, a hand-off
          packet, a plugin's summary — all written in Markdown by whoever
          composed them. A <pre> here printed that authoring as source. It
          opens the way a step does: the row stays a line, and what it holds
          stands in a plate under it. */}
      {open && (
        <Card variant="plate" spacing="compact" className={styles.injectionBody}>
          <CardViewport size="lines" maxHeight={380}>
            <Text as="div" role="muted">
              <Markdown chat text={text} />
            </Text>
          </CardViewport>
        </Card>
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
  /* Same rhythm option as `UserMessage` above: 6px each way, this row's own
     value for the transcript's answer. */
  <Message align="start" rhythm="transcript">
    <Bubble variant="ghost">
      <Text as="div" role="prose" {...(item.phase === 'commentary' ? { ink: 'secondary' as const } : {})}>
        <Markdown text={item.text} />
        {/* Still writing: the system's running mark, the one the inspector's
            running rows and the header's status wear. */}
        {streaming && (
          <span className={styles.caret} aria-label="Still writing">
            <Dot state="signin" pulse />
          </span>
        )}
        {/* No actions here: they sit once at the end of the turn (TurnTail), for
            the whole answer, rather than under every paragraph of it. */}
      </Text>
    </Bubble>
  </Message>
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
    >
      {body.length > 0 && (
        <Text as="div" role="prose" ink="secondary">
          {body.map((paragraph, index) => (
            <p key={index} className={styles.reasoningSummary}>
              {paragraph}
            </p>
          ))}
        </Text>
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
          {item.origin === 'user' && <Chip tone="neutral" size="sm">You</Chip>}
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
          {item.changes.map((change, index) => (
            <FileEntry
              key={change.path}
              change={change}
              root={root}
              divider={index > 0}
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
  divider,
}: {
  change: FileChangeItem['changes'][number]
  root?: string
  /* Hunks and files alike are told apart by the app's one hairline, never
     drawn above the first (`ChangesReview`'s own file list keeps the rule). */
  divider: boolean
}) => {
  const [open, setOpen] = useState(false)
  // The rule the view below draws by — the whole file, added or removed, unless
  // the payload is a diff — so the badge is what is drawn. See `countFileChange`.
  const counts = countFileChange(change)
  const added = counts.added

  return (
    <section>
      {divider && <Separator />}
      <Button type="button" variant="quiet" size="content" className={styles.fileHeader} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <DisclosureChevron open={open} size="sm" />
        <Text role="muted" className={styles.filePath} title={change.path}>
          {relativeTo(change.path, root)}
        </Text>
        <ChangeStats added={added} removed={counts.removed} />
      </Button>
      {open && <DiffView diff={change.diff} wholeFile={wholeFileOf(change.kind.type)} inline />}
    </section>
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

/**
 * A plan's steps, drawn the way the Tasks panel draws them: the step's mark
 * set in its line (`TextMark`), a finished one struck and stepped back
 * (`Text done`), and the one in progress at the subject weight. A step's own
 * priority — ACP's, not every source has one — sits in a chip on the same
 * line rather than a second one under it (rule 9).
 *
 * Exported so a turn's own ACP plan, which carries no tool call of its own
 * to hang this off, still draws as the same list — one definition of what a
 * checklist looks like, whichever kind of update set it.
 */
export const TodoListView = ({ todos }: { todos: readonly Todo[] }) => (
  <ul className={styles.list}>
    {todos.map((todo, index) => (
      <Text as="li" role="prose" key={index} className={styles.listItem}>
        <TextMark role="prose">
          {todo.done ? <TodoDoneIcon size={12} /> : todo.active ? <TodoActiveIcon size={12} /> : <TodoPendingIcon size={12} />}
        </TextMark>
        <Text role={todo.active ? 'subject' : 'prose'} done={todo.done}>{todo.label}</Text>
        {todo.priority && <Chip tone="neutral" size="sm">{todo.priority}</Chip>}
      </Text>
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
    return args === null || args === undefined ? null : <CodeBlock output={JSON.stringify(args, null, 2)} />
  }
  const argTodos = findTodos(args)
  if (argTodos) return <TodoListView todos={argTodos} />
  const entries = Object.entries(args as Record<string, unknown>)
  if (entries.length === 0) return null
  return (
    <KeyValue variant="panel" data-role="arguments" className={styles.args}>
      {entries.map(([key, value]) => (
        <KeyValueRow key={key} variant="panel" label={<CodeText>{key}</CodeText>}>
          <CardViewport size="lines" maxHeight={132}>
            <CodeText className={styles.argValue}>
              {typeof value === 'string' ? relativeTo(value, root) : JSON.stringify(value, null, 1)}
            </CodeText>
          </CardViewport>
        </KeyValueRow>
      ))}
    </KeyValue>
  )
}

/**
 * One part of a tool's result, drawn the way its shape earns: text and image
 * parts are already what a top-level result carries, so a content array
 * found inside a `json` part recurses through this same function rather
 * than a second copy of the same two cases.
 *
 * The recognition itself — which runtime's envelope this is — is
 * `readToolResult`'s job, kept free of rendering so it can be run straight
 * over stored transcripts. This function only decides how each kind draws.
 */
/** Whether a result part draws anything at all, by the same rules `resultPartView` follows. */
const resultPartDraws = (part: ToolResultContent): boolean => {
  if (part.type === 'text') return part.text.trim() !== ''
  if (part.type === 'image') return true
  if (typeof part.value === 'string') return part.value.trim() !== ''
  const reading = readToolResult(part.value)
  if (reading.kind === 'output') return reading.text.trim() !== ''
  if (reading.kind === 'blocks') return reading.blocks.some((block) => block.type === 'image' || block.text.trim() !== '')
  return true
}

const resultPartView = (part: ToolResultContent, key: string): ReactNode => {
  // Nothing to show draws nothing, in any of a result's shapes (see the
  // `{output}` case below).
  if (part.type === 'text' && part.text.trim() === '') return null
  if (part.type === 'json' && typeof part.value === 'string' && part.value.trim() === '') return null
  if (part.type === 'text') {
    return <CodeBlock key={key} output={stripAnsi(part.text)} />
  }
  if (part.type === 'image') {
    // An <img> only for what one can draw: a PDF in one was a broken image
    // (#79), and so was a link that declares a PDF (review, round 1).
    // Anything else is named, with its type and size.
    return <ResultImage key={key} url={part.url} mimeType={part.mimeType} />
  }
  // A JSON part carrying a bare string is output, not a document. Encoding it
  // turns every newline into a literal \n and every quote into \" — the
  // shell transcript arrives as its own source.
  if (typeof part.value === 'string') {
    return <CodeBlock key={key} output={stripAnsi(part.value)} />
  }
  const reading = readToolResult(part.value)
  if (reading.kind === 'blocks') {
    // Some runtimes (Claude Code's Agent tool among them) answer a call with
    // an MCP content array rather than the plain value the call produced.
    // Unwrapped, its blocks draw exactly as a top-level result would; still
    // wrapped, a person sees the array's own `"type": "text"` punctuation.
    return <Fragment key={key}>{reading.blocks.map((block, index) => resultPartView(block, `${key}-${index}`))}</Fragment>
  }
  if (reading.kind === 'command') {
    // A command's own record (Antigravity's shell tool, among others) draws
    // as the same plate a `command` step does — the exit line included,
    // through the plate's own mechanism rather than a second one here.
    return <CodeBlock key={key} command={reading.command} output={reading.output ? stripAnsi(reading.output) : '(no output)'} exitCode={reading.exitCode} />
  }
  // A result with nothing in it draws nothing: an empty plate under a step
  // reads as output that failed to load, when there was simply none.
  if (reading.kind === 'output' && reading.text.trim() === '') return null
  if (reading.kind === 'output') {
    // A bare `{output, isError}` pair (DeepSeek, among others): the text is
    // drawn the same way `item.error` already is, whichever it says.
    return <CodeBlock key={key} output={stripAnsi(reading.text)} />
  }
  const todos = findTodos(part.value)
  if (todos) return <TodoListView key={key} todos={todos} />
  const diff = findDiff(part.value)
  if (diff) return <DiffView key={key} diff={diff} inline />
  // Structured output is output: the same plate as a text result.
  return <CodeBlock key={key} output={JSON.stringify(part.value, null, 2)} />
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
  const record =
    typeof item.args === 'object' && item.args !== null && !Array.isArray(item.args)
      ? (item.args as Record<string, unknown>)
      : null
  const path = pathArgument(item.args)
  const relativePath = path ? relativeTo(path, root) : null
  const target = path ? fileLabel(path, root, labels) : null
  const command = toolCallCommandOf(item)
  const recordsCommand = item.result?.some((part) => part.type === 'json' && readToolResult(part.value).kind === 'command') ?? false
  const commandOutputParts = command ? item.result?.map((part) => {
    if (part.type === 'text') return stripAnsi(part.text)
    if (part.type === 'json' && typeof part.value === 'string') return stripAnsi(part.value)
    // A shell call whose runtime wraps its output in `{output, isError}`:
    // the output belongs inside the command's own plate, not in a second box.
    if (part.type === 'json') {
      const reading = readToolResult(part.value)
      if (reading.kind === 'output') return stripAnsi(reading.text)
    }
    return null
  }) : undefined
  const commandOutput = commandOutputParts && commandOutputParts.length > 0
    && commandOutputParts.every((part): part is string => part !== null)
    ? commandOutputParts.join('\n')
    : undefined
  const pattern = [record?.['pattern'], record?.['query']].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  )
  // A plan tool is said as the plan it set, whatever the agent calls it —
  // `planOf`, the one reading of "did this call write to the plan", so this
  // sentence and the Tasks panel can never disagree about a call that
  // cleared the plan (`{todos: []}`) or wrote it under a different key.
  const plans = planOf(item.args) !== null
  const detail: ToolSentenceDetail | undefined = (() => {
    if (plans) return { kind: 'plan' }
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
  // An identifier that only repeats the sentence's own verb — an agent's
  // bare `read` under "Read README.md", its `bash` under the command, its
  // plan tool under "Updated the plan" — is dropped. Any other name stays,
  // because a person writes a permission rule against it: a plugin's
  // `read_file` or `search_text` keeps its row.
  const bare = bareToolName(item.tool).toLowerCase()
  const saysOnlyTheVerb =
    detail?.kind === 'plan' ||
    (detail?.kind === 'read' && bare === 'read') ||
    (detail?.kind === 'command' && SHELL_TOOLS.test(bare) && /^[a-z]+$/.test(bare))
  const wire = saysOnlyTheVerb ? null : wireNameOf(item.tool)
  // An MCP tool's server is the one word that says whose tool ran.
  const label = described ?? (item.source.kind === 'mcp' ? `${item.source.server} · ${said}` : said)
  // A call the lookup has no grammar for carries no object in its sentence,
  // so its one telling argument — the page, the query — stands beside it.
  const argument = !described && !detail ? headlineArg(item.args, root) : null
  const headline = argument && !label.includes(argument.split('/').pop() ?? argument) ? argument : null
  const change = verb === 'fileChange' ? editOf(item) : null
  const counts = change ? countFileChange(change) : null
  const Icon = plans ? PlanIcon : VERB_ICON[verb]
  const readsInFull =
    detail?.kind === 'read' && record !== null && Object.keys(record).every((key) => PATH_KEYS.includes(key))
  const argsShown = !(recordsCommand || readsInFull) && typeof item.args === 'object' && item.args !== null
    && (Array.isArray(item.args) || Object.keys(item.args).length > 0)
  const resultsShown = !(planOf(item.args) !== null && effectiveItemStatus(item) !== 'failed')
    && (item.result ?? []).some(resultPartDraws)
  /* A step with nothing to show under it does not offer to open: an opened
     card with an empty body reads as something that failed to load. */
  const bodyEmpty = !wire && !item.error && !change && !command && !argsShown && !resultsShown

  return (
    <Row
      icon={<Icon size={14} />}
      title={
        headline ? (
          <>
            {label}
            <Text role="muted" ink="muted" className={styles.headline}>{headline}</Text>
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
      bareBody={Boolean(change) || Boolean(command) || recordsCommand}
    >
      {bodyEmpty ? null : (<>
      {/* A plain wrapper, not `Text` itself: `Text` owns `data-role` for its
          own role, so a second meaning of the attribute has to sit outside it. */}
      {wire && (
        <div data-role="wire-name" className={styles.wire}>
          <Text as="span" role="meta">
            <CodeText>{wire}</CodeText>
          </Text>
        </div>
      )}
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
            <CodeBlock
              command={shellCommandOf(command)}
              output={commandOutput !== undefined && commandOutput.trim() === '' ? (item.status === 'inProgress' ? undefined : '(no output)') : commandOutput}
              onCopyError={copyFailed}
            />
          ) : recordsCommand || readsInFull ? null : (
            // A result that is its own command record already opens onto the
            // command it ran; its arguments would only say it again, with the
            // absolute folder it ran in beside it. So would a read whose only
            // argument is the file the title already names.
            <ArgsView args={item.args} root={root} />
          )}
          {/* A plan write that went through already shows the plan it wrote;
              the agent's echo of it ("Updated todo list: …") says it twice. */}
          {commandOutput === undefined &&
            !(planOf(item.args) !== null && effectiveItemStatus(item) !== 'failed') &&
            item.result?.map((part, index) => resultPartView(part, String(index)))}
        </>
      )}
      </>)}
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
                <Text role="muted" className={styles.filePath}>
                  {member.nickname ?? member.sessionId.slice(0, 8)}
                </Text>
                {member.role && <Chip tone="neutral" size="sm">{capitalize(member.role)}</Chip>}
                {member.state && <Chip tone="neutral" size="sm">{MEMBER_STATE_WORDS[member.state] ?? capitalize(member.state)}</Chip>}
                {member.usage && member.usage.totalTokens > 0 && (
                  <Chip
                    tone="neutral" size="sm"
                    {...(member.usage.outputExact === false
                      ? { title: 'At least this much: the child was still streaming when its last count was taken.' }
                      : {})}
                  >
                    {formatTokensWithFloor(member.usage)} tokens
                  </Chip>
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
      {/* The same list as a tool's todo list, every step still to do. */}
      <ol className={styles.list}>
        {steps.map((step, index) => (
          <Text as="li" role="prose" key={index} className={styles.listItem} data-status="pending">
            <TextMark role="prose"><TodoPendingIcon size={12} /></TextMark>
            <Text role="prose">{step}</Text>
          </Text>
        ))}
      </ol>
    </Row>
  )
}

/**
 * A line across the column with a word in it: where a conversation was
 * summarised, where a review began or ended. The rules are the system's
 * separator, the one the work fold's own head runs out to.
 */
const Marker = ({ children }: { children: ReactNode }) => (
  <div className={styles.marker}>
    <Separator className={styles.markerLine} />
    <Text role="meta">{children}</Text>
    <Separator className={styles.markerLine} />
  </div>
)

const Compaction = (_: { item: CompactionItem }) => (
  <Marker>Earlier messages were summarised to free up context</Marker>
)

/**
 * The runtime's own housekeeping on one dim line — a command it ran for us, a
 * background task reporting back, a turn that was stopped. Quiet on purpose:
 * it is the setting for what follows, not something to read.
 */
const Notice = ({ item }: { item: NoticeItem }) => (
  <Note ink="muted" icon={<InfoIcon size={12} className={styles.noticeIcon} />}>
    {item.text}
  </Note>
)

const Review = ({ item }: { item: ReviewItem }) => (
  <Marker>{item.phase === 'entered' ? `Started review: ${item.review}` : 'Finished review'}</Marker>
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
