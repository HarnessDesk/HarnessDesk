import { useMemo, useState } from 'react'

import type { RuntimeId, UserContent } from '@harnessdesk/protocol'

import { useSnapshot, useStore } from '../state/context'
import { Dialog } from '../design/primitives/Dialog'
import { Btn } from '../design/primitives/Kit'
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
          <Btn variant="primary" disabled={busy || !runtime || prompt.trim().length === 0} onClick={start}>
            {busy ? 'Starting…' : 'Start session'}
          </Btn>
          <Btn disabled={busy} onClick={() => onDone(false)}>
            Cancel
          </Btn>
        </>
      }
    >
      <div className={styles.body}>
        <p className={styles.headline}>{troubleHeadline(trouble)}</p>

        {runtimes.length === 0 ? (
          <div className={styles.error}>
            No agents are set up yet, so there is nobody to ask. Add one in Settings first.
          </div>
        ) : (
          <div className={styles.agents} role="radiogroup" aria-label="Which agent">
            {runtimes.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={runtime === entry.id}
                className={styles.agent}
                {...(runtime === entry.id ? { 'data-on': '' } : {})}
                onClick={() => setRuntime(entry.id)}
              >
                <RuntimeMark runtime={entry} size={16} />
                <span className={styles.agentName}>{entry.presentation.name}</span>
                {runtime === entry.id && (
                  <span className={styles.agentTick}>
                    <CheckIcon size={12} />
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        <label className={styles.field}>
          <span className={styles.label}>What it will be asked — yours to edit</span>
          <textarea
            className={styles.prompt}
            value={prompt}
            rows={12}
            spellCheck={false}
            aria-label="The prompt the agent is sent"
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>

        <span className={styles.note}>
          A new conversation starts in {folder}, and this is its first message. Nothing is sent to the
          conversation you are in now.
        </span>
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
  <div className={styles.trouble}>
    <span className={styles.troubleWhat}>{message}</span>
    {trouble && (
      <Btn small className={styles.troubleDo} onClick={() => onAsk(trouble)}>
        <AgentIcon size={13} />
        Ask an agent to fix this
      </Btn>
    )}
  </div>
)
