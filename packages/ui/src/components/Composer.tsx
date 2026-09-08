import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react'

import { isBusy, sessionKey, type FileMatch, type RuntimeId, type UserContent } from '@harnessdesk/protocol'

import { Btn, Dialog, Input } from '../design'
import { availableCommands, matchCommands, type CommandDefinition } from '../state/commands'
import { wrapContext } from '../lib/context-envelope'
import { CARRY_LABEL } from '../lib/handoff'
import { brandOf } from '../lib/identity'
import { attachmentName, dragHasFiles, imageFilesOf, vetImageFiles } from '../lib/images'
import { PLAN_EDIT_SOURCE, planEditNote } from '../lib/plan-edits'
import { sessionPlan } from '../lib/todos'
import { cycle, detectTrigger, stripTrigger } from '../lib/triggers'
import {
  useActiveSession,
  useIsFocusedPane,
  useQueue,
  useRuntime,
  useSessionKey,
  useSnapshot,
  useStore,
} from '../state/context'
import { Slot } from '../slots/registry'
import {
  AlertIcon,
  AtIcon,
  CrossIcon,
  FileIcon,
  FolderOpenIcon,
  HandoffIcon,
  ImageIcon,
  NoteIcon,
  PaperclipIcon,
  PlusIcon,
  SendIcon,
  SlashIcon,
  SparkIcon,
  StopIcon,
} from './Icons'
import { AgentControl, ModeControl, ModelControl, MoreControl, PermissionControl } from './ComposerControls'
import { ContextUsage } from './ContextUsage'
import { Lightbox } from './Lightbox'
import { Popover, popoverStyles } from './Popover'
import { TriggerMenu, type TriggerItem } from './TriggerMenu'
import styles from './Composer.module.css'

/**
 * The composer.
 *
 * Enter sends; Shift+Enter is a newline. While a turn is running, Enter
 * **queues**: the host holds the message and sends it when the turn ends
 * This used to steer instead, which only one of the four agents can
 * do — for the other three the message was destroyed and replaced by an error
 * toast, which is the worst thing a text box can do.
 *
 * Steering did not go away: ⌘↵ still adds to the running turn, for the agents
 * whose runtime declares `capabilities.steer`.
 *
 * `/` and `@` share one trigger pipeline: detect, filter, navigate, pick. They
 * differ only in what they search and what picking does.
 */

interface Attachment {
  /** Stable for the chip's lifetime. Two identical pastes are two chips, and removing one removes one. */
  readonly id: string
  readonly name: string
  /** A filesystem path for files and skills; a data URL for images; a key for context and notes. */
  readonly path: string
  readonly kind: 'file' | 'image' | 'skill' | 'session' | 'context' | 'note'
  /** Context chips: the provider's contribution id and the reference it was given. */
  readonly contextId?: string
  readonly ref?: string
  /**
   * Note chips: the block itself, already composed — a page's annotations, a
   * review's findings. It travels in the context envelope under `name`, and
   * never touches the text box: what is in there is what a person typed.
   */
  readonly text?: string
  /**
   * Session chips: the agent that holds it. `path` is the session's id, and an
   * id alone is ambiguous — ACP agents number their sessions, so the same "1"
   * exists under several. Carried from the picker rather than looked up at
   * send time, when the active agent may be a different one entirely.
   */
  readonly runtime?: RuntimeId
}

let attachmentCounter = 0
const nextAttachmentId = (): string => `att-${++attachmentCounter}`

/**
 * What a note chip says on hover. The block itself can be thousands of
 * characters, and a chip is the only sight of it before it is sent — so the
 * first few lines, and an honest count of the rest.
 */
const notePreview = (note: { readonly name: string; readonly text?: string }): string => {
  const body = (note.text ?? '').replace(/^<context source=[^\n]*\n?/, '').replace(/\n?<\/context>$/, '')
  const lines = body.split('\n').filter((line) => line.trim().length > 0)
  const head = lines.slice(0, 6).join('\n')
  const rest = lines.length - 6
  return `Sent with your message.\n\n${head}${rest > 0 ? `\n… ${rest} more line${rest === 1 ? '' : 's'}` : ''}`
}

/** Images are inlined as data URLs: the browser has no filesystem path to send. See lib/images. */

/** What a `harnessdesk:compose` event may hand the focused composer. */
interface ComposeDetail {
  readonly text: string
  readonly replace?: boolean
  readonly attachments?: readonly {
    readonly name: string
    readonly path: string
    readonly kind: Attachment['kind']
    /** Note chips only: the block this chip carries. */
    readonly text?: string
  }[]
  /** A sender that wants to know it landed — see `lib/compose`. */
  readonly onReceived?: () => void
}

type Trigger =
  | { readonly kind: 'none' }
  | { readonly kind: 'command'; readonly query: string }
  | { readonly kind: 'file'; readonly query: string }
  | { readonly kind: 'choose'; readonly command: CommandDefinition }

export const Composer = ({ onChooseProject }: { onChooseProject: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const session = useActiveSession()
  const key = useSessionKey()
  const focused = useIsFocusedPane()
  const textarea = useRef<HTMLTextAreaElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)

  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // Drag-and-drop: the counter survives the enter/leave pairs every child
  // fires as the pointer crosses it, so the highlight does not flicker.
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState<number | null>(null)
  const pastedImages = useRef(0)
  const [trigger, setTrigger] = useState<Trigger>({ kind: 'none' })
  const [files, setFiles] = useState<FileMatch[]>([])
  const [active, setActive] = useState(0)

  const busy = session ? isBusy(session) : false
  // Messages already waiting change what Enter means even when nothing is
  // running: they go first, so this one joins the back of the line rather
  // than starting a turn. Saying so beats a keystroke that appears to do
  // nothing because the queue is held.
  const queue = useQueue()
  const waiting = queue?.messages.length ?? 0
  // No session yet is not a locked composer: typing is how a session starts.
  // Only a missing workspace or a runtime that is not ready blocks input.
  const ready = snapshot.health?.state === 'ready'
  const canType = Boolean(session) || (ready && Boolean(snapshot.workspace))
  // A hand-off chip rides on the draft only; it leaves with the first message.
  const handoff = session ? null : snapshot.draftHandoff
  // Context providers that asked to be chips (docs/extending.md).
  const chipProviders = useMemo(
    () =>
      snapshot.contributions.filter(
        (entry): entry is Extract<typeof entry, { kind: 'context' }> => entry.kind === 'context' && !!entry.chip,
      ),
    [snapshot.contributions],
  )
  const [refPrompt, setRefPrompt] = useState<(typeof chipProviders)[number] | null>(null)
  // Whether the agent this draft will go to can look at an image at all. The
  // pane's runtime for an open session, the chosen one for a draft — so an
  // agent switch on the draft re-evaluates the tiles already attached.
  const runtime = useRuntime()
  const acceptsImages = runtime.capabilities.imageInput
  // Whether this agent can take a message into a turn already running. Only
  // some can; the ones that cannot say so by refusing, so the shortcut is
  // offered by capability rather than tried and apologised for.
  const canSteer = runtime.capabilities.steer
  const agentName = brandOf(runtime.name)
  const images = useMemo(() => attachments.filter((entry) => entry.kind === 'image'), [attachments])
  const addContext = useCallback((provider: (typeof chipProviders)[number], ref?: string) => {
    const trimmed = ref?.trim()
    setAttachments((current) => {
      const path = `context:${provider.id}:${trimmed ?? ''}`
      if (current.some((entry) => entry.path === path)) return current
      return [
        ...current,
        {
          id: nextAttachmentId(),
          name: trimmed ? `${provider.label}: ${trimmed}` : provider.label,
          path,
          kind: 'context',
          contextId: provider.id,
          ...(trimmed ? { ref: trimmed } : {}),
        },
      ]
    })
  }, [])
  /** A pasted text that a provider recognises becomes its chip, not a line of text. */
  const chipForPaste = useCallback(
    (pasted: string): boolean => {
      const candidate = pasted.trim()
      if (!candidate || candidate.includes('\n')) return false
      for (const provider of chipProviders) {
        if (!provider.chip?.match) continue
        try {
          if (new RegExp(`^(?:${provider.chip.match})$`).test(candidate)) {
            addContext(provider, candidate)
            return true
          }
        } catch {
          // A provider's bad pattern is its own bug, not a reason to lose the paste.
        }
      }
      return false
    },
    [addContext, chipProviders],
  )
  /**
   * A task reworded in the Tasks panel is something to send in its own right.
   * The note is the whole message then — the agent is being told to use the
   * person's wording, which needs no sentence around it — and without this the
   * only way to deliver a correction was to type filler beside it.
   */
  const pendingPlanNote = useMemo(
    () => (key ? planEditNote(sessionPlan(session) ?? [], snapshot.planEdits[key] ?? []) : null),
    [key, session, snapshot.planEdits],
  )
  const canSend =
    canType &&
    (text.trim().length > 0 || attachments.length > 0 || handoff !== null || pendingPlanNote !== null)
  const root = snapshot.workspace?.path ?? session?.cwd

  useLayoutEffect(() => {
    const element = textarea.current
    if (!element) return
    const measure = (): void => {
      element.style.height = '0px'
      element.style.height = `${Math.min(element.scrollHeight, 320)}px`
    }
    measure()
    // Only a width change can invalidate the measurement; reacting to height
    // would feed the observer its own output.
    let lastWidth = element.clientWidth
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === lastWidth) return
      lastWidth = element.clientWidth
      measure()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])

  // File search is debounced; command matching is local and instant.
  useEffect(() => {
    if (trigger.kind !== 'file' || !root) {
      setFiles([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      // Through the runtime's own search where it has one, so `@` ranks the
      // way its other clients rank.
      void store.transport
        .request('workspace/files', {
          root,
          query: trigger.query,
          limit: 8,
          ...(snapshot.activeRuntime ? { runtime: snapshot.activeRuntime } : {}),
        })
        .then((found) => {
          if (!cancelled) setFiles([...found])
        })
        .catch(() => setFiles([]))
    }, 90)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [trigger, root, store, snapshot.activeRuntime])

  const commands = useMemo(() => availableCommands(snapshot), [snapshot])

  const items: TriggerItem[] = useMemo(() => {
    if (trigger.kind === 'command') {
      return matchCommands(commands, trigger.query).map((command) => ({
        id: command.name,
        name: `/${command.name}`,
        hint: command.argumentHint
          ? `${command.argumentHint} — ${command.description}`
          : command.description,
        mono: true,
        ...(command.source ? { badge: command.source } : {}),
      }))
    }
    if (trigger.kind === 'file') {
      // Skills and files share the `@` menu because they are the same gesture:
      // pointing the agent at something by name.
      const needle = trigger.query.toLowerCase()
      // Other sessions are referenceable too: "what did we decide over there" is
      // a question people ask constantly, and re-explaining it is the tax.
      const sessions = snapshot.history
        .filter(
          (entry) =>
            // By key, not id: `history` spans every agent, and two of them can
            // both hold a session called "1". Excluding by id alone would hide
            // someone else's conversation and offer this one.
            sessionKey(entry.runtime, entry.id) !== snapshot.activeSessionKey &&
            `${entry.title ?? ''} ${entry.preview ?? ''}`.toLowerCase().includes(needle),
        )
        .slice(0, 3)
        .map((entry) => ({
          // The runtime travels in the id: the menu hands back only the item,
          // and the id is the one place to put what picking it needs to know.
          id: `session:${entry.runtime}:${entry.id}`,
          name: entry.title?.trim() || entry.preview?.trim() || 'Untitled session',
          hint: entry.cwd.split('/').pop() ?? entry.cwd,
          badge: 'session',
        }))
      const skills = snapshot.skills
        .filter((skill) => skill.enabled && skill.name.toLowerCase().includes(needle))
        .slice(0, 4)
        .map((skill) => ({
          id: `skill:${skill.name}`,
          name: skill.name,
          hint: skill.description,
          badge: 'skill',
        }))
      return [
        ...skills,
        ...sessions,
        ...files.map((file) => ({
          id: file.path,
          name: file.relativePath.split('/').pop() ?? file.relativePath,
          hint: file.relativePath,
          pathStyle: true,
        })),
      ]
    }
    if (trigger.kind === 'choose' && trigger.command.kind.type === 'choose') {
      return trigger.command.kind.choices(snapshot).map((choice) => ({
        id: choice.id,
        name: choice.label,
        ...(choice.hint ? { hint: choice.hint } : {}),
        ...(choice.selected ? { selected: true } : {}),
      }))
    }
    return []
  }, [trigger, commands, files, snapshot])

  useEffect(() => {
    setActive(0)
  }, [trigger.kind, items.length])

  const onChange = useCallback((value: string) => {
    setText(value)
    setTrigger(detectTrigger(value))
  }, [])

  const runCommand = useCallback(
    (command: CommandDefinition) => {
      // Everything up to the trigger is kept, so `/model` in the middle of a
      // draft does not throw away what was already typed.
      const remainder = stripTrigger(text, 'command')
      if (command.kind.type === 'choose') {
        setText(remainder)
        setTrigger({ kind: 'choose', command })
        return
      }
      const argument = remainder.trim()
      setText('')
      setTrigger({ kind: 'none' })
      void command.kind.run(store, argument)
      textarea.current?.focus()
    },
    [store, text],
  )

  const pick = useCallback(
    (item: TriggerItem) => {
      if (trigger.kind === 'command') {
        const command = commands.find((entry) => entry.name === item.id)
        if (command) runCommand(command)
        return
      }
      if (trigger.kind === 'file') {
        if (item.id.startsWith('session:')) {
          // `session:<runtime>:<id>` — split at the first colon only, because a
          // runtime id is a registry slug while a session id is whatever the
          // agent calls it, colons included.
          const rest = item.id.slice('session:'.length)
          const divider = rest.indexOf(':')
          if (divider < 0) return
          const runtime = rest.slice(0, divider) as RuntimeId
          const id = rest.slice(divider + 1)
          setAttachments((current) =>
            current.some((entry) => entry.path === id && entry.runtime === runtime)
              ? current
              : [
                  ...current,
                  { id: nextAttachmentId(), name: item.name, path: id, kind: 'session', runtime },
                ],
          )
          setText((current) => stripTrigger(current, 'file'))
          setTrigger({ kind: 'none' })
          textarea.current?.focus()
          return
        }
        if (item.id.startsWith('skill:')) {
          const name = item.id.slice('skill:'.length)
          const skill = snapshot.skills.find((entry) => entry.name === name)
          setAttachments((current) =>
            current.some((entry) => entry.path === (skill?.path ?? name))
              ? current
              : [...current, { id: nextAttachmentId(), name, path: skill?.path ?? name, kind: 'skill' }],
          )
          setText((current) => stripTrigger(current, 'file'))
          setTrigger({ kind: 'none' })
          textarea.current?.focus()
          return
        }
        const file = files.find((entry) => entry.path === item.id)
        if (!file) return
        const name = file.relativePath.split('/').pop() ?? file.relativePath
        setAttachments((current) =>
          current.some((entry) => entry.path === file.path)
            ? current
            : [...current, { id: nextAttachmentId(), name, path: file.path, kind: 'file' }],
        )
        setText((current) => stripTrigger(current, 'file'))
        setTrigger({ kind: 'none' })
        textarea.current?.focus()
        return
      }
      if (trigger.kind === 'choose' && trigger.command.kind.type === 'choose') {
        void trigger.command.kind.pick(store, item.id)
        setTrigger({ kind: 'none' })
        textarea.current?.focus()
      }
    },
    [commands, files, runCommand, snapshot.history, snapshot.skills, store, trigger],
  )

  /**
   * `mode: 'now'` is ⌘↵ — add to the turn already running, where the agent can
   * take it. Everything else goes through `turn/queue`, which is the host's
   * call to make: it sends at once when nothing is running and holds it when
   * something is, so the two states cannot disagree across a round trip.
   */
  const submit = useCallback(async (mode: 'auto' | 'now' = 'auto') => {
    // `/open src/a.ts` is a command with an argument, not a message that
    // happens to start with a slash — and that holds however the draft is
    // submitted. The send button must not deliver to the agent what the
    // Enter key would have run locally.
    const inline = /^\/(\S+)\s+(.*)$/s.exec(text.trim())
    const inlineCommand = inline ? commands.find((entry) => entry.name === inline[1]) : undefined
    if (inline && inlineCommand && inlineCommand.kind.type === 'action') {
      setText('')
      setTrigger({ kind: 'none' })
      void inlineCommand.kind.run(store, inline[2] ?? '')
      return
    }

    if (!canSend) return
    if (images.length > 0 && !acceptsImages) {
      store.notice(
        'warning',
        `${agentName} does not accept images. Remove ${images.length === 1 ? 'the image' : 'them'} or pick an agent that does.`,
      )
      return
    }

    const content: UserContent[] = []
    // A handed-off conversation travels as its packet, first, so the
    // instruction below reads against it.
    if (handoff) {
      const packet = await store.handoffPacket(handoff)
      // Same rule as a context chip that will not resolve, and for a stronger
      // reason: a hand-off whose packet went missing starts the new agent on
      // an instruction that refers to work it has never heard of.
      if (!packet) {
        store.notice(
          'warning',
          `Nothing could be carried over from “${handoff.title}”. Open it and copy what matters, or remove the hand-off to send this on its own.`,
        )
        return
      }
      content.push({ type: 'text', text: packet })
    }
    // Referenced sessions are resolved to context: the runtime has no notion of
    // one thread pointing at another, so the summary has to travel as text.
    const referenced = attachments.filter((entry) => entry.kind === 'session')
    for (const reference of referenced) {
      if (!reference.runtime) {
        // Same rule as a context chip that will not resolve: a message quietly
        // missing what its chip promised misleads the agent, and guessing the
        // runtime here is how the wrong conversation gets summarised.
        store.notice('warning', `${reference.name}: no agent recorded for this conversation.`)
        return
      }
      const summary = await store.summariseSession(reference.path, reference.runtime)
      if (summary) content.push({ type: 'text', text: summary })
    }

    // Context chips resolve through their plugin now, with the workspace the
    // message is about. A chip that cannot resolve stops the send: a message
    // silently missing the context it promised would mislead the agent.
    for (const chip of attachments.filter((entry) => entry.kind === 'context')) {
      try {
        const resolved = await store.transport.request('context/resolve', {
          id: chip.contextId ?? '',
          ...(chip.ref ? { ref: chip.ref } : {}),
          ...(snapshot.activeRuntime ? { runtime: snapshot.activeRuntime } : {}),
          ...(snapshot.workspace?.path ? { workspaceRoot: snapshot.workspace.path } : {}),
        })
        // An image provider (a screenshot chip) resolves to a picture where
        // the agent takes one, and to its text alone — with the omission
        // named — where it does not.
        const dropped = resolved.image && !acceptsImages
        const note = dropped
          ? `${resolved.text}\n\n(A screenshot was taken, but ${agentName} does not accept images.)`.trim()
          : resolved.text
        if (note.trim().length > 0) content.push({ type: 'text', text: wrapContext(resolved.label, note) })
        if (resolved.image && acceptsImages) {
          content.push({ type: 'image', url: resolved.image.dataUrl, name: resolved.image.name ?? resolved.label })
        }
      } catch (error) {
        store.notice('warning', `${chip.name}: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }

    // Blocks the desk composed for this message — the marks made on a page —
    // are already whole. They go in the same envelope a plugin's context
    // travels in, so the transcript folds them the same way.
    for (const note of attachments.filter((entry) => entry.kind === 'note')) {
      if (note.text && note.text.trim().length > 0) content.push({ type: 'text', text: note.text })
    }

    for (const attachment of attachments) {
      if (attachment.kind === 'session' || attachment.kind === 'context') continue
      if (attachment.kind === 'note') continue
      if (attachment.kind === 'image') {
        content.push({ type: 'image', url: attachment.path, name: attachment.name })
      }
      else if (attachment.kind === 'skill') {
        content.push({ type: 'skill', name: attachment.name, path: attachment.path })
      } else content.push({ type: 'mention', name: attachment.name, path: attachment.path })
    }
    // A task the person reworded travels with the next thing they say. No
    // runtime lets the desk set its plan, so this is the whole of how an edit
    // reaches the agent — and the edit retires itself once the agent's own
    // plan comes back carrying the new wording.
    const plan = sessionPlan(session)
    if (plan && key) {
      if (pendingPlanNote) content.push({ type: 'text', text: wrapContext(PLAN_EDIT_SOURCE, pendingPlanNote) })
      store.retirePlanEdits(plan, key)
    }
    if (text.trim().length > 0) content.push({ type: 'text', text: text.trim() })

    const draft = { text, attachments }
    setText('')
    setAttachments([])
    setTrigger({ kind: 'none' })

    if (mode === 'now' && busy && canSteer) {
      await store.steer(content, key)
      return
    }
    // A message that did not get anywhere goes back in the box. Losing what
    // was typed is the failure this whole feature exists to prevent, so the
    // one path that can fail has to put it back.
    const delivered = await store.queue(content, key)
    if (!delivered) {
      setText((current) => (current.trim().length > 0 ? current : draft.text))
      setAttachments((current) => (current.length > 0 ? current : draft.attachments))
    }
  }, [
    acceptsImages,
    agentName,
    attachments,
    busy,
    canSend,
    canSteer,
    commands,
    handoff,
    images.length,
    key,
    snapshot.activeRuntime,
    snapshot.workspace?.path,
    store,
    text,
  ])

  /**
   * Attaches images from a picker, a paste, or a drop — the same way each
   * time. Unreadable and oversized files are reported one by one; the rest are
   * read in the order they came and appended in that order, however the reads
   * finish. An image that is already attached is not attached twice.
   */
  const attachImages = useCallback(
    (fileList: Iterable<File> | null, source: 'picker' | 'paste' | 'drop' = 'picker') => {
      const { accepted, rejected } = vetImageFiles(fileList ?? [])
      for (const { reason } of rejected) store.notice('warning', reason)
      if (accepted.length === 0) return
      if (!acceptsImages) {
        store.notice('warning', `${agentName} does not accept images.`)
        return
      }
      const pasted = source === 'paste'
      const named = accepted.map((file) => {
        const name = attachmentName(file, pastedImages.current, pasted)
        if (pasted) pastedImages.current += 1
        return { file, name }
      })
      void Promise.all(
        named.map(
          ({ file, name }) =>
            new Promise<Attachment | null>((resolve) => {
              const reader = new FileReader()
              reader.onload = () =>
                resolve({ id: nextAttachmentId(), name, path: String(reader.result), kind: 'image' })
              reader.onerror = () => {
                store.notice('warning', `Could not read ${name}.`)
                resolve(null)
              }
              reader.readAsDataURL(file)
            }),
        ),
      ).then((read) => {
        setAttachments((current) => {
          const present = new Set(current.filter((entry) => entry.kind === 'image').map((entry) => entry.path))
          const fresh: Attachment[] = []
          for (const entry of read) {
            if (!entry) continue
            if (present.has(entry.path)) {
              store.notice('info', `${entry.name} is already attached.`)
              continue
            }
            present.add(entry.path)
            fresh.push(entry)
          }
          return fresh.length > 0 ? [...current, ...fresh] : current
        })
      })
    },
    [acceptsImages, agentName, store],
  )

  // The composer is the drop target for images — the whole shell, not the
  // text box, because a tile strip above the text is where they land.
  const onDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }, [])
  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])
  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(event.dataTransfer)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }, [])
  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!dragHasFiles(event.dataTransfer)) return
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const found = imageFilesOf(event.dataTransfer)
      if (found.length === 0) {
        store.notice('warning', 'Only images can be dropped here. Use @ to mention a file.')
        return
      }
      attachImages(found, 'drop')
      textarea.current?.focus()
    },
    [attachImages, store],
  )

  const menuOpen = trigger.kind !== 'none'

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (menuOpen && items.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActive((value) => cycle(value, 1, items.length))
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActive((value) => cycle(value, -1, items.length))
          return
        }
        if (event.key === 'Enter' || (event.key === 'Tab' && trigger.kind !== 'choose')) {
          const item = items[active]
          if (item) {
            event.preventDefault()
            pick(item)
            return
          }
        }
      }
      if (menuOpen && event.key === 'Escape') {
        event.preventDefault()
        setTrigger({ kind: 'none' })
        return
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault()
        // ⌘↵ / Ctrl+↵ adds to the running turn where the agent can take it;
        // plain ↵ queues. Inline commands (`/open src/a.ts`) are intercepted
        // inside submit, so the keys and the buttons behave identically.
        void submit(event.metaKey || event.ctrlKey ? 'now' : 'auto')
      }
    },
    [active, commands, items, menuOpen, pick, store, submit, text, trigger.kind],
  )

  // A review action elsewhere — "revise this file" in the changes panel, or
  // "edit" on a queued message — hands the focused composer a draft to finish.
  useEffect(() => {
    if (!focused) return
    const onCompose = (event: Event): void => {
      const raw = (event as CustomEvent<string | ComposeDetail>).detail
      const detail = typeof raw === 'string' ? { text: raw, replace: false } : raw
      if (!detail || typeof detail.text !== 'string') return
      // The receipt, first: a sender retrying each frame stops the moment
      // this composer says it has the message.
      detail.onReceived?.()
      // An empty detail is only a request for focus — a new draft pane
      // handing over the keyboard — and must not disturb a typed draft.
      // "Edit" on a sent message replaces the draft: that message is the draft.
      if (detail.text.length > 0) {
        setText((current) =>
          detail.replace || current.trim().length === 0 ? detail.text : `${current}\n${detail.text}`,
        )
      }
      // A message taken back out of the queue brings its chips with it;
      // otherwise editing one would silently drop what it carried.
      if (detail.attachments && detail.attachments.length > 0) {
        setAttachments((current) => {
          const existing = new Set(current.map((entry) => entry.path))
          const added = detail.attachments!
            .filter((entry) => !existing.has(entry.path))
            .map((entry) => ({ id: nextAttachmentId(), ...entry }))
          return [...current, ...added]
        })
      }
      textarea.current?.focus()
    }
    window.addEventListener('harnessdesk:compose', onCompose)
    return () => window.removeEventListener('harnessdesk:compose', onCompose)
  }, [focused])

  const placeholder = useMemo(() => {
    if (!session && !canType) {
      return snapshot.workspace ? 'Waiting for the runtime…' : 'Choose a project folder to begin'
    }
    if (!session) return 'Describe a task to start a session — / for commands, @ for files'
    if (busy) {
      return canSteer
        ? 'Type the next message — ↵ queues it, ⌘↵ adds it to this turn'
        : 'Type the next message — it is sent when this turn ends'
    }
    if (waiting > 0) {
      return `Adds to the ${waiting} message${waiting === 1 ? '' : 's'} already waiting`
    }
    return 'Describe a task — / for commands, @ for files'
  }, [busy, canSteer, canType, session, snapshot.workspace, waiting])

  // Whether pressing send delivers now or hands the message to the queue.
  // A running turn is the usual reason; a queue held behind a stopped turn
  // is the other, and both put this message behind something.
  const deferred = busy || waiting > 0
  // What the button says on hover. Only when there is something it would not
  // be obvious about — a disabled button explains itself in the placeholder
  // above it, and "Send" on a send button is noise.
  const sendTitle = !canSend
    ? undefined
    : busy
      ? canSteer
        ? 'Sends when this turn ends. ⌘↵ adds it to the turn instead.'
        : 'Sends when this turn ends'
      : waiting > 0
        ? `Goes after the ${waiting} message${waiting === 1 ? '' : 's'} already waiting`
        : undefined

  const menuTitle =
    trigger.kind === 'choose' && trigger.command.kind.type === 'choose'
      ? trigger.command.kind.title
      : trigger.kind === 'command'
        ? 'Commands'
        : undefined

  return (
    <div className={styles.composer}>
      <Slot name="composer.row" />
      <div
        className={`${styles.shell} ${styles.anchor}${dragging ? ` ${styles.dropping}` : ''}`}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {dragging && (
          <div className={styles.dropHint} aria-hidden>
            <ImageIcon size={18} />
            {acceptsImages ? 'Drop images to attach' : `${agentName} does not accept images`}
          </div>
        )}
        {menuOpen && (
          <TriggerMenu
            {...(menuTitle ? { title: menuTitle } : {})}
            items={items}
            activeIndex={active}
            onHover={setActive}
            onPick={pick}
            emptyLabel={trigger.kind === 'file' ? 'No files match' : 'No commands match'}
          />
        )}

        {images.length > 0 && (
          <div className={styles.tiles} role="list" aria-label="Attached images">
            {images.map((image, index) => (
              <div
                key={image.id}
                role="listitem"
                className={`${styles.tile}${acceptsImages ? '' : ` ${styles.tileRefused}`}`}
                title={acceptsImages ? image.name : `${image.name} — ${agentName} does not accept images`}
              >
                <button
                  type="button"
                  className={styles.tileOpen}
                  aria-label={`View ${image.name}`}
                  onClick={() => setPreview(index)}
                >
                  <img className={styles.thumb} src={image.path} alt={image.name} draggable={false} />
                </button>
                <button
                  type="button"
                  className={styles.tileRemove}
                  aria-label={`Remove ${image.name}`}
                  onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== image.id))}
                >
                  <CrossIcon size={11} />
                </button>
                {!acceptsImages && (
                  <span className={styles.tileBadge}>
                    <AlertIcon size={11} />
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {(attachments.length > images.length || handoff) && (
          <div className={styles.attachments}>
            {handoff && (
              <span
                className={`${styles.chip} ${styles.chipHandoff}`}
                title={`${CARRY_LABEL[handoff.carry]} of “${handoff.title}” will be sent first. Click to read the original — the hand-off waits for the next new conversation.`}
              >
                <button
                  type="button"
                  className={styles.chipLink}
                  onClick={() => void store.openSession(handoff.sessionId, { runtime: handoff.runtime })}
                >
                  <HandoffIcon size={12} />
                  <span className={styles.chipText}>
                    From {brandOf(handoff.agentName)} — {handoff.title}
                  </span>
                  <span className={styles.chipMeta}>{CARRY_LABEL[handoff.carry]}</span>
                </button>
                <button
                  type="button"
                  className={styles.chipRemove}
                  aria-label="Remove the hand-off"
                  onClick={() => store.clearDraftHandoff()}
                >
                  <CrossIcon size={10} />
                </button>
              </span>
            )}
            {attachments.filter((entry) => entry.kind !== 'image').map((attachment) => (
              <span
                key={attachment.id}
                className={styles.chip}
                title={
                  attachment.kind === 'context'
                    ? 'Resolved by its plugin when you send.'
                    : attachment.kind === 'note'
                      ? notePreview(attachment)
                      : attachment.path
                }
              >
                {attachment.kind === 'context' ? (
                  <PaperclipIcon size={12} />
                ) : attachment.kind === 'note' ? (
                  <NoteIcon size={12} />
                ) : attachment.kind === 'skill' ? (
                  <SparkIcon size={12} />
                ) : (
                  <FileIcon size={12} />
                )}
                <span className={styles.chipText}>{attachment.name}</span>
                <button
                  type="button"
                  className={styles.chipRemove}
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() =>
                    setAttachments((current) => current.filter((entry) => entry.id !== attachment.id))
                  }
                >
                  <CrossIcon size={10} />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={textarea}
          className={styles.input}
          value={text}
          rows={1}
          placeholder={placeholder}
          disabled={!canType}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            // A screenshot on the clipboard, or image files copied from the
            // file browser, become tiles; text that a chip provider knows
            // becomes its chip; everything else is a paste.
            const pasted = imageFilesOf(event.clipboardData)
            if (pasted.length > 0) {
              event.preventDefault()
              attachImages(pasted, 'paste')
              return
            }
            if (chipForPaste(event.clipboardData.getData('text/plain'))) event.preventDefault()
          }}
          spellCheck
        />

        <div className={styles.toolbar}>
          <input
            ref={filePicker}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(event) => {
              attachImages(event.target.files ? Array.from(event.target.files) : null, 'picker')
              event.target.value = ''
            }}
          />
          <Popover title="Add" drop="up" align="left" label={<PlusIcon size={14} />}>
            {(close) => (
              <>
                <button
                  type="button"
                  className={popoverStyles.option}
                  disabled={!acceptsImages}
                  // The other ways in ride on hover: they are a shortcut for
                  // the row, not a thing to know before taking it. The refusal
                  // stays on screen below — a disabled control cannot be
                  // relied on to show a tooltip at all.
                  title={acceptsImages ? 'Or paste, or drop them here.' : `${agentName} does not accept images.`}
                  onClick={() => {
                    filePicker.current?.click()
                    close()
                  }}
                >
                  <span className={popoverStyles.optionIcon}>
                    <ImageIcon size={13} />
                  </span>
                  <span className={popoverStyles.optionBody}>
                    <span className={popoverStyles.optionLabel}>Attach images…</span>
                    {!acceptsImages && (
                      <div className={popoverStyles.optionHint}>{agentName} does not accept images.</div>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  className={popoverStyles.option}
                  onClick={() => {
                    onChange(text.length > 0 && !text.endsWith(' ') ? `${text} @` : `${text}@`)
                    textarea.current?.focus()
                    close()
                  }}
                >
                  <span className={popoverStyles.optionIcon}>
                    <AtIcon size={13} />
                  </span>
                  <span className={popoverStyles.optionBody}>
                    <span className={popoverStyles.optionLabel}>Add a file — @</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={popoverStyles.option}
                  onClick={() => {
                    onChange('/')
                    textarea.current?.focus()
                    close()
                  }}
                >
                  <span className={popoverStyles.optionIcon}>
                    <SlashIcon size={13} />
                  </span>
                  <span className={popoverStyles.optionBody}>
                    <span className={popoverStyles.optionLabel}>Slash commands — /</span>
                  </span>
                </button>
                {chipProviders.length > 0 && (
                  <>
                    <div className={popoverStyles.groupLabel}>Add context</div>
                    {chipProviders.map((provider) => (
                      <button
                        key={provider.id}
                        type="button"
                        className={popoverStyles.option}
                        onClick={() => {
                          close()
                          if (provider.chip?.prompt) setRefPrompt(provider)
                          else addContext(provider)
                        }}
                      >
                        <span className={popoverStyles.optionIcon}>
                          <PaperclipIcon size={13} />
                        </span>
                        <span className={popoverStyles.optionBody}>
                          <span className={popoverStyles.optionLabel}>
                            {provider.label}
                            {provider.chip?.prompt ? '…' : ''}
                          </span>
                          {provider.chip?.description && (
                            <div className={popoverStyles.optionHint}>{provider.chip.description}</div>
                          )}
                        </span>
                      </button>
                    ))}
                    <div className={popoverStyles.groupLabel}>Project</div>
                  </>
                )}
                <button
                  type="button"
                  className={popoverStyles.option}
                  onClick={() => {
                    onChooseProject()
                    close()
                  }}
                >
                  <span className={popoverStyles.optionIcon}>
                    <FolderOpenIcon size={13} />
                  </span>
                  <span className={popoverStyles.optionBody}>
                    <span className={popoverStyles.optionLabel}>Change project folder…</span>
                  </span>
                </button>
              </>
            )}
          </Popover>
          <AgentControl />
          <PermissionControl />
          <ModeControl />
          <Slot name="composer.action" />
          <span className={styles.spacer} />
          <MoreControl />
          <ContextUsage />
          <ModelControl />
          {/* The corner acts on the turn: it starts one, or it stops the one
              running. Stop therefore takes the exact place the send button
              just occupied, so the pointer that started a turn is already on
              the control that ends it — and once a turn is running Stop does
              not move again, whether or not the next message has been typed.

              The message being written is a different kind of thing and is
              drawn as a different weight, inboard of the corner: filled in
              the ink colour for Stop, and the accent reserved for the send.
              Two saturated coins side by side read as two competing primary
              buttons, which is what this replaces. */}
          {(!busy || canSend) && (
            <button
              type="button"
              className={styles.send}
              data-when={!canSend ? 'nothing' : deferred ? 'later' : 'now'}
              disabled={!canSend}
              onClick={() => void submit()}
              aria-label={deferred ? 'Queue' : 'Send'}
              {...(sendTitle ? { title: sendTitle } : {})}
            >
              <SendIcon size={15} />
            </button>
          )}
          {busy && (
            <button
              type="button"
              className={`${styles.send} ${styles.stop}`}
              onClick={() => void store.interrupt(key)}
              aria-label="Stop"
              title="Stop this turn"
            >
              <StopIcon size={12} />
            </button>
          )}
        </div>
      </div>
      {preview != null && images[preview] && (
        <Lightbox
          images={images.map((image) => ({ url: image.path, name: image.name }))}
          index={preview}
          onClose={() => setPreview(null)}
        />
      )}
      {refPrompt && (
        <RefPrompt
          label={refPrompt.label}
          placeholder={refPrompt.chip?.prompt ?? ''}
          hint={refPrompt.chip?.description}
          onCancel={() => setRefPrompt(null)}
          onConfirm={(ref) => {
            addContext(refPrompt, ref)
            setRefPrompt(null)
            textarea.current?.focus()
          }}
        />
      )}
    </div>
  )
}

/** The one question a context chip may need: which one. */
const RefPrompt = ({
  label,
  placeholder,
  hint,
  onCancel,
  onConfirm,
}: {
  label: string
  placeholder: string
  hint?: string | undefined
  onCancel: () => void
  onConfirm: (ref: string) => void
}) => {
  const [value, setValue] = useState('')
  return (
    <Dialog
      title={label}
      icon={<PaperclipIcon size={16} />}
      onClose={onCancel}
      footer={
        <>
          <Btn variant="primary" disabled={!value.trim()} onClick={() => onConfirm(value)}>
            Attach
          </Btn>
          <Btn onClick={onCancel}>Don&rsquo;t attach</Btn>
        </>
      }
      footerAside="⏎ to attach"
    >
      {hint && <p>{hint}</p>}
      <Input
        autoFocus
        placeholder={placeholder}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && value.trim()) onConfirm(value)
        }}
      />
    </Dialog>
  )
}
