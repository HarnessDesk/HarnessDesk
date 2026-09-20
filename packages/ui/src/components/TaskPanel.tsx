import { Button, Text, Textarea } from '../design'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useActiveSession, useSessionKey, useSnapshot, useStore } from '../state/context'
import { applyPlanEdits, type ShownTodo } from '../lib/plan-edits'
import { sessionPlan } from '../lib/todos'
import { PanelSection } from '../slots/PanelBlocks'
import { registerSlot } from '../slots/registry'
import { TodoDoneIcon, TodoPendingIcon } from './Icons'
import styles from './TaskPanel.module.css'

/**
 * The Tasks panel: the plan the conversation on screen is working to.
 *
 * Read from that conversation — `sessionPlan` returns the last plan its
 * transcript carries — rather than held anywhere beside it. Three things
 * follow from that, and all three were wrong when a plugin owned the panel
 * and kept the list in a variable: each session has its own, a new plan
 * replaces the old one whatever wrote it, and a hand-off carries it because
 * `buildHandoff` reads the same function.
 *
 * A task is editable, and that is the one thing here the transcript does not
 * say. No agent offers a way to set its plan, so the edit is the desk's: it
 * is kept per session, shown over the read, and told to the agent on the next
 * turn — which is what stops it being a second source of truth. See
 * `lib/plan-edits.ts`. Statuses are not editable: ticking a task off is a
 * claim about work, and only the agent doing the work can make it.
 */

const TaskRow = ({ todo }: { todo: ShownTodo }) => {
  const store = useStore()
  const key = useSessionKey()
  const [draft, setDraft] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  /**
   * Committing twice was one keystroke away: Enter commits and closes the
   * field, closing it blurs it, and the blur handler committed again — two
   * identical writes and two `app/state/set` requests per edit.
   */
  const done = useRef(false)

  // Grow to the text rather than scroll it. A plan step is often a sentence,
  // and a fixed one-line box would clip what a person is trying to read while
  // they retype it.
  useLayoutEffect(() => {
    const node = field.current
    if (draft === null || !node) return
    node.style.height = 'auto'
    node.style.height = `${node.scrollHeight}px`
  }, [draft])

  useEffect(() => {
    if (draft !== null) field.current?.select()
  }, [draft !== null])

  const open = (): void => {
    done.current = false
    setDraft(todo.label)
  }

  const commit = (): void => {
    if (draft === null || done.current) return
    done.current = true
    const next = draft.trim()
    setDraft(null)
    // `todo.source` and never `todo.label`: an edit is keyed on what the
    // transcript says, so editing an edited task replaces its edit. `at` is
    // what tells two identical steps apart.
    if (next !== todo.label) store.editPlanTask(todo.source, next, todo.at, key ?? undefined)
  }

  const bullet = (
    <Text role="meta" aria-hidden="true" className={styles.bullet}>
      {todo.done ? <TodoDoneIcon size={12} /> : <TodoPendingIcon size={12} />}
    </Text>
  )

  if (draft !== null) {
    return (
      <Text as="li" role="value" className={styles.item}>
        {bullet}
        <Textarea
          ref={field}
          variant="composer" controlSize="composer" className={styles.input}
          value={draft}
          rows={1}
          aria-label={`Task: ${todo.label}`}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              commit()
            }
            // Escape abandons the edit rather than committing it, which is
            // what every other text field on this desk does.
            if (event.key === 'Escape') {
              event.preventDefault()
              done.current = true
              setDraft(null)
            }
          }}
          spellCheck={false}
        />
      </Text>
    )
  }

  return (
    <Text as="li" role="value" className={styles.item}>
      {bullet}
      <Button
        type="button"
        variant="row" size="row" className={styles.label}
        {...(todo.done ? { 'data-done': '' } : {})}
        title={
          todo.edited
            ? `You reworded this. The agent wrote “${todo.source}”, and is told your wording with your next message.`
            : 'Click to reword this task'
        }
        onClick={open}
      >
        <Text role="value">{todo.label}</Text>
        {todo.active && <Text role="meta" className={styles.hint}>in progress</Text>}
        {/* The panel is a read of the conversation, so where it is showing
            something the conversation does not say, it says so. */}
        {todo.edited && <Text role="meta" className={styles.edited}><em>edited</em></Text>}
      </Button>
    </Text>
  )
}

export const TaskPanel = () => {
  const store = useStore()
  const session = useActiveSession()
  const key = useSessionKey()
  const { planEdits } = useSnapshot()
  const plan = useMemo(() => sessionPlan(session), [session])
  const shown = useMemo(
    () => (plan ? applyPlanEdits(plan, (key && planEdits[key]) || []) : []),
    [plan, key, planEdits],
  )

  /**
   * Retire on the plan, not on the send.
   *
   * An edit the agent has taken up is finished, and it used to be dropped only
   * when the next message went out. An agent that adopted the wording and then
   * moved on — a plan or two later, with nothing typed in between — left the
   * edit standing against a plan that no longer mentioned it, ready to rewrite
   * some later task that reused the old label. The plan changing is the event
   * that settles it, so that is what this watches.
   */
  useEffect(() => {
    if (plan && key) store.retirePlanEdits(plan, key)
  }, [plan, key, store])

  if (shown.length === 0) return null

  const finished = shown.filter((todo) => todo.done).length
  return (
    <PanelSection id="hd.tasks" title={`Tasks · ${finished}/${shown.length}`}>
      <ul className={styles.list}>
        {shown.map((todo) => (
          // A plan may list the same step twice; the label alone is then two
          // rows under one React key, which breaks reconciliation and focus.
          /* Escaped, not the raw byte: a NUL in the source makes the whole
             file binary to grep and to git diff, and the string is identical either way. */
          <TaskRow key={`${todo.source}\0${todo.at}`} todo={todo} />
        ))}
      </ul>
    </PanelSection>
  )
}

/*
 * Above the panel area, which is where docked panels land: the plan belongs
 * with the session list it describes, and anything a person dragged into the
 * sidebar themselves sits under it.
 */
registerSlot('sidebar.panel', 'hd.tasks', TaskPanel, { order: 40 })
