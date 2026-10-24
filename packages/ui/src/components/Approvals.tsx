import { useApprovalKeys } from './use-approval-keys'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { Approval, ApprovalOption } from '@harnessdesk/protocol'

import { useIsFocusedPane, useRuntime, useSessionKey, useSnapshot, useStore } from '../state/context'
import { wholeFileOf, DiffView } from '../editor'
import { boardToolPhrase } from '../lib/tool-names'
import { approvalChoiceOrder } from '../lib/approval-order'
import { boardToolLabel, boardToolNamedBy, boardToolNote, boardToolPlacement, offersPermanentGrant, permissionSummary } from '../lib/board-tool-note'
import { folderShown } from '../lib/projects'
import { AlertIcon, CheckAllIcon, CheckIcon, CrossIcon } from './Icons'
import {
  ApprovalChoiceHint,
  ApprovalCode,
  ApprovalDialog,
  ApprovalFilePath,
  ApprovalMeta,
  ApprovalPermissionList,
  ApprovalQuestionText,
  ApprovalReason,
  Button,
  Text,
  type ApprovalDialogAction,
} from '../design'
import styles from './Approvals.module.css'
import { sanitizeText } from '../lib/sanitize'

/** The glyph for an answer: yes, yes-and-keep-saying-yes, no. */
const INTENT_ICON = {
  approve: <CheckIcon size={13} />,
  alternative: <CheckIcon size={13} />,
  approveAlways: <CheckAllIcon size={13} />,
  deny: <CrossIcon size={13} />,
  cancel: <CrossIcon size={13} />,
} as const

/**
 * The approval dialog.
 *
 * One dialog for every approval kind and every runtime, because the protocol
 * already normalised them. Keyboard-first: an approval interrupts what the user
 * was doing, so answering it should not require reaching for the mouse.
 */

/** Where a key belongs to the field, not to an approval. */

/**
 * How long a key reaching a docked card that took the focus from the composer
 * is still the sentence the person was typing: longer than the gap between
 * two keystrokes of fluent typing, shorter than reading a one-line question.
 */
const TYPED_THROUGH_MS = 500

const titles = (agent: string): Record<Approval['type'], string> => ({
  command: 'Run this command?',
  fileChange: 'Apply these changes?',
  permission: 'Grant additional access?',
  userInput: `${agent} has a question`,
  elicitation: 'A tool needs some information',
})

/** The dialog's title for a command approval, which depends on what is being approved. */
const commandTitle = (approval: Extract<Approval, { type: 'command' }>): string =>
  approval.kind === 'stdin' ? 'Send this input to the running command?' : 'Run this command?'

/**
 * Where a command runs, the way the rest of the app names a folder: the
 * project's short name, or a home-shortened path, with the full path one
 * hover away. In the interface's own type — a folder is a place, and only
 * the command itself is set as code.
 */
const FolderMeta = ({ cwd, home, project }: { cwd: string; home: string | null; project: string | null }) => (
  <ApprovalMeta label="in" kind="folder" title={cwd}>{folderShown(cwd, home, project)}</ApprovalMeta>
)

const CommandBody = ({ approval, home, project }: {
  approval: Extract<Approval, { type: 'command' }>
  home: string | null
  project: string | null
}) =>
  approval.kind === 'stdin' ? (
    // Input to a program that is already running: the text goes first,
    // because it is the thing being approved, and the command it goes to is
    // the context. Codex 0.153.0 asks this for a terminal the agent left
    // running; read as a command to run it said "(unknown command)".
    <>
      {approval.reason && <ApprovalReason className={styles.reason}>{approval.reason}</ApprovalReason>}
      <ApprovalCode className={styles.command}>{approval.input ?? ''}</ApprovalCode>
      <ApprovalMeta label="to">{approval.command}</ApprovalMeta>
      {approval.cwd && <FolderMeta cwd={approval.cwd} home={home} project={project} />}
    </>
  ) : (
    <>
      {approval.reason && <ApprovalReason className={styles.reason}>{approval.reason}</ApprovalReason>}
      <ApprovalCode className={styles.command}>{approval.command}</ApprovalCode>
      {approval.cwd && <FolderMeta cwd={approval.cwd} home={home} project={project} />}
    </>
  )

const FileChangeBody = ({ approval }: { approval: Extract<Approval, { type: 'fileChange' }> }) => (
  <>
    {approval.reason && <ApprovalReason className={styles.reason}>{approval.reason}</ApprovalReason>}
    {approval.changes.length === 0 && (
      <ApprovalReason className={styles.reason}>The runtime wants to write changes to disk.</ApprovalReason>
    )}
    {approval.changes.map((change) => (
      <div key={change.path} className={styles.fileBlock}>
        <ApprovalFilePath className={styles.filePath}>{change.path}</ApprovalFilePath>
        <DiffView diff={change.diff} wholeFile={wholeFileOf(change.kind.type)} />
      </div>
    ))}
  </>
)

const PermissionBody = ({ approval, hideSummary = false }: {
  approval: Extract<Approval, { type: 'permission' }>
  hideSummary?: boolean
}) => (
  <>
    {!hideSummary && !approval.facts?.length && <ApprovalReason className={styles.reason}>{permissionSummary(approval.summary)}</ApprovalReason>}
    {/* Why the agent is asking, when it said. The summary is the tool it wants
        to run; a decision needs the sentence under it — "the file is outside
        the workspace" is the part that answers allow or reject. */}
    {approval.facts?.map(fact => fact.label === 'Command' ? <ApprovalCode key={fact.label}>{sanitizeText(fact.value)}</ApprovalCode> : <ApprovalMeta key={fact.label} label={fact.label}>{sanitizeText(fact.value)}</ApprovalMeta>)}
    {approval.reason && <ApprovalReason className={styles.reason}>{approval.reason}</ApprovalReason>}
    {(approval.filesystem?.length ?? 0) > 0 && (
      <>
        <Text role="muted" as="div">Filesystem</Text>
        <ApprovalPermissionList>
          {approval.filesystem?.map((path) => <li key={path}>{path}</li>)}
        </ApprovalPermissionList>
      </>
    )}
    {(approval.network?.length ?? 0) > 0 && (
      <>
        <Text role="muted" as="div">Network</Text>
        <ApprovalPermissionList>
          {approval.network?.map((host) => <li key={host}>{host}</li>)}
        </ApprovalPermissionList>
      </>
    )}
  </>
)

const UserInputBody = ({
  approval,
  answers,
  onAnswer,
}: {
  approval: Extract<Approval, { type: 'userInput' }>
  answers: Record<string, string[]>
  onAnswer: (questionId: string, optionId: string) => void
}) => (
  <>
    {approval.questions.map((question) => (
      <div key={question.id} className={styles.question}>
        <ApprovalQuestionText>{question.question}</ApprovalQuestionText>
        <div className={styles.choices}>
          {question.options.map((option) => (
            <Button
              key={option.id}
              type="button" variant="choice" size="row" className={styles.choice}
              {...(answers[question.id]?.includes(option.id) ? { 'data-selected': '' } : {})}
              onClick={() => onAnswer(question.id, option.id)}
            >
              <span>
                {option.label}
                {option.description && (
                  <ApprovalChoiceHint className={styles.choiceHint}>{option.description}</ApprovalChoiceHint>
                )}
              </span>
            </Button>
          ))}
        </div>
      </div>
    ))}
  </>
)

/**
 * Rendered inside a pane, for that pane's conversation only: an approval
 * belongs to the agent that asked, and the dialog sits over its transcript so
 * there is never a question of which conversation is asking. Keyboard
 * shortcuts answer only in the focused pane — two agents asking at once must
 * not share one Escape key.
 *
 * `placement="docked"` draws the same question as an inline card rather than
 * over the pane — the room's own use, where the thread belongs to everyone
 * in it and stays readable while one member waits. A
 * docked card traps nothing, so its keys are its own: they answer only from
 * inside the card, never from a field anywhere else in the window. It takes
 * focus only with an explicit `takeFocus`; the room keeps its composer
 * visible and leaves that false. For a caller replacing a focused composer,
 * a key already on its way from that sentence is not an answer (`TYPED_THROUGH_MS`).
 */
export const Approvals = ({ placement = 'overlay', takeFocus = false, requester }: {
  requester?: { name: string; mark?: ReactNode; open: () => void }
  placement?: 'overlay' | 'docked'
  /** Docked only: explicitly transfer focus when replacing a focused control. Inline chat leaves this false. */
  takeFocus?: boolean
} = {}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const runtime = useRuntime()
  const key = useSessionKey()
  const focused = useIsFocusedPane()
  const mine = useMemo(
    () => snapshot.approvals.filter((entry) => entry.key === key),
    [snapshot.approvals, key],
  )
  const approval = mine[0]?.approval
  const TITLES = titles(runtime.presentation.name)
  const title = approval?.type === 'permission' && approval.facts?.length ? approval.summary : approval?.type === 'command' ? commandTitle(approval) : approval ? TITLES[approval.type] : ''
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const scope = useRef<HTMLDivElement>(null)
  const docked = placement === 'docked'
  /* Until when a key reaching a card that took the focus mid-sentence is
     still the sentence's. Focus alone cannot tell the two apart — the
     keystroke in flight lands on the card exactly as a deliberate one does —
     so this is the one window it cannot close; a press on the card itself
     is deliberate and closes it at once. */
  const typedThrough = useRef(0)
  useLayoutEffect(() => {
    typedThrough.current = docked && takeFocus && approval ? Date.now() + TYPED_THROUGH_MS : 0
  }, [docked, takeFocus, approval?.id])
  useEffect(() => {
    const node = scope.current
    if (!docked || !node) return
    const deliberate = (): void => { typedThrough.current = 0 }
    node.addEventListener('pointerdown', deliberate)
    return () => node.removeEventListener('pointerdown', deliberate)
  }, [docked, approval?.id])

  useEffect(() => {
    setAnswers({})
  }, [approval?.id])

  const options: readonly ApprovalOption[] = useMemo(
    () =>
      approval && 'options' in approval
        ? approval.options
        : [
            { id: 'submit', label: 'Send', intent: 'approve' },
            { id: 'cancel', label: 'Cancel', intent: 'cancel' },
          ],
    [approval],
  )
  const namedBoardTool = boardToolNamedBy(approval)
  const boardToolApproval = runtime.capabilities.perToolMcpApproval && runtime.presentation.boardToolApproval
    ? runtime.presentation.boardToolApproval
    : null
  const explainBoardTool = namedBoardTool !== null && boardToolApproval !== null
  const approvalNote = explainBoardTool
    ? boardToolNote({
      phrase: boardToolPhrase(namedBoardTool),
      runtimeName: runtime.presentation.name,
      permanentApprovalSetting: boardToolApproval.permanentApprovalSetting,
      hasPermanentOption: offersPermanentGrant(options),
    })
    : null

  const choose = useCallback(
    (option: ApprovalOption) => {
      if (!approval || !key) return
      if (approval.type === 'userInput') {
        if (option.intent === 'cancel') {
          void store.respondToApproval(key, approval.id, { type: 'cancel' })
          return
        }
        void store.respondToApproval(key, approval.id, { type: 'answers', answers })
        return
      }
      if (approval.type === 'elicitation') {
        if (option.intent === 'cancel') {
          void store.respondToApproval(key, approval.id, { type: 'cancel' })
          return
        }
        void store.respondToApproval(key, approval.id, { type: 'content', value: {} })
        return
      }
      if (option.intent === 'cancel') {
        void store.respondToApproval(key, approval.id, { type: 'cancel' })
        return
      }
      void store.respondToApproval(key, approval.id, { type: 'option', optionId: option.id })
    },
    [answers, approval, key, store],
  )

  useApprovalKeys(scope, Boolean(approval && (docked || focused)), docked,
    options.map((option, index) => ({ shortcut: index + 1, onSelect: () => choose(option) })),
    () => { const deny = options.find(option => option.intent === 'deny') ?? options.at(-1); if (deny) choose(deny) }, typedThrough)

  if (!approval) return null

  const actionOptions = approvalChoiceOrder(options)
  const actions: ApprovalDialogAction[] = actionOptions.map((option) => ({
    id: option.id,
    label: explainBoardTool
      ? boardToolLabel(option, options, {
        session: boardToolApproval?.sessionOptionLabel,
        once: boardToolApproval?.onceOptionLabel,
      })
      : option.label,
    description: option.description,
    icon: INTENT_ICON[option.intent],
    shortcut: options.indexOf(option) + 1,
    // When the card explains a board-tool request, a permanent grant is shown quiet and apart from the plain
    // "Allow", so granting it is a deliberate click and never the filled, default-looking choice.
    placement: explainBoardTool
      ? boardToolPlacement(option)
      : option.intent === 'deny' || option.intent === 'cancel' ? 'safe' : 'proceed',
    tone: option.intent === 'deny' ? 'destructive' : 'default',
    onSelect: () => choose(option),
  }))

  return (
    <ApprovalDialog
      ref={scope}
      title={title}
      icon={<AlertIcon />}
      queue={mine.length > 1 ? `1 of ${mine.length}` : undefined}
      focused={docked ? takeFocus : focused}
      focusKey={approval.id}
      actions={actions}
      placement={placement}
    >
          {requester && <ApprovalMeta label={requester.mark ? <>{requester.mark}<span className="sr-only">From</span></> : 'From'} kind="person"><Text>{sanitizeText(requester.name)}</Text><Button variant="link" size="inline-link" onClick={requester.open}>Open conversation</Button></ApprovalMeta>}
          {approval.type === 'command' && (
            <CommandBody
              approval={approval}
              home={snapshot.home ?? null}
              project={(key && snapshot.sessions.get(key)?.cwd) || snapshot.workspace?.path || null}
            />
          )}
          {approval.type === 'fileChange' && <FileChangeBody approval={approval} />}
          {approval.type === 'permission' && <>
            <PermissionBody approval={approval} hideSummary={explainBoardTool} />
            {approvalNote && <ApprovalReason className={styles.reason} title={approvalNote.title}>{approvalNote.text}</ApprovalReason>}
          </>}
          {approval.type === 'userInput' && (
            <UserInputBody
              approval={approval}
              answers={answers}
              onAnswer={(questionId, optionId) => {
                const question = approval.questions.find((q) => q.id === questionId)
                setAnswers((current) => {
                  const existing = current[questionId] ?? []
                  if (question?.multiSelect) {
                    const next = existing.includes(optionId)
                      ? existing.filter((id) => id !== optionId)
                      : [...existing, optionId]
                    return { ...current, [questionId]: next }
                  }
                  return { ...current, [questionId]: [optionId] }
                })
              }}
            />
          )}
          {approval.type === 'elicitation' && (
            <>
              <ApprovalReason className={styles.reason}>{approval.message}</ApprovalReason>
              <ApprovalCode className={styles.command}>{JSON.stringify(approval.schema, null, 2)}</ApprovalCode>
            </>
          )}
    </ApprovalDialog>
  )
}
