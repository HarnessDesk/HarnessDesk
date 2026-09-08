import { useEffect, useMemo, useState, type ReactNode } from 'react'

import type {
  Account,
  AcpRegistryCatalogInfo,
  AgentTemplateInfo,
  ConfigOption,
  InstallInfo,
  OptionValue,
  RateLimits,
  RuntimeHealth,
  RuntimeId,
  RuntimeInfo,
  UsageWindow,
} from '@harnessdesk/protocol'

import {
  accountIdentity,
  agentGroups,
  accountKey,
  accountName,
  connectionLabel,
  credentialHome,
  TINTS,
  tintOf,
  type Tint,
} from '../lib/accounts'
import {
  registryAddLabel,
  registryMatches,
  registryOrder,
  registrySentence,
} from '../lib/acp-registry'
import { describeLimits, formatReset } from '../lib/limits'
import { readinessOf, worstReadiness, type Readiness } from '../lib/readiness'
import { codeSpans, splitHealth, type Unavailable } from '../lib/health'
import { bindingLane, isBlocked, remainingOf } from '../lib/usage'
import { describeUpdate, describeVersion } from '../lib/versions'
import { copyReason, describeCopy, describeFallback, installSummary, standingChip } from '../lib/installs'
import { useSnapshot, useStore } from '../state/context'
import type { AppSnapshot } from '../state/store'
import { RuntimeMark } from './BrandIcons'
import {
  AgentIcon,
  CaretIcon,
  CheckIcon,
  PlusIcon,
  SignInIcon,
  SignOutIcon,
} from './Icons'
import {
  BackLink,
  Btn,
  Chip,
  DetailHead,
  Dot,
  Field,
  FormStack,
  Input,
  kit,
  Note,
  Search,
  Select,
  Textarea,
  PageHead,
  Row,
  RowButton,
  Rows,
  SectionHead,
  Segmented,
  Toggle,
} from '../design/primitives/Kit'
import { useOptionConfirm } from './OptionConfirm'
import { Dialog } from '../design/primitives/Dialog'
import { ConfirmDialog } from '../design/patterns/ConfirmDialog'
import styles from './SettingsAgents.module.css'

/**
 * Agents, and the accounts under them.
 *
 * The account is the unit. An agent is the runtime that account speaks
 * through, so the page is a list of agents each holding its accounts, and
 * opening one of either replaces the page rather than floating a sheet over
 * it — detail is never a dialog here.
 */

type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'add' }
  | { readonly kind: 'agent'; readonly runtime: RuntimeId }
  | { readonly kind: 'account'; readonly runtime: RuntimeId; readonly key: string }

/** What the page is narrowed to, beside the search text. */
type StatusFilter = 'all' | Readiness

/** The agent list's slice of the snapshot — everything these helpers read. */
type AgentsView = Pick<
  AppSnapshot,
  'accountsByRuntime' | 'accountPrefs' | 'healthByRuntime' | 'usage'
>

/**
 * Whether a turn sent to this agent right now would start — over every
 * account it holds, not just the first.
 *
 * The worst answer wins, so an agent whose second account is out of credit
 * does not report itself ready. Two cases the plain `readinessOf` cannot see
 * from one runtime: a gateway account has no vendor account under it and is
 * complete the moment it exists, and a slot added but never signed into is an
 * unfinished extra rather than a claim that the whole agent needs signing in
 * — it only speaks when no sibling has an account at all.
 */
export const agentReadiness = (
  siblings: readonly RuntimeInfo[],
  view: AgentsView,
): Readiness => {
  const answered = siblings
    .map((entry): Readiness | null => {
      const health = view.healthByRuntime[entry.id] ?? null
      if (health?.state === 'unavailable') return 'broken'
      if (entry.slot?.gateway) return 'ready'
      const status = view.accountsByRuntime[entry.id] ?? null
      if ((status?.accounts.length ?? 0) === 0) return null
      return readinessOf({
        registered: true,
        health,
        account: status,
        usage: view.usage.filter((report) => report.runtime === entry.id),
      })
    })
    .filter((state): state is Readiness => state !== null)
  if (answered.length > 0) return worstReadiness(answered)
  // Nothing signed in anywhere. An agent that runs without an account is
  // ready like that; every other one is waiting on a credential.
  return siblings.some((entry) => entry.capabilities.account) ? 'signin' : 'ready'
}

/**
 * Whether typed text finds this agent.
 *
 * The field says "agents or accounts" and means it: the nickname you gave an
 * account, the address behind it, the plan it is on and the endpoint a
 * gateway points at are all findable, because those are the words someone
 * looking for one account among ten actually remembers.
 */
export const agentMatches = (
  siblings: readonly RuntimeInfo[],
  view: AgentsView,
  needle: string,
): boolean => {
  if (!needle) return true
  const words: (string | null | undefined)[] = []
  for (const entry of siblings) {
    words.push(entry.presentation.name, entry.presentation.tagline, entry.name)
    words.push(entry.slot?.gateway?.name, entry.slot?.gateway?.endpoint)
    for (const account of view.accountsByRuntime[entry.id]?.accounts ?? []) {
      words.push(account.label, account.email, account.planType)
      words.push(accountName(account, view.accountPrefs[accountKey(entry.id, account)]))
    }
  }
  return words.some((word) => (word ?? '').toLowerCase().includes(needle))
}

/** "2 accounts", or the honest sentence when there are none. */
/**
 * How many accounts, or nothing at all.
 *
 * This slot used to answer for every agent — "No account needed", "Signs in
 * on its own" — and on a page of ten that is the same sentence ten times,
 * which is one sentence of information and ten rows of height. What varies
 * here is a count and a state, and the state has a chip of its own; an agent
 * with neither says nothing, which is what "nothing is wrong" should look
 * like. See docs/design.md.
 */
const countLabel = (count: number): string | null =>
  count === 0 ? null : count === 1 ? '1 account' : `${count} accounts`

/** One rolling allowance as a bar: how much of the window is left, and when it refills. */
export const UsageMeter = ({ window }: { window: UsageWindow }) => {
  const remaining = Math.max(0, Math.round(100 - window.usedPercent))
  const tone = remaining <= 0 ? 'bad' : remaining < 20 ? 'warn' : 'good'
  const reset = formatReset(window.resetsAt)
  return (
    <div className={styles.meter} data-tone={tone}>
      <div className={styles.meterHead}>
        <span className={styles.meterLabel}>{window.label}</span>
        <span className={styles.meterValue}>
          {remaining}% left
          {reset && <span className={styles.meterReset}> · resets {reset}</span>}
        </span>
      </div>
      {/* Filled with what is LEFT, like every other meter in the app. It used
          to fill with what had been spent under a figure reading "48% left",
          so the bar and its own number moved in opposite directions. */}
      <div
        className={styles.meterTrack}
        role="progressbar"
        aria-valuenow={remaining}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${window.label} remaining`}
      >
        <div className={styles.meterFill} style={{ width: `${remaining}%` }} />
      </div>
    </div>
  )
}

/** The account's own colour, as five circles wearing the agent's mark. */
const RingPicker = ({
  info,
  value,
  onChange,
}: {
  info: RuntimeInfo
  value: Tint
  onChange: (tint: Tint) => void
}) => (
  <span className={styles.rings} role="radiogroup" aria-label="Ring colour">
    {TINTS.map((tint) => (
      <button
        key={tint}
        type="button"
        role="radio"
        aria-checked={tint === value}
        aria-label={tint}
        className={`${kit.avatar} ${styles.ring}`}
        data-tint={tint}
        {...(tint === value ? { 'data-on': '' } : {})}
        onClick={() => onChange(tint)}
      >
        <RuntimeMark runtime={info} size={14} />
      </button>
    ))}
  </span>
)

/** Host text, with what it wrote between backticks set as code. */
const Prose = ({ text }: { text: string }) => (
  <>
    {codeSpans(text).map((span, index) =>
      span.code ? (
        <code key={index} className={kit.mono}>
          {span.text}
        </code>
      ) : (
        <span key={index}>{span.text}</span>
      ),
    )}
  </>
)

/**
 * Why an agent will not start, in three parts rather than one paragraph.
 *
 * The sentence naming what happened, then the agent's own output with its
 * line breaks kept — a validator reports one finding per line and collapsing
 * that into prose is what made this unreadable — then the repair. The block
 * scrolls rather than growing: an agent having a bad day must not push the
 * nine below it off the screen.
 *
 * There is no state marker here. The block is the state; a red dot floating
 * beside six lines of it was pointing at something already said.
 */
const HealthBlock = ({ health }: { health: Unavailable }) => {
  const { lead, detail, remediation } = splitHealth(health)
  return (
    <div className={styles.problem}>
      <p className={styles.problemLead}>
        <Prose text={lead} />
      </p>
      {detail && <pre className={styles.problemDetail}>{detail}</pre>}
      {remediation && (
        <p className={styles.problemFix}>
          <Prose text={remediation} />
        </p>
      )}
    </div>
  )
}

/* --- the list ------------------------------------------------------------ */

/** What this agent's accounts look like as rows, plus how to add one. */
const AgentBlock = ({
  info,
  siblings,
  state,
  open,
  onToggle,
  onOpenAgent,
  onOpenAccount,
  onSignIn,
}: {
  info: RuntimeInfo
  /**
   * Every runtime that is this same agent, `info` first. An agent whose CLI
   * keeps one credential gets a second account by running a second time over
   * a credential home of its own, so "the accounts of this agent" and "the
   * runtimes of this agent" are the same list.
   */
  siblings: readonly RuntimeInfo[]
  /** Whether a turn sent to this agent would start — see `agentReadiness`. */
  state: Readiness
  /** Whether the accounts under it are showing. */
  open: boolean
  onToggle: () => void
  onOpenAgent: () => void
  onOpenAccount: (runtime: RuntimeId, key: string) => void
  onSignIn: (runtime: RuntimeId) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [addingGateway, setAddingGateway] = useState(false)
  const [adding, setAdding] = useState(false)
  const status = snapshot.accountsByRuntime[info.id]
  // One flat list of rows across the agent's runtimes, each row remembering
  // which runtime it belongs to — that is what a sign-out or a removal needs.
  const rows = siblings.flatMap((entry) =>
    (snapshot.accountsByRuntime[entry.id]?.accounts ?? []).map((account) => ({ entry, account })),
  )
  // A gateway account never signs in, so it has no vendor account to list and
  // would otherwise fall into `empties` and be offered a sign-in it does not
  // want. It is complete the moment it exists; it gets a row of its own.
  const gateways = siblings.filter((entry) => entry.slot?.gateway)
  const empties = siblings.filter(
    (entry) =>
      entry !== info &&
      !entry.slot?.gateway &&
      (snapshot.accountsByRuntime[entry.id]?.accounts ?? []).length === 0,
  )
  const canSignIn = (status?.signInMethods ?? []).some((method) => method.flow !== 'external')
  // A key has to be typed somewhere, so those methods hand off to the sign-in
  // page instead of being started from a button with nowhere to type.
  const needsField = (status?.signInMethods ?? []).every(
    (method) => method.flow === 'apiKey' || method.flow === 'external',
  )
  const health = snapshot.healthByRuntime[info.id] ?? null
  const build = describeVersion(info)?.replace(`${info.presentation.name} `, '') ?? null
  const connection = connectionLabel(info, status?.signInMethods ?? [])
  const count = countLabel(rows.length + gateways.length)

  /**
   * Making the account and signing into it, in that order.
   *
   * An agent that can hold several gets a fresh credential home first, so the
   * browser flow lands beside the existing account instead of on top of it.
   * One that cannot falls back to the old behaviour, which its own tooltip
   * has always described honestly.
   */
  const addAccount = async (): Promise<void> => {
    if (!info.slot?.canAdd) {
      if (needsField) onSignIn(info.id)
      else await store.signInAgent(info.id)
      return
    }
    // Held for the whole of it, not just the add. `runtime/account/add` now
    // waits for the new account to be able to answer before it hands the id
    // back — a fifth of a second usually, and up to the host's start deadline
    // when an agent is wedged — which is exactly the interval in which a
    // person presses again because nothing happened. Two presses are two
    // slots: `AccountSlots.add` is unconditional, so each one is another
    // credential home, another process and another row, and the orphan is
    // only swept up at the next launch.
    if (adding) return
    setAdding(true)
    try {
      const added = await store.addAccount(info.id)
      if (!added) return
      if (needsField) onSignIn(added)
      else await store.signInAgent(added)
    } finally {
      setAdding(false)
    }
  }

  return (
    <section className={styles.agent} {...(open ? { 'data-open': '' } : {})}>
      {/* Two targets, not one: the agent's name opens what belongs to the
          runtime — health, version, behaviour — and the caret only decides
          whether its accounts are on screen. Nesting them would make one of
          the two unreachable. */}
      <div className={styles.head}>
        {/* The tagline rides on hover here. This card is about an agent you
            already chose and installed; a definition of it cannot change what
            you do on a page for managing its accounts, and the one line it had
            was set to nowrap, so a longer one arrived cut. It still shows in
            full where choosing is the actual task — the Add agent list below,
            first run, and sign-in. */}
        <button
          type="button"
          className={styles.headOpen}
          title={info.presentation.tagline}
          onClick={onOpenAgent}
        >
          <span className={kit.rowMark}>
            <RuntimeMark runtime={info} size={17} />
          </span>
          <span className={styles.headText}>
            <span className={styles.headName}>
              {info.presentation.name}
              {build && <span className={styles.headBuild}>{build}</span>}
              {connection && <span className={styles.tag}>{connection}</span>}
            </span>
          </span>
          {/* Inside the name's button, not beside it: how many accounts there
              are and whether they work is what the agent's own page answers,
              so the whole sentence is one target and the caret is the only
              thing on this row that means something else. */}
          {/* One vocabulary, and only when it has something to say: which
              agent the composer points at, how many accounts there are, and
              the state — as a chip that names itself, never as a bare dot the
              reader has to decode. A healthy agent shows none of the three. */}
          <span className={styles.headMeta}>
            {snapshot.activeRuntime === info.id && <Chip state="ready" label="Active" />}
            {count !== null && <span className={styles.headCount}>{count}</span>}
            {state !== 'ready' && <Chip state={state} />}
          </span>
        </button>
        <button
          type="button"
          className={styles.headToggle}
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} the accounts under ${info.presentation.name}`}
          onClick={onToggle}
        >
          <CaretIcon size={15} />
        </button>
      </div>

      {open && (
      <div className={styles.body}>
      <div className={styles.list}>
        {rows.map(({ entry, account }) => {
          const key = accountKey(entry.id, account)
          const own = snapshot.usage.filter((report) => report.runtime === entry.id)
          const report = own.find((item) => item.account === account.label) ?? own[0]
          // What is left is the account's binding window — the tightest of the
          // *account-wide* lanes, which is what `bindingLane` picks. Taking the
          // tightest of every lane instead read `0% left` beside a chip that
          // correctly said the account was fine, because a spent model-scoped
          // week is the tightest lane and is not the account's figure. Rounded
          // the way `describeLane` rounds, so this row and the Dashboard cannot
          // disagree about the same account.
          const binding = report ? bindingLane(report.lanes) : null
          const remaining = binding === null ? null : remainingOf(binding)
          const left = remaining === null ? null : Math.round(remaining)
          // Account-wide only: a spent model-scoped window is a limit you
          // can step around, and this chip speaks for the whole account.
          const accountState: Readiness =
            report && isBlocked(report) ? 'limit' : state === 'broken' ? 'broken' : 'ready'
          const name = accountName(account, snapshot.accountPrefs[key])
          const identity = account.email ?? account.label
          return (
            <RowButton
              key={key}
              onClick={() => onOpenAccount(entry.id, key)}
              mark={
                <span
                  className={`${kit.avatar} ${styles.rowAvatar}`}
                  data-tint={tintOf(key, snapshot.accountPrefs)}
                >
                  <RuntimeMark runtime={info} size={14} />
                </span>
              }
              title={
                <span className={styles.rowName}>
                  {name}
                  {entry.id === info.id && rows.length > 1 && (
                    <span className={styles.badge}>Default</span>
                  )}
                </span>
              }
              /* The plan used to ride along in this line as "…@acme.dev · Pro".
                 It is the one word that answers "what am I paying for", so it
                 moved to the right where the other answers are, and the line
                 is the address again — and is dropped when it would only
                 repeat the name above it, as "API key" over "API key" did. */
              {...(identity && identity !== name ? { desc: identity } : {})}
              control={
                <>
                  {account.planType && (
                    <span
                      className={styles.plan}
                      data-tint={tintOf(key, snapshot.accountPrefs)}
                    >
                      {account.planType}
                    </span>
                  )}
                  {/* Said, not implied: a bare "48%" reads as spent to half the
                      people who see it, and the meters this comes from fill
                      with what is left. */}
                  {left !== null && <span className={styles.figure}>{left}% left</span>}
                  <Dot state={accountState} />
                </>
              }
            />
          )
        })}

        {/* An account of this same agent, on the user's own endpoint. Same
            models, same everything — the bill is what moved, so the row says
            where it goes and nothing about signing in. */}
        {gateways.map((entry) => (
          <Row
            key={entry.id}
            mark={
              <span className={`${kit.avatar} ${styles.rowAvatar}`}>
                <RuntimeMark runtime={info} size={14} />
              </span>
            }
            title={
              <span className={styles.rowName}>
                {entry.slot?.gateway?.name}
                <span className={styles.badge}>Gateway</span>
              </span>
            }
            desc={entry.slot?.gateway?.endpoint}
            control={
              <Btn small variant="quiet" onClick={() => void store.removeAccount(entry.id)}>
                Remove
              </Btn>
            }
          />
        ))}

        {/* A slot made but never signed into. Left visible on purpose: it is
            what an abandoned sign-in leaves behind, and hiding it would put
            the credential home on disk with nothing naming it. */}
        {empties.map((entry) => (
          <Row
            key={entry.id}
            title="Waiting to be signed in"
            desc="This account was added but the sign-in never finished. Sign in to use it, or remove it."
            control={
              <>
                <Btn small variant="primary" onClick={() => void store.signInAgent(entry.id)}>
                  <SignInIcon size={13} />
                  Sign in
                </Btn>
                <Btn small onClick={() => void store.removeAccount(entry.id)}>
                  Remove
                </Btn>
              </>
            }
          />
        ))}

        {rows.length === 0 && gateways.length === 0 && health?.state === 'unavailable' ? (
          /* A dead agent's account is not the story. This row used to read
             "runs without an account" about an agent that could not start —
             a true sentence about the wrong subject. */
          <HealthBlock health={health} />
        ) : (
          rows.length === 0 &&
          gateways.length === 0 && (
            <Row
              title={
                info.capabilities.account
                  ? 'Not signed in'
                  : info.install?.signIn
                    ? 'Signs in on its own'
                    : 'No account needed'
              }
              /* The command differs per agent and is the only thing here
                 anyone can act on, so it is earned — and it is set as code,
                 which is what it is. */
              desc={
                info.capabilities.account ? (
                  `${info.presentation.name} has no credential here yet, so a session sent to it would not start.`
                ) : info.install?.signIn ? (
                  <Prose
                    text={`${info.presentation.name} keeps its own credential — HarnessDesk never sees it. ${
                      info.install.signIn.terminal
                        ? `Sign in by running \`${info.install.signIn.terminal}\` in a terminal.`
                        : info.install.signIn.note
                    }`}
                  />
                ) : (
                  `${info.presentation.name} runs without one.`
                )
              }
              /* A button where there is something to press, and nothing where
                 there is not. The dot that used to sit here said "ready" about
                 an agent nobody can sign in from this app — a green mark at
                 the end of a sentence explaining that, which is the header's
                 job and was already done there. */
              control={
                info.capabilities.account && canSignIn ? (
                  <Btn
                    small
                    variant="primary"
                    onClick={() => (needsField ? onSignIn(info.id) : void store.signInAgent(info.id))}
                  >
                    <SignInIcon size={13} />
                    Sign in
                  </Btn>
                ) : undefined
              }
            />
          )
        )}
      </div>

      {addingGateway && <GatewayDialog info={info} onClose={() => setAddingGateway(false)} />}

      {(info.slot?.canAdd || (rows.length > 0 && info.capabilities.account && canSignIn)) && (
        <div className={styles.foot}>
          {info.capabilities.account && canSignIn && (
            <Btn
              small
              variant="quiet"
              title={
                info.slot?.canAdd
                  ? `${info.presentation.name} keeps one credential per home, so a new account gets a home of its own. Its sessions stay shared with this one.`
                  : /* Said out loud rather than discovered: most CLIs keep one
                       credential file, so a second sign-in replaces the first. */
                    `${info.presentation.name} keeps one credential, so signing in again replaces this one.`
              }
              disabled={adding}
              onClick={() => void addAccount()}
            >
              <PlusIcon size={13} />
              {adding ? 'Adding…' : 'Add account'}
            </Btn>
          )}
          {/* Offered even with no plan account signed in: paying your own way
              is a first-class way to run this agent, not a fallback. */}
          {info.slot?.canAdd && (
            <Btn
              small
              variant="quiet"
              title={`Run ${info.presentation.name} against your own endpoint — an API key or a gateway — instead of the plan it signs into.`}
              onClick={() => setAddingGateway(true)}
            >
              <PlusIcon size={13} />
              Add gateway account…
            </Btn>
          )}
        </div>
      )}
      </div>
      )}
    </section>
  )
}

/* --- adding an agent ------------------------------------------------------ */

/**
 * A gateway account for this agent: the same agent, billed to an endpoint of
 * the user's own. The form is a child so that closing it unmounts it — a
 * cancelled key must not sit in a parent's state waiting for the next open.
 */
const GatewayDialog = ({ info, onClose }: { info: RuntimeInfo; onClose: () => void }) => {
  const store = useStore()
  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = name.trim() !== '' && endpoint.trim() !== '' && apiKey.trim() !== ''

  const save = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      const added = await store.addGatewayAccount(info.id, {
        name: name.trim(),
        endpoint: endpoint.trim(),
        apiKey: apiKey.trim(),
      })
      if (!added) {
        setError('HarnessDesk could not add it. Check the endpoint and the key.')
        return
      }
      onClose()
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Add a gateway account"
      icon={<RuntimeMark runtime={info} size={15} />}
      onClose={onClose}
      footer={
        <>
          <Btn variant="primary" disabled={busy || !ready} onClick={() => void save()}>
            {busy ? 'Adding…' : 'Add account'}
          </Btn>
          <Btn onClick={onClose}>Cancel</Btn>
        </>
      }
    >
      <FormStack>
        <Field label="Name" hint="How the composer lists it.">
          {(control) => (
            <Input
              {...control}
              value={name}
              placeholder="Vercel AI Gateway"
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <Field label="Endpoint">
          {(control) => (
            <Input
              {...control}
              value={endpoint}
              placeholder="https://ai-gateway.vercel.sh/codex/v1"
              onChange={(event) => setEndpoint(event.target.value)}
            />
          )}
        </Field>
        <Field label="API key" hint="Kept in the keychain, never written to a file.">
          {(control) => (
            <Input
              {...control}
              type="password"
              value={apiKey}
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
            />
          )}
        </Field>
      </FormStack>
      {error ? (
        <Note key="error" tone="bad">{error}</Note>
      ) : (
        <Note key="note">
          Same {info.presentation.name}, same models, billed to this endpoint instead of the
          account above.
        </Note>
      )}
    </Dialog>
  )
}

/**
 * An agent of the user's own: a name and a command. A child for the same
 * reason as the gateway dialog — closing it forgets what was typed.
 */
const CustomAgentDialog = ({ onAdded, onClose }: { onAdded: () => void; onClose: () => void }) => {
  const store = useStore()
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = name.trim() !== '' && command.trim() !== ''

  const add = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      const added = await store.addAgent({
        custom: {
          name: name.trim(),
          command: command.trim(),
          args: args
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        },
      })
      if (!added) {
        setError('HarnessDesk could not add it. Check that the command starts.')
        return
      }
      onAdded()
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Add a custom agent"
      icon={<AgentIcon size={15} />}
      onClose={onClose}
      footer={
        <>
          <Btn variant="primary" disabled={busy || !ready} onClick={() => void add()}>
            {busy ? 'Adding…' : 'Add agent'}
          </Btn>
          <Btn onClick={onClose}>Cancel</Btn>
        </>
      }
    >
      <FormStack>
        <Field label="Name" hint="What the picker calls it.">
          {(control) => (
            <Input {...control} value={name} autoFocus onChange={(event) => setName(event.target.value)} />
          )}
        </Field>
        <Field label="Command" hint="A name on your PATH, or an absolute path.">
          {(control) => (
            <Input
              {...control}
              value={command}
              placeholder="my-agent"
              onChange={(event) => setCommand(event.target.value)}
            />
          )}
        </Field>
        <Field label="Arguments" hint="One per line.">
          {(control) => (
            <Textarea
              {...control}
              value={args}
              placeholder="--acp"
              rows={3}
              onChange={(event) => setArgs(event.target.value)}
            />
          )}
        </Field>
      </FormStack>
      {error ? (
        <Note key="error" tone="bad">{error}</Note>
      ) : (
        <Note key="note">
          Secrets, a working directory and account commands live in the registry file this
          adds a row to.
        </Note>
      )}
    </Dialog>
  )
}


/**
 * The agents this build can register without a text editor.
 *
 * The catalogue comes from the host — it knows which bridges shipped and
 * which CLIs are on this machine — so nothing here names a runtime. A row
 * that cannot be added says why, with the install command beside the reason,
 * because a greyed button with no sentence is a dead end.
 */
export const AddAgents = ({ onBack, onDone }: { onBack: () => void; onDone: () => void }) => {
  const store = useStore()
  const [templates, setTemplates] = useState<readonly AgentTemplateInfo[] | null>(null)
  const [registry, setRegistry] = useState<AcpRegistryCatalogInfo | null>(null)
  const [registryQuery, setRegistryQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [customOpen, setCustomOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void store.agentCatalog().then((loaded) => {
      if (!cancelled) setTemplates(loaded)
    })
    void store.acpRegistry().then((loaded) => {
      if (!cancelled) setRegistry(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [store])

  const add = async (key: string): Promise<void> => {
    setBusy(key)
    try {
      const added = await store.addAgent({ template: key })
      if (added) setTemplates(await store.agentCatalog())
    } finally {
      setBusy(null)
    }
  }

  const addFromRegistry = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      const added = await store.addAgent({ registry: { id } })
      if (added) setRegistry(await store.acpRegistry())
    } finally {
      setBusy(null)
    }
  }

  const registryListed = registryOrder(registry?.agents ?? []).filter((agent) =>
    registryMatches(agent, registryQuery),
  )

  return (
    <>
      <BackLink to="Agents" onClick={onBack} />
      <PageHead
        title="Add an agent"
        blurb="An agent keeps its own account, configuration and history; adding it here only tells HarnessDesk how to start it."
      />
      <Rows>
        {(templates ?? []).map((template) => (
          <Row
            key={template.key}
            /* The square is the agent and the circle is an account, on this
               page and on the list it comes back to. A template has no
               account yet, so it can only be the square. */
            mark={
              <span className={kit.rowMark}>
                <RuntimeMark
                  runtime={{
                    id: template.key,
                    presentation: {
                      name: template.name,
                      ...(template.brand ? { brand: template.brand } : {}),
                    },
                  }}
                  size={17}
                />
              </span>
            }
            title={template.name}
            desc={
              template.registered ? (
                template.tagline
              ) : template.available ? (
                <>
                  {template.tagline}
                  {template.requires?.found && template.requires.version && (
                    <>
                      {' '}
                      Found {template.requires.command} {template.requires.version}
                      {template.requires.channelLabel ? ` via ${template.requires.channelLabel}` : ''}.
                    </>
                  )}
                  {template.requires && !template.requires.found && (
                    <>
                      {' '}
                      Works without {template.requires.command} installed, using the bridge's own
                      copy.
                    </>
                  )}
                </>
              ) : (
                <>
                  {template.reason}
                  {template.requires?.installCommand && (
                    <>
                      {' '}
                      Install it with{' '}
                      <span className={kit.mono}>{template.requires.installCommand}</span>, then
                      come back.
                    </>
                  )}
                </>
              )
            }
            control={
              template.registered ? (
                <Chip state="ready" label="Added" />
              ) : (
                <Btn
                  small
                  variant="primary"
                  disabled={!template.available || busy !== null}
                  onClick={() => void add(template.key)}
                >
                  <PlusIcon size={13} />
                  {busy === template.key ? 'Adding…' : 'Add'}
                </Btn>
              )
            }
          />
        ))}
        {templates === null && <Row title="Looking at this machine…" />}
      </Rows>

      {/* The protocol's own list. Every entry is shown — the blocked ones say
          why in the line a description would use, and the search exists
          because forty rows is where scanning stops working. */}
      <SectionHead name="From the ACP registry" />
      {(registry?.agents.length ?? 0) > 8 && (
        <Search
          className={styles.pageSearch}
          value={registryQuery}
          placeholder="Search the registry"
          label="Search the ACP registry"
          onChange={setRegistryQuery}
        />
      )}
      {/* A catalogue of forty is a grid of compact cells, not forty rows —
          each carries its sentence in full, and a blocked entry's sentence is
          the reason, so nothing is grey without saying why. A binary entry's
          button reads Download, because that is what the click does. */}
      {registryListed.length > 0 && (
        <div className={styles.registryGrid}>
          {registryListed.map((agent) => {
            const line = registrySentence(agent)
            return (
              <div
                key={agent.id}
                className={styles.registryCell}
                {...(agent.available ? {} : { 'data-blocked': '' })}
              >
                <span className={kit.rowMark}>
                  <RuntimeMark
                    runtime={{ id: agent.id, presentation: { name: agent.name } }}
                    size={17}
                  />
                </span>
                <span className={styles.registryCellText}>
                  <span className={styles.registryCellName}>{agent.name}</span>
                  {line && <span className={styles.registryCellLine}>{line}</span>}
                </span>
                {agent.registered ? (
                  <Chip state="ready" label="Added" />
                ) : agent.available ? (
                  <Btn
                    small
                    variant="primary"
                    disabled={busy !== null}
                    onClick={() => void addFromRegistry(agent.id)}
                  >
                    <PlusIcon size={13} />
                    {registryAddLabel(agent, busy === agent.id)}
                  </Btn>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
      {registry === null && (
        <Rows>
          <Row title="Reading the registry…" />
        </Rows>
      )}
      {registry !== null && registryListed.length === 0 && (
        <Rows>
          <Row
            title={
              registry.unavailable ??
              (registryQuery.trim()
                ? 'Nothing in the registry matches'
                : 'The registry lists nothing to add')
            }
          />
        </Rows>
      )}

      <SectionHead name="Something else" />
      <Rows>
        <Row
          title="A command of your own"
          desc="Any agent that speaks the protocol: name it and say how to start it."
          control={
            <Btn small onClick={() => setCustomOpen(true)}>
              <PlusIcon size={13} />
              Set up…
            </Btn>
          }
        />
      </Rows>
      {customOpen && (
        <CustomAgentDialog onAdded={onDone} onClose={() => setCustomOpen(false)} />
      )}
    </>
  )
}

/* --- one account --------------------------------------------------------- */

const AccountDetail = ({
  info,
  account,
  onBack,
  onSignIn,
}: {
  info: RuntimeInfo
  account: Account
  onBack: () => void
  onSignIn: (runtime: RuntimeId) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const key = accountKey(info.id, account)
  const prefs = snapshot.accountPrefs[key]
  const [name, setName] = useState(prefs?.nickname ?? '')
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [limits, setLimits] = useState<RateLimits | null>(null)
  const report = snapshot.usage.find(
    (entry) => entry.runtime === info.id && (entry.account === account.label || entry.account === null),
  )
  const state: Readiness = report && isBlocked(report) ? 'limit' : 'ready'

  useEffect(() => {
    let cancelled = false
    void store.limitsFor(info.id).then((loaded) => {
      if (!cancelled) setLimits(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [store, info.id, account.label])

  const limitsView = describeLimits(limits)
  const planLabel = account.kind === 'externalKey' ? null : (account.planType ?? limits?.planType ?? null)
  const isKey = account.kind === 'apiKey' || account.kind === 'externalKey'

  return (
    <>
      <BackLink to="Agents" onClick={onBack} />
      <DetailHead
        mark={
          <span
            className={`${kit.avatar} ${kit.avatarLg}`}
            data-tint={tintOf(key, snapshot.accountPrefs)}
          >
            <RuntimeMark runtime={info} size={20} />
          </span>
        }
        name={accountName(account, prefs)}
        owner={info.presentation.name}
        blurb={accountIdentity(account)}
        actions={<Chip state={state} />}
      />

      <SectionHead name="Name and colour" />
      <Rows>
        <Row
          title="Name"
          desc="How the sidebar, the composer and the menu bar refer to this account."
          control={
            <Input
              className={styles.nameField}
              value={name}
              placeholder={accountName(account, undefined)}
              aria-label="Account name"
              onChange={(event) => setName(event.target.value)}
              onBlur={() => store.setAccountPrefs(key, { nickname: name })}
            />
          }
        />
        <Row
          title="Ring"
          desc="Tells this account apart from another one of the same agent."
          control={
            <RingPicker
              info={info}
              value={tintOf(key, snapshot.accountPrefs)}
              onChange={(tint) => store.setAccountPrefs(key, { tint })}
            />
          }
        />
      </Rows>

      <SectionHead name="Account" />
      <Rows>
        <Row
          title={account.label}
          desc={
            account.kind === 'apiKey'
              ? `Stored by HarnessDesk — ${snapshot.credentialProtection}. Handed to ${info.presentation.name} when it starts.`
              : account.kind === 'externalKey'
                ? `Read from ${account.planType}. HarnessDesk holds no copy.`
                : `${info.presentation.name} keeps the credential; HarnessDesk never stores it.`
          }
          control={
            <>
              {planLabel && <span className={kit.rowFixed}>{planLabel}</span>}
              {isKey ? (
                <Btn small onClick={() => onSignIn(info.id)}>
                  <SignInIcon size={13} />
                  Manage key…
                </Btn>
              ) : (
                <Btn small onClick={() => setConfirmingSignOut(true)}>
                  <SignOutIcon size={13} />
                  {info.slot?.removable ? 'Remove…' : 'Sign out…'}
                </Btn>
              )}
            </>
          }
        />
        {credentialHome(info) && (
          <Row
            title="Where its credential lives"
            desc={<span className={kit.mono}>{credentialHome(info)}</span>}
          />
        )}
      </Rows>

      <SectionHead name="Usage" />
      {limitsView?.blocked && (
        <p className={styles.note} data-tone="bad">
          {limitsView.blocked.title} — {limitsView.blocked.detail}
        </p>
      )}
      {limitsView && limitsView.windows.length > 0 ? (
        <Rows>
          <div className={styles.meters}>
            {limitsView.windows.map((window) => (
              <UsageMeter key={window.label} window={window} />
            ))}
          </div>
        </Rows>
      ) : (
        <Rows>
          <Row
            title="Nothing to read yet"
            desc={`${info.presentation.name} has not written any usage down on this Mac.`}
          />
        </Rows>
      )}

      <SectionHead name="Defaults" />
      <Rows>
        <Row
          title="Use for new sessions"
          desc="The composer starts on this account."
          control={
            snapshot.activeRuntime === info.id ? (
              <Chip state="ready" label="Default" />
            ) : (
              <Btn small onClick={() => void store.selectRuntime(info.id)}>
                Make default
              </Btn>
            )
          }
        />
      </Rows>
      {confirmingSignOut && (
        <ConfirmDialog
          title={info.slot?.removable ? `Remove ${accountName(account, prefs)}?` : `Sign out of ${accountName(account, prefs)}?`}
          confirmLabel={info.slot?.removable ? 'Remove account' : 'Sign out'}
          onCancel={() => setConfirmingSignOut(false)}
          onConfirm={() => {
            setConfirmingSignOut(false)
            // Removing an extra account signs it out and drops its
            // credential home. The sessions are the agent's, linked
            // rather than copied, so none of them go with it.
            if (info.slot?.removable) void store.removeAccount(info.id)
            else void store.signOutAgent(info.id)
            onBack()
          }}
        >
          {info.slot?.removable
            ? 'Its sign-in is forgotten. Conversations stay with the agent.'
            : `${info.presentation.name} forgets this sign-in. Signing in again is the only way back.`}
        </ConfirmDialog>
      )}
    </>
  )
}

/* --- one agent ----------------------------------------------------------- */

/** One list of declared options as rows — the same rendering wherever a page has some. */
const OptionRows = ({
  options,
  onSet,
}: {
  options: readonly ConfigOption[]
  onSet: (id: string, value: OptionValue) => void
}) => {
  const { ask, dialog } = useOptionConfirm()
  return (
    <Rows>
      {dialog}
      {options.map((option) => (
        <Row
          key={option.id}
          title={option.label}
          desc={option.description ?? option.disabled}
          control={
            option.type === 'boolean' ? (
              <Toggle
                label={option.label}
                on={option.currentValue}
                disabled={Boolean(option.disabled)}
                onChange={(next) => ask(option, next, () => onSet(option.id, next))}
              />
            ) : (
              <Segmented
                label={option.label}
                value={String(option.currentValue)}
                options={option.choices.map((choice) => ({
                  value: String(choice.value),
                  label: choice.label,
                }))}
                onChange={(value) => onSet(option.id, value)}
              />
            )
          }
        />
      ))}
    </Rows>
  )
}

/**
 * What this agent's next session starts with — model, effort, approvals,
 * sandbox, whatever the runtime declares. The list is the runtime's own
 * answer to `sessionDefaults` with the stored picks applied, and a pick made
 * here lands in the same per-agent record the composer's pre-session
 * controls write: one set of picks, whichever surface set them. A runtime
 * that only declares options once a session exists gets the truthful row
 * saying so, not an empty section pretending to be a choice.
 */
export const NewSessionDefaults = ({
  info,
  heading = 'New sessions',
  mark,
  only,
  empty = 'Set per conversation',
}: {
  info: RuntimeInfo
  /** The section's own name — the agent's, when several agents are listed together. */
  heading?: string
  /** A mark beside the heading, for the same reason. */
  mark?: ReactNode
  /** Show only some of the declared options — the access ones, on Permissions. */
  only?: (option: ConfigOption) => boolean
  /** The row shown when there is nothing to pre-set. */
  empty?: string
}) => {
  const store = useStore()
  const [options, setOptions] = useState<readonly ConfigOption[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void store.newSessionDefaultsFor(info.id).then((loaded) => {
      if (!cancelled) setOptions(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [store, info.id])

  const pick = (id: string, value: OptionValue): void => {
    void store.setNewSessionDefault(info.id, id, value).then(setOptions)
  }

  if (!Array.isArray(options)) return null
  const listed = only ? options.filter(only) : options
  return (
    <>
      <SectionHead
        name={
          mark ? (
            <span className={styles.sectionMark}>
              {mark}
              {heading}
            </span>
          ) : (
            heading
          )
        }
      />
      {listed.length === 0 ? (
        <Rows>
          <Row
            title={empty}
            desc={`${info.presentation.name} declares its controls once a session exists, so each conversation carries its own.`}
          />
        </Rows>
      ) : (
        <OptionRows options={listed} onSet={pick} />
      )}
    </>
  )
}

/**
 * Every copy of the agent on this machine, and which one answers.
 *
 * The host looked, judged and chose; the section shows its work. One row
 * per copy with its standing in a chip and its reason on the line; the
 * row's own fallback beneath, with the desk's own update button when the
 * fallback is a download the desk made; and the facts a person needs to
 * do the rest themselves — the update command for their package manager,
 * where the agent keeps its home, how it is signed into. Nothing here is
 * run on the person's behalf except the desk's own download.
 */
const InstallSection = ({ info }: { info: RuntimeInfo }) => {
  const store = useStore()
  const [install, setInstall] = useState<InstallInfo | null>(info.install ?? null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void store.installsFor(info.id).then((loaded) => {
      if (!cancelled && loaded) setInstall(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [store, info.id])

  useEffect(() => {
    if (info.install) setInstall(info.install)
  }, [info.install])

  if (!install) return null

  const choose = async (path: string | null): Promise<void> => {
    setBusy(path ?? 'auto')
    try {
      const next = await store.useInstall(info.id, path)
      if (next) setInstall(next)
    } finally {
      setBusy(null)
    }
  }

  const update = async (): Promise<void> => {
    setBusy('update')
    try {
      if (await store.updateAgent(info.id)) {
        const next = await store.installsFor(info.id)
        if (next) setInstall(next)
      }
    } finally {
      setBusy(null)
    }
  }

  const fallbackLine = describeFallback(install)
  return (
    <>
      <SectionHead name="Install" />
      <Rows>
        <Row
          title={installSummary(install)}
          desc={
            install.policy === 'pinned'
              ? 'A pinned copy answers even when a newer one is installed.'
              : 'The newest copy that is new enough answers; a copy installed or updated later is picked up on the next check.'
          }
          control={
            install.policy === 'pinned' ? (
              <Btn small disabled={busy !== null} onClick={() => void choose(null)}>
                {busy === 'auto' ? 'Unpinning…' : 'Use newest'}
              </Btn>
            ) : undefined
          }
        />
        {install.copies.map((copy) => {
          const chip = standingChip(copy.standing)
          const reason = copyReason(copy, install)
          const pinnable = copy.standing === 'older' || (copy.standing === 'chosen' && install.copies.length > 1)
          // The desk's own download is updated by the desk, from the row it
          // is listed on — the registry's newer build is the button's label.
          const updatable = copy.managed && install.registryUpdate && install.fallback?.command === copy.path
          return (
            <Row
              key={copy.path}
              title={
                <>
                  {describeCopy(copy)} <Chip state={chip.state} label={chip.label} />
                </>
              }
              desc={reason ? <Prose text={reason} /> : undefined}
              control={
                updatable ? (
                  <Btn small variant="primary" disabled={busy !== null} onClick={() => void update()}>
                    {busy === 'update' ? 'Updating…' : `Update to ${install.registryUpdate?.version}`}
                  </Btn>
                ) : pinnable ? (
                  <Btn small disabled={busy !== null} onClick={() => void choose(copy.path)}>
                    {busy === copy.path ? 'Pinning…' : 'Pin'}
                  </Btn>
                ) : undefined
              }
            />
          )
        })}
        {fallbackLine && (
          <Row
            title={
              <>
                Fallback{' '}
                <Chip
                  state={install.chosen ? 'available' : 'ready'}
                  label={install.chosen ? 'Standing by' : 'In use'}
                />
              </>
            }
            desc={fallbackLine}
            control={
              install.fallback?.managed && install.registryUpdate ? (
                <Btn small variant="primary" disabled={busy !== null} onClick={() => void update()}>
                  {busy === 'update' ? 'Updating…' : `Update to ${install.registryUpdate.version}`}
                </Btn>
              ) : undefined
            }
          />
        )}
        {install.copies.length === 0 && install.installCommand && (
          <Row
            title="Install it on this machine"
            desc={
              <>
                <span className={kit.mono}>{install.installCommand}</span>
                {install.fallback ? ' — optional while the fallback answers.' : ''}
              </>
            }
          />
        )}
        {install.home && (
          <Row
            title="Its own home"
            desc={
              <>
                <span className={kit.mono}>{install.home.path}</span>
                {install.home.env ? (
                  <>
                    {' '}
                    (moved by <span className={kit.mono}>{install.home.env}</span>)
                  </>
                ) : null}
                {install.home.note ? <> <Prose text={install.home.note} /></> : ''}
              </>
            }
          />
        )}
        {install.signIn && (
          <Row
            title="Signing in"
            desc={
              <>
                <Prose text={install.signIn.note} />
                {install.signIn.terminal ? (
                  <>
                    {' '}
                    Run <code className={kit.mono}>{install.signIn.terminal}</code> in a terminal.
                  </>
                ) : null}
              </>
            }
          />
        )}
      </Rows>
    </>
  )
}

/**
 * What belongs to the runtime rather than to any one account: whether it is
 * healthy, what version it is on, and the behaviour it lets HarnessDesk set.
 */
const AgentDetail = ({ info, onBack }: { info: RuntimeInfo; onBack: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const active = snapshot.activeRuntime === info.id
  const [health, setHealth] = useState<RuntimeHealth | null>(active ? snapshot.health : null)
  const [options, setOptions] = useState<readonly ConfigOption[]>([])
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  useEffect(() => {
    let cancelled = false
    void store.healthFor(info.id).then((loaded) => {
      if (!cancelled) setHealth(loaded)
    })
    void store.optionsFor(info.id).then((loaded) => {
      if (!cancelled) setOptions(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [store, info.id])

  const update = describeUpdate(info)
  const build = describeVersion(info)?.replace(`${info.presentation.name} `, '') ?? null

  const setOption = async (id: string, value: OptionValue): Promise<void> => {
    await store.setOptionFor(info.id, id, value)
    setOptions(await store.optionsFor(info.id))
  }

  return (
    <>
      <BackLink to="Agents" onClick={onBack} />
      <DetailHead
        mark={
          <span className={kit.detailMark}>
            <RuntimeMark runtime={info} size={22} />
          </span>
        }
        name={info.presentation.name}
        owner={build ?? undefined}
        blurb={info.presentation.tagline}
        actions={
          active ? (
            <Chip state="ready" label="Active" />
          ) : (
            <Btn
              variant="outline"
              disabled={health?.state === 'unavailable'}
              onClick={() => void store.selectRuntime(info.id)}
            >
              <CheckIcon size={14} />
              Use this agent
            </Btn>
          )
        }
      />

      {health?.state === 'unavailable' && (
        <>
          <SectionHead name="Why it will not start" />
          <Rows>
            <HealthBlock health={health} />
          </Rows>
        </>
      )}

      {update && (
        <>
          <SectionHead name="Update" />
          <Rows>
            <Row
              title={`${info.update?.version} available`}
              desc={
                <>
                  {update.text}
                  {update.command && (
                    <>
                      {' '}
                      <span className={kit.mono}>{update.command}</span>
                    </>
                  )}
                </>
              }
            />
          </Rows>
        </>
      )}

      {info.origin === 'registry' && <InstallSection info={info} />}

      <NewSessionDefaults info={info} />

      {options.length > 0 && (
        <>
          <SectionHead name="Settings" />
          <OptionRows options={options} onSet={setOption} />
        </>
      )}

      {info.origin === 'registry' && (
        <>
          <SectionHead name="Registration" />
          <Rows>
            <Row
              title="Remove from HarnessDesk"
              desc="Its account, configuration and history stay where the agent keeps them."
              control={
                <Btn small onClick={() => setConfirmingRemove(true)}>
                  Remove…
                </Btn>
              }
            />
          </Rows>
        </>
      )}
      {confirmingRemove && (
        <ConfirmDialog
          title={`Remove ${info.presentation.name}?`}
          confirmLabel="Remove agent"
          onCancel={() => setConfirmingRemove(false)}
          onConfirm={() => {
            void store.removeAgent(info.id).then((removed) => {
              if (removed) onBack()
            })
          }}
        >
          It leaves the picker. A build HarnessDesk downloaded for it is deleted; everything the
          agent keeps itself is untouched.
        </ConfirmDialog>
      )}
    </>
  )
}

/* --- the page ------------------------------------------------------------ */


export const AgentsSection = ({ onSignIn }: { onSignIn: (runtime: RuntimeId) => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [view, setView] = useState<View>({ kind: 'list' })
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  /**
   * Which blocks are open, where the user has said. Where they have not, a
   * block opens only when it needs attention — broken, or waiting on a
   * sign-in — so the page reads as a roster of one-line agents, which is the
   * management view, not a wall of every account on the machine. (It used to
   * open everything; user decision 2026-08-29.) Expand all and Collapse all
   * write every agent's override at once, and filtering still forces every
   * hit open, because a filtered list is a list you are searching.
   */
  const [opened, setOpened] = useState<ReadonlyMap<RuntimeId, boolean>>(() => new Map())

  useEffect(() => {
    void store.loadAccounts()
  }, [store])

  const back = (): void => setView({ kind: 'list' })

  const groups = useMemo(() => agentGroups(snapshot.runtimes), [snapshot.runtimes])
  const needle = query.trim().toLowerCase()
  const filtering = needle !== '' || status !== 'all'

  const listed = useMemo(
    () =>
      groups
        .map((group) => ({ ...group, state: agentReadiness(group.siblings, snapshot) }))
        .filter(
          (group) =>
            (status === 'all' || group.state === status) &&
            agentMatches(group.siblings, snapshot, needle),
        ),
    [groups, snapshot, status, needle],
  )

  /** Whether an unasked-about block arrives open: only when it has a story. */
  const openByDefault = (state: Readiness): boolean => state === 'broken' || state === 'signin'
  const isOpen = (id: RuntimeId, state: Readiness): boolean =>
    filtering || (opened.get(id) ?? openByDefault(state))
  const allOpen = listed.every(({ info, state }) => isOpen(info.id, state))
  const setAll = (value: boolean): void =>
    setOpened(new Map(listed.map(({ info }) => [info.id, value])))

  if (view.kind === 'add') {
    return <AddAgents onBack={back} onDone={back} />
  }

  if (view.kind === 'agent') {
    const info = snapshot.runtimes.find((entry) => entry.id === view.runtime)
    if (info) return <AgentDetail key={info.id} info={info} onBack={back} />
  }

  if (view.kind === 'account') {
    const info = snapshot.runtimes.find((entry) => entry.id === view.runtime)
    const account = snapshot.accountsByRuntime[view.runtime]?.accounts.find(
      (entry) => accountKey(view.runtime, entry) === view.key,
    )
    if (info && account) {
      return (
        <AccountDetail
          key={view.key}
          info={info}
          account={account}
          onBack={back}
          onSignIn={onSignIn}
        />
      )
    }
  }

  return (
    <>
      <PageHead
        title="Agents"
        blurb="The agents HarnessDesk can start, and the accounts each is signed in as."
        actions={
          <>
            {/* Hidden while filtering, which force-opens every hit anyway. */}
            {groups.length > 1 && !filtering && (
              <Btn variant="outline" onClick={() => setAll(!allOpen)}>
                {allOpen ? 'Collapse all' : 'Expand all'}
              </Btn>
            )}
            <Btn variant="default" onClick={() => setView({ kind: 'add' })}>
              <PlusIcon size={14} />
              Add agent
            </Btn>
          </>
        }
      />

      {/* Two agents fit on a screen and need no help being found; the filters
          arrive with the third, which is where scrolling starts. */}
      {groups.length > 2 && (
        <div className={styles.filters}>
          <Search
            className={styles.pageSearch}
            value={query}
            placeholder="Search agents or accounts"
            onChange={setQuery}
          />
          <Select
            label="Filter by status"
            value={status}
            options={[
              { value: 'all', label: 'Any status' },
              { value: 'ready', label: 'Ready' },
              { value: 'signin', label: 'Needs sign-in' },
              { value: 'limit', label: 'Limit reached' },
              { value: 'broken', label: 'Unavailable' },
            ]}
            onChange={setStatus}
          />
        </div>
      )}

      {listed.length === 0 ? (
        <Rows>
          <Row
            title={groups.length === 0 ? 'No agent is registered yet' : 'No agent matches'}
            desc={
              groups.length === 0
                ? 'Add one to send it a session.'
                : 'Nothing matches that search and status.'
            }
            control={
              groups.length === 0 ? (
                <Btn small variant="primary" onClick={() => setView({ kind: 'add' })}>
                  <PlusIcon size={13} />
                  Add agent
                </Btn>
              ) : (
                <Btn
                  small
                  onClick={() => {
                    setQuery('')
                    setStatus('all')
                  }}
                >
                  Clear filters
                </Btn>
              )
            }
          />
        </Rows>
      ) : (
        listed.map(({ info, siblings, state }) => {
          const open = isOpen(info.id, state)
          return (
            <AgentBlock
              key={info.id}
              info={info}
              siblings={siblings}
              state={state}
              open={open}
              onToggle={() => setOpened((current) => new Map(current).set(info.id, !open))}
              onSignIn={onSignIn}
              onOpenAgent={() => setView({ kind: 'agent', runtime: info.id })}
              onOpenAccount={(runtime, key) => setView({ kind: 'account', runtime, key })}
            />
          )
        })
      )}
    </>
  )
}
