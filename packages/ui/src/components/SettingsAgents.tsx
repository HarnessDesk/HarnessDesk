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
  agentKey,
  accountKey,
  accountName,
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
import { isBlocking, READINESS_LABEL, readinessOf, worstReadiness, type Readiness } from '../lib/readiness'
import { splitHealth, type Unavailable } from '../lib/health'
import { Prose } from './Prose'
import { bindingLane, isBlocked, remainingOf } from '../lib/usage'
import { usageAccount } from '../lib/usage-alerts'
import { describeUpdate, describeVersion } from '../lib/versions'
import { copyReason, describeCopy, describeFallback, installSummary, standingChip, pinHolds } from '../lib/installs'
import { useSnapshot, useStore } from '../state/context'
import type { AppSnapshot } from '../state/store'
import { RuntimeMark } from './BrandIcons'
import {
  AgentIcon,
  CheckIcon,
  PlusIcon,
  SignInIcon,
  SignOutIcon,
} from './Icons'
import {
  AccountMark,
  BackLink,
  Button,
  Card,
  CardViewport,
  Chip,
  CodeText,
  DetailMark,
  DetailHead,
  Dot,
  Field,
  FormStack,
  Input,
  Note,
  Search,
  NativeSelect,
  Textarea,
  PageHead,
  Progress,
  Row,
  RowButton,
  RowMark,
  RowValue,
  Rows,
  Section,
  SectionHead,
  Segmented,
  SummaryItem,
  SummaryList,
  Switch,
  Text,
} from '../design'
import { useOptionConfirm } from './OptionConfirm'
import { Dialog, ConfirmDialog, EmptyState } from '../design'
import styles from './SettingsAgents.module.css'

/**
 * Runtimes — the agent programs HarnessDesk starts — and the accounts under them.
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
  // Nothing signed in anywhere — or not yet known which. An agent that runs
  // without an account is ready like that; one still waiting on any sibling's
  // `runtime/account` has not said it needs a credential, only that it has
  // not answered; every other one is waiting on one.
  const relevant = siblings.filter((entry) => entry.capabilities.account)
  if (relevant.length === 0) return 'ready'
  return relevant.every((entry) => view.accountsByRuntime[entry.id] !== undefined) ? 'signin' : 'unknown'
}

/**
 * What the "Default" chip says, wherever it is drawn.
 *
 * The chip means "new sessions run as this", so the only state worth wearing
 * is the one the rest of the app answers with: would a turn sent right now
 * start. That was derived three ways — the agent's full readiness in the list
 * header, and `unavailable → broken, else ready` on each of the two detail
 * pages the header links to. Health alone cannot see a missing credential or
 * a spent plan window, so a default that was signed out read "needs sign-in"
 * in the list and green on its own page, and one at its limit read green on
 * both pages while the list said otherwise (#131).
 *
 * One derivation now, and it is the list's: `agentReadiness` over every
 * account the agent holds. `siblings` is looked up rather than passed because
 * the detail pages are reached by id and hold one runtime, not the group.
 */
export const defaultChipState = (info: RuntimeInfo, snapshot: AppSnapshot): Readiness => {
  const group = agentGroups(snapshot.runtimes).find((entry) => agentKey(entry.info) === agentKey(info))
  return agentReadiness(group?.siblings ?? [info], snapshot)
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

/**
 * An account's usage: whether it is blocked, the windows it draws on, and the
 * prepaid balance that outlasts them. `describeLimits` worked the balance out
 * since #85 and nothing showed it but the Usage window, so a zero balance, the
 * reading #85 was about, was visible in one place only (#182).
 */
export const UsageSection = ({ limits, name }: { limits: RateLimits | null; name: string }) => {
  const view = describeLimits(limits)
  return (
    <>
      <SectionHead name="Usage" />
      {view?.blocked && (
        <Text role="muted" as="p" tone="danger" className="mb-2">
          {view.blocked.title} — {view.blocked.detail}
        </Text>
      )}
      {/* One card: the windows and the balance are one section's rows. Two
          cards under one heading read as a second section that forgot its
          name (review of #216). Each window is a row of it, as the balance
          is — the name, when it refills, and the meter with its figure at the
          row's end — so the windows' meters line up in one column. */}
      {view && (view.windows.length > 0 || view.credits) ? (
        <Rows>
          {view.windows.map((window) => (
            <UsageMeter key={window.label} window={window} />
          ))}
          {view.credits && (
            <Row
              title="Credits"
              desc="What this account can still spend once a window runs out."
              control={
                /* In the tone describeLimits grades it, as the meters are. A
                   zero is the reading #85 was about, and the row vocabulary's
                   dimmest ink drew it fainter than a window's name. */
                <Text role="muted" numeric tone={view.credits.tone === 'bad' ? 'danger' : undefined}>
                  {view.credits.label}
                </Text>
              }
            />
          )}
        </Rows>
      ) : (
        <Rows>
          <EmptyState variant="row" title="Nothing to read yet" description={`${name} has not written any usage down on this Mac.`} />
        </Rows>
      )}
    </>
  )
}

/**
 * One rolling allowance as a row of the usage card: its name, when it refills,
 * and a meter of what is left.
 *
 * The meter is the app's one remaining-budget meter (`Progress` measuring
 * what is left), so it fills with what is LEFT and grades itself the way the
 * Dashboard's and the plan strip's do — neutral while there is room, amber
 * under a fifth, red when spent. The figure is said, not implied: a bare
 * "48%" reads as spent to half the people who see it.
 */
export const UsageMeter = ({ window }: { window: UsageWindow }) => {
  const remaining = Math.max(0, Math.round(100 - window.usedPercent))
  const reset = formatReset(window.resetsAt)
  return (
    <Row
      title={window.label}
      {...(reset ? { desc: `Resets ${reset}` } : {})}
      control={
        <>
          <Progress
            className="w-40"
            value={remaining}
            measure="remaining"
            size="sm"
            label={false}
            aria-label={`${window.label} remaining`}
          />
          <Text role="muted" numeric align="end" className="min-w-16">
            {remaining}% left
          </Text>
        </>
      }
    />
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
      <AccountMark
        as="button"
        key={tint}
        role="radio"
        aria-checked={tint === value}
        aria-label={tint}
        className={styles.ring}
        data-tint={tint}
        {...(tint === value ? { 'data-on': '' } : {})}
        onClick={() => onChange(tint)}
      >
        <RuntimeMark runtime={info} size={14} />
      </AccountMark>
    ))}
  </span>
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
 *
 * It is a row of the card it stands in: the sentence is the row's title and
 * the output and the repair are its description, whole rather than clamped.
 */
const HealthBlock = ({ health }: { health: Unavailable }) => {
  const { lead, detail, remediation } = splitHealth(health)
  return (
    <Row
      title={<Prose text={lead} />}
      {...(detail || remediation
        ? {
            desc: (
              <span className="mt-1.5 flex flex-col gap-2">
                {/* Bounded, as a panel's code block is: the card keeps its
                    corners while the lines scroll inside it. */}
                {detail && (
                  <Card variant="flush" radius="sm">
                    <CardViewport size="lines" maxHeight={170}>
                      <CodeText as="pre" block ground="muted">
                        {detail}
                      </CodeText>
                    </CardViewport>
                  </Card>
                )}
                {remediation && (
                  <span>
                    <Prose text={remediation} />
                  </span>
                )}
              </span>
            ),
          }
        : {})}
    />
  )
}

/* --- the list ------------------------------------------------------------ */

/** What this agent's accounts look like as rows, plus how to add one. */
/**
 * One agent on the list, as one line: its mark, its name and build, who it is
 * signed in as — the fact a person scans this list for — and at the end only
 * what is not fine. A signed-out agent carries its Sign in there, because
 * that is the one thing anyone opens it to do; the whole line opens its page.
 *
 * The account count and the sign-in method used to ride on every row: "1
 * account" nine times is one fact said nine times, and a method is the
 * agent's definition, which its page and Sign in show where it is chosen.
 */
const AgentRow = ({
  info,
  siblings,
  state,
  query,
  onOpen,
  onSignIn,
}: {
  info: RuntimeInfo
  siblings: readonly RuntimeInfo[]
  /** Whether a turn sent to this agent would start — see `agentReadiness`. */
  state: Readiness
  /** The page's search, lowercased; its hit leads the account line. */
  query: string
  onOpen: () => void
  onSignIn: (runtime: RuntimeId) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const status = snapshot.accountsByRuntime[info.id]
  const build = describeVersion(info)?.replace(`${info.presentation.name} `, '') ?? null
  const names = siblings.flatMap((entry) => [
    // The whole address, not its local part: on a list of agents the address
    // is what tells two of them apart, and a nickname you gave it wins. An
    // agent that cannot say who it is signed in as says only that it is.
    ...(snapshot.accountsByRuntime[entry.id]?.accounts ?? []).map((account) =>
      snapshot.accountPrefs[accountKey(entry.id, account)]?.nickname?.trim() ||
      (account.anonymous ? 'Signed in' : account.email ?? account.label),
    ),
    ...(entry.slot?.gateway ? [entry.slot.gateway.name] : []),
  ])
  // A search hit on a second account leads the line, so what was searched
  // for is what is shown; and accounts that cannot say who they are count.
  const hit = query ? names.findIndex((name) => name.toLowerCase().includes(query)) : -1
  const ordered = hit > 0 ? [names[hit]!, ...names.filter((_, index) => index !== hit)] : names
  const who =
    ordered.length === 0
      ? null
      : ordered.length === 1
        ? ordered[0]!
        : ordered[0] === 'Signed in'
          ? `${ordered.length} accounts`
          : `${ordered[0]} and ${ordered.length - 1} more`
  const canSignIn = info.capabilities.account && (status?.signInMethods ?? []).some((method) => method.flow !== 'external')
  // A key has to be typed somewhere, so those methods hand off to the sign-in
  // page instead of being started from a button with nowhere to type.
  const needsField = (status?.signInMethods ?? []).every(
    (method) => method.flow === 'apiKey' || method.flow === 'external',
  )
  const waiting = snapshot.logins[info.id]?.outcome.type === 'pending'
  const signIn = state === 'signin' && canSignIn
  return (
    <RowButton
      data-slot="agent-row"
      onClick={onOpen}
      mark={<RuntimeMark runtime={info} size={17} />}
      title={
        <span className={styles.headName} title={info.presentation.tagline}>
          <Text role="subject">{info.presentation.name}</Text>
          {build && <Text role="muted" ink="muted" numeric>{build}</Text>}
        </span>
      }
      {...(who ? { desc: who, truncateDesc: true } : {})}
      control={
        /* The default's chip wears the agent's own state: a default that has
           crashed is not a green one (#131) — and it still names the state
           beside it, or an amber "Default" leaves why unsaid. A state chip
           only where the state is not fine, and not beside a Sign in that
           already says it. */
        snapshot.activeRuntime === info.id || (state !== 'ready' && !signIn) ? (
          <>
            {snapshot.activeRuntime === info.id && <Chip state={state} label="Default" />}
            {state !== 'ready' && !signIn && <Chip state={state} />}
          </>
        ) : undefined
      }
      {...(signIn
        ? {
            action: (
              <Button
                size="sm"
                variant="default"
                disabled={waiting}
                onClick={() => (needsField ? onSignIn(info.id) : void store.signInAgent(info.id))}
              >
                <SignInIcon size={13} />
                {waiting ? 'Waiting…' : 'Sign in'}
              </Button>
            ),
          }
        : {})}
    />
  )
}

/**
 * The accounts an agent holds, on its own page: each one, the gateways that
 * bill it elsewhere, the slots added and never signed into, and the ways to
 * add another. This was a fold under every row of the list, which made the
 * list a page of cards; the list now says who each agent is signed in as, in
 * a line, and this is where they are managed.
 */
const AgentAccounts = ({
  info,
  siblings,
  state,
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
    <>
      {/* The ways to add another stand in the section's head, where a card's
          own actions stand on a page, rather than in a bar under the list. */}
      <SectionHead
        name="Accounts"
        action={
          info.slot?.canAdd || (rows.length > 0 && info.capabilities.account && canSignIn) ? (
            <>
              {info.capabilities.account && canSignIn && (
                <Button
                  size="sm"
                  variant="outline"
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
                </Button>
              )}
              {/* Offered even with no plan account signed in: paying your own way
                  is a first-class way to run this agent, not a fallback. */}
              {info.slot?.canAdd && (
                <Button
                  size="sm"
                  variant="outline"
                  title={`Run ${info.presentation.name} against your own endpoint — an API key or a gateway — instead of the plan it signs into.`}
                  onClick={() => setAddingGateway(true)}
                >
                  <PlusIcon size={13} />
                  Add gateway account…
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      <Rows>
        {rows.map(({ entry, account }) => {
          const key = accountKey(entry.id, account)
          const own = snapshot.usage.filter((report) => report.runtime === entry.id)
          const report = own.find((item) => usageAccount(item) === account.label.trim()) ?? own[0]
          // What is left is the account's binding window — the tightest of the
          // *account-wide* lanes, which is what `bindingLane` picks. Taking the
          // tightest of every lane instead read `0% left` beside a chip that
          // correctly said the account was fine, because a spent model-scoped
          // week is the tightest lane and is not the account's figure. Rounded
          // the way `describeLane` rounds, so this row and the Dashboard cannot
          // disagree about the same account.
          const binding = report ? bindingLane(report.lanes, snapshot.accountPrefs[key]) : null
          const remaining = binding === null ? null : remainingOf(binding)
          const left = remaining === null ? null : Math.round(remaining)
          // Account-wide only: a spent model-scoped window is a limit you
          // can step around, and this chip speaks for the whole account.
          const accountState: Readiness =
            report && isBlocked(report) ? 'limit' : state === 'broken' ? 'broken' : 'ready'
          const name = accountName(account, snapshot.accountPrefs[key], entry.presentation.name)
          const identity = account.email ?? account.label
          return (
            <RowButton
              key={key}
              onClick={() => onOpenAccount(entry.id, key)}
              mark={
                <AccountMark data-tint={tintOf(key, snapshot.accountPrefs)}>
                  <RuntimeMark runtime={info} size={14} />
                </AccountMark>
              }
              title={
                <span className={styles.rowName}>
                  {name}
                  {entry.id === info.id && rows.length > 1 && (
                    <Chip tone="neutral" size="sm">Default</Chip>
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
                    <Chip tint={tintOf(key, snapshot.accountPrefs)}>
                      {account.planType}
                    </Chip>
                  )}
                  {/* Said, not implied: a bare "48%" reads as spent to half the
                      people who see it, and the meters this comes from fill
                      with what is left. */}
                  {left !== null && <Text role="muted" numeric className="whitespace-nowrap">{left}% left</Text>}
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
              <AccountMark>
                <RuntimeMark runtime={info} size={14} />
              </AccountMark>
            }
            title={
              <span className={styles.rowName}>
                {entry.slot?.gateway?.name}
                <Chip tone="neutral" size="sm">Gateway</Chip>
              </span>
            }
            desc={entry.slot?.gateway?.endpoint}
            truncateDesc
            control={
              <Button size="sm" variant="ghost" onClick={() => void store.removeAccount(entry.id)}>
                Remove
              </Button>
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
            desc="Added, but the sign-in never finished."
            control={
              <>
                <Button size="sm" variant="default" onClick={() => void store.signInAgent(entry.id)}>
                  <SignInIcon size={13} />
                  Sign in
                </Button>
                <Button variant="secondary" size="sm" onClick={() => void store.removeAccount(entry.id)}>
                  Remove
                </Button>
              </>
            }
          />
        ))}

        {rows.length === 0 && gateways.length === 0 && health?.state === 'unavailable' ? (
          /* A dead agent's account is not the story. This row used to read
             "runs without an account" about an agent that could not start —
             a true sentence about the wrong subject. The page's own "Why it
             will not start" says why, above; here it is only named. */
          <Row title="Unavailable" desc="Its accounts show once it starts." />
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
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => (needsField ? onSignIn(info.id) : void store.signInAgent(info.id))}
                  >
                    <SignInIcon size={13} />
                    Sign in
                  </Button>
                ) : undefined
              }
            />
          )
        )}
      </Rows>

      {addingGateway && <GatewayDialog info={info} onClose={() => setAddingGateway(false)} />}
    </>
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
          <Button variant="default" disabled={busy || !ready} onClick={() => void save()}>
            {busy ? 'Adding…' : 'Add account'}
          </Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
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
      title="Add a custom runtime"
      icon={<AgentIcon size={15} />}
      onClose={onClose}
      footer={
        <>
          <Button variant="default" disabled={busy || !ready} onClick={() => void add()}>
            {busy ? 'Adding…' : 'Add runtime'}
          </Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
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
      <BackLink to="Runtimes" onClick={onBack} />
      <PageHead
        title="Add a runtime"
        blurb="A runtime keeps its own account, configuration and history; adding it here only tells HarnessDesk how to start it."
      />
      <Rows>
        {(templates ?? []).map((template) => (
          <Row
            key={template.key}
            /* The square is the agent and the circle is an account, on this
               page and on the list it comes back to. A template has no
               account yet, so it can only be the square. */
            mark={
              <RowMark>
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
              </RowMark>
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
                      <CodeText>{template.requires.installCommand}</CodeText>, then
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
                <Button
                  size="sm"
                  variant="default"
                  disabled={!template.available || busy !== null}
                  onClick={() => void add(template.key)}
                >
                  <PlusIcon size={13} />
                  {busy === template.key ? 'Adding…' : 'Add'}
                </Button>
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
              <Card
                key={agent.id}
                variant="plate"
                spacing="compact"
                className={`${styles.registryCell} flex-row`}
                {...(agent.available ? {} : { 'data-blocked': '' })}
              >
                <RowMark>
                  <RuntimeMark
                    runtime={{ id: agent.id, presentation: { name: agent.name } }}
                    size={17}
                  />
                </RowMark>
                <span className={styles.registryCellText}>
                  <Text role={agent.available ? 'row' : 'muted'} ink={agent.available ? undefined : 'muted'} className={styles.registryCellName}>
                    {agent.name}
                    {agent.run === 'binary' && agent.integrity === 'none' && !agent.installed && (
                      <Chip tone="neutral" size="sm" className={styles.unverifiedBadge}
                        title="The registry publishes no checksum for this build, so the download cannot be verified."
                      >
                        Unverified
                      </Chip>
                    )}
                  </Text>
                  {line && <Text role="meta" className={styles.registryCellLine}>{line}</Text>}
                </span>
                {agent.registered ? (
                  <Chip state="ready" label="Added" />
                ) : agent.available ? (
                  <Button
                    size="sm"
                    variant="default"
                    disabled={busy !== null}
                    onClick={() => void addFromRegistry(agent.id)}
                  >
                    <PlusIcon size={13} />
                    {registryAddLabel(agent, busy === agent.id)}
                  </Button>
                ) : null}
              </Card>
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
            <Button variant="secondary" size="sm" onClick={() => setCustomOpen(true)}>
              <PlusIcon size={13} />
              Set up…
            </Button>
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
    (entry) => entry.runtime === info.id && (usageAccount(entry) === account.label.trim() || usageAccount(entry) === ''),
  )
  const state: Readiness = report && isBlocked(report) ? 'limit' : 'ready'
  const accountWide = report?.lanes.some((lane) => lane.placeholder !== true && !lane.scope) ?? false
  const usageOptions = [
    { value: '', label: 'Automatic' },
    ...(report?.lanes ?? [])
      .filter((lane) => lane.placeholder !== true && (!accountWide || !lane.scope))
      .map((lane) => ({ value: lane.id, label: lane.scope ? `${lane.label} · ${lane.scope}` : lane.label })),
  ]
  const pinLaneId =
    prefs?.pinLaneId && usageOptions.some((option) => option.value === prefs.pinLaneId) ? prefs.pinLaneId : ''

  useEffect(() => {
    let cancelled = false
    void store.limitsFor(info.id).then((loaded) => {
      if (!cancelled) setLimits(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [store, info.id, account.label])

  const planLabel = account.kind === 'externalKey' ? null : (account.planType ?? limits?.planType ?? null)
  const isKey = account.kind === 'apiKey' || account.kind === 'externalKey'

  return (
    <>
      {/* Back to the agent it belongs to, which is where its accounts are listed. */}
      <BackLink to={info.presentation.name} onClick={onBack} />
      <DetailHead
        mark={
          <AccountMark
            size="lg"
            data-tint={tintOf(key, snapshot.accountPrefs)}
          >
            <RuntimeMark runtime={info} size={20} />
          </AccountMark>
        }
        name={accountName(account, prefs, info.presentation.name)}
        owner={info.presentation.name}
        blurb={accountIdentity(account)}
        actions={<Chip state={state} />}
      />

      {/* Three ways the desk shows this account, in one card: the name and ring
          it wears, and the limit it leads with. The limit was a one-row card
          of its own, under a second "Usage" heading above the real one. */}
      <Section title="How it is shown">
        <Rows>
          <Row
            title="Name"
            desc="How the sidebar, the composer and the menu bar refer to this account."
            control={
              <Input
                className={styles.nameField}
                value={name}
                placeholder={accountName(account, undefined, info.presentation.name)}
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
          <Row
            title="Primary usage window"
            desc="Which limit appears first in the tray, account summary and menu."
            control={
              <NativeSelect
                aria-label="Primary usage window"
                value={pinLaneId}
                disabled={usageOptions.length <= 1}
                onChange={(event) => store.setAccountPrefs(key, { pinLaneId: event.target.value || undefined })}
              >
                {usageOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </NativeSelect>
            }
          />
        </Rows>
      </Section>

      {/* The facts about the sign-in, as one card: who, on what plan, where
          its credential lives, and whether new sessions start on it. They were
          two cards under two headings ("Account", "Defaults"). */}
      <Section title="Account">
        <SummaryList>
          <SummaryItem
            label="Signed in as"
            note={
              account.kind === 'apiKey'
                ? `Stored by HarnessDesk — ${snapshot.credentialProtection}. Handed to ${info.presentation.name} when it starts.`
                : account.kind === 'externalKey'
                  ? `Read from ${account.planType}. HarnessDesk holds no copy.`
                  : `${info.presentation.name} keeps the credential; HarnessDesk never stores it.`
            }
            action={
              isKey ? (
                <Button variant="secondary" size="sm" onClick={() => onSignIn(info.id)}>
                  <SignInIcon size={13} />
                  Manage key…
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => setConfirmingSignOut(true)}>
                  <SignOutIcon size={13} />
                  {info.slot?.removable ? 'Remove…' : 'Sign out…'}
                </Button>
              )
            }
          >
            {account.label}
          </SummaryItem>
          {planLabel && <SummaryItem label="Plan">{planLabel}</SummaryItem>}
          {credentialHome(info) && (
            <SummaryItem label="Credential" kind="path">{credentialHome(info) ?? ''}</SummaryItem>
          )}
          <SummaryItem
            label="New sessions"
            {...(snapshot.activeRuntime === info.id
              ? {}
              : {
                  action: (
                    <Button variant="secondary" size="sm" onClick={() => void store.selectRuntime(info.id)}>
                      Make default
                    </Button>
                  ),
                })}
          >
            {snapshot.activeRuntime === info.id ? (
              /* The chip is the account's readiness as the default, the same
                 reading the list and the agent's page give (#131). */
              <span className="inline-flex flex-wrap items-center gap-x-(--hd-space-2)">
                Start on this account
                <Chip state={defaultChipState(info, snapshot)} label="Default" />
              </span>
            ) : (
              'Start on another account'
            )}
          </SummaryItem>
        </SummaryList>
      </Section>

      <UsageSection limits={limits} name={info.presentation.name} />

      {confirmingSignOut && (
        <ConfirmDialog
          title={info.slot?.removable ? `Remove ${accountName(account, prefs, info.presentation.name)}?` : `Sign out of ${accountName(account, prefs, info.presentation.name)}?`}
          confirmLabel={info.slot?.removable ? 'Remove account' : 'Sign out'}
          tone="destructive"
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
      {options.map((option) => {
        const nativeSelect =
          option.type === 'select' &&
          (option.choices.length > 3 || option.choices.some((choice) => Boolean(choice.disabled)))
        return (
          <Row
            key={option.id}
            title={option.label}
            desc={option.description ?? option.disabled}
            control={
              option.type === 'boolean' ? (
                <Switch
                  aria-label={option.label}
                  checked={option.currentValue}
                  disabled={Boolean(option.disabled)}
                  onCheckedChange={(next) => ask(option, next, () => onSet(option.id, next))}
                />
              ) : nativeSelect ? (
                <NativeSelect
                  aria-label={option.label}
                  value={String(option.currentValue)}
                  disabled={Boolean(option.disabled)}
                  onChange={(event) => {
                    const value = event.target.value
                    ask(option, value, () => onSet(option.id, value))
                  }}
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
              ) : (
                <Segmented
                  label={option.label}
                  value={String(option.currentValue)}
                  options={option.choices.map((choice) => ({
                    value: String(choice.value),
                    label: choice.label,
                  }))}
                  onChange={(value) => ask(option, value, () => onSet(option.id, value))}
                />
              )
            }
          />
        )
      })}
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
  /*
   * What the rule is doing, under the line that says what runs. A pin stays
   * recorded after the copy it names has gone or grown too old, and the rule
   * picks again — but it can pick nothing at all, when no copy left on the
   * machine is new enough: `judgeInstalls` then chooses none, and `chosen` is
   * null with the pin still recorded. Told as one sentence, the recorded pin
   * promised "the newest copy that is new enough answers" while the line above
   * it said none qualified (#251), so that state gets its own sentence.
   *
   * The unpinned half had the same hole: with no pin recorded the rule still
   * promised a copy answered in every state where `chosen` is null — nothing
   * installed new enough, or nothing installed at all. Both halves are keyed
   * on `chosen` now, and the empty machine gets the sentence that is true of
   * it, the way `installSummary` tells those two apart for the line above.
   */
  const rule = pinHolds(install)
    ? 'A pinned copy answers even when a newer one is installed.'
    : install.policy === 'pinned'
      ? install.chosen
        ? 'The pinned copy is gone or too old, so the newest copy that is new enough answers until you pin another.'
        : 'The pinned copy is gone or too old, and nothing else installed is new enough, so no installed copy answers.'
      : install.chosen
        ? 'The newest copy that is new enough answers; a copy installed or updated later is picked up on the next check.'
        : install.copies.length > 0
          ? 'No copy installed is new enough; install or update one and it is picked up on the next check.'
          : 'No copy is installed; install one and it is picked up on the next check.'
  return (
    <>
      <SectionHead name="Install" />
      <Rows>
        <Row
          title={installSummary(install)}
          desc={rule}
          control={
            install.policy === 'pinned' ? (
              <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void choose(null)}>
                {busy === 'auto' ? 'Unpinning…' : 'Use newest'}
              </Button>
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
                  <Button size="sm" variant="default" disabled={busy !== null} onClick={() => void update()}>
                    {busy === 'update' ? 'Updating…' : `Update to ${install.registryUpdate?.version}`}
                  </Button>
                ) : pinnable ? (
                  <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void choose(copy.path)}>
                    {busy === copy.path ? 'Pinning…' : 'Pin'}
                  </Button>
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
                <Button size="sm" variant="default" disabled={busy !== null} onClick={() => void update()}>
                  {busy === 'update' ? 'Updating…' : `Update to ${install.registryUpdate.version}`}
                </Button>
              ) : undefined
            }
          />
        )}
        {install.copies.length === 0 && install.installCommand && (
          <Row
            title="Install it on this machine"
            desc={
              <>
                <CodeText>{install.installCommand}</CodeText>
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
                <CodeText>{install.home.path}</CodeText>
                {install.home.env ? (
                  <>
                    {' '}
                    (moved by <CodeText>{install.home.env}</CodeText>)
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
                    Run <CodeText as="code">{install.signIn.terminal}</CodeText> in a terminal.
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
const AgentDetail = ({
  info,
  onBack,
  onOpenAccount,
  onSignIn,
}: {
  info: RuntimeInfo
  onBack: () => void
  onOpenAccount: (runtime: RuntimeId, key: string) => void
  onSignIn: (runtime: RuntimeId) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const siblings = agentGroups(snapshot.runtimes).find((entry) => agentKey(entry.info) === agentKey(info))?.siblings ?? [info]
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
      <BackLink to="Runtimes" onClick={onBack} />
      <DetailHead
        mark={
          <DetailMark>
            <RuntimeMark runtime={info} size={22} />
          </DetailMark>
        }
        name={info.presentation.name}
        owner={build ?? undefined}
        blurb={info.presentation.tagline}
        actions={
          active ? (
            /* The snapshot's health, not this page's one-shot read: the chip is
               only drawn for the default, whose health the store keeps current
               as `runtime/healthChanged` arrives. `health` below still answers
               "why will it not start", which is a different question. */
            <Chip state={defaultChipState(info, snapshot)} label="Default" />
          ) : (
            /* Never disabled for a down agent: choosing one is how it is
               restarted, which is what its own health advises. */
            <Button variant="outline" onClick={() => void store.selectRuntime(info.id)}>
              <CheckIcon size={14} />
              Use for new sessions
            </Button>
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

      {/* The accounts belong to the agent, not to whichever of its runtimes
          this page was opened on: a fix for a second account opens the page
          on that account's runtime, and read from there the Default chip,
          the unfinished slots and Add account all answered for the wrong one. */}
      <AgentAccounts
        info={siblings[0] ?? info}
        siblings={siblings}
        state={agentReadiness(siblings, snapshot)}
        onOpenAccount={onOpenAccount}
        onSignIn={onSignIn}
      />

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
                      <CodeText>{update.command}</CodeText>
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
                <Button variant="secondary" size="sm" onClick={() => setConfirmingRemove(true)}>
                  Remove…
                </Button>
              }
            />
          </Rows>
        </>
      )}
      {confirmingRemove && (
        <ConfirmDialog
          title={`Remove ${info.presentation.name}?`}
          confirmLabel="Remove agent"
          tone="destructive"
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


export const RuntimesSection = ({
  onSignIn,
  focus = null,
}: {
  onSignIn: (runtime: RuntimeId) => void
  /** The thing inside the page to open, once — the refusal sheet's "Add Codex", "Open Cursor in Settings". */
  focus?: string | null
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [view, setView] = useState<View>({ kind: 'list' })
  const [query, setQuery] = useState('')

  useEffect(() => {
    void store.loadAccounts()
  }, [store])

  // Opened on a thing inside the page — the refusal sheet's "Add Codex", its
  // "Open Cursor in Settings" — rather than on the list.
  useEffect(() => {
    if (focus === 'add') setView({ kind: 'add' })
    else if (focus && snapshot.runtimes.some((entry) => entry.id === focus)) {
      setView({ kind: 'agent', runtime: focus as RuntimeId })
    }
  }, [focus, snapshot.runtimes])

  const back = (): void => setView({ kind: 'list' })
  const openAccount = (runtime: RuntimeId, key: string): void => setView({ kind: 'account', runtime, key })

  const groups = useMemo(() => agentGroups(snapshot.runtimes), [snapshot.runtimes])
  const needle = query.trim().toLowerCase()

  const listed = useMemo(
    () =>
      groups
        .map((group) => ({ ...group, state: agentReadiness(group.siblings, snapshot) }))
        .filter((group) => agentMatches(group.siblings, snapshot, needle)),
    [groups, snapshot, needle],
  )
  /* Split by what each agent needs from you. The reason anyone opens this
     page is usually one agent of many that will not take a turn, and sorting
     by that answer makes it the first line rather than the search. The groups
     are the status, so the page needs no status filter beside its search.
     "Needs attention" is `isBlocking`, the same test the Runtimes nav dot
     uses (`Settings.tsx`) — not "not literally ready" — because an agent
     that has not answered `runtime/account` yet has not asked anyone for
     anything: it may turn out to need a sign-in, or not, but it does not
     belong beside a dead agent and a spent plan window before it says
     which. Nor does it belong under a heading that says "Ready": `unknown`
     promises never to assert that (`readiness.ts`'s own `worstReadiness`
     comment), so it gets a heading of its own, named the same word every
     other surface uses for it — never folded into either claim. */
  const sections = [
    { name: 'Needs attention', agents: listed.filter(({ state }) => isBlocking(state)) },
    { name: READINESS_LABEL.unknown, agents: listed.filter(({ state }) => state === 'unknown') },
    { name: 'Ready', agents: listed.filter(({ state }) => state === 'ready') },
  ].filter((section) => section.agents.length > 0)

  if (view.kind === 'add') {
    return <AddAgents onBack={back} onDone={back} />
  }

  if (view.kind === 'agent') {
    const info = snapshot.runtimes.find((entry) => entry.id === view.runtime)
    if (info) {
      return (
        <AgentDetail key={info.id} info={info} onBack={back} onOpenAccount={openAccount} onSignIn={onSignIn} />
      )
    }
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
          onBack={() => {
            // Back to the agent it belongs to — its page is where its accounts are.
            const owner = groups.find((group) => group.siblings.some((entry) => entry.id === info.id))
            setView({ kind: 'agent', runtime: owner?.info.id ?? info.id })
          }}
          onSignIn={onSignIn}
        />
      )
    }
  }

  return (
    <>
      <PageHead
        title="Runtimes"
        blurb="What your Agents run on: the agent programs HarnessDesk can start, and the accounts each is signed in as."
        actions={
          <Button variant="default" onClick={() => setView({ kind: 'add' })}>
            <PlusIcon size={14} />
            Add a runtime
          </Button>
        }
      />

      {/* Two agents fit on a screen and need no help being found; the filters
          arrive with the third, which is where scrolling starts. */}
      {groups.length > 2 && (
        <div className={styles.filters}>
          <Search
            className={styles.pageSearch}
            value={query}
            placeholder="Search runtimes or accounts"
            onChange={setQuery}
          />
        </div>
      )}

      {listed.length === 0 ? (
        <Rows>
          <Row
            title={groups.length === 0 ? 'No runtime is added yet' : 'No runtime matches'}
            desc={
              groups.length === 0
                ? 'Add one to start a conversation on it.'
                : 'Nothing matches that search.'
            }
            control={
              groups.length === 0 ? (
                <Button size="sm" variant="default" onClick={() => setView({ kind: 'add' })}>
                  <PlusIcon size={13} />
                  Add a runtime
                </Button>
              ) : (
                <Button variant="secondary"
                  size="sm"
                  onClick={() => setQuery('')}
                >
                  Clear search
                </Button>
              )
            }
          />
        </Rows>
      ) : (
        sections.map((section) => (
          /* No accessible name of its own: the head names the group, and a
             label beside it was announced twice. */
          <div key={section.name} data-group={section.name}>
            <SectionHead
              name={section.name}
              action={<Text role="meta" numeric>{section.agents.length}</Text>}
            />
            <Rows>
              {section.agents.map(({ info, siblings, state }) => (
                <AgentRow
                  key={info.id}
                  info={info}
                  siblings={siblings}
                  state={state}
                  query={needle}
                  onOpen={() => setView({ kind: 'agent', runtime: info.id })}
                  onSignIn={onSignIn}
                />
              ))}
            </Rows>
          </div>
        ))
      )}
    </>
  )
}
