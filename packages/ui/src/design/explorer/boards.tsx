import { useState, type JSX } from 'react'

import type { AgentItem } from '@harnessdesk/protocol'

import { AlertIcon, BranchIcon, CheckIcon, CrossIcon, FolderIcon, PluginIcon, TerminalIcon, TodoPendingIcon } from '../../components/Icons'
import { DiffView } from '../../components/Diff'
import { Toaster } from '../ui/toast'
import { ItemView } from '../../components/Items'
import { Markdown } from '../../components/Markdown'
import { PublicationCard } from '../../components/Publication'
import { StoreProvider } from '../../state/context'
import { emptySnapshot, type AppStore } from '../../state/store'
import {
  ComposerNotice,
  ComposerNoticeStack,
  InboxPanel,
  InboxList,
  NoticeCard,
  NoticeStrip,
  showProgress,
  showToast,
  type InboxMessage,
  type NoticeMessage,
  Alert,
  AlertContent,
  AlertDescription,
  AlertTitle,
  Banner,
  BannerAction,
  ActionError,
  AppWindowPage,
  AppWindowRail,
  AppWindowRailScroll,
  AppWindowRailTop,
  Button,
  Card,
  ChangeStats,
  AgentCard,
  ApprovalCode,
  ApprovalDialog,
  ApprovalMeta,
  ApprovalReason,
  ChannelMessage,
  ChannelNotice,
  ChannelSignal,
  Chip,
  ChoiceList,
  ComposerChip,
  ComposerDropHint,
  ComposerShell,
  CodeBlock,
  CodeText,
  CopyButton,
  ConfirmDialog,
  DetailHead,
  Face,
  Field,
  Fieldset,
  FileState,
  Input,
  Keycap,
  Dialog,
  Dot,
  NativeSelect,
  PageHead,
  PatchHeader,
  Row,
  RowButton,
  Checkbox,
  RowChoice,
  Rows,
  Lightbox,
  MetaList,
  Monogram,
  NavigationGroupHeader,
  Note,
  NoteList,
  PopoverSurface,
  RefusedAction,
  SectionHead,
  Segmented,
  StatePill,
  Spinner,
  Text,
  TextMark,
  Switch,
  SwitchShape,
  ToggleGroup,
  ToggleGroupItem,
  stateTone,
  SortableAnnouncer,
  SortableHandle,
  Toolbar,
  sortableItemClass,
  useSortable,
} from '..'
import { Specimen } from './specimen'
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

const BUTTON_CATALOG_VARIANTS = ['default', 'outline', 'secondary', 'ghost', 'floating', 'danger', 'destructive', 'link', 'row', 'navigation', 'choice', 'quiet', 'muted', 'warning', 'reveal', 'subtle', 'primary', 'action'] as const
const BUTTON_CATALOG_SIZES = ['default', 'xs', 'sm', 'icon', 'icon-xs', 'icon-sm', 'content', 'table-row', 'pattern', 'chip', 'inline', 'panel', 'row', 'navigation', 'fill', 'icon-circle'] as const
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
        <Dot state="signin" pulse />
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
      <Case label="outline tag">
        <Chip tone="neutral" size="sm" variant="outline" emphasis>Loaded first</Chip>
      </Case>
      <Case label="chip identity tints">
        <Chip tint="blue">Branch</Chip>
        <Chip tint="amber">Tag</Chip>
        <Chip tint="violet">Session</Chip>
      </Case>
      <Case label="long identity chip">
        <Chip tint="blue" title="feat/promo-stacking-for-the-seasonal-storefront">
          <BranchIcon size={10} />
          <span>feat/promo-stacking-for-the-seasonal-storefront</span>
        </Chip>
      </Case>
      <Case label="emphatic current chip">
        <Chip tone="brand" emphasis>HEAD</Chip>
      </Case>
      <Case label="stale and unknown">
        <Chip tone="success" stale>Passed yesterday</Chip>
        <Chip tone="danger" unknown />
        <Chip tone="warning" unknown>Last checked</Chip>
      </Case>
      <Case label="one line, in a narrow card">
        <div className="flex w-44 flex-wrap gap-1 rounded-(--hd-radius-md) border border-(--hd-border) p-2">
          <Chip tone="success">verify ✓ @a1b2c3d</Chip>
          <Chip tone="neutral" stale>verify ✓ @a1b2c3d — 2 commits since</Chip>
          <Chip tone="neutral" stale>+120 −30 in 6 files — 2 commits since</Chip>
        </div>
      </Case>
      <Case label="counts, zero draws nothing">
        <Chip tone="neutral" count={5}>never fired</Chip>
        <Chip tone="warning" count={2}>copies differ</Chip>
        <Chip tone="warning" count={0}>reach none</Chip>
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
      <Case label="running operation">
        <Spinner size="sm" tone="brand" aria-label="Loading" />
      </Case>
      <Case label="text marks">
        <span className="flex items-baseline gap-2"><TextMark role="row"><TodoPendingIcon size={12} /></TextMark><Text role="row">Planned</Text></span>
        <span className="flex items-baseline gap-2"><TextMark role="row" tone="success"><CheckIcon size={12} /></TextMark><Text role="row">Done</Text></span>
        <span className="flex items-baseline gap-2"><TextMark role="row" tone="warning"><CrossIcon size={12} /></TextMark><Text role="row">Failed</Text></span>
      </Case>
      <Case label="library row facts">
        <Monogram>CR</Monogram>
        <MetaList><span>3 copies</span><span>Last Tuesday</span></MetaList>
        <CodeText as="code" size="inherit">~/skills/code-review</CodeText>
      </Case>
      <Case label="supporting note with icon">
        <Note ink="muted" icon={<FolderIcon size={13} />}>Manifest required</Note>
      </Case>
    </div>
    <p className={styles.rule}>
      Readiness keeps its five states and dot. A toned chip judges any other compact fact; a tinted
      chip identifies one. The emphatic brand form marks the current item. Stale crosses out what is
      no longer current, while unknown says the fact cannot be determined. Pull requests and checks
      take their label and tone from one <code>stateTone</code> map.
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
  const [folded, setFolded] = useState(true)
  const [picked, setPicked] = useState(false)
  return (
    <>
      <Specimen measure="page" caption="A settings page, assembled from Row, RowButton and RowChoice">
      <div className={styles.stack}>
        <Text role="wordmark" data-catalog-size="wordmark">HarnessDesk</Text>
        <PageHead
          title={<span data-slot="page-title-case" data-catalog-size="page">General</span>}
          blurb="Settings for this desk."
        />
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

        <SectionHead name="A row that opens and folds" />
        <Rows data-catalog-case="row-fold">
          <RowButton
            mark={<TerminalIcon size={15} />}
            title={<Text role="subject">Codex</Text>}
            chevron={false}
            onClick={() => {}}
            fold={{ open: !folded, onToggle: () => setFolded((was) => !was), label: `${folded ? 'Show' : 'Hide'} the accounts under Codex` }}
          />
          {!folded && <RowButton title="dev" desc="dev@example.com" onClick={() => {}} />}
        </Rows>
        <SectionHead name="A row with its one action" />
        <Rows data-catalog-case="row-action">
          <RowButton
            mark={<TerminalIcon size={15} />}
            title={<Text role="subject">Codex</Text>}
            desc="dev@example.com"
            onClick={() => {}}
          />
          <RowButton
            mark={<TerminalIcon size={15} />}
            title={<Text role="subject">Qwen Code</Text>}
            onClick={() => {}}
            action={<Button size="sm" variant="default">Sign in</Button>}
          />
        </Rows>
        <Checkbox
          data-catalog-case="checkbox-label"
          checked={picked}
          onCheckedChange={(next) => setPicked(next === true)}
          label={<Text role="navigation">Install for Codex</Text>}
        />

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
      </Specimen>
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
    <Specimen measure="page" caption="An Agents page, and one row drilled into">
    <div className={styles.stack}>
      <Text role="wordmark" data-catalog-size="wordmark">HarnessDesk</Text>
      <PageHead
        title={<span data-slot="page-title-case" data-catalog-size="page">Agents</span>}
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
    </Specimen>
    <p className={styles.rule}>
      20px and 600 weight name the app and a page; subjects use the reading step at medium. That is
      the whole heading scale — a screen that wants a third size is asking for a size the system
      does not have.
    </p>
  </>
)

const AppWindowBoard = () => (
  <>
    <div className="grid h-72 w-full grid-cols-[15.25rem_minmax(0,1fr)] overflow-hidden rounded-(--hd-radius-lg) border border-(--hd-border)">
      <AppWindowRail className="flex min-h-0 flex-col">
        <AppWindowRailTop>
          <Button variant="navigation" size="navigation" className="w-full">Back to app</Button>
        </AppWindowRailTop>
        <AppWindowRailScroll className="flex min-h-0 flex-1 flex-col">
          <NavigationGroupHeader label="You" />
          <Button variant="navigation" size="navigation" data-selected className="w-full">Appearance</Button>
          <Button variant="navigation" size="navigation" className="w-full">Permissions</Button>
        </AppWindowRailScroll>
      </AppWindowRail>
      <AppWindowPage className="overflow-hidden">
        <PageHead title="Appearance" blurb="The full-window page uses the same reading measure and rail in every destination." />
      </AppWindowPage>
    </div>
    <p className={styles.rule}>
      A destination window is one surface: a navigation plate and a centred page plate. Base UI owns modality and focus; this pattern owns the visible chrome.
    </p>
  </>
)

const FaceBoard = () => (
  <>
    <Specimen caption="Face at its sizes, and one drawn into a DetailHead">
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
    </Specimen>
    <p className={styles.rule}>
      A person is a squared tile; an account is a ring. The tile is the shared avatar primitive — one plate, one
      hairline — its corner stepping up the radius scale as it grows, and the house mark for any
      face this build does not ship: the third tile is an id no build has.
    </p>
  </>
)

/* The notice surfaces, each with the message it is for. The words are the
   desk's own situations, so the board reads as the app would. */
const NOTICE_NOW = 30 * 60_000
const NOTICE_CARD: NoticeMessage[] = [
  { id: 'update', tone: 'info', title: 'Relaunch to update', body: 'HarnessDesk 0.2.5 and one agent update are ready.', action: { label: 'Relaunch', onSelect: () => {}, shortcut: '⌘R' } },
  { id: 'offer', title: 'Skills and servers to share', body: 'Your other agents have some this machine could use. Nothing is copied until you confirm.', action: { label: 'Review in Library', onSelect: () => {} } },
]
const NOTICE_STRIP: NoticeMessage[] = [
  { id: 'pace', tone: 'warning', title: 'Claude Code is on course to run out in 51m.', action: { label: 'Switch agent', onSelect: () => {} } },
  { id: 'signin', tone: 'danger', title: 'Cursor is not signed in.', action: { label: 'Sign in', onSelect: () => {} } },
]
const NOTICE_INBOX: InboxMessage[] = [
  { id: 'i0', tone: 'info', from: 'Reviewer', title: 'Keep the old retry count, or raise it to five?', body: 'Five covers the documented flaps; three matches the other clients.', action: { label: 'Start as a task', onSelect: () => {} }, at: NOTICE_NOW - 60_000 },
  { id: 'i1', tone: 'warning', title: 'On course to run out', body: 'Claude Code will run out in 51m, before the window resets.', action: { label: 'Switch agent', onSelect: () => {} }, at: NOTICE_NOW - 4 * 60_000 },
  { id: 'i2', tone: 'info', title: 'Relaunch to update', body: 'HarnessDesk 0.2.5 is ready.', at: NOTICE_NOW - 2 * 3_600_000 },
  { id: 'i3', from: 'Checkout hardening', title: 'Goal finished', body: 'Checkout hardening closed its last card.', at: NOTICE_NOW - 26 * 3_600_000, read: true },
]

const NOTICE_ASK: NoticeMessage = {
  id: 'ask',
  tone: 'info',
  title: 'Keep the old retry count, or raise it to five?',
  body: 'Five covers the documented flaps; three matches the other clients.',
}

/* Every surface in every state the app can put it in, drawn by the shipped
   components with the props the app passes: one message and several, with and
   without an action, dismissable and not, the second dismissal's "Stop showing
   this", the inbox empty, all read and full, and each kind of toast. */
const NoticesBoard = () => {
  const [inbox, setInbox] = useState(NOTICE_INBOX)
  const read = (id: string) => setInbox((all) => all.map((message) => (message.id === id ? { ...message, read: true } : message)))
  return (
    <div className={styles.stack}>
      <Case label="card: one message">
        <div style={{ width: 'calc(var(--hd-space-16) * 3.5)' }}>
          <NoticeCard messages={NOTICE_CARD.slice(1)} onDismiss={() => {}} />
        </div>
      </Case>
      <Case label="card: several, paged one at a time">
        <div style={{ width: 'calc(var(--hd-space-16) * 3.5)' }}>
          <NoticeCard messages={NOTICE_CARD} onDismiss={() => {}} />
        </div>
      </Case>
      <Case label="card: dismissed twice before — the × offers Stop showing this">
        <div style={{ width: 'calc(var(--hd-space-16) * 3.5)' }}>
          <NoticeCard messages={NOTICE_CARD.slice(1)} onDismiss={() => {}} onMute={() => () => {}} />
        </div>
      </Case>
      <Case label="composer: each tone, with and without an action or a dismiss">
        <div style={{ width: 'min(var(--hd-column), 100%)' }}>
          <ComposerNoticeStack>
            <ComposerNotice message={NOTICE_STRIP[0]!} onDismiss={() => {}} />
            <ComposerNotice message={{ ...NOTICE_STRIP[1]!, id: 'signin-2' }} />
            <ComposerNotice message={{ id: 'plain', title: 'Reconnecting to the host…' }} />
          </ComposerNoticeStack>
        </div>
      </Case>
      <Case label="composer: an Agent asks, and the strip sharing the stack">
        <div style={{ width: 'min(var(--hd-column), 100%)' }}>
          <ComposerNoticeStack>
            <NoticeStrip messages={[{ id: 'link', tone: 'warning', title: 'Reconnecting to the host…' }]} onDismiss={() => {}} />
            <ComposerNotice message={NOTICE_ASK} onDismiss={() => {}} onMute={() => {}} />
          </ComposerNoticeStack>
        </div>
      </Case>
      <Case label="strip: one message">
        <NoticeStrip messages={NOTICE_STRIP.slice(0, 1)} onDismiss={() => {}} />
      </Case>
      <Case label="strip: several, paged">
        <NoticeStrip messages={NOTICE_STRIP} onDismiss={() => {}} />
      </Case>
      <Case label="inbox: the bell and its panel; unread tints the bell">
        <div className="flex items-start gap-(--hd-space-4)">
          <InboxPanel messages={inbox} now={NOTICE_NOW} onOpen={read} />
          <div className="rounded-(--hd-radius-xl) border border-(--hd-border) bg-(--hd-popover) p-(--hd-space-1) shadow-(--hd-shadow-lg)">
            <InboxList
              messages={inbox}
              now={NOTICE_NOW}
              onOpen={read}
              onMarkAllRead={() => setInbox((all) => all.map((message) => ({ ...message, read: true })))}
              onClear={() => setInbox([])}
            />
          </div>
        </div>
      </Case>
      <Case label="inbox: all read, and empty">
        <div className="flex flex-wrap items-start gap-(--hd-space-4)">
          <InboxPanel messages={NOTICE_INBOX.map((message) => ({ ...message, read: true }))} now={NOTICE_NOW} />
          <div className="rounded-(--hd-radius-xl) border border-(--hd-border) bg-(--hd-popover) p-(--hd-space-1) shadow-(--hd-shadow-lg)">
            <InboxList messages={NOTICE_INBOX.map((message) => ({ ...message, read: true }))} now={NOTICE_NOW} />
          </div>
          <div className="rounded-(--hd-radius-xl) border border-(--hd-border) bg-(--hd-popover) p-(--hd-space-1) shadow-(--hd-shadow-lg)">
            <InboxList messages={[]} now={NOTICE_NOW} />
          </div>
        </div>
      </Case>
      <Case label="toast: a result, a failure that stays until closed, and work under way">
        <div className="flex flex-wrap gap-(--hd-space-2)">
          <Button variant="secondary" type="button" onClick={() => showToast({ title: 'Backup saved to your Desktop.', action: { label: 'Show', onSelect: () => {} } })}>
            Result
          </Button>
          <Button variant="secondary" type="button" onClick={() => showToast({ tone: 'danger', title: 'Could not save the backup.', body: 'The disk is full.' }, { persist: true })}>
            Failure
          </Button>
          <Button
            variant="secondary"
            type="button"
            onClick={() => showProgress(new Promise((resolve) => setTimeout(resolve, 1500)), { working: 'Exporting…', done: 'Exported.', failed: 'Export failed.' })}
          >
            Under way
          </Button>
        </div>
        <Toaster />
      </Case>
    </div>
  )
}

const BannerBoard = () => (
  <>
    <Specimen measure="page" caption="Alert tones and variants, ActionError, a patch card, and every Banner">
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
      {ALERT_CATALOG_VARIANTS.map((variant) => (
        <Alert key={variant} tone="neutral" variant={variant} data-catalog-variant={variant}>
          <AlertContent>
            <AlertTitle>{variant} neutral</AlertTitle>
            <AlertDescription>An ambient hand-off that belongs with the page.</AlertDescription>
          </AlertContent>
        </Alert>
      ))}
      <ActionError>Could not switch branches. The working tree has uncommitted changes.</ActionError>
      <Card variant="flush">
        <PatchHeader>packages/ui/src/components/GitPane.tsx</PatchHeader>
        <section className="flex items-center gap-2 px-3 py-2">
          <FileState state="modified" />
          <span>One implementation for repository presentation</span>
          <ChangeStats added={12} removed={3} className="ml-auto" />
        </section>
      </Card>
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
    </Specimen>
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

/**
 * A sortable list: drag from the handle, or ⌥↑/⌥↓ from a row, and the move is
 * announced. This owner answers at once; the app's message queue — the one
 * consumer drawn here — answers when the host does.
 */
const QueueRows = () => {
  const [ids, setIds] = useState(['Run the focused tests again', 'Then write the release note', 'Open a pull request'])
  const sortable = useSortable({
    ids,
    name: (id) => `“${id}”`,
    onMove: (id, to) => setIds((was) => {
      const rest = was.filter((one) => one !== id)
      return [...rest.slice(0, to), id, ...rest.slice(to)]
    }),
  })
  return (
    <>
      <ol aria-label="Waiting messages" data-catalog-case="sortable-list" className="flex flex-col gap-0.5">
        {ids.map((id, index) => (
          <li key={id} data-slot="sortable-row" {...sortable.row(id, index)} className={`${sortableItemClass()} flex items-center gap-2`}>
            <SortableHandle {...sortable.handle(id)} />
            <Text role="meta">{index + 1}</Text>
            <Text role="navigation" className="min-w-0 flex-1 truncate">{id}</Text>
            {index === 0 ? <Text role="meta" tone="brand">next</Text> : null}
            <span data-slot="sortable-actions" className="flex shrink-0 items-center">
              <Button variant="ghost" size="icon-sm" aria-label="Remove"><CrossIcon size={13} /></Button>
            </span>
          </li>
        ))}
      </ol>
      <SortableAnnouncer message={sortable.announcement} />
    </>
  )
}

const QueueBoard = () => (
  <>
    <Specimen caption="The message queue: a paused header, a trigger picker, and the composer shell">
    <div className={styles.stack}>
      <Alert variant="soft" tone="warning" className="flex-col items-stretch gap-1.5">
        <Toolbar className="flex-nowrap">
          <Text role="meta" tone="warning"><AlertIcon size={13} /></Text>
          <Text role="meta" ink="primary" className="flex-1">The turn did not finish. Two messages waiting.</Text>
          <Button variant="quiet" size="sm">Send now</Button>
        </Toolbar>
        <QueueRows />
      </Alert>
      <PopoverSurface limit="trigger">
        <Text role="muted" as="div" className="px-2 py-1">Commands</Text>
        <Button variant="navigation" size="navigation" className="w-full">/review</Button>
      </PopoverSurface>
      <Text role="muted" as="div">
        Press <Keycap>esc</Keycap> to close; “Set<Text as="b" role="meta" ink="primary" weight="semibold">tings</Text>” shows the matched text at full ink and weight.
      </Text>
      <NoteList><li>A short supporting fact keeps its list anatomy.</li></NoteList>
      <ComposerShell className="relative min-h-20">
        <ComposerChip tone="brand" removeLabel="Remove report.pdf" onRemove={() => {}}>report.pdf</ComposerChip>
        <ComposerDropHint>Drop images to attach</ComposerDropHint>
      </ComposerShell>
    </div>
    </Specimen>
    <p className={styles.rule}>
      The queue is one held-work surface: warning belongs to the paused header, order stays quiet in
      its rows, and the controls arrive only at the row being handled. Trigger pickers use the same
      floating plate as anchored menus.
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

/** A step whose body is an argument panel and an unwrapped text result, not a
 * plate — the shape that showed the two-edges defect against the command
 * step right below it. */
const CATALOGUE_AGENT_STEP = {
  id: 'catalogue-agent-step',
  type: 'toolCall',
  tool: 'Task',
  source: { kind: 'builtin' },
  status: 'completed',
  args: { description: 'Summarize the failing tests', subagent_type: 'general-purpose' },
  result: [{ type: 'json', value: [{ type: 'text', text: 'Three specs fail on the retry path.' }] }],
} as unknown as AgentItem

const CATALOGUE_COMMAND_STEP = {
  id: 'catalogue-command-step',
  type: 'command',
  command: 'pnpm test',
  cwd: '/workspace',
  origin: 'agent',
  actions: [{ type: 'unknown', command: 'pnpm test' }],
  status: 'completed',
  output: 'Tests 3 failed',
} as unknown as AgentItem

/** A runtime that answers a shell call with its own record, not a plain
 * result — read as the same command plate a `command` step draws. */
const CATALOGUE_RUNTIME_COMMAND_RESULT = {
  id: 'catalogue-runtime-command-result',
  type: 'toolCall',
  tool: 'run_command',
  source: { kind: 'builtin' },
  status: 'completed',
  args: {},
  result: [{
    type: 'json',
    value: {
      commandLine: 'pnpm build',
      workingDir: '/workspace',
      exitCode: 0,
      exit_code: 0,
      combinedOutput: 'Build succeeded in 4.2s',
      formatted_output: 'Build succeeded in 4.2s',
    },
  }],
} as unknown as AgentItem

/** A runtime that answers every call with a bare `{output, isError}` pair. */
const CATALOGUE_RUNTIME_ERROR_RESULT = {
  id: 'catalogue-runtime-error-result',
  type: 'toolCall',
  tool: 'run_query',
  source: { kind: 'builtin' },
  status: 'completed',
  args: {},
  result: [{ type: 'json', value: { output: 'connection refused', isError: true } }],
} as unknown as AgentItem

/** A runtime that answers every call with an empty `{output, isError}` pair. */
const emptyResult = [{ type: 'json', value: { output: '', isError: false } }]
const CATALOGUE_EMPTY_RESULTS = [
  { id: 'catalogue-empty-plan', type: 'toolCall', tool: 'todo_write', source: { kind: 'builtin' }, status: 'completed', args: { todos: [{ content: 'List the folder', status: 'completed' }, { content: 'Read the README', status: 'completed' }] }, result: emptyResult },
  { id: 'catalogue-empty-shell', type: 'toolCall', tool: 'ls -a', source: { kind: 'builtin' }, status: 'completed', args: { command: 'ls -a', description: 'List the folder' }, result: emptyResult },
  { id: 'catalogue-empty-read', type: 'toolCall', tool: 'read', source: { kind: 'builtin' }, status: 'completed', args: { file_path: '/workspace/README.md' }, result: emptyResult },
] as unknown as AgentItem[]

/** DeepSeek over its own ACP server: its three everyday tools, with real output. */
const CATALOGUE_DSH_TURN = [
  { id: 'catalogue-dsh-plan', type: 'toolCall', tool: 'todo_write', source: { kind: 'builtin' }, status: 'completed', args: { todos: [{ content: 'List the folder', status: 'completed' }, { content: 'Read the README', status: 'completed' }] }, result: [{ type: 'text', text: 'Updated todo list: 0 pending, 0 in progress, 2 completed.' }] },
  { id: 'catalogue-dsh-bash', type: 'toolCall', tool: 'bash', source: { kind: 'builtin' }, status: 'completed', args: { command: 'ls -a', description: 'List the folder' }, result: [{ type: 'text', text: '.\n..\nREADME.md\npackages' }] },
  { id: 'catalogue-dsh-read', type: 'toolCall', tool: 'read', source: { kind: 'builtin' }, status: 'completed', args: { file_path: '/workspace/README.md' }, result: [{ type: 'text', text: '# Workspace\n\nA small example project.' }] },
] as unknown as AgentItem[]

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
    <Case label="an argument panel and a result, over a command — the shared step edges">
      <div className="w-full flex flex-col" data-testid="step-edges-sample" data-register="light">
        <StoreProvider store={catalogueStore}>
          <ItemView item={CATALOGUE_AGENT_STEP} root="/workspace" />
          <ItemView item={CATALOGUE_COMMAND_STEP} root="/workspace" />
        </StoreProvider>
      </div>
    </Case>
    <Case label="a runtime's own command record, unwrapped as the command plate">
      <div className="w-full" data-testid="runtime-command-result-sample" data-register="light">
        <StoreProvider store={catalogueStore}>
          <ItemView item={CATALOGUE_RUNTIME_COMMAND_RESULT} root="/workspace" />
        </StoreProvider>
      </div>
    </Case>
    <Case label="a runtime's own {output, isError} pair, unwrapped as output">
      <div className="w-full" data-testid="runtime-error-result-sample" data-register="light">
        <StoreProvider store={catalogueStore}>
          <ItemView item={CATALOGUE_RUNTIME_ERROR_RESULT} root="/workspace" />
        </StoreProvider>
      </div>
    </Case>
    <Case label="DeepSeek's own tools, with their output">
      <div className="w-full flex flex-col" data-testid="dsh-turn-sample" data-register="light">
        <StoreProvider store={catalogueStore}>
          {CATALOGUE_DSH_TURN.map((item) => <ItemView key={item.id} item={item} root="/workspace" />)}
        </StoreProvider>
      </div>
    </Case>
    <Case label="a runtime whose results come back empty">
      <div className="w-full flex flex-col" data-testid="empty-results-sample" data-register="light">
        <StoreProvider store={catalogueStore}>
          {CATALOGUE_EMPTY_RESULTS.map((item) => <ItemView key={item.id} item={item} root="/workspace" />)}
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

export const DialogBoard = () => {
  const [open, setOpen] = useState<null | 'plain' | 'form' | 'confirm' | 'approval' | 'lightbox'>(null)
  const [name, setName] = useState('')
  const [ceiling, setCeiling] = useState<'read' | 'edit' | 'publish' | 'merge'>('read')
  return (
    <>
      <div className={styles.matrix}>
        <Case label="open one">
          <Button variant="secondary" onClick={() => setOpen('plain')}>Dialog</Button>
          <Button variant="secondary" onClick={() => setOpen('form')}>Form dialog</Button>
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
      {open === 'form' && (
        /* The form grammar: the body is the form stack, a Field's label sits
           on its control, a Fieldset's legend on its group, and a ChoiceList
           explains only the answer that holds. The primary stays disabled
           until the name is written. */
        <Dialog
          title="Save as an Agent"
          size="md"
          onClose={() => setOpen(null)}
          footer={
            <>
              <Button variant="default" disabled={name.trim() === ''} onClick={() => setOpen(null)}>
                Save
              </Button>
              <Button variant="secondary" onClick={() => setOpen(null)}>Cancel</Button>
            </>
          }
        >
          <Field label="Name">
            {(control) => <Input {...control} value={name} placeholder="Checkout reviewer" onChange={(event) => setName(event.target.value)} />}
          </Field>
          <Field label="What it is for" optional hint="One line. The roster shows it under the name.">
            {(control) => <Input {...control} />}
          </Field>
          <Fieldset legend="The most it may do">
            <ChoiceList
              label="The most it may do"
              value={ceiling}
              onChange={setCeiling}
              options={[
                { value: 'read', title: 'Read', description: 'Changes nothing: it reads, searches and reports.' },
                { value: 'edit', title: 'Edit', description: 'May change files and commit in its own checkout, and never push.' },
                { value: 'publish', title: 'Publish', description: 'May push its own branch and open a pull request, and never merge.' },
                { value: 'merge', title: 'Merge', description: 'May merge what it is asked to merge.' },
              ]}
            />
          </Fieldset>
        </Dialog>
      )}
      {open === 'confirm' && (
        <ConfirmDialog
          title="Delete conversation"
          confirmLabel="Delete"
          tone="destructive"
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
          <ApprovalReason>Runs the repository's complete verification gate.</ApprovalReason>
          <ApprovalCode>pnpm verify</ApprovalCode>
          <ApprovalMeta label="in">/workspace</ApprovalMeta>
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
      <p className={styles.rule}>
        A footer has one filled button: the act, in ink — or filled red (<code>danger</code>) when it
        destroys — and a quiet way out. A disabled act keeps its own hue, dimmed, so it still reads as
        the act. A form dialog&rsquo;s body keeps one rhythm: a label 6px over its control, the next
        field 16px down, a legend on its group the way a label sits on its field, and a choice list
        that explains only the answer that holds.
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
 * One density: the channel is read in the room, where it *is* the
 * conversation, and it is built from the transcript's own parts.
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

    <Case label="a notice, and a message with its envelope">
      <div className={styles.channel}>
        <ChannelNotice
          about="Opus"
          cause="limit"
          text="You've hit your usage limit. It resets at 3:20 PM."
          at="03:36 PM"
        />
        <ChannelMessage
          from="Builder"
          brand="cursor"
          tint="violet"
          to="Reviewer"
          at="03:37 PM"
          state="delivered"
          envelope={'Message from Builder — “Review the verify fix”\n\nThe verify fix looks right.'}
          text="The verify fix looks right — root build, then the suites. One thing: the fixture copy runs before the renderer build, so a changed fixture needs two runs to land."
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
      One density, and the transcript&rsquo;s parts. Each row is a transcript
      item &mdash; a grouped message and a board event are its light register
      &mdash; the face is the room&rsquo;s identity tile on the sender&rsquo;s
      tint, the attribution is one run of facts at the left (name, who it
      reached, when, and how it went), and trouble is a chip in the tone it is.
      The envelope is held back until the pointer or the keyboard arrives,
      because it is a diagnostic rather than part of reading.
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
    id: 'queue',
    title: 'Sortable list · Trigger picker',
    about: 'Work waiting beside the composer, and the list that inserts into it.',
    render: QueueBoard,
  },
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
    id: 'app-window',
    title: 'AppWindow',
    about: 'Full-window navigation and page chrome for places a person goes to read.',
    render: AppWindowBoard,
  },
  {
    id: 'face',
    title: 'Face',
    about: 'A person, drawn: the face they chose, or the house mark.',
    render: FaceBoard,
  },
  {
    id: 'notices',
    title: 'Notices',
    about:
      'Where a message goes, chosen by what it is about: a card at the sidebar\u2019s foot for something to do when convenient, a notice on the composer it blocks, a slim strip, the inbox for what is worth keeping, a toast for a result. One message shape for all five.',
    render: NoticesBoard,
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
]
