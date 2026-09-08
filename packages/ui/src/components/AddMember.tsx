import { useEffect, useMemo, useState } from 'react'

import {
  sessionKey,
  splitSessionKey,
  type ConfigOption,
  type OptionValue,
  type RuntimeId,
  type SessionKey,
} from '@harnessdesk/protocol'

import { Btn, Dialog, Toggle } from '../design'
import { NativeSelect } from '../design/ui/native-select'
import { groupByProject } from '../lib/projects'
import { sessionLabel } from '../lib/sessions'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import styles from './AddMember.module.css'

/**
 * Putting an agent in the room, from inside the room.
 *
 * There was no way to do this. A member joined because a conversation happened
 * to be open in the folder and happened to take a turn — so adding one meant
 * leaving the room, starting a session, sending something, and coming back to
 * see whether it had appeared. The rail listed the roster and offered no way to
 * change it, which is the one thing a roster is for.
 *
 * The controls are the runtime's own `sessionDefaults`: model, and whatever
 * else that agent declares — effort, approvals, sandbox, mode. They are the
 * same stored picks the composer writes, so choosing here is choosing once.
 *
 * Native selects rather than the segmented control Settings uses: Cursor
 * publishes about thirty models, and thirty segments is not a control.
 *
 * Two ways in, because there are two situations. Starting a fresh agent is the
 * common one. But a project usually already has conversations running on their
 * own — the entry point advertises exactly that — and before this there was no
 * path from one of them into a room at all: the only caller of `joinRoom` was
 * this dialog, immediately after creating a brand-new session.
 */
export const AddMember = ({
  room,
  root,
  onClose,
}: {
  /** The room it joins. */
  readonly room: string
  /** The project the conversation starts in — the room's own. */
  readonly root: string
  readonly onClose: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()

  const agents = snapshot.runtimes
  const [runtime, setRuntime] = useState<RuntimeId | null>(
    snapshot.activeRuntime ?? agents[0]?.id ?? null,
  )
  const [options, setOptions] = useState<readonly ConfigOption[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  /* The conversations this project is already running that are in no room —
     the ones the tree draws at the project's own level.

     Grouped with the sidebar's own resolver, so a worktree's conversation is
     offered under the project it belongs to rather than by a cwd prefix — but
     against the *unfiltered* history, which is where this parts company with
     the sidebar. `useProjectGroups` narrows by `listPrefs.agent` first, which
     is right for a list somebody has deliberately filtered and wrong for a
     dialog promising every loose conversation in the project: with the
     sidebar set to Claude, a loose Codex conversation vanished from here and
     the option disabled itself claiming everything was already placed.

     Anything already in a room is left out: `joinRoom` would move it, and a
     picker that quietly empties another room is not one you can use safely. */
  const loose = useMemo(() => {
    const taken = new Set(
      [...snapshot.teams.values()].flatMap((team) => team.members.map(String)),
    )
    const groups = groupByProject(
      snapshot.history,
      snapshot.workspaces.map((workspace) => workspace.path),
      snapshot.workspace ?? null,
    )
    return (groups.find((group) => group.root === root)?.sessions ?? []).filter(
      (one) => !taken.has(String(sessionKey(one.runtime, one.id))),
    )
  }, [root, snapshot.history, snapshot.teams, snapshot.workspace, snapshot.workspaces])

  const [mode, setMode] = useState<'new' | 'running'>('new')
  const [picked, setPicked] = useState<SessionKey | null>(null)
  /* What is actually selected, which is not the same as what was clicked.
     `picked` outlived the row it names: put that conversation in another room
     from anywhere else and the row disappeared while the button stayed armed,
     and pressing it moved the conversation out of the room it had just joined
     — the exact silent move the exclusion above exists to prevent. Derived
     rather than cleared in an effect, so there is no frame in which the two
     disagree. */
  const choice = loose.some((one) => sessionKey(one.runtime, one.id) === picked) ? picked : null

  useEffect(() => {
    if (!runtime) return
    let cancelled = false
    setOptions(null)
    void store.newSessionDefaultsFor(runtime).then((loaded) => {
      if (!cancelled) setOptions(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [store, runtime])

  /* Each pick re-asks the runtime, because the answer changes the question: a
     model with one context window greys its own Max-mode switch. The composer
     works the same way and this is the same stored record. */
  const pick = (id: string, value: OptionValue): void => {
    if (!runtime) return
    void store.setNewSessionDefault(runtime, id, value).then(setOptions)
  }

  /** Puts a conversation that is already running into the room. */
  const join = async (): Promise<void> => {
    // Checked again here, not only on the button: the answer can change
    // between the render that enabled it and the press.
    if (!choice) return
    setBusy(true)
    setProblem(null)
    const { runtime: held, id } = splitSessionKey(choice)
    try {
      await store.joinRoom(room, held, id)
    } catch (error) {
      setBusy(false)
      setProblem(error instanceof Error ? error.message : 'The room would not take it.')
      return
    }
    onClose()
  }

  const add = async (): Promise<void> => {
    if (!runtime) return
    setBusy(true)
    setProblem(null)
    /* `reveal: false` because main is a slot: showing the new conversation
       would replace the very room being staffed, so pressing "Add to room"
       took you out of it and left you on an empty draft instead. */
    const key = await store.newSession({ cwd: root, runtime, reveal: false })
    if (!key) {
      setBusy(false)
      setProblem('That agent would not start. Check it is signed in, in Settings › Agents.')
      return
    }
    /* Starting it is half the job. Membership is explicit now — a project
       holds several rooms, so being open in the folder cannot mean being in
       one — and a conversation that started and did not join is an agent the
       rail never lists and the board never reaches. */
    const { runtime: started, id } = splitSessionKey(key)
    try {
      await store.joinRoom(room, started, id)
    } catch (error) {
      setBusy(false)
      setProblem(
        error instanceof Error ? error.message : 'It started, but the room would not take it.',
      )
      return
    }
    onClose()
  }

  const chosen = agents.find((one) => one.id === runtime)

  return (
    <Dialog
      title="Add an agent to the room"
      size="md"
      onClose={onClose}
      footer={
        <>
          <Btn
            variant="primary"
            disabled={busy || (mode === 'new' ? !runtime : !choice)}
            onClick={() => void (mode === 'new' ? add() : join())}
          >
            {busy ? (mode === 'new' ? 'Starting…' : 'Adding…') : 'Add to room'}
          </Btn>
          <Btn disabled={busy} onClick={onClose}>
            Cancel
          </Btn>
        </>
      }
    >
      <div className={styles.body}>
        <div className={styles.field}>
          <span className={styles.label}>Which agent</span>
          <div className={styles.modes} role="radiogroup" aria-label="Which agent">
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'new'}
              className={styles.mode}
              onClick={() => setMode('new')}
            >
              Start a new one
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'running'}
              className={styles.mode}
              disabled={loose.length === 0}
              title={
                loose.length === 0
                  ? 'Every conversation in this project is already in a room.'
                  : undefined
              }
              onClick={() => setMode('running')}
            >
              One already running
              {loose.length > 0 && <span className={styles.count}>{loose.length}</span>}
            </button>
          </div>
        </div>

        {mode === 'running' ? (
          <div className={styles.field}>
            <span className={styles.label}>In this project, in no room</span>
            <div className={styles.picker}>
              {loose.map((one) => {
                const key = sessionKey(one.runtime, one.id)
                const agent = snapshot.runtimes.find((each) => each.id === one.runtime)
                return (
                  <label key={String(key)} className={styles.candidate}>
                    <input
                      type="radio"
                      name="member"
                      aria-label={sessionLabel(one.title, one.preview)}
                      checked={choice === key}
                      onChange={() => setPicked(key)}
                    />
                    {agent && <RuntimeMark runtime={agent} size={14} />}
                    <span className={styles.candidateName}>
                      {sessionLabel(one.title, one.preview)}
                    </span>
                    <span className={styles.candidateAgent}>{agent?.presentation.name}</span>
                  </label>
                )
              })}
            </div>
            {/* Joining does not interrupt it: the conversation keeps its
                transcript and whatever it was doing, and gains a board. */}
            <p className={styles.note}>
              It keeps its transcript and carries on — joining adds the board, it does not
              restart anything.
            </p>
          </div>
        ) : (
          <>
        <label className={styles.field}>
          <span className={styles.label}>Agent</span>
          <NativeSelect
            aria-label="Agent"
            value={runtime ?? ''}
            onChange={(event) => setRuntime(event.target.value as RuntimeId)}
          >
            {agents.map((one) => (
              <option key={one.id} value={one.id}>
                {one.presentation.name}
              </option>
            ))}
          </NativeSelect>
        </label>

        {options === null ? (
          <p className={styles.note}>Asking {chosen?.presentation.name ?? 'the agent'}…</p>
        ) : options.length === 0 ? (
          /* Truthful rather than empty: some agents only declare their controls
             once a session exists, so there is nothing to pre-set. */
          <p className={styles.note}>
            {chosen?.presentation.name ?? 'This agent'} declares its controls once a session
            exists, so there is nothing to choose here first.
          </p>
        ) : (
          options.map((option) => (
            <label key={option.id} className={styles.field}>
              <span className={styles.label}>
                {option.label}
                {option.disabled ? <span className={styles.why}>{option.disabled}</span> : null}
              </span>
              {option.type === 'boolean' ? (
                <Toggle
                  label={option.label}
                  on={option.currentValue}
                  disabled={Boolean(option.disabled)}
                  onChange={(next) => pick(option.id, next)}
                />
              ) : (
                <NativeSelect
                  aria-label={option.label}
                  value={String(option.currentValue)}
                  disabled={Boolean(option.disabled)}
                  onChange={(event) => pick(option.id, event.target.value)}
                >
                  {option.choices.map((choice) => (
                    <option
                      key={choice.value}
                      value={choice.value}
                      disabled={Boolean(choice.disabled)}
                    >
                      {choice.label}
                      {choice.disabled ? ` — ${choice.disabled}` : ''}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </label>
          ))
        )}

        <p className={styles.note}>
          {chosen ? <RuntimeMark runtime={chosen} size={13} /> : null} It joins the room as soon
          as it starts, and takes a name of its own.
        </p>
          </>
        )}

        {problem && (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        )}
      </div>
    </Dialog>
  )
}
