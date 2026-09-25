import { useMemo, useState } from 'react'

import type { RuntimeId, UserContent } from '@harnessdesk/protocol'

import { useSnapshot, useStore } from '../state/context'
import {
  ActionError,
  Alert,
  AlertContent,
  AlertDescription,
  Button,
  Dialog,
  Field,
  Note,
  Text,
  Textarea,
} from '../design'
import { RuntimeMark } from './BrandIcons'
import { AgentIcon, CheckIcon } from './Icons'
import { troubleHeadline, troublePrompt, type GitTrouble } from '../lib/git-trouble'
import styles from './GitAskAgent.module.css'

/**
 * "Ask an agent to fix this" — the door out of a git refusal.
 *
 * The history pane already refuses rather than guesses: a rebase that would
 * conflict aborts itself, a merge leaves its conflicts in the tree. Both are
 * honest, and both leave a person holding a problem the app declines to
 * solve. This is the other half of that bargain — the app cannot resolve a
 * conflict, but it is sitting next to several agents that can.
 *
 * What makes it worth a dialog rather than a one-click hand-off:
 *
 * - **The agent is a choice.** Which harness resolves your merge is not a
 *   detail; they differ in what they cost and what they are good at. Every
 *   runtime is offered, the active one first.
 * - **The prompt is visible and editable before it is sent.** A prompt
 *   composed behind someone's back is a prompt they cannot correct, and this
 *   one carries git's own words — which are worth reading anyway.
 * - **It starts a session rather than typing into the current one.** The
 *   conversation you are in is about something else; a conflict is its own
 *   job, in its own thread, in the repository the trouble is in.
 */

export const AskAgentDialog = ({
  trouble,
  onDone,
}: {
  trouble: GitTrouble
  /** `true` when a session was started — the caller closes its own surface. */
  onDone: (started: boolean) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const runtimes = snapshot.runtimes
  const [runtime, setRuntime] = useState<RuntimeId | null>(
    snapshot.activeRuntime ?? runtimes[0]?.id ?? null,
  )
  const [prompt, setPrompt] = useState(() => troublePrompt(trouble))
  const [busy, setBusy] = useState(false)

  const folder = useMemo(() => trouble.root.split('/').filter(Boolean).at(-1) ?? trouble.root, [trouble.root])

  const start = (): void => {
    if (!runtime || busy || prompt.trim().length === 0) return
    setBusy(true)
    void (async () => {
      // The session runs in the repository the trouble is in, which is not
      // always the workspace: a worktree's conflict belongs to that checkout.
      const key = await store.newSession({ cwd: trouble.root, runtime })
      if (!key) {
        setBusy(false)
        return
      }
      // Dispatched, not awaited: the conversation is already on screen behind
      // this dialog, and a modal that waits for the send holds a "Starting…"
      // button over the very thing the person wants to watch. A send that
      // fails says so in a notice, the way every other send does.
      const input: UserContent[] = [{ type: 'text', text: prompt.trim() }]
      void store.send(input, key)
      onDone(true)
    })()
  }

  return (
    <Dialog
      title="Ask an agent to fix this"
      icon={<AgentIcon size={16} />}
      size="lg"
      onClose={() => onDone(false)}
      footer={
        <>
          <Button variant="default" disabled={busy || !runtime || prompt.trim().length === 0} onClick={start}>
            {busy ? 'Starting…' : 'Start session'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => onDone(false)}>
            Cancel
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <Text as="p" role="subject">{troubleHeadline(trouble)}</Text>

        {runtimes.length === 0 ? (
          <ActionError>
            No agents are set up yet, so there is nobody to ask. Add one in Settings first.
          </ActionError>
        ) : (
          <div className={styles.agents} role="radiogroup" aria-label="Which agent">
            {runtimes.map((entry) => (
              <Button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={runtime === entry.id}
                variant="choice" size="row" className={styles.agent}
                {...(runtime === entry.id ? { 'data-on': '' } : {})}
                onClick={() => setRuntime(entry.id)}
              >
                <RuntimeMark runtime={entry} size={16} />
                <Text role="row">{entry.presentation.name}</Text>
                {runtime === entry.id && (
                  <Text tone="brand">
                    <CheckIcon size={12} />
                  </Text>
                )}
              </Button>
            ))}
          </div>
        )}

        <Field label="What it will be asked — yours to edit">
          {(control) => (
            <Textarea
              {...control}
              variant="editor" controlSize="compact" className={styles.prompt}
              value={prompt}
              rows={12}
              spellCheck={false}
              aria-label="The prompt the agent is sent"
              onChange={(event) => setPrompt(event.target.value)}
            />
          )}
        </Field>

        <Note>
          A new conversation starts in {folder}, and this is its first message. Nothing is sent to the
          conversation you are in now.
        </Note>
      </div>
    </Dialog>
  )
}

/**
 * The red block every git surface already shows when something is refused,
 * with the way out attached. The button is part of the refusal rather than a
 * separate affordance somewhere else: the moment a person reads "would not
 * apply cleanly" is the moment they want someone to go and apply it.
 */
export const TroubleNote = ({
  message,
  trouble,
  onAsk,
}: {
  message: string
  /** Null while the caller has nothing an agent could act on. */
  trouble: GitTrouble | null
  onAsk: (trouble: GitTrouble) => void
}) => (
  <Alert tone="danger" role="alert" className={styles.trouble}>
    <AlertContent className={styles.troubleWhat}>
      <AlertDescription>{message}</AlertDescription>
    </AlertContent>
    {trouble && (
      <Button variant="secondary" size="sm" className={styles.troubleDo} onClick={() => onAsk(trouble)}>
        <AgentIcon size={13} />
        Ask an agent to fix this
      </Button>
    )}
  </Alert>
)
