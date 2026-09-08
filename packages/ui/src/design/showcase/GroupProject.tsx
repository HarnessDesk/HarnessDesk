import { useState } from 'react'

import { BrandMark } from '@/components/BrandIcons'
import {
  ArrowLeftIcon,
  BranchIcon,
  FolderIcon,
  ModelIcon,
  MoreIcon,
  PaperclipIcon,
  PlanIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  SessionIcon,
  TeamIcon,
} from '@/components/Icons'
import { ChannelMessage } from '../patterns/ChannelMessage'
import {
  AvatarStack,
  Board,
  BoardCard,
  BoardColumn,
  BoardMenuButton,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  ComposerChip,
  ComposerChips,
  ComposerGap,
  ComposerShell,
  ComposerText,
  ComposerTools,
  IconTile,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  ListRow,
  ListRows,
  Section,
  type StackMember,
} from '../ui'
import { AGENTS, AVAILABLE, COLUMNS, TASKS, type HarnessAgent, type Task } from './group-fixtures'
import { ROOM, THREADS } from './group-threads'
import styles from './group-project.module.css'

/**
 * A group project: several harnesses on one goal, with a board between them.
 *
 * The Team panel this replaces was a channel bolted to the side of the app —
 * agents could talk, and that was all. Talking is the least of it. What a
 * group of agents actually needs is the thing a group of people needs: a list
 * of work, an agreement about who has what, and somewhere to go when you want
 * to know what one of them is actually doing.
 *
 * So the concept is three claims, and the layout is built to make each of them
 * true rather than merely possible.
 *
 * ---------------------------------------------------------------------------
 * 1. A group project is a project, not a mode
 *
 * It sits in the workspace list beside ordinary sessions, at the same density,
 * under its own mark. Not in a separate region, not behind a tab — because the
 * question "what am I working on" should have one list as its answer, and a
 * reader should not have to know which *kind* of thing something is before
 * they can find it. The strip above the panes shows that arrangement.
 *
 * ---------------------------------------------------------------------------
 * 2. The agents are deliberately not alike
 *
 * Four agents on four harnesses: Claude Code for the long refactor, Codex for
 * the test suite, Cursor for quick edits, Gemini for reading a spec nobody
 * wants to read. That heterogeneity IS the feature — a group project exists so
 * you can put the right runtime on the right task — which means the interface
 * has one job it must not fail: **make the choice visible after it is made.**
 *
 * Hence the harness mark rather than initials, everywhere a member appears. On
 * the rail, on a board card, in the composer's addressing chip. "CC" and "CO"
 * are two letters a reader has to learn; the Claude and Codex marks are the
 * ones they already know from the sign-in screen.
 *
 * ---------------------------------------------------------------------------
 * 3. The board, the agent, and the conversation are one triangle
 *
 * This is the whole design. A task names the harness holding it; pressing that
 * harness opens its conversation; the conversation's header names the task and
 * offers the way back. Three surfaces, two clicks, no dead ends — so "why is
 * this still in review" is answered by looking, not by asking.
 *
 * The rail carries it too: an agent's row says what it is on *right now*, so
 * the roster answers "who is doing what" without anything being opened at all.
 *
 * ---------------------------------------------------------------------------
 * What the rail's order encodes
 *
 * Board first, room second, agents after. The board is the project; the room
 * is where the project is discussed; an agent is where one part of it is being
 * done. A reader arriving at a group project wants the state of the work
 * before they want the chatter, and that ordering is the only thing telling
 * them so.
 */

const STATE_DOT: Record<HarnessAgent['state'], string> = {
  working: 'bg-(--hd-success)',
  idle: 'bg-(--hd-muted-foreground)',
  waiting: 'bg-(--hd-warning)',
}

const STATE_WORD: Record<HarnessAgent['state'], string> = {
  working: 'working',
  idle: 'idle',
  waiting: 'waiting on you',
}

/** A member as the avatar stack wants it, wearing its harness mark. */
const asMember = (agent: HarnessAgent, size = 13): StackMember => ({
  name: agent.name,
  mark: <BrandMark brand={agent.brand} size={size} />,
})

export const GroupProject = () => {
  /** 'board' | 'room' | an agent id. One rail drives all three. */
  const [view, setView] = useState<string>('board')
  const [adding, setAdding] = useState(false)
  /**
   * Claims made in this session, over the fixture's own.
   *
   * Claiming has to *move the task*, not just change the view. An earlier
   * version of this screen opened the agent's conversation and left the card
   * unclaimed, so pressing Cursor on an unclaimed task landed you in Cursor's
   * unrelated thread with no task line and no way back &mdash; the triangle
   * broken at exactly the corner it exists for.
   */
  const [claims, setClaims] = useState<Record<string, string>>({})

  const tasks: Task[] = TASKS.map((one) =>
    claims[one.id]
      ? { ...one, agent: claims[one.id] as string, column: one.column === 'open' ? 'claimed' : one.column }
      : one,
  )

  const agent = AGENTS.find((one) => one.id === view) ?? null
  /* The task the agent is on: a claim made here wins over the fixture's, so
     the conversation names the task you just handed it. */
  const task = agent
    ? tasks.find((one) => one.agent === agent.id && claims[one.id] === agent.id) ??
      (agent.onTask ? tasks.find((one) => one.id === agent.onTask) ?? null : null)
    : null
  const messages = agent ? THREADS[agent.id] ?? [] : ROOM

  /** Pressing the harness on a claimed card goes to its conversation. */
  const openAgent = (id: string | null) => id && setView(id)

  /** Claiming assigns the task, then opens the agent that now holds it. */
  const claim = (taskId: string, agentId: string) => {
    setClaims((was) => ({ ...was, [taskId]: agentId }))
    setView(agentId)
  }

  return (
    <div className={styles.frame}>
      <header className={styles.head}>
        <div className={styles.headText}>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <FolderIcon aria-hidden />
                <BreadcrumbLink href="#">harnessdesk</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <TeamIcon aria-hidden />
                <BreadcrumbPage>Auth migration</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <h1 className={styles.title}>Auth migration</h1>
        </div>
        <div className={styles.headActions}>
          <AvatarStack members={AGENTS.map((one) => asMember(one))} max={4} />
          <Button variant="outline" onClick={() => setAdding((on) => !on)}>
            <PlusIcon /> Add agent
          </Button>
        </div>
      </header>

      {/* Choosing the harnesses is the act that creates a group project, so the
          picker shows what it is really choosing between: not four accounts,
          four runtimes with different strengths. */}
      {adding && (
        <Section variant="quiet" className={styles.picker}>
          <div className={styles.pickerLabel}>Add a harness to this project</div>
          <div className={styles.pickerGrid}>
            {AVAILABLE.map((one) => (
              <button key={one.name} type="button" className={styles.pickerItem}>
                <IconTile size="sm">
                  <BrandMark brand={one.brand} size={13} />
                </IconTile>
                <span className={styles.pickerName}>{one.name}</span>
                <span className={styles.pickerNote}>{one.note}</span>
              </button>
            ))}
          </div>
        </Section>
      )}

      {/* What the workspace list looks like once a group project is one of the
          things in it: the same rows, a different mark, a member count. */}
      <Section variant="quiet" className={styles.workspaceNote}>
        <div className={styles.workspaceLabel}>In the workspace</div>
        <ListRows size="sm">
          <ListRow
            size="sm"
            interactive
            selected
            lead={
              <IconTile size="sm" tint="violet">
                <TeamIcon />
              </IconTile>
            }
            title="Auth migration"
            trail={<AvatarStack members={AGENTS.map((one) => asMember(one, 11))} size="sm" max={4} />}
          />
          <ListRow
            size="sm"
            interactive
            lead={
              <IconTile size="sm">
                <SessionIcon />
              </IconTile>
            }
            title="Trace the flaky socket test"
            trail="DeepSeek Harness"
          />
          <ListRow
            size="sm"
            interactive
            lead={
              <IconTile size="sm">
                <SessionIcon />
              </IconTile>
            }
            title="Rewrite the release notes"
            trail="Cursor"
          />
        </ListRows>
      </Section>

      <Section className={styles.pane}>
        {/* ---- the rail: board, room, then the harnesses ------------------ */}
        <aside className={styles.rail}>
          <div className={styles.railHead}>
            <IconTile tint="violet" size="lg">
              <TeamIcon />
            </IconTile>
            <div className={styles.railHeadText}>
              <div className={styles.railTitle}>Auth migration</div>
              <div className={styles.railSub}>
                {AGENTS.length} harnesses &middot; {TASKS.filter((t) => t.agent).length} claimed
              </div>
            </div>
            <Button variant="ghost" size="icon" aria-label="Project menu">
              <MoreIcon />
            </Button>
          </div>

          <div className={styles.railSearch}>
            <InputGroup>
              <InputGroupAddon align="inline-start">
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput placeholder="Find a task or agent" aria-label="Find a task or agent" />
            </InputGroup>
          </div>

          {/* The project before the chatter. */}
          <div className={styles.railPinned}>
            <ListRow
              size="sm"
              interactive
              selected={view === 'board'}
              onClick={() => setView('board')}
              lead={
                <IconTile size="sm" tint="violet">
                  <PlanIcon />
                </IconTile>
              }
              title="Board"
              subtitle={`${TASKS.filter((t) => !t.agent).length} unclaimed`}
              trail={<span className={styles.count}>{TASKS.length}</span>}
            />
            <ListRow
              size="sm"
              interactive
              selected={view === 'room'}
              onClick={() => setView('room')}
              lead={
                <IconTile size="sm" tint="violet">
                  <TeamIcon />
                </IconTile>
              }
              title="Team room"
              subtitle="Everyone on this project"
              trail={<span className={styles.unread}>3</span>}
            />
          </div>

          <div className={styles.railLabel}>Harnesses</div>
          <ListRows size="sm" className={styles.railList}>
            {AGENTS.map((one) => {
              const onTask = one.onTask ? TASKS.find((t) => t.id === one.onTask) : null
              return (
                <ListRow
                  key={one.id}
                  size="sm"
                  interactive
                  selected={view === one.id}
                  onClick={() => setView(one.id)}
                  lead={
                    <span className={styles.face}>
                      <IconTile size="sm" tint={one.tint}>
                        <BrandMark brand={one.brand} size={13} />
                      </IconTile>
                      <span aria-hidden className={`${styles.presence} ${STATE_DOT[one.state]}`} />
                    </span>
                  }
                  title={one.name}
                  /* Not the last message — what it is *on*. The rail answers
                     "who is doing what" without anything being opened. */
                  subtitle={onTask ? onTask.title : one.reason}
                  trail={
                    one.unread != null ? <span className={styles.unread}>{one.unread}</span> : null
                  }
                />
              )
            })}
          </ListRows>
        </aside>

        {/* ---- the right pane: board, room, or one agent ------------------ */}
        <div className={styles.thread}>
          {view === 'board' ? (
            <BoardView tasks={tasks} onOpenAgent={openAgent} onClaim={claim} />
          ) : (
            <Conversation
              agent={agent}
              task={task}
              messages={messages}
              onBackToBoard={() => setView('board')}
            />
          )}
        </div>
      </Section>
    </div>
  )
}

/* --- the board ------------------------------------------------------------
   Columns are states, so no card repeats its own. What a card *does* carry
   that an ordinary kanban card does not is the harness holding it, as a
   pressable mark: that press is the task-to-conversation edge of the triangle,
   and it is the reason this board belongs next to the chats rather than in a
   tool of its own. */

const BoardView = ({
  tasks,
  onOpenAgent,
  onClaim,
}: {
  tasks: Task[]
  onOpenAgent: (id: string | null) => void
  onClaim: (taskId: string, agentId: string) => void
}) => (
  <>
    <header className={styles.threadHead}>
      <IconTile tint="violet" size="lg">
        <PlanIcon />
      </IconTile>
      <div className={styles.threadWho}>
        <div className={styles.threadName}>Board</div>
        <div className={styles.threadState}>
          {tasks.filter((t) => !t.agent).length} unclaimed &middot;{' '}
          {tasks.filter((t) => t.column === 'review').length} waiting on you
        </div>
      </div>
      <Button variant="outline" size="sm">
        <PlusIcon /> New task
      </Button>
    </header>

    <div className={styles.boardBody}>
      <Board>
        {COLUMNS.map((column) => {
          const cards = tasks.filter((one) => one.column === column.id)
          return (
            <BoardColumn
              key={column.id}
              title={column.title}
              count={cards.length}
              tint={column.tint}
              onAdd={() => undefined}
              addLabel="Add task"
              actions={<BoardMenuButton />}
            >
              {cards.map((one) => (
                <TaskCard
                  key={one.id}
                  task={one}
                  onOpenAgent={onOpenAgent}
                  onClaim={onClaim}
                />
              ))}
            </BoardColumn>
          )
        })}
      </Board>
    </div>
  </>
)

const TaskCard = ({
  task,
  onOpenAgent,
  onClaim,
}: {
  task: Task
  onOpenAgent: (id: string | null) => void
  onClaim: (taskId: string, agentId: string) => void
}) => {
  const holder = AGENTS.find((one) => one.id === task.agent) ?? null

  return (
    <BoardCard
      title={task.title}
      priority={task.priority}
      tag={task.scope ? { label: task.scope, tint: 'teal' } : undefined}
      attachments={task.attachments}
      comments={task.comments}
      actions={<BoardMenuButton />}
      cover={
        holder ? (
          /* The harness, pressable. This is the edge of the triangle: from a
             task to the conversation doing it, in one press. */
          <button
            type="button"
            className={styles.holder}
            onClick={() => onOpenAgent(holder.id)}
            title={`Open ${holder.name}'s conversation`}
          >
            <IconTile size="sm" tint={holder.tint}>
              <BrandMark brand={holder.brand} size={12} />
            </IconTile>
            <span className={styles.holderName}>{holder.name}</span>
            <span className={styles.holderModel}>{holder.model}</span>
          </button>
        ) : (
          /* Unclaimed is where the heterogeneity becomes a decision rather
             than a fact: the row is the list of harnesses you could put on it. */
          <div className={styles.claim}>
            <span className={styles.claimLabel}>Claim with</span>
            {AGENTS.map((one) => (
              <button
                key={one.id}
                type="button"
                className={styles.claimMark}
                title={`Claim with ${one.name} — ${one.reason}`}
                aria-label={`Claim "${task.title}" with ${one.name}`}
                onClick={() => onClaim(task.id, one.id)}
              >
                <BrandMark brand={one.brand} size={13} />
              </button>
            ))}
          </div>
        )
      }
    />
  )
}

/* --- one agent's conversation ---------------------------------------------
   The same thread an individual session gets — this is deliberately not a
   reduced version. A group project federates conversations; it does not
   replace them. What is added is the line saying which task this is, and the
   way back to the board. */

const Conversation = ({
  agent,
  task,
  messages,
  onBackToBoard,
}: {
  agent: HarnessAgent | null
  task: Task | null
  messages: React.ComponentProps<typeof ChannelMessage>[]
  onBackToBoard: () => void
}) => (
  <>
    <header className={styles.threadHead}>
      <IconTile tint={agent?.tint ?? 'violet'} size="lg">
        {agent ? <BrandMark brand={agent.brand} size={18} /> : <TeamIcon />}
      </IconTile>
      <div className={styles.threadWho}>
        <div className={styles.threadName}>{agent?.name ?? 'Team room'}</div>
        <div className={styles.threadState}>
          {agent ? (
            <>
              <span aria-hidden className={`${styles.presence} ${STATE_DOT[agent.state]}`} />
              {agent.model} &middot; {STATE_WORD[agent.state]}
            </>
          ) : (
            'Everyone on this project reads this'
          )}
        </div>
      </div>
      {!agent && <AvatarStack members={AGENTS.map((one) => asMember(one))} max={4} />}
      <Button variant="ghost" size="icon" aria-label="Conversation menu">
        <MoreIcon />
      </Button>
    </header>

    {/* The third edge: the conversation names its task and offers the way
        back, so the triangle closes rather than stranding the reader. */}
    {task && (
      <button type="button" className={styles.onTask} onClick={onBackToBoard}>
        <ArrowLeftIcon aria-hidden />
        <PlanIcon aria-hidden />
        <span className={styles.onTaskTitle}>{task.title}</span>
        <span className={styles.onTaskBack}>Back to board</span>
      </button>
    )}

    <div className={styles.messages}>
      {messages.map((message, index) => (
        <ChannelMessage key={index} {...message} />
      ))}
    </div>

    <div className={styles.composer}>
      <ComposerShell>
        <ComposerChips>
          <ComposerChip>
            {agent ? (
              <>
                <BrandMark brand={agent.brand} size={11} /> To {agent.name}
              </>
            ) : (
              'To everyone'
            )}
          </ComposerChip>
          {task && <ComposerChip onRemove={() => undefined}>{task.title}</ComposerChip>}
        </ComposerChips>
        <ComposerText
          placeholder={agent ? `Message ${agent.name}…` : 'Message everyone on this project…'}
        />
        <ComposerTools>
          <Button variant="ghost" size="icon-sm" aria-label="Attach">
            <PaperclipIcon />
          </Button>
          <Button variant="ghost" size="sm">
            <ModelIcon /> {agent?.model ?? 'Per harness'}
          </Button>
          <ComposerGap />
          <Button size="sm">
            <SendIcon /> Send
          </Button>
        </ComposerTools>
      </ComposerShell>
    </div>
  </>
)
