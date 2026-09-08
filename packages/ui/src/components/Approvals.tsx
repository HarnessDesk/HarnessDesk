import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Approval, ApprovalOption } from '@harnessdesk/protocol'

import { useIsFocusedPane, useRuntime, useSessionKey, useSnapshot, useStore } from '../state/context'
import { DiffView } from './Diff'
import { AlertIcon, CheckAllIcon, CheckIcon, CrossIcon } from './Icons'
import styles from './Approvals.module.css'

/**
 * Where the two approving answers sit relative to each other.
 *
 * The rest of the app puts the proceeding action rightmost, nearest the thumb.
 * Here that is the plain yes: `approveAlways` says yes *and* stops asking, so
 * it changes what happens the next time too, and an answer with a tail should
 * not get the easiest target on the row. The runtime's own order still decides
 * the shortcut numbers — this only decides which one your hand lands on.
 */
const approvingLast = (a: ApprovalOption, b: ApprovalOption): number =>
  (a.intent === 'approveAlways' ? 0 : 1) - (b.intent === 'approveAlways' ? 0 : 1)

/** The glyph for an answer: yes, yes-and-keep-saying-yes, no. */
const INTENT_ICON = {
  approve: <CheckIcon size={13} />,
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

const CommandBody = ({ approval }: { approval: Extract<Approval, { type: 'command' }> }) =>
  approval.kind === 'stdin' ? (
    // Input to a program that is already running: the text goes first,
    // because it is the thing being approved, and the command it goes to is
    // the context. Codex 0.153.0 asks this for a terminal the agent left
    // running; read as a command to run it said "(unknown command)".
    <>
      {approval.reason && <p className={styles.reason}>{approval.reason}</p>}
      <pre className={styles.command}>{approval.input ?? ''}</pre>
      <div className={styles.meta}>
        <span className={styles.metaLabel}>to</span>
        <span className={styles.metaValue}>{approval.command}</span>
      </div>
      {approval.cwd && (
        <div className={styles.meta}>
          <span className={styles.metaLabel}>in</span>
          <span className={styles.metaValue}>{approval.cwd}</span>
        </div>
      )}
    </>
  ) : (
    <>
      {approval.reason && <p className={styles.reason}>{approval.reason}</p>}
      <pre className={styles.command}>{approval.command}</pre>
      <div className={styles.meta}>
        <span className={styles.metaLabel}>in</span>
        <span className={styles.metaValue}>{approval.cwd}</span>
      </div>
    </>
  )

const FileChangeBody = ({ approval }: { approval: Extract<Approval, { type: 'fileChange' }> }) => (
  <>
    {approval.reason && <p className={styles.reason}>{approval.reason}</p>}
    {approval.changes.length === 0 && (
      <p className={styles.reason}>The agent wants to write changes to disk.</p>
    )}
    {approval.changes.map((change) => (
      <div key={change.path} className={styles.fileBlock}>
        <div className={styles.filePath}>{change.path}</div>
        <DiffView diff={change.diff} wholeFile={change.kind.type === 'add'} />
      </div>
    ))}
  </>
)

const PermissionBody = ({ approval }: { approval: Extract<Approval, { type: 'permission' }> }) => (
  <>
    <p className={styles.reason}>{approval.summary}</p>
    {/* Why the agent is asking, when it said. The summary is the tool it wants
        to run; a decision needs the sentence under it — "the file is outside
        the workspace" is the part that answers allow or reject. */}
    {approval.reason && <p className={styles.reason}>{approval.reason}</p>}
    {(approval.filesystem?.length ?? 0) > 0 && (
      <>
        <div className={styles.metaLabel}>Filesystem</div>
        <ul className={styles.permissionList}>
          {approval.filesystem?.map((path) => <li key={path}>{path}</li>)}
        </ul>
      </>
    )}
    {(approval.network?.length ?? 0) > 0 && (
      <>
        <div className={styles.metaLabel}>Network</div>
        <ul className={styles.permissionList}>
          {approval.network?.map((host) => <li key={host}>{host}</li>)}
        </ul>
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
        <p className={styles.questionText}>{question.question}</p>
        <div className={styles.choices}>
          {question.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className={styles.choice}
              {...(answers[question.id]?.includes(option.id) ? { 'data-selected': '' } : {})}
              onClick={() => onAnswer(question.id, option.id)}
            >
              <span>
                {option.label}
                {option.description && (
                  <span className={styles.choiceHint}>{option.description}</span>
                )}
              </span>
            </button>
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
 */
export const Approvals = () => {
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
  const title = approval?.type === 'command' ? commandTitle(approval) : approval ? TITLES[approval.type] : ''
  const [answers, setAnswers] = useState<Record<string, string[]>>({})

  useEffect(() => {
    setAnswers({})
  }, [approval?.id])

  const surface = useRef<HTMLDivElement>(null)

  // An approval interrupts, so the window's attention moves onto the card and
  // goes back to whatever the user was doing once it is answered.
  //
  // Not for the shortcuts — those are answered on `document` below and never
  // depended on this. It is for Tab and the screen reader, which until now
  // started at the top of the window rather than at the question; and it takes
  // the caret out of a composer the user has stopped looking at, where the
  // digit they typed next would have answered the approval instead.
  //
  // Only in the focused pane. A background pane renders its approval too, and
  // an agent asking over there must not pull the caret out of the conversation
  // you are typing in.
  useEffect(() => {
    if (!approval || !focused) return
    const returnTo = document.activeElement as HTMLElement | null
    // The surface, not a button: landing on one means a stray Return answers
    // a question nobody read — and here the answer runs a command.
    surface.current?.focus()
    return () => returnTo?.focus?.()
  }, [approval?.id, focused])

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
      if (option.intent === 'cancel') {
        void store.respondToApproval(key, approval.id, { type: 'cancel' })
        return
      }
      void store.respondToApproval(key, approval.id, { type: 'option', optionId: option.id })
    },
    [answers, approval, key, store],
  )

  // Number keys pick an option; Escape denies. An approval blocks the agent, so
  // the fastest safe answer should always be one keystroke away.
  useEffect(() => {
    if (!approval || !focused) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'Escape') {
        event.preventDefault()
        const deny = options.find((option) => option.intent === 'deny') ?? options[options.length - 1]
        if (deny) choose(deny)
        return
      }
      const index = Number(event.key) - 1
      if (Number.isInteger(index) && index >= 0 && index < options.length) {
        event.preventDefault()
        const option = options[index]
        if (option) choose(option)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [approval, choose, focused, options])

  if (!approval) return null

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label={title}>
      <div className={styles.dialog} ref={surface} tabIndex={-1}>
        <div className={styles.header}>
          <AlertIcon className={styles.headerIcon} />
          <span className={styles.title}>{title}</span>
          {mine.length > 1 && <span className={styles.queue}>1 of {mine.length}</span>}
        </div>

        <div className={styles.body}>
          {approval.type === 'command' && <CommandBody approval={approval} />}
          {approval.type === 'fileChange' && <FileChangeBody approval={approval} />}
          {approval.type === 'permission' && <PermissionBody approval={approval} />}
          {approval.type === 'userInput' && (
            <UserInputBody
              approval={approval}
              answers={answers}
              onAnswer={(questionId, optionId) =>
                setAnswers((current) => ({ ...current, [questionId]: [optionId] }))
              }
            />
          )}
          {approval.type === 'elicitation' && (
            <>
              <p className={styles.reason}>{approval.message}</p>
              <pre className={styles.command}>{JSON.stringify(approval.schema, null, 2)}</pre>
            </>
          )}
        </div>

        <div className={styles.footer}>
          {options
            .filter((option) => option.intent === 'deny' || option.intent === 'cancel')
            .map((option) => (
              <button
                key={option.id}
                type="button"
                className={styles.button}
                data-intent={option.intent}
                onClick={() => choose(option)}
                title={option.description}
              >
                {INTENT_ICON[option.intent]}
                {option.label}
                <span className={styles.shortcut}>{options.indexOf(option) + 1}</span>
              </button>
            ))}
          <span className={styles.spacer} />
          {options
            .filter((option) => option.intent === 'approve' || option.intent === 'approveAlways')
            .sort(approvingLast)
            .map((option) => (
              <button
                key={option.id}
                type="button"
                className={styles.button}
                data-intent={option.intent === 'approve' ? 'approve' : undefined}
                onClick={() => choose(option)}
                title={option.description}
              >
                {INTENT_ICON[option.intent]}
                {option.label}
                <span className={styles.shortcut}>{options.indexOf(option) + 1}</span>
              </button>
            ))}
        </div>
      </div>
    </div>
  )
}
