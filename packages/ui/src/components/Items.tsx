import { useMemo, useState, type ReactNode } from 'react'

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
  ReasoningItem,
  ReviewItem,
  SessionId,
  SubagentItem,
  ToolCallItem,
  UserMessageItem,
  WebSearchItem,
} from '@harnessdesk/protocol'

import { stripAnsi } from '../lib/ansi'
import { instant } from '../lib/clock'
import { formatTokensWithFloor } from '../lib/context-usage'
import { countDrawn } from '../lib/diff'
import {
  describedTitle,
  isSilentReasoning,
  reasoningBody,
  reasoningHeadline,
  toolCallVerb,
  type ToolCallVerb,
} from '../lib/group-items'
import { findTodos, type Todo } from '../lib/todos'
import { shellCommandOf, toolSentence, toolSentences, wireNameOf } from '../lib/tool-names'
import { DiffView } from './Diff'
import {
  AgentIcon,
  AlertIcon,
  BrainIcon,
  CheckIcon,
  ChevronIcon,
  TeamIcon,
  CopyIcon,
  DiffIcon,
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
import { isRenderableImageUrl } from '../lib/images'
import { Lightbox, type LightboxImage } from './Lightbox'
import { Markdown } from './Markdown'
import styles from './Items.module.css'

/**
 * Transcript item views.
 *
 * One component per `AgentItem` variant. Nothing here knows which runtime
 * produced the item, which is the whole point of the protocol layer — a Codex
 * command card and a future Claude command card are the same card.
 */

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
  if (status === 'inProgress') return <span className={styles.spinner} />
  if (status === 'completed') return null
  return (
    <span className={styles.badge} data-status={status}>
      {status === 'failed' ? 'failed' : 'declined'}
    </span>
  )
}

/** Shared disclosure row used by commands, tools, reasoning, and file changes. */
const Row = ({
  icon,
  title,
  plainTitle = false,
  meta,
  status,
  defaultOpen = false,
  children,
}: {
  icon: ReactNode
  title: ReactNode
  plainTitle?: boolean
  meta?: ReactNode
  status?: ItemStatus
  defaultOpen?: boolean
  children?: ReactNode
}) => {
  const [open, setOpen] = useState(defaultOpen)
  const collapsible = Boolean(children)

  return (
    <div className={styles.row}>
      <button
        type="button"
        className={styles.rowHeader}
        onClick={() => collapsible && setOpen((value) => !value)}
        aria-expanded={collapsible ? open : undefined}
        style={collapsible ? undefined : { cursor: 'default' }}
      >
        <span className={styles.rowIcon}>{icon}</span>
        <span className={`${styles.rowTitle} ${plainTitle ? styles.rowTitlePlain : ''}`}>
          {title}
        </span>
        <span className={styles.rowMeta}>
          {meta}
          {status && <StatusMark status={status} />}
        </span>
        {collapsible && (
          <ChevronIcon
            className={styles.chevron}
            size={14}
            {...(open ? { 'data-open': '' } : {})}
          />
        )}
      </button>
      {collapsible && open && <div className={styles.rowBody}>{children}</div>}
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
const CopyButton = ({
  text,
  label,
  className,
}: {
  text: string
  label: string
  className?: string
}) => {
  const store = useStore()
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={className ?? styles.action}
      title="Copy"
      aria-label={label}
      onClick={() =>
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => store.notice('warning', 'Could not copy to the clipboard.'))
      }
    >
      {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
    </button>
  )
}

const UserMessageFooter = ({ text, at }: { text: string; at: number | undefined }) => {
  const when = sentAt(at)
  return (
    <div className={styles.userFooter}>
      {when && <span className={styles.userTime}>{when}</span>}
      <CopyButton text={text} label="Copy this message" />
      <button
        type="button"
        className={styles.action}
        title="Edit — puts this message in the composer"
        aria-label="Edit this message"
        onClick={() =>
          window.dispatchEvent(new CustomEvent('harnessdesk:compose', { detail: { text, replace: true } }))
        }
      >
        <PencilIcon size={13} />
      </button>
    </div>
  )
}

/**
 * A person's own words, with inline code shown as code.
 *
 * People type backticks meaning "this bit is a command", and every client they
 * use renders that — Codex included. We were printing the marks themselves,
 * which is the same complaint as a tool row showing its own source.
 *
 * Inline code only, deliberately. A bubble is a quotation of what someone
 * said: a stray `#` must not silently become a heading, and a pasted diff must
 * keep every one of its lines.
 */
const inlineCode = (text: string): ReactNode[] =>
  text.split(/(`[^`\n]+`)/g).map((part, index) =>
    part.length > 2 && part.startsWith('`') && part.endsWith('`') ? (
      <code key={index} className={styles.bubbleCode}>
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  )

const UserMessage = ({ item, sentAt }: { item: UserMessageItem; sentAt?: number }) => {
  const raw = item.content
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n')
  const { injections, text } = splitContext(raw)
  const attachments = item.content.filter((part) => part.type !== 'text')
  const images = imagesOf(item)
  const [preview, setPreview] = useState<number | null>(null)

  return (
    <div className={styles.userRow}>
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
            <button
              key={index}
              type="button"
              role="listitem"
              className={styles.imageTile}
              title={image.name}
              aria-label={`View ${image.name}`}
              onClick={() => setPreview(position)}
            >
              <img className={styles.imageThumb} src={image.url} alt={image.name} loading="lazy" draggable={false} />
            </button>
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
                <span key={index} className={styles.chip} title={part.path}>
                  <SparkIcon size={12} />
                  {part.name}
                  <span className={styles.badge}>skill</span>
                </span>
              )
            }
            if (part.type === 'mention') {
              return (
                <span key={index} className={styles.chip} title={part.path}>
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
              <span key={index} className={styles.chip} title={part.type === 'localImage' ? part.path : undefined}>
                <ImageIcon size={12} />
                {name}
              </span>
            )
          })}
        </div>
      )}
      {text.length > 0 && <div className={styles.bubble}>{inlineCode(text)}</div>}
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
      className={styles.injectionWrap}
      {...(open ? { 'data-open': '' } : {})}
      {...(fromAgent ? { 'data-peer': '' } : {})}
    >
      <button type="button" className={styles.injection} onClick={() => setOpen((value) => !value)}>
        <ChevronIcon size={11} {...(open ? { 'data-open': '' } : {})} className={styles.chevron} />
        {fromAgent ? <TeamIcon size={12} /> : <FileIcon size={12} />}
        {fromAgent ? 'From another agent' : origin === 'agent' ? 'Sent with your message' : 'Context added'}
        <span className={styles.injectionLabel}>{fromAgent ? label.replace(/^Message from /, '') : label}</span>
      </button>
      {/* The body is prose, not terminal output: a git note, a hand-off
          packet, a plugin's summary — all written in Markdown by whoever
          composed them. A <pre> here printed that authoring as source. */}
      {open && (
        <div className={styles.injectionBody}>
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
  <div className={`${styles.assistant} ${item.phase === 'commentary' ? styles.commentary : ''}`}>
    <Markdown text={item.text} />
    {streaming && <span className={styles.caret} />}
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
      plainTitle
      meta={item.content.length > 0 ? 'reasoning' : undefined}
    >
      {body.length > 0 && (
        <div className={styles.reasoningBody}>
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

/** A short human label for a command, falling back to the command itself. */
const describeCommand = (item: CommandItem): string => {
  const first = item.actions[0]
  if (!first) return shellCommandOf(item.command)
  switch (first.type) {
    case 'read':
      return `Read ${first.name}`
    case 'listFiles':
      return first.path ? `List ${first.path}` : 'List files'
    case 'search':
      return first.query ? `Search for ${first.query}` : 'Search'
    case 'unknown':
      return shellCommandOf(item.command)
  }
}

/**
 * The command itself, wrapped in full and copyable, under a prompt mark.
 *
 * A row's title is a label and ellipsises; this is what actually ran. A
 * command step and a shell tool call both open onto it, so a step never
 * shows output with no sight of what produced it — and a described call,
 * whose row is the agent's sentence, keeps its command exactly one click
 * away rather than glued to the sentence.
 */
const ShellLine = ({ command }: { command: string }) => (
  <div className={styles.shellRow}>
    <span className={styles.shellPrompt} aria-hidden="true">
      $
    </span>
    <code className={styles.shellCommand}>{command}</code>
    <CopyButton text={command} label="Copy this command" className={styles.shellCopy} />
  </div>
)

const Command = ({ item }: { item: CommandItem }) => (
  <Row
    icon={<TerminalIcon size={14} />}
    title={item.actions.length === 1 ? describeCommand(item) : shellCommandOf(item.command)}
    meta={
      <>
        {item.origin === 'user' && <span className={styles.badge}>you</span>}
        {formatDuration(item.durationMs)}
        {item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0 && (
          <span className={styles.badge} data-status="failed">
            exit {item.exitCode}
          </span>
        )}
      </>
    }
    status={item.status}
    defaultOpen={item.status === 'inProgress' || item.status === 'failed'}
  >
    <ShellLine command={shellCommandOf(item.command)} />
    <pre className={styles.output}>
      {item.output ? stripAnsi(item.output) : item.status === 'inProgress' ? '' : '(no output)'}
    </pre>
  </Row>
)

const FileChange = ({ item, root }: { item: FileChangeItem; root?: string }) => {
  const totals = item.changes.reduce(
    (accumulator, change) => {
      const counts = countDrawn(change.diff, change.kind.type === 'add')
      return {
        added: accumulator.added + counts.added,
        removed: accumulator.removed + counts.removed,
      }
    },
    { added: 0, removed: 0 },
  )

  return (
    <Row
      icon={<DiffIcon size={14} />}
      title={
        item.changes.length === 1
          ? relativeTo(item.changes[0]?.path ?? '', root)
          : `${item.changes.length} files changed`
      }
      plainTitle
      meta={
        <>
          <span className={styles.statAdd}>+{totals.added}</span>
          <span className={styles.statRemove}>−{totals.removed}</span>
        </>
      }
      status={item.status}
      defaultOpen={item.changes.length === 1}
    >
      <div className={styles.fileList}>
        {item.changes.map((change) => (
          <FileEntry
            key={change.path}
            change={change}
            root={root}
            single={item.changes.length === 1}
          />
        ))}
      </div>
    </Row>
  )
}

const FileEntry = ({
  change,
  root,
  single,
}: {
  change: FileChangeItem['changes'][number]
  root?: string
  single: boolean
}) => {
  const [open, setOpen] = useState(single)
  // The rule the view below draws by — `wholeFile` for an added file — so the
  // badge is what is drawn. See `countDrawn`.
  const counts = countDrawn(change.diff, change.kind.type === 'add')
  const added = counts.added

  return (
    <div className={styles.fileEntry}>
      <button type="button" className={styles.fileHeader} onClick={() => setOpen((v) => !v)}>
        <ChevronIcon className={styles.chevron} size={12} {...(open ? { 'data-open': '' } : {})} />
        <span className={styles.filePath} title={change.path}>
          {relativeTo(change.path, root)}
        </span>
        <span className={`${styles.stat} ${styles.statAdd}`}>+{added}</span>
        <span className={`${styles.stat} ${styles.statRemove}`}>−{counts.removed}</span>
      </button>
      {open && (
        <div className={styles.fileBody}>
          <DiffView diff={change.diff} wholeFile={change.kind.type === 'add'} />
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
  <ul className={styles.todoList}>
    {todos.map((todo, index) => (
      <li
        key={index}
        className={styles.todoRow}
        {...(todo.done ? { 'data-done': '' } : todo.active ? { 'data-active': '' } : {})}
      >
        <span className={styles.todoMark} aria-hidden="true">
          {todo.done ? <TodoDoneIcon size={13} /> : todo.active ? <TodoActiveIcon size={13} /> : <TodoPendingIcon size={13} />}
        </span>
        {todo.label}
      </li>
    ))}
  </ul>
)

/** The one argument worth showing beside the title, shortened to the repo. */
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
      <pre className={styles.json}>{JSON.stringify(args, null, 2)}</pre>
    )
  }
  const argTodos = findTodos(args)
  if (argTodos) return <TodoListView todos={argTodos} />
  const entries = Object.entries(args as Record<string, unknown>)
  if (entries.length === 0) return null
  return (
    <dl className={styles.argList}>
      {entries.map(([key, value]) => (
        <div key={key} className={styles.argRow}>
          <dt className={styles.argKey}>{key}</dt>
          <dd className={styles.argValue}>
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
  const snapshot = useSnapshot()
  const sentences = useMemo(() => toolSentences(snapshot.contributions), [snapshot.contributions])
  const said = toolSentence(item.tool, sentences)
  const described = describedTitle(item)
  const label = described ?? (item.source.kind === 'mcp' ? `${item.source.server} · ${said}` : said)
  // Null when the adapter's "tool name" was already the sentence above.
  const wire = wireNameOf(item.tool)
  const headline = headlineArg(item.args, root)
  // The title often already names the file (the adapters do that work);
  // repeating it as a subtitle would be noise. A described row names
  // nothing but its sentence, on purpose.
  const subtitle =
    !described && headline && !String(label).includes(headline.split('/').pop() ?? headline) ? headline : null
  const record =
    typeof item.args === 'object' && item.args !== null && !Array.isArray(item.args)
      ? (item.args as Record<string, unknown>)
      : null
  const command = typeof record?.['command'] === 'string' && record['command'].trim().length > 0 ? record['command'] : null
  const Icon = VERB_ICON[toolCallVerb(item)]

  return (
    <Row
      icon={<Icon size={14} />}
      title={
        subtitle ? (
          <>
            {label}
            <span className={styles.rowSubtitle}>{subtitle}</span>
          </>
        ) : (
          label
        )
      }
      plainTitle={described !== null}
      meta={formatDuration(item.durationMs)}
      status={item.status}
      defaultOpen={item.status === 'failed'}
    >
      {wire && <div className={styles.wireName}>{wire}</div>}
      {item.error ? (
        <pre className={styles.output}>{stripAnsi(item.error)}</pre>
      ) : (
        <>
          {/* A shell call opens onto the command it ran, the way a command
              step does; every other call lists its arguments. The
              description is the row's title and the background flag is the
              panel's business, so neither is repeated here as a field. */}
          {command ? <ShellLine command={command} /> : <ArgsView args={item.args} root={root} />}
          {item.result?.map((part, index) => {
            if (part.type === 'text') {
              return (
                <pre key={index} className={styles.output}>
                  {stripAnsi(part.text)}
                </pre>
              )
            }
            if (part.type === 'image') {
              return <img key={index} src={part.url} alt="" style={{ maxWidth: '100%' }} />
            }
            // A JSON part carrying a bare string is output, not a document.
            // Encoding it turns every newline into a literal \n and every
            // quote into \" — the shell transcript arrives as its own source.
            if (typeof part.value === 'string') {
              return (
                <pre key={index} className={styles.output}>
                  {stripAnsi(part.value)}
                </pre>
              )
            }
            const todos = findTodos(part.value)
            if (todos) {
              return <TodoListView key={index} todos={todos} />
            }
            const diff = findDiff(part.value)
            if (diff) {
              return (
                <div key={index} className={styles.fileBody}>
                  <DiffView diff={diff} />
                </div>
              )
            }
            return (
              <pre key={index} className={styles.json}>
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
      plainTitle
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
      {item.prompt && <pre className={styles.output}>{item.prompt}</pre>}
      {item.members.length > 0 && (
        <div className={styles.fileList}>
          {item.members.map((member) => {
            // A child with a conversation of its own can be opened; one whose
            // id is only the handle of the call that spawned it cannot, and a
            // button that fails after the press is worse than a row.
            const openable = member.openable !== false
            return (
              <button
                key={member.sessionId}
                type="button"
                className={styles.fileHeader}
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
                <span className={styles.filePath}>
                  {member.nickname ?? member.sessionId.slice(0, 8)}
                </span>
                {member.role && <span className={styles.badge}>{member.role}</span>}
                {member.state && <span className={styles.badge}>{member.state}</span>}
                {member.usage && member.usage.totalTokens > 0 && (
                  <span
                    className={styles.badge}
                    {...(member.usage.outputExact === false
                      ? { title: 'At least this much: the child was still streaming when its last count was taken.' }
                      : {})}
                  >
                    {formatTokensWithFloor(member.usage)} tokens
                  </span>
                )}
              </button>
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
    title={`Searched the web for “${item.query}”`}
    plainTitle
    status={item.status}
  />
)

const Plan = ({ item }: { item: PlanItem }) => {
  const steps = item.text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s*/, '').trim())
    .filter(Boolean)

  return (
    <Row icon={<PlanIcon size={14} />} title="Plan" plainTitle defaultOpen>
      <ol className={styles.planList}>
        {steps.map((step, index) => (
          <li key={index} className={styles.planStep} data-status="pending">
            <span className={styles.planBullet} />
            {step}
          </li>
        ))}
      </ol>
    </Row>
  )
}

const Compaction = (_: { item: CompactionItem }) => (
  <div className={styles.marker}>
    <span className={styles.markerLine} />
    Earlier messages were summarised to free up context
    <span className={styles.markerLine} />
  </div>
)

/**
 * The runtime's own housekeeping on one dim line — a command it ran for us, a
 * background task reporting back, a turn that was stopped. Quiet on purpose:
 * it is the setting for what follows, not something to read.
 */
const Notice = ({ item }: { item: NoticeItem }) => (
  <div className={styles.notice}>
    <InfoIcon size={12} className={styles.noticeIcon} />
    <span>{item.text}</span>
  </div>
)

const Review = ({ item }: { item: ReviewItem }) => (
  <div className={styles.marker}>
    <span className={styles.markerLine} />
    {item.phase === 'entered' ? `Started review: ${item.review}` : 'Finished review'}
    <span className={styles.markerLine} />
  </div>
)

const ErrorRow = ({ item }: { item: ErrorItem }) => (
  <div className={styles.error}>
    <AlertIcon className={styles.errorIcon} size={14} />
    <span>{item.message}</span>
  </div>
)

const ImageRow = ({ item }: { item: ImageItem }) => (
  <Row
    icon={<ImageIcon size={14} />}
    title={item.generated ? 'Generated an image' : item.path.split('/').pop() ?? 'Image'}
    plainTitle
  />
)

export const ItemView = ({
  item,
  root,
  streaming = false,
  sentAt,
}: {
  item: AgentItem
  /** Session working directory, used to shorten absolute paths. */
  root?: string
  streaming?: boolean
  /** When the turn began, for a user message that does not carry its own time. */
  sentAt?: number
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
        return <Command item={item} />
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
      case 'error':
        return <ErrorRow item={item} />
    }
  })()

  if (body === null) return null
  return <div className={styles.item}>{body}</div>
}
