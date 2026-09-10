import { useState, type JSX } from 'react'

import { BranchIcon, FolderIcon, PluginIcon, TerminalIcon } from '../../components/Icons'
import {
  Banner,
  BannerAction,
  Btn,
  ChannelMessage,
  ChannelSignal,
  Chip,
  ConfirmDialog,
  DetailHead,
  Dialog,
  Dot,
  IconBtn,
  PageHead,
  Row,
  RowButton,
  RowChoice,
  Rows,
  SectionHead,
  Segmented,
  Select,
  Toggle,
} from '..'
import styles from './explorer.module.css'

/**
 * What the system is, rendered by the system.
 *
 * Every board below imports the real component from `../index` — the same
 * module the ten settings screens and the notification stack import. There is
 * no second copy of a button on this page to fall out of date: if a board
 * looks wrong, the app looks wrong, which is the only arrangement that stays
 * honest.
 *
 * That was not true of the first version of this file. It rendered a parallel
 * set of primitives written for the explorer, which looked tidy here and
 * described an app nobody was running.
 */

export type Board = {
  id: string
  title: string
  /** What this piece is for, and the rule for reaching for it. */
  about: string
  render: () => JSX.Element
}

/** A labelled cell in a state matrix. */
const Case = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className={styles.case}>
    <div className={styles.caseLabel}>{label}</div>
    <div className={styles.caseBody}>{children}</div>
  </div>
)

const ButtonBoard = () => (
  <>
    <div className={styles.matrix}>
      {([undefined, 'primary', 'quiet', 'danger'] as const).map((variant) => (
        <Case key={variant ?? 'default'} label={variant ?? 'default'}>
          <Btn variant={variant}>Continue</Btn>
          <Btn variant={variant} disabled>
            Continue
          </Btn>
          <Btn variant={variant} small>
            Small
          </Btn>
        </Case>
      ))}
      <Case label="icon only">
        <IconBtn aria-label="Terminal">
          <TerminalIcon size={14} />
        </IconBtn>
        <IconBtn aria-label="Folder">
          <FolderIcon size={14} />
        </IconBtn>
      </Case>
    </div>
    <p className={styles.rule}>
      At most one <code>primary</code> per surface — it is the thing the surface exists for. Anything
      that throws work away is <code>danger</code>, which reads as red text on the ordinary ground
      until the pointer commits it, so nobody deletes by reflex.
    </p>
    <p className={styles.rule}>
      The shape is not written in this component. It comes from{' '}
      <code>--hd-btn-radius</code>, <code>--hd-btn-h</code> and the rest of the button block in{' '}
      <code>tokens.css</code>, which is why the <strong>Pill buttons</strong> foundation above
      restyles every button in the app without touching a line of TSX.
    </p>
  </>
)

const StateBoard = () => (
  <>
    <div className={styles.matrix}>
      <Case label="dot">
        <Dot state="ready" />
        <Dot state="available" />
        <Dot state="signin" />
        <Dot state="limit" />
        <Dot state="broken" />
      </Case>
      <Case label="chip">
        <Chip state="ready" />
        <Chip state="available" />
        <Chip state="signin" />
      </Case>
      <Case label="chip, said better">
        <Chip state="limit" label="Out of weekly credit until Thursday" />
        <Chip state="broken" label="No executable at that path" />
      </Case>
    </div>
    <p className={styles.rule}>
      One vocabulary of five states, so a colour means the same thing in the sidebar, on a settings
      row and in the account list. Pass <code>label</code> only to say something more specific than
      the state&rsquo;s own name — never to say something different.
    </p>
  </>
)

const ControlBoard = () => {
  const [on, setOn] = useState(true)
  const [effort, setEffort] = useState<'low' | 'medium' | 'high'>('medium')
  return (
    <>
      <div className={styles.matrix}>
        <Case label="toggle">
          <Toggle on={on} onChange={setOn} label="Start sessions in a worktree" />
          <Toggle on={false} onChange={() => {}} label="Off" />
          <Toggle on label="Managed by the agent" />
        </Case>
        <Case label="select">
          <Select
            label="Model"
            value="default"
            options={[
              { value: 'default', label: "The agent's default" },
              { value: 'fast', label: 'Fast' },
            ]}
            onChange={() => {}}
          />
        </Case>
        <Case label="segmented">
          <Segmented
            label="Reasoning effort"
            value={effort}
            onChange={setEffort}
            options={[
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ]}
          />
        </Case>
      </div>
      <p className={styles.rule}>
        A toggle is a <code>&lt;button role=&quot;switch&quot;&gt;</code> rather than a checkbox
        because every one of these takes effect the moment it is pressed — there is no form to
        submit. Passing no <code>onChange</code> is how a control says the agent owns this setting;
        it disables itself rather than lying about being editable.
      </p>
    </>
  )
}

const RowBoard = () => {
  const [choice, setChoice] = useState('ask')
  return (
    <>
      <div className={styles.stack}>
        <SectionHead name="Plugins" action={<Btn variant="outline" small>Add</Btn>} />
        <Rows>
          <Row
            mark={<PluginIcon size={15} />}
            title="Browser"
            desc="Drive a page and read it back."
            control={<Toggle on onChange={() => {}} label="Browser" />}
          />
          <Row
            mark={<PluginIcon size={15} />}
            title="Filesystem"
            desc="~/.harnessdesk/plugins/fs"
            control={<Toggle on={false} onChange={() => {}} label="Filesystem" />}
          />
          <RowButton
            mark={<BranchIcon size={15} />}
            title="Worktrees"
            desc="Two checkouts on this machine"
            onClick={() => {}}
          />
        </Rows>

        <SectionHead name="When an agent asks to run something" />
        <Rows>
          {[
            { id: 'ask', title: 'Ask every time', desc: 'Nothing runs until you say so.' },
            { id: 'session', title: 'Ask once a session', desc: 'The first yes covers the rest.' },
            { id: 'never', title: 'Never ask', desc: 'Everything runs. Worktrees only.' },
          ].map((option) => (
            <RowChoice
              key={option.id}
              title={option.title}
              desc={option.desc}
              selected={choice === option.id}
              onClick={() => setChoice(option.id)}
            />
          ))}
        </Rows>
      </div>
      <p className={styles.rule}>
        A row has no opinion about what its control is — that is what lets twelve settings pages
        stay the same height. Only a row that <em>does</em> something is a{' '}
        <code>&lt;button&gt;</code>, and a row ends in a chevron <em>or</em> a control, never both.
      </p>
    </>
  )
}

const HeadBoard = () => (
  <>
    <div className={styles.stack}>
      <PageHead
        title="Agents"
        blurb="Which coding agents this app can start a session with."
        actions={<Btn variant="default">Add an agent</Btn>}
      />
      <DetailHead
        mark={<PluginIcon size={22} />}
        name="Browser"
        owner="built in"
        blurb="Drive a page and read it back. Available to agents that accept plugin tools."
        actions={<Btn small>Remove</Btn>}
      />
    </div>
    <p className={styles.rule}>
      20px and 600 weight name the app and a sheet; a page title is 16px at 500. That is the whole
      heading scale — a screen that wants a third size is asking for a size the system does not
      have.
    </p>
  </>
)

const BannerBoard = () => (
  <>
    <div className={styles.stack}>
      <Banner tone="neutral" title="A newer version of the agent is available." onDismiss={() => {}}>
        1.4.2 is installed; 1.5.0 adds the thing you asked about.
      </Banner>
      <Banner
        tone="info"
        title="Signed in."
        actions={<BannerAction onClick={() => {}}>Open settings</BannerAction>}
        onDismiss={() => {}}
      >
        Sessions you start now run as this account.
      </Banner>
      <Banner tone="warning" title="The turn did not finish." onDismiss={() => {}}>
        Three queued messages are still waiting. They will be sent when it does.
      </Banner>
      <Banner
        tone="danger"
        title="The agent stopped responding."
        actions={
          <>
            <BannerAction onClick={() => {}}>Restart</BannerAction>
            <BannerAction variant="secondary" onClick={() => {}}>
              Show log
            </BannerAction>
          </>
        }
        onDismiss={() => {}}
      >
        It exited while the turn was open. Nothing was lost.
      </Banner>
      <Banner tone="info" compact role="status" onDismiss={() => {}}>
        Copied the transcript.
      </Banner>
    </div>
    <p className={styles.rule}>
      The card stays neutral in every tone. Colour that floods a banner reads as an emergency
      whatever it says, and most of these are not — so severity is carried by the icon alone.
    </p>
    <p className={styles.rule}>
      Every banner can be put away, and the toast form is the same component with{' '}
      <code>compact</code> — which is what stops the fourth kind of message from inventing a fourth
      look.
    </p>
    <p className={styles.rule}>
      <strong>Known disagreement.</strong> <code>BannerAction</code> is the only control in the app
      drawn as a 34px pill on the platform&rsquo;s primary fill; every other button is a 26px
      bordered control on the brand blue. The <strong>Pill buttons</strong> foundation is what
      settling that in the banner&rsquo;s favour would look like.
    </p>
  </>
)

const DialogBoard = () => {
  const [open, setOpen] = useState<null | 'plain' | 'confirm'>(null)
  return (
    <>
      <div className={styles.matrix}>
        <Case label="open one">
          <Btn onClick={() => setOpen('plain')}>Dialog</Btn>
          <Btn variant="danger" onClick={() => setOpen('confirm')}>
            Delete conversation
          </Btn>
        </Case>
      </div>
      {open === 'plain' && (
        <Dialog
          title="Add a workspace"
          icon={<FolderIcon size={16} />}
          onClose={() => setOpen(null)}
          footer={
            <>
              <Btn variant="primary" onClick={() => setOpen(null)}>
                Add
              </Btn>
              <Btn onClick={() => setOpen(null)}>Cancel</Btn>
            </>
          }
          footerAside="⌘⏎ to add"
        >
          Sessions you start in this folder are grouped under it, and worktrees are cut from it.
        </Dialog>
      )}
      {open === 'confirm' && (
        <ConfirmDialog
          title="Delete conversation"
          confirmLabel="Delete"
          onConfirm={() => setOpen(null)}
          onCancel={() => setOpen(null)}
        >
          This removes <strong>Review the sprint notes</strong> from the agent, and the transcript
          HarnessDesk kept of it. It will not be in either window afterwards.
        </ConfirmDialog>
      )}
      <p className={styles.rule}>
        Actions sit bottom-right with the proceeding one rightmost, because that is where every
        macOS dialog puts them; it is written first, so it is also the first one Tab reaches.
        Nothing is focused on open, so a stray Return cannot confirm. Escape closes either dialog; a
        click on the ground closes only the plain one, because a question has to be answered.
      </p>
      <p className={styles.rule}>
        The cancel action says the verb for keeping things as they are — <code>Keep</code>, not{' '}
        <code>Cancel</code>. Someone reading quickly sees two verbs and picks one;{' '}
        <code>Cancel</code> beside <code>Delete</code> reads as two ways to stop.
      </p>
    </>
  )
}

/**
 * The team channel, with the traffic from a real run: the user opens the
 * board, Codex claims and finishes work, Cursor reviews it and messages the
 * verdict — including the refusal the host issued when Cursor addressed a
 * conversation by a name nobody has.
 *
 * Shown at both densities, because the same channel is read in two places
 * that are not the same size: the 360px Team panel, where it is a glance, and
 * the room pane, where it *is* the conversation and should read like every
 * chat window the reader has ever used.
 */
const ChannelBoard = () => (
  <div className={styles.stack}>
    <Case label="the story of a piece of work">
      <div className={styles.channel}>
        <ChannelSignal by="You" said="added #1 — verify never builds the renderer · script/verify.mjs" at="03:29 PM" />
        <ChannelSignal by="Reviewer" said="claimed #1 — verify never builds the renderer" at="03:30 PM" />
        <ChannelSignal by="Reviewer" said="completed #1 — Committed 86e1bdb: verify now runs the root build." at="03:31 PM" />
        <ChannelSignal by="Builder" said="claimed #2 — Review the verify fix" at="03:33 PM" />
        <ChannelMessage
          from="Builder"
          brand="cursor"
          tint="violet"
          to="Reviewer"
          at="03:34 PM"
          state="delivered"
          refusedFirst={'no conversation in this room is named “(untitled)”. In this room: Reviewer.'}
          text={REVIEW_TEXT}
        />
        <ChannelMessage
          from="Reviewer"
          brand="codex"
          tint="green"
          to="Builder"
          at="03:35 PM"
          state="delivered"
          text="Understood — taking the CI parity point as the headline in the commit message."
        />
        <ChannelMessage
          from="Reviewer"
          brand="codex"
          tint="green"
          at="03:35 PM"
          state="delivered"
          grouped
          text="Nothing else is open on my side."
        />
      </div>
    </Case>

    <Case label="room density — the same channel, at the size it is the conversation">
      <div className={styles.channelRoom}>
        <ChannelSignal
          by="You"
          said="added #1 — verify never builds the renderer · script/verify.mjs"
          at="03:29 PM"
          density="room"
        />
        <ChannelSignal
          by="Reviewer"
          said="claimed #1 — verify never builds the renderer"
          at="03:30 PM"
          density="room"
        />
        <ChannelMessage
          from="Builder"
          brand="cursor"
          tint="violet"
          to="Reviewer"
          at="03:34 PM"
          state="delivered"
          density="room"
          envelope={'Message from Builder — “Review the verify fix”\n\nThe verify fix looks right.'}
          text="The verify fix looks right — root build, then the suites. One thing: the fixture copy runs before the renderer build, so a changed fixture needs two runs to land."
        />
        <ChannelMessage
          from="Reviewer"
          brand="codex"
          tint="green"
          at="03:35 PM"
          state="delivered"
          density="room"
          text="Understood — taking the CI parity point as the headline in the commit message."
        />
        <ChannelMessage
          from="Reviewer"
          brand="codex"
          tint="green"
          at="03:35 PM"
          state="delivered"
          grouped
          density="room"
          text="Nothing else is open on my side."
        />
      </div>
    </Case>

    <Case label="states — held, refused, queued">
      <div className={styles.channel}>
        <ChannelMessage
          from="Builder"
          brand="cursor"
          tint="violet"
          to="Reviewer"
          at="03:40 PM"
          state="held"
          reason="The receiver holds inbound messages; release it when you want it read."
          text="Picking up #4 once you land the rename."
          onDeliver={() => {}}
        />
        <ChannelMessage
          from="Smoke runner"
          brand="anthropic"
          tint="amber"
          at="03:41 PM"
          state="refused"
          reason={'no conversation in this room is named “build-bot”. In this room: Reviewer, Builder.'}
          text="@build-bot can you re-run the packaged smoke?"
        />
        <ChannelMessage
          from="You"
          tint="blue"
          to="Reviewer"
          at="03:42 PM"
          state="queued"
          reason="The reviewer is mid-turn; this lands when the turn ends."
          text="When you get a moment — does the gate need the renderer in CI too?"
        />
      </div>
    </Case>

    <p className={styles.rule}>
      Two densities, one implementation. The panel is a glance in 360px: a 24px
      mark, 13px type, and the time and delivery state floated right, where a
      long name cannot push them off. The room is the conversation at full pane
      width: a 36px mark, 14px body, and the attribution as one run at the left
      &mdash; name, who it reached, when, and how it went &mdash; with a
      full-bleed highlight under the row the pointer is on. Both come from one{' '}
      <code>DENSITY</code> table in <code>ChannelMessage</code>; the envelope is
      held back until the pointer or the keyboard arrives, because it is a
      diagnostic rather than part of reading.
    </p>
  </div>
)

const REVIEW_TEXT = `Reviewed your 86e1bdb fix. Verdict: correct and complete.

1. CATCHES BROKEN RENDERER: Yes. Before, verify ran build:node (tsc only — server packages). A broken Vite import, bad CSS module, or asset issue in @harnessdesk/ui sailed through. Now it runs the full build, which includes vite build. That's the class of error tsc cannot see.

2. CI PARITY: This was the real win. CI (ci.yml line 40) was already running pnpm run build. The local gate was running build:node — a strict subset. verify.mjs lines 6-9 literally warn about this exact drift. The fix closes it.

3. SPEED: Yes, it adds the Vite bundle to every verify run — probably 5-15s. But CI was already paying that cost, and the alternative (green local / red CI) is worse.

One-line fix, right target, no regressions. Ship it.`

export const BOARDS: Board[] = [
  {
    id: 'button',
    title: 'Btn · IconBtn',
    about: 'One button; the variant says what pressing it costs.',
    render: ButtonBoard,
  },
  {
    id: 'state',
    title: 'Dot · Chip',
    about: 'Whether a thing is ready, said the same way everywhere.',
    render: StateBoard,
  },
  {
    id: 'control',
    title: 'Toggle · Select · Segmented',
    about: 'Answering a question that takes effect immediately.',
    render: ControlBoard,
  },
  {
    id: 'row',
    title: 'Rows · Row · RowChoice',
    about: 'The line every settings page is built out of.',
    render: RowBoard,
  },
  {
    id: 'head',
    title: 'PageHead · DetailHead',
    about: 'Naming the screen you are on, and the thing you drilled into.',
    render: HeadBoard,
  },
  {
    id: 'banner',
    title: 'Banner',
    about: 'Something the app needs to say that nobody asked for.',
    render: BannerBoard,
  },
  {
    id: 'channel',
    title: 'Channel',
    about:
      'Agents talking to each other, and the board recording what they did. A face finds the sender, a run of messages groups, a long review folds, and a retry after a refusal is one message rather than two copies.',
    render: ChannelBoard,
  },
  {
    id: 'dialog',
    title: 'Dialog · ConfirmDialog',
    about: 'A surface that takes the window until it is answered.',
    render: DialogBoard,
  },
]
