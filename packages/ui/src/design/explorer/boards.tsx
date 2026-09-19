import { useState, type JSX } from 'react'

import type { AgentItem } from '@harnessdesk/protocol'

import { BranchIcon, FolderIcon, PluginIcon, TerminalIcon } from '../../components/Icons'
import { DiffView } from '../../components/Diff'
import { ItemView } from '../../components/Items'
import { Markdown } from '../../components/Markdown'
import { StoreProvider } from '../../state/context'
import { emptySnapshot, type AppStore } from '../../state/store'
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertTitle,
  Banner,
  BannerAction,
  ActionError,
  Button,
  AgentCard,
  ApprovalDialog,
  ChannelMessage,
  ChannelSignal,
  Chip,
  CodeBlock,
  CopyButton,
  ConfirmDialog,
  DetailHead,
  Face,
  Input,
  Dialog,
  Dot,
  NativeSelect,
  PageHead,
  Row,
  RowButton,
  RowChoice,
  Rows,
  Lightbox,
  PublicationCard,
  RefusedAction,
  SectionHead,
  Segmented,
  StatePill,
  Switch,
  SwitchShape,
  ToggleGroup,
  ToggleGroupItem,
  stateTone,
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

const BUTTON_CATALOG_VARIANTS = ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link', 'row', 'navigation', 'choice', 'quiet', 'muted', 'warning', 'reveal', 'subtle', 'primary', 'action'] as const
const BUTTON_CATALOG_SIZES = ['default', 'xs', 'sm', 'icon', 'icon-xs', 'icon-sm', 'content', 'chip', 'inline', 'panel', 'row', 'navigation', 'fill', 'icon-circle'] as const
const BUTTON_CATALOG_STATES = ['default', 'hover', 'focus-visible', 'disabled'] as const
const INPUT_CATALOG_VARIANTS = ['default', 'quiet', 'filled', 'chrome', 'code'] as const
const INPUT_CATALOG_SIZES = ['default', 'compact', 'bare'] as const
const INPUT_CATALOG_STATES = ['default', 'focus-visible', 'disabled', 'error'] as const
const NATIVE_SELECT_CATALOG_VARIANTS = ['default', 'filled'] as const
const NATIVE_SELECT_CATALOG_SIZES = ['default', 'compact'] as const
const NATIVE_SELECT_CATALOG_STATES = ['closed', 'open', 'focus-visible', 'disabled'] as const
const ALERT_CATALOG_VARIANTS = ['default', 'soft'] as const
const ALERT_CATALOG_SIZES = ['default'] as const
const ALERT_CATALOG_STATES = ['default', 'success', 'warning', 'error'] as const
const ALERT_CATALOG_TONE = ['neutral', 'info', 'success', 'warning', 'danger'] as const
const SWITCH_CATALOG_VARIANTS = ['default'] as const
const SWITCH_CATALOG_SIZES = ['default', 'sm'] as const
const SWITCH_CATALOG_STATES = ['unchecked', 'checked', 'focus-visible', 'disabled'] as const
const SWITCH_CATALOG_ON = ['true', 'false'] as const
const TOGGLE_GROUP_CATALOG_VARIANTS = ['default', 'outline'] as const
const TOGGLE_GROUP_CATALOG_SIZES = ['default', 'sm', 'lg'] as const
const TOGGLE_GROUP_CATALOG_STATES = ['unselected', 'selected', 'focus-visible', 'disabled'] as const

const ButtonBoard = () => (
  <>
    <div className={styles.matrix} data-catalog-states={BUTTON_CATALOG_STATES.join(' ')}>
      {BUTTON_CATALOG_VARIANTS.map((variant) => (
        <Case key={variant} label={variant}>
          <Button variant={variant} data-catalog-variant={variant}>Continue</Button>
          <Button variant={variant} disabled>
            Continue
          </Button>
          <Button variant={variant} size="sm">
            Small
          </Button>
        </Case>
      ))}
      <Case label="icon only">
        <Button variant="ghost" size="icon-sm" aria-label="Terminal">
          <TerminalIcon size={14} />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Folder">
          <FolderIcon size={14} />
        </Button>
      </Case>
      <Case label="all supported sizes">
        <div className="flex w-full flex-wrap items-start gap-2">
          {BUTTON_CATALOG_SIZES.map((size) => (
            <Button key={size} variant="outline" size={size} data-catalog-size={size} aria-label={`Button size ${size}`}>
              {size.startsWith('icon') ? <TerminalIcon size={14} /> : size}
            </Button>
          ))}
        </div>
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
      <Case label="chip tones">
        <Chip tone="neutral">Neutral</Chip>
        <Chip tone="brand">Brand</Chip>
        <Chip tone="success">Success</Chip>
        <Chip tone="warning">Warning</Chip>
        <Chip tone="danger">Danger</Chip>
        <Chip tone="info">Info</Chip>
      </Case>
      <Case label="stale and unknown">
        <Chip tone="success" stale>Passed yesterday</Chip>
        <Chip tone="danger" unknown />
        <Chip tone="warning" unknown>Last checked</Chip>
      </Case>
      <Case label="pull request states">
        {(['open', 'draft', 'merged', 'closed'] as const).map((state) => (
          <StatePill key={state} state={state} />
        ))}
      </Case>
      <Case label="check outcomes">
        {(['passed', 'failed', 'running', 'skipped', 'timed out'] as const).map((state) => {
          const { label, tone } = stateTone(state)
          return <Chip key={state} tone={tone}>{label}</Chip>
        })}
      </Case>
    </div>
    <p className={styles.rule}>
      Readiness keeps its five states and dot. A toned chip judges any other compact fact; stale
      crosses out what is no longer current, while unknown says the fact cannot be determined.
      Pull requests and checks take their label and tone from one <code>stateTone</code> map.
    </p>
  </>
)

const ControlBoard = () => {
  const [on, setOn] = useState(true)
  const [effort, setEffort] = useState<'low' | 'medium' | 'high'>('medium')
  return (
    <>
      <div className={styles.matrix}>
        <Case label="input variants and sizes">
          <div className="grid w-full gap-2" data-catalog-states={INPUT_CATALOG_STATES.join(' ')}>
            {INPUT_CATALOG_VARIANTS.map((variant) => (
              <Input key={variant} variant={variant} data-catalog-variant={variant} placeholder={variant} aria-label={`${variant} input`} />
            ))}
            {INPUT_CATALOG_SIZES.map((controlSize) => (
              <Input key={controlSize} controlSize={controlSize} data-catalog-size={controlSize} placeholder={controlSize} aria-label={`${controlSize} input size`} />
            ))}
            <Input disabled value="disabled" aria-label="Disabled input" readOnly />
            <Input aria-invalid value="invalid" aria-label="Invalid input" readOnly />
          </div>
        </Case>
        <Case label="toggle">
          <div data-catalog-variants={SWITCH_CATALOG_VARIANTS.join(' ')} data-catalog-states={SWITCH_CATALOG_STATES.join(' ')}>
            <Switch checked={on} onCheckedChange={setOn} aria-label="Start sessions in a worktree" />
            {SWITCH_CATALOG_SIZES.map((size) => (
              <Switch key={size} size={size} data-catalog-size={size} checked={false} onCheckedChange={() => {}} aria-label={`${size} switch`} />
            ))}
            {SWITCH_CATALOG_ON.map((value) => (
              <SwitchShape key={value} checked={value === 'true'} data-catalog-on={value} />
            ))}
            <Switch checked aria-label="Managed by the agent" disabled />
          </div>
        </Case>
        <Case label="native select variants and sizes">
          <div className="grid w-full gap-2" data-catalog-states={NATIVE_SELECT_CATALOG_STATES.join(' ')}>
            {NATIVE_SELECT_CATALOG_VARIANTS.map((variant) => (
              <NativeSelect key={variant} variant={variant} data-catalog-variant={variant} aria-label={`${variant} model`} defaultValue="default">
                <option value="default">The agent&apos;s default</option>
                <option value="fast">Fast</option>
              </NativeSelect>
            ))}
            {NATIVE_SELECT_CATALOG_SIZES.map((controlSize) => (
              <NativeSelect key={controlSize} controlSize={controlSize} data-catalog-size={controlSize} aria-label={`${controlSize} select`} defaultValue="default">
                <option value="default">{controlSize}</option>
              </NativeSelect>
            ))}
            <NativeSelect disabled aria-label="Disabled select"><option>Disabled</option></NativeSelect>
          </div>
        </Case>
        <Case label="segmented">
          <div
            data-catalog-variants={TOGGLE_GROUP_CATALOG_VARIANTS.join(' ')}
            data-catalog-sizes={TOGGLE_GROUP_CATALOG_SIZES.join(' ')}
            data-catalog-states={TOGGLE_GROUP_CATALOG_STATES.join(' ')}
          >
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
          <div className="mt-2 flex flex-wrap gap-2">
            {TOGGLE_GROUP_CATALOG_VARIANTS.map((variant) => (
              <ToggleGroup key={variant} type="single" variant={variant} defaultValue="one" data-catalog-variant={variant}>
                <ToggleGroupItem value="one">One</ToggleGroupItem>
                <ToggleGroupItem value="two">Two</ToggleGroupItem>
              </ToggleGroup>
            ))}
            {TOGGLE_GROUP_CATALOG_SIZES.map((size) => (
              <ToggleGroup key={size} type="single" size={size} defaultValue="one" data-catalog-size={size}>
                <ToggleGroupItem value="one">{size}</ToggleGroupItem>
                <ToggleGroupItem value="two">Two</ToggleGroupItem>
              </ToggleGroup>
            ))}
          </div>
          </div>
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
        <SectionHead name="Plugins" action={<Button variant="outline" size="sm">Add</Button>} />
        <SectionHead
          sticky
          name="What is left"
          description="Gemini is out of quota."
          action={<Button variant="outline" size="sm">Range</Button>}
        />
        <Rows>
          <Row
            mark={<PluginIcon size={15} />}
            title="Browser"
            desc="Drive a page and read it back."
            control={<Switch checked onCheckedChange={() => {}} aria-label="Browser" />}
          />
          <Row
            mark={<PluginIcon size={15} />}
            title="Filesystem"
            desc="~/.harnessdesk/plugins/fs"
            control={<Switch checked={false} onCheckedChange={() => {}} aria-label="Filesystem" />}
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
        actions={<Button variant="default">Add an agent</Button>}
      />
      <DetailHead
        mark={<PluginIcon size={22} />}
        name="Browser"
        owner="built in"
        blurb="Drive a page and read it back. Available to agents that accept plugin tools."
        actions={<Button variant="secondary" size="sm">Remove</Button>}
      />
    </div>
    <p className={styles.rule}>
      20px and 600 weight name the app and a sheet; a page title is 16px at 500. That is the whole
      heading scale — a screen that wants a third size is asking for a size the system does not
      have.
    </p>
  </>
)

const FaceBoard = () => (
  <>
    <div className={styles.stack}>
      <div>
        <Face avatar={null} size={24} /> <Face avatar="astronaut" size={24} /> <Face avatar="pirate" size={24} />{' '}
        <Face avatar={null} size={44} /> <Face avatar="wizard" size={44} />
      </div>
      <DetailHead
        mark={<Face avatar="wizard" size={44} />}
        name="Jane Doe"
        blurb="A person's head: the face they chose, drawn through the canonical avatar primitive."
      />
    </div>
    <p className={styles.rule}>
      A person is a squared tile; an account is a ring. The tile is the shared avatar primitive — one plate, one
      hairline — its corner stepping up the radius scale as it grows, and the house mark for any
      face this build does not ship: the third tile is an id no build has.
    </p>
  </>
)

const BannerBoard = () => (
  <>
    <div
      className={styles.stack}
      data-catalog-variants={ALERT_CATALOG_VARIANTS.join(' ')}
      data-catalog-sizes={ALERT_CATALOG_SIZES.join(' ')}
      data-catalog-states={ALERT_CATALOG_STATES.join(' ')}
    >
      {ALERT_CATALOG_TONE.map((tone) => (
        <Alert key={tone} tone={tone} data-catalog-tone={tone}>
          <AlertContent>
            <AlertTitle>{tone}</AlertTitle>
            <AlertDescription>The canonical alert tone, rendered from the CVA contract.</AlertDescription>
          </AlertContent>
        </Alert>
      ))}
      <ActionError>Could not switch branches. The working tree has uncommitted changes.</ActionError>
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

/* The prose renderer reads the app's theme through the store, and this page
   has none; it gets the empty desk's snapshot, kept in one place so the store
   hands back the same object each time it is asked. */
const catalogueSnapshot = emptySnapshot()
const catalogueStore = { subscribe: () => () => {}, getSnapshot: () => catalogueSnapshot } as unknown as AppStore
const CATALOGUE_DIFF = [
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..734dfc9',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const opened = true',
  '+export const count = 2',
  'diff --git a/src/existing.ts b/src/existing.ts',
  'index 1111111..2222222 100644',
  '--- a/src/existing.ts',
  '+++ b/src/existing.ts',
  '@@ -8,2 +8,2 @@',
  '-const label = "Before"',
  '+const label = "After"',
  ' render(label)',
].join('\n')

const CATALOGUE_INLINE_EDIT = {
  id: 'catalogue-inline-edit',
  type: 'toolCall',
  tool: 'Edit src/existing.ts',
  source: { kind: 'builtin' },
  status: 'completed',
  args: {
    file_path: '/workspace/src/existing.ts',
    old_string: 'const label = "Before"',
    new_string: 'const label = "After"',
  },
} as AgentItem

const CodeBoard = () => (
  <div className={styles.stack}>
    <Case label="command, output, and failure">
      <div className="w-full" data-testid="code-block-sample">
        <CodeBlock
          command="pnpm --filter @harnessdesk/ui exec vitest run src/components/Items"
          output={'Tests 1 failed\nDuration 1.8s'}
          exitCode={1}
        />
      </div>
    </Case>
    <Case label="the copy control">
      <CopyButton text="pnpm verify" label="Copy this command" />
    </Case>
    <Case label="the same plate in prose">
      <div className="w-full" data-testid="markdown-code-sample">
        <StoreProvider store={catalogueStore}>
          <Markdown text={'```ts\nconst opened = true\n```'} />
        </StoreProvider>
      </div>
    </Case>
    <Case label="two hunks, including a new file">
      <div className="w-full" data-testid="diff-sample">
        <DiffView diff={CATALOGUE_DIFF} />
      </div>
    </Case>
    <Case label="the same plate in an opened step">
      <div className="w-full" data-testid="inline-diff-sample" data-register="light">
        <StoreProvider store={catalogueStore}>
          <ItemView item={CATALOGUE_INLINE_EDIT} root="/workspace" />
        </StoreProvider>
      </div>
    </Case>
    <p className={styles.rule}>
      A command and what it printed are one exact record, so they share one
      plate and one code register. Prose keeps its horizontal scroll because a
      source line is not a shell command and should not be reflowed.
    </p>
  </div>
)

const DialogBoard = () => {
  const [open, setOpen] = useState<null | 'plain' | 'confirm' | 'approval' | 'lightbox'>(null)
  return (
    <>
      <div className={styles.matrix}>
        <Case label="open one">
          <Button variant="secondary" onClick={() => setOpen('plain')}>Dialog</Button>
          <Button variant="destructive" onClick={() => setOpen('confirm')}>
            Delete conversation
          </Button>
          <Button variant="outline" onClick={() => setOpen('approval')}>Approval</Button>
          <Button variant="outline" onClick={() => setOpen('lightbox')}>Lightbox</Button>
        </Case>
      </div>
      {open === 'plain' && (
        <Dialog
          title="Add a workspace"
          icon={<FolderIcon size={16} />}
          onClose={() => setOpen(null)}
          footer={
            <>
              <Button variant="default" onClick={() => setOpen(null)}>
                Add
              </Button>
              <Button variant="secondary" onClick={() => setOpen(null)}>Cancel</Button>
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
      {open === 'approval' && (
        <ApprovalDialog
          title="Run a command?"
          icon={<TerminalIcon size={16} />}
          focused
          focusKey="catalog-approval"
          actions={[
            { id: 'keep', label: 'Keep waiting', shortcut: 1, placement: 'safe', onSelect: () => setOpen(null) },
            { id: 'run', label: 'Run once', shortcut: 2, placement: 'proceed', onSelect: () => setOpen(null) },
          ]}
        >
          <code>pnpm verify</code> runs in the current workspace.
        </ApprovalDialog>
      )}
      {open === 'lightbox' && (
        <Lightbox
          images={[{ url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="320" height="180"%3E%3Crect width="320" height="180" fill="%235b8def"/%3E%3C/svg%3E', name: 'Synthetic catalog image' }]}
          index={0}
          onClose={() => setOpen(null)}
        />
      )}
      <div className={styles.matrix}>
        <Case label="agent card">
          <AgentCard subject={{
            kind: 'agent',
            name: 'Review agent',
            identity: 'Codex · dev@example.com',
            tint: 'green',
            mark: <PluginIcon size={15} />,
            running: { model: 'Astra', state: 'Ready' },
            actions: [{ label: 'Open', primary: true, onSelect: () => undefined }],
          }} />
        </Case>
        <Case label="publication card">
          <PublicationCard reference={{
            kind: 'pullRequest', action: 'opened', repo: 'acme/harnessdesk', number: 42,
            url: 'https://example.com/acme/harnessdesk/pull/42', title: 'Unify the interface',
            state: 'open', author: 'jane-doe', additions: 120, deletions: 38, files: 12,
            excerpt: 'One foundation and one component vocabulary.', via: 'app', signature: null,
          }} />
        </Case>
        <Case label="refused action">
          <RefusedAction reason="Finish the active turn before removing this agent.">
            <Button disabled variant="destructive">Remove agent</Button>
          </RefusedAction>
        </Case>
      </div>
      <p className={styles.rule}>
        Actions sit bottom-right with the proceeding one rightmost, because that is where every
        macOS dialog puts them. Nothing is focused on open, so a stray Return cannot confirm, and
        the confirm hands the first Tab to Keep. Escape closes either dialog; a click on the ground
        closes only the plain one, because a question has to be answered.
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
          face={<Face avatar="astronaut" />}
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
    title: 'Button · icon size',
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
    title: 'Switch · NativeSelect · Segmented',
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
    id: 'face',
    title: 'Face',
    about: 'A person, drawn: the face they chose, or the house mark.',
    render: FaceBoard,
  },
  {
    id: 'banner',
    title: 'Banner',
    about: 'Something the app needs to say that nobody asked for.',
    render: BannerBoard,
  },
  {
    id: 'code',
    title: 'CodeBlock',
    about: 'A command and its output, kept together as one exact record.',
    render: CodeBoard,
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
