import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type {
  AcpRegistryAgentInfo,
  AcpRegistryCatalogInfo,
  Account,
  AuthMethod,
  RuntimeId,
  RuntimeInfo,
} from '@harnessdesk/protocol'

import { credentialHome } from '../lib/accounts'
import {
  registryAddLabel,
  registryMatches,
  registryOrder,
  registryRunSentence,
} from '../lib/acp-registry'
import { isDesktop, openExternal } from '../lib/desktop'
import { readinessOf, type Readiness } from '../lib/readiness'
import { useSnapshot, useStore } from '../state/context'
import type { AppSnapshot } from '../state/store'
import { RuntimeMark } from './BrandIcons'
import {
  AlertIcon,
  CheckIcon,
  ChevronIcon,
  GlobeIcon,
  KeyIcon,
  KeyboardIcon,
  TerminalIcon,
} from './Icons'
import {
  ActionError,
  Alert,
  AlertContent,
  AlertDescription,
  AlertTitle,
  AppWindowRail,
  Button,
  CodeText,
  DialogBody,
  DialogContent,
  DialogHead,
  DialogRoot,
  Dot,
  IconTile,
  Input,
  ListRow,
  ListRows,
  Note,
  RailSection,
  Search,
  SectionFooter,
  SectionHead,
  Spinner,
  SummaryItem,
  SummaryList,
  Text,
  type Tone,
} from '../design'
import own from './SignIn.module.css'

/**
 * Signing in — every harness on one page.
 *
 * A person with four agents installed has four accounts to keep alive, and
 * the one that is signed out is rarely the one in front of them. So the page
 * is a roster: every registered agent, what state it is in, and the way in
 * for the one selected. Nothing here knows a vendor. Each agent's card is
 * drawn from what its runtime declared — the methods it has, what each is
 * called, whether HarnessDesk can drive it — which is why a key-based agent
 * gets a field and a browser-based one gets a button without this file
 * naming either.
 *
 * The four shapes, in the order they are offered:
 *   apiKey      a secret the user pastes; the host keeps it, the renderer
 *               never sees it again, and the row afterwards only says one is
 *               stored.
 *   browser     opens a page and finishes elsewhere; the page waits on the
 *               event stream, not on a promise.
 *   deviceCode  a code to type on another device.
 *   external    HarnessDesk cannot drive it; say what to do instead.
 *
 * The rail counts what is connected and what is not, because the reason
 * anyone opens this window is that one of four agents is asleep — and until
 * the count is on screen, finding which one is the whole task.
 *
 * Below the roster, the rail carries the public ACP registry: every agent
 * the protocol's own list names that is not registered here yet. Selecting
 * one shows what it is and one button to add it — after which it is a row in
 * "Your agents" like any other, with whatever way in it declares. The
 * sign-in page is where people discover an agent is missing, so it is also
 * where the missing ones are offered.
 */

type Status = 'in' | 'key' | 'out' | 'manual' | 'none' | 'asking'

interface Row {
  readonly info: RuntimeInfo
  readonly status: Status
  readonly state: Readiness
  readonly detail: string
  readonly methods: readonly AuthMethod[]
  readonly pending: boolean
}

const STATUS_LABEL: Record<Status, string> = {
  in: 'Signed in',
  key: 'Key stored',
  out: 'Not connected',
  manual: 'Signed in elsewhere',
  none: 'No account',
  asking: 'Starting…',
}

/** What a runtime's account and methods add up to, with no vendor in sight. */
const rowFor = (info: RuntimeInfo, snapshot: AppSnapshot): Row => {
  const status = snapshot.accountsByRuntime[info.id]
  const account = status?.accounts[0]
  const methods = status?.signInMethods ?? []
  const driveable = methods.filter((method) => method.flow !== 'external')
  const pending = snapshot.logins[info.id]?.outcome.type === 'pending'
  const state = readinessOf({
    // Every runtime's health, not just the active one's. A second account is
    // never the active runtime, so the rail drew one that had failed to start
    // as merely needing a sign-in — and `snapshot.health` is only kept for
    // whichever agent is in front of you.
    health: snapshot.healthByRuntime[info.id] ?? (info.id === snapshot.activeRuntime ? snapshot.health : null),
    registered: true,
    account: status,
    accounts: info.capabilities.account,
    usage: snapshot.usage.filter((report) => report.runtime === info.id),
  })
  if (account) {
    const key = account.kind === 'apiKey' || account.kind === 'externalKey'
    const kind = key ? 'key' : 'in'
    return {
      info,
      status: kind,
      state,
      detail: key ? account.planType || account.label : account.label || STATUS_LABEL[kind],
      methods,
      pending,
    }
  }
  if (driveable.length > 0) {
    return { info, status: 'out', state, detail: STATUS_LABEL.out, methods, pending }
  }
  if (methods.length > 0) {
    return { info, status: 'manual', state: 'ready', detail: methods[0]!.label, methods, pending }
  }
  // No status at all is not an empty one. A runtime registered a moment ago
  // has not answered `runtime/account` yet, and calling that "runs without
  // one" put a starting account in the connected count and contradicted the
  // detail pane beside it, which says it is starting.
  if (status === undefined) {
    return { info, status: 'asking', state, detail: STATUS_LABEL.asking, methods, pending }
  }
  return { info, status: 'none', state: 'ready', detail: 'Runs without one', methods, pending }
}

export const SignIn = ({ runtime, onClose }: { runtime?: RuntimeId; onClose: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()

  const rows = useMemo(
    () => snapshot.runtimes.map((info) => rowFor(info, snapshot)),
    [snapshot],
  )
  // Opens on the agent the caller pointed at, else the first one that wants
  // attention, else the active one: the page should land where the work is.
  // A plain string, because the rail also offers agents that are not
  // runtimes yet — the registry entries below the roster.
  const [selected, setSelected] = useState<string | null>(
    () => runtime ?? rows.find((row) => row.status === 'out')?.info.id ?? snapshot.activeRuntime ?? null,
  )

  const [registry, setRegistry] = useState<AcpRegistryCatalogInfo | null>(null)
  const [registryQuery, setRegistryQuery] = useState('')
  useEffect(() => {
    let cancelled = false
    void store.acpRegistry().then((loaded) => {
      if (!cancelled) setRegistry(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [store])
  // What is registered lives above as "Your agents"; this section is what is
  // not — judged against the live roster, so an agent added a moment ago
  // leaves the list the moment its runtime row arrives.
  const registryRows = useMemo(() => {
    const known = new Set<string>(rows.map((entry) => entry.info.id))
    return registryOrder(
      (registry?.agents ?? []).filter((agent) => !agent.registered && !known.has(agent.id)),
    )
  }, [registry, rows])
  const listedRegistry = registryRows.filter((agent) => registryMatches(agent, registryQuery))

  const fromRegistry =
    !rows.some((entry) => entry.info.id === selected)
      ? registryRows.find((agent) => agent.id === selected) ?? null
      : null
  const row = fromRegistry
    ? null
    : rows.find((entry) => entry.info.id === selected) ?? rows[0] ?? null
  // An account still starting is not connected and is not disconnected; it is
  // not an answer yet, so it counts as neither.
  const connected = rows.filter((entry) => entry.status !== 'out' && entry.status !== 'asking').length
  const nextUp = rows.find((entry) => entry.status === 'out' && entry.info.id !== row?.info.id)

  useEffect(() => {
    void store.loadAccounts()
  }, [store])

  const close = (): void => {
    onClose()
  }

  return (
    <DialogRoot open onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent
        bleed
        className={own.dialog}
        portalled={false}
        aria-label="Sign in"
        showCloseButton={false}
      >
        {/* The head every dialog wears: its name, one inset, the rule under
            it and the way out. Closing through it is the root's own close. */}
        <DialogHead title="Sign in" />

        <div className={own.split}>
          {/* The rail is the window rail — the plate Settings and the
              dashboard stand their rosters on — under the dialog's own head,
              so its head opens with the short step a ruled head takes. */}
          <AppWindowRail aria-label="Agents" className={own.rail}>
            <RailSection stretch="head" density="comfortable" ruled>
              <Text as="div" role="subject">Your agents</Text>
              <Text as="div" role="muted" className={own.spineCount}>
                {connected} of {rows.length} connected
              </Text>
              <RosterLights states={rows.map((entry) => entry.state)} />
            </RailSection>

            <RailSection stretch="list" density="comfortable" className={own.railList}>
              <ListRows size="sm">
              {rows.map((entry) => (
                <ListRow
                  key={entry.info.id}
                  as="button"
                  size="sm"
                  interactive
                  selected={entry.info.id === row?.info.id}
                  onClick={() => setSelected(entry.info.id)}
                  lead={<RuntimeMark runtime={entry.info} size={16} />}
                  title={<Text role="row">{entry.info.presentation.name}</Text>}
                  subtitle={
                    <Text role="meta" tone={entry.state === 'signin' ? 'brand' : entry.state === 'limit' ? 'warning' : undefined}>
                      {entry.pending ? 'Waiting…' : entry.detail}
                    </Text>
                  }
                  trail={entry.pending ? (
                    <Spinner size="sm" tone="brand" aria-hidden="true" />
                  ) : (
                    <Dot state={entry.state} />
                  )}
                />
              ))}
              </ListRows>

              {registryRows.length > 0 && (
                <>
                  <SectionHead name="From the ACP registry" />
                  {/* Two agents need no finding aid; forty do. */}
                  {registryRows.length > 8 && (
                    <Search
                      className={own.railFilter}
                      value={registryQuery}
                      placeholder="Search the registry"
                      label="Search the ACP registry"
                      onChange={setRegistryQuery}
                    />
                  )}
                  <ListRows size="sm">
                  {listedRegistry.map((agent) => (
                    <ListRow
                      key={agent.id}
                      as="button"
                      size="sm"
                      interactive
                      selected={agent.id === fromRegistry?.id}
                      onClick={() => setSelected(agent.id)}
                      lead={<RuntimeMark
                          runtime={{ id: agent.id, presentation: { name: agent.name } }}
                          size={16}
                        />}
                      title={<Text role="row" ink={agent.available ? 'primary' : 'muted'}>{agent.name}</Text>}
                      subtitle={agent.run === 'binary' && agent.integrity === 'none' && !agent.installed
                        ? <Text role="meta">Unverified</Text>
                        : undefined}
                    />
                  ))}
                  </ListRows>
                  {listedRegistry.length === 0 && (
                    <Text as="div" role="meta" className={own.railNote}>Nothing in the registry matches.</Text>
                  )}
                </>
              )}
              {registryRows.length === 0 && registry?.unavailable && (
                <>
                  <SectionHead name="From the ACP registry" />
                  <Text as="div" role="meta" className={own.railNote}>{registry.unavailable}</Text>
                </>
              )}
            </RailSection>

            <SectionFooter>
              <Text as="div" role="muted">
                Credentials stay on this machine — in each agent's own store, or here
                under {snapshot.credentialProtection} for the keys you paste.
              </Text>
            </SectionFooter>
          </AppWindowRail>

          {/* The work beside the roster is the dialog's body: a reading
              body, inset the dialog's step, that scrolls on its own. */}
          <DialogBody layout="reading" className={own.detail}>
            {fromRegistry ? (
              <RegistryAgent
                key={fromRegistry.id}
                agent={fromRegistry}
                onAdded={(added) => setSelected(added)}
              />
            ) : row ? (
              <Agent key={row.info.id} row={row} onSelect={setSelected} />
            ) : (
              <Note>No agents are registered yet.</Note>
            )}

            {row && row.status !== 'out' ? (
              <Alert tone="neutral" variant="soft" className={own.next}>
                <span className={own.nextMark}>
                  <RuntimeMark runtime={(nextUp ?? row).info} size={20} />
                </span>
                <AlertContent className={own.nextText}>
                  <AlertTitle>
                    {nextUp
                      ? `${nextUp.info.presentation.name} is still waiting`
                      : 'Everything else is already connected'}
                  </AlertTitle>
                  <AlertDescription>
                    {nextUp
                      ? 'One more sign-in and every agent here can take a turn.'
                      : 'Nothing left to sign in — close this and start a conversation.'}
                  </AlertDescription>
                </AlertContent>
                <Button
                  variant="default"
                  onClick={() => (nextUp ? setSelected(nextUp.info.id) : close())}
                >
                  {nextUp ? 'Sign in' : 'Done'}
                </Button>
              </Alert>
            ) : null}
          </DialogBody>
        </div>
      </DialogContent>
    </DialogRoot>
  )
}

/**
 * The whole roster in one glance: each agent's readiness light, in roster
 * order — the same `Dot` its row carries below, so the summary and the rows
 * it summarises are one vocabulary. Named once, in words, for a reader.
 */
const ROSTER_WORDS: readonly (readonly [Readiness, string])[] = [
  ['ready', 'ready'],
  ['signin', 'needs sign-in'],
  ['limit', 'at a limit'],
  ['broken', 'unavailable'],
  ['available', 'not added'],
]

const RosterLights = ({ states }: { states: readonly Readiness[] }) => {
  const counts = new Map<Readiness, number>()
  for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1)
  const named = ROSTER_WORDS
    .flatMap(([state, word]) => counts.has(state) ? [`${counts.get(state)} ${word}`] : [])
    .join(', ')
  return (
    <span data-slot="roster-lights" role="img" aria-label={`${states.length} agents: ${named}`} className={own.lights}>
      {states.map((state, index) => <Dot key={`${state}:${index}`} state={state} aria-hidden="true" />)}
    </span>
  )
}

/**
 * One account state: its judged mark, what it is, and the reason under it —
 * a round `IconTile` in the state's tone beside the subject and muted roles.
 */
const StatusSummary = ({
  icon,
  title,
  description,
  tone = 'neutral',
}: {
  icon: ReactNode
  title: ReactNode
  description?: ReactNode
  tone?: Tone
}) => (
  <div data-slot="status-summary" data-tone={tone} className="flex items-center gap-3">
    <IconTile shape="round" tone={tone}>{icon}</IconTile>
    <span className="flex min-w-0 flex-col gap-px">
      <Text role="subject">{title}</Text>
      {description != null ? <Text role="muted">{description}</Text> : null}
    </span>
  </div>
)

/** The glyph a way in wears: what it opens, not what it is called. */
const METHOD_ICON: Record<AuthMethod['flow'], typeof KeyIcon> = {
  apiKey: KeyIcon,
  browser: GlobeIcon,
  deviceCode: KeyboardIcon,
  external: TerminalIcon,
}

/**
 * The second line under a connected account: everything the first line is not.
 *
 * The title is the account's own label, which for a plan account is the email
 * — so the email is only worth repeating here when the label is something
 * else, and the plan is what a person actually wants beside it.
 */
const connectedHint = (account: Account): string => {
  const extra = account.email && account.email !== account.label ? account.email : null
  return [account.planType, extra].filter(Boolean).join(' · ') || 'Connected'
}

/**
 * Where this account's credential lives, as a fact rather than a sentence.
 *
 * A path is the one thing on this page that is not prose, and it was set in
 * prose: an inline code chip inside a paragraph, with a `~/.codex` in the
 * common case and a fifteen-segment absolute path in every other, which ran
 * out of the column and was clipped mid-word. Given a line of its own it can
 * wrap where paths wrap, and the consequence — whose credential this is, and
 * what signing out here costs — reads as its own line instead of a clause.
 */
const CredentialHome = ({ info, label }: { info: RuntimeInfo; label: string }) => {
  const home = credentialHome(info)
  if (home === null) return null
  return (
    <SummaryList className={own.fact}>
      <SummaryItem
        label={label}
        kind="path"
        note={info.slot?.removable
          ? `It belongs to ${info.presentation.name}. Only the credential lives there — the sessions are the agent’s own.`
          : `It belongs to ${info.presentation.name}. Signing out here signs that CLI out too.`}
      >
        {home}
      </SummaryItem>
    </SummaryList>
  )
}

/**
 * Who else this agent is already signed in as.
 *
 * Accounts of one agent are separate runtimes tied together by `slot.agent`,
 * so a second account's peers are exactly the other runtimes carrying that
 * agent's id. First one named wins: the sentence this feeds wants an example,
 * not a census.
 */
const peerAccount = (info: RuntimeInfo, snapshot: AppSnapshot): string | null => {
  const agent = info.slot?.agent
  if (agent === undefined) return null
  for (const other of snapshot.runtimes) {
    if (other.id === info.id) continue
    if (other.slot?.agent !== agent && other.id !== agent) continue
    const account = snapshot.accountsByRuntime[other.id]?.accounts[0]
    const name = account?.email ?? account?.label
    if (name) return name
  }
  return null
}

/** The selected agent: who it is, what state it is in, and the way in. */
const Agent = ({ row, onSelect }: { row: Row; onSelect: (runtime: RuntimeId) => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const { info } = row
  const login = snapshot.logins[info.id] ?? null
  // Null means "has not answered yet", which is not "has no account": a
  // runtime registered a moment ago cannot say either way, and the two states
  // read differently below.
  const status = snapshot.accountsByRuntime[info.id] ?? null
  // Why the *whole* map and not `snapshot.health`: that one is the active
  // runtime's, and an account being added is by definition not it.
  const health = snapshot.healthByRuntime[info.id] ?? null
  const broken = health?.state === 'unavailable' ? health : null
  const account = status?.accounts[0]
  const [adding, setAdding] = useState(false)
  const driveable = row.methods.filter((method) => method.flow !== 'external')
  const external = row.methods.filter((method) => method.flow === 'external')
  // One way in that needs a field is not a choice — open it. Two or more, and
  // the choice is the question, so the cards come first.
  const only = driveable.length === 1 && driveable[0]!.flow === 'apiKey' ? driveable[0]! : null
  const [opened, setOpened] = useState<string | null>(only?.id ?? null)
  const openedMethod = row.methods.find((method) => method.id === opened) ?? null

  // A browser flow ends in another application. Open it once, and only where
  // "open" means the system browser: in a plain web build an automatic
  // window.open is popup-blocker bait, so the link does that job on a click.
  useEffect(() => {
    // An agent that opened the browser from inside its own `authenticate`
    // hands over no URL, and there is nothing here to open (#749).
    if (login?.outcome.type === 'pending' && login.start.type === 'browser' && login.start.url && isDesktop()) {
      openExternal(login.start.url)
    }
  }, [login?.start.loginId, login?.outcome.type, login?.start])

  const signedIn = account && account.kind !== 'apiKey' && account.kind !== 'externalKey'

  return (
    <>
      <div className={own.who}>
        <span className={own.whoMark}>
          <RuntimeMark runtime={info} size={22} />
        </span>
        <Text role="subject" truncate>{info.presentation.name}</Text>
      </div>
      <Note className={own.blurb}>
        {info.presentation.tagline ?? `${STATUS_LABEL[row.status]}.`}
      </Note>

      {login?.outcome.type === 'pending' ? (
        <Pending
          runtime={info.id}
          login={login}
          // Not gated on `slot.removable`. The fold cuts both ways: sign the
          // agent's *own* account back in as somebody a second account already
          // is, and it is the second account that is dropped
          // (`Host.#foldDuplicateAccount`) — a row taken from the user, from
          // the one pane that was excluded from warning about it. `peerAccount`
          // is null when there is no peer to collide with, which is the guard
          // this actually needed.
          alreadyAs={peerAccount(info, snapshot)}
        />
      ) : login?.outcome.type === 'failed' ? (
        <div className={own.waiting}>
          <ActionError>{login.outcome.error}</ActionError>
          <div className={own.row}>
            <Button variant="secondary" onClick={() => store.dismissLogin(info.id)}>Try again</Button>
          </div>
        </div>
      ) : signedIn ? (
        <div className={own.waiting}>
          <StatusSummary
            tone="success"
            icon={<CheckIcon size={16} />}
            title={account.label || 'Already connected'}
            description={connectedHint(account)}
          />
          <CredentialHome info={info} label="Credential" />
          <SignOut
            runtime={info.id}
            lead={
              info.slot?.canAdd ? (
                <Button
                  variant="default"
                  disabled={adding}
                  onClick={() => {
                    // A second identity needs a second credential home, or the
                    // sign-in would land on top of the one shown above. The
                    // host holds the answer until the new account can be
                    // signed in, so the button says it is working — and is
                    // held as well as disabled, because `disabled` only lands
                    // on the next render and two slots is what a second press
                    // buys.
                    if (adding) return
                    setAdding(true)
                    void store
                      .addAccount(info.id)
                      .then((added) => {
                        if (added) onSelect(added)
                      })
                      .finally(() => setAdding(false))
                  }}
                >
                  {adding ? 'Adding…' : 'Add another account'}
                </Button>
              ) : null
            }
          />
        </div>
      ) : openedMethod && openedMethod.flow === 'apiKey' ? (
        <KeyField
          runtime={info.id}
          method={openedMethod}
          stored={account?.kind === 'apiKey'}
          {...(only ? {} : { onBack: () => setOpened(null) })}
          {...(account?.kind === 'externalKey'
            ? { elsewhere: account.planType ?? 'its own configuration' }
            : {})}
        />
      ) : driveable.length > 0 ? (
        <div>
          <SectionHead name="How would you like to connect it?" />
          <ListRows size="sm" className={own.methods}>
            {driveable.map((method) => {
              const Glyph = METHOD_ICON[method.flow]
              /* `row`, not `sm`: a method card is a name with the agent's own
                 sentence under it, and every button size below `row` is one
                 line of a fixed height with `whitespace-nowrap`. At `sm` the
                 four methods Antigravity declares wrapped nowhere, and once
                 they wrapped they drew over each other (#749). `row` is the
                 design system's own multi-line row: `h-auto`, a min-height,
                 and `whitespace-normal`. */
              return (
                <ListRow
                  key={method.id}
                  as="button"
                  size="sm"
                  interactive
                  onClick={() => {
                    if (method.flow === 'apiKey') setOpened(method.id)
                    else void store.startLogin(info.id, method.id)
                  }}
                  lead={<Glyph size={18} />}
                  title={<Text role="subject">{method.label}</Text>}
                  subtitle={method.description ? <Text role="muted">{method.description}</Text> : undefined}
                  wrapSubtitle
                  trail={<ChevronIcon size={16} />}
                />
              )
            })}
          </ListRows>
          <CredentialHome info={info} label="Where the credential lands" />
          {/* An account added and then thought better of. Removable here so it
              does not have to be walked back through the settings page. No
              sentence beside it: this whole pane is already the state it
              describes. */}
          {info.slot?.removable ? (
            <div className={own.actions}>
              <Button variant="ghost" onClick={() => void store.removeAccount(info.id)}>
                Remove this account
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* A way in this window cannot drive. Same shape as everything else on
          the card — a label, the thing itself, and what it means — rather
          than a bold sentence with a shell command set in prose. */}
      {external.map((method) => (
        <div key={method.id} className={own.aside}>
          <SectionHead name={method.label} />
          {method.description ? <Note className={own.noteFlush}>{method.description}</Note> : null}
        </div>
      ))}

      {/* "No ways in" and "has not said yet" are different facts and used to
          read the same. An account made a second ago has not answered for
          itself, and saying it needs no account then is both wrong and a dead
          end: it is the one screen with nothing to press.
          A third fact hides inside the second: an agent that will *never*
          answer. Its health is the only thing that separates "coming up" from
          "did not come up", and a second account is never the active runtime,
          so this is the one place that reads it. Without this the pane spins
          on "as soon as it answers" for an answer that is not coming. */}
      {row.methods.length === 0 ? (
        status === null ? (
          broken ? (
            <div className={own.waiting}>
              <StatusSummary
                tone="danger"
                icon={<AlertIcon size={16} />}
                title={`${info.presentation.name} did not start`}
                description={broken.message}
              />
              {broken.remediation ? <Note className={own.note}>{broken.remediation}</Note> : null}
              {info.slot?.removable ? (
                <div className={own.actions}>
                  <Button variant="ghost" onClick={() => void store.removeAccount(info.id)}>
                    Remove this account
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <Note className={own.noteFlush} icon={<Spinner size="sm" tone="brand" aria-hidden="true" />}>
              Starting{' '}
              {info.presentation.name} — its ways in appear as soon as it answers.
            </Note>
          )
        ) : (
          <Note className={own.noteFlush}>
            {info.presentation.name} needs no account here
            {info.presentation.configLocation
              ? `; it reads its own configuration from ${info.presentation.configLocation}.`
              : '.'}
          </Note>
        )
      ) : null}
    </>
  )
}

/**
 * An agent the ACP registry names and this desk does not hold yet: what it
 * is, in the registry's own words, and the one button that changes that.
 * Registering installs nothing for a package-runner entry and downloads the
 * agent's build for a binary one — the sentence above the button says which
 * before it happens. Once added, the runtime's own row takes over.
 */
const RegistryAgent = ({
  agent,
  onAdded,
}: {
  agent: AcpRegistryAgentInfo
  onAdded: (runtime: RuntimeId) => void
}) => {
  const store = useStore()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const add = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const outcome = await store.addAgentTelling({ registry: { id: agent.id } })
    setBusy(false)
    if ('error' in outcome) setError(outcome.error)
    else onAdded(outcome.runtime)
  }

  const meta = [
    `v${agent.version}`,
    agent.license,
    agent.run === 'binary' && agent.integrity === 'none' && !agent.installed ? 'Unverified' : null,
  ].filter(Boolean).join(' · ')

  return (
    <>
      <div className={own.who}>
        <span className={own.whoMark}>
          <RuntimeMark runtime={{ id: agent.id, presentation: { name: agent.name } }} size={22} />
        </span>
        <Text role="subject" truncate>{agent.name}</Text>
        <Text role="meta" className={own.whoMeta}>{meta}</Text>
      </div>
      <Note className={own.blurb}>
        {agent.description ?? 'An agent from the public ACP registry.'}
      </Note>

      {error ? <ActionError className={own.actionError}>{error}</ActionError> : null}

      {agent.available ? (
        <div className={own.waiting}>
          <Note className={own.noteFlush}>
            {registryRunSentence(agent)}
          </Note>
          <div className={own.row}>
            <Button variant="default" disabled={busy} onClick={() => void add()}>
              {registryAddLabel(agent, busy)}
            </Button>
            {agent.website ? (
              <Button variant="ghost" onClick={() => openExternal(agent.website!)}>
                Its website
              </Button>
            ) : null}
          </div>
          <Note className={own.note}>
            {agent.run === 'binary'
              ? 'The agent keeps its own account, configuration and history. Removing it from HarnessDesk later deletes the downloaded build and nothing else.'
              : 'Registering points HarnessDesk at it and nothing more — the agent keeps its own account, configuration and history, and removing it later uninstalls nothing.'}
          </Note>
        </div>
      ) : (
        <div className={own.waiting}>
          <StatusSummary
            tone="danger"
            icon={<AlertIcon size={16} />}
            title="Cannot run on this machine"
            description={agent.reason}
          />
          {agent.website ? (
            <div className={own.row}>
              <Button variant="ghost" onClick={() => openExternal(agent.website!)}>
                Its website
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </>
  )
}

/**
 * The key field.
 *
 * The value goes straight to the host and into the credential broker, which
 * hands it to the agent as an environment variable when it next starts. It is
 * never put in the snapshot, never logged, and cannot be read back — so once
 * one is stored this shows that fact and offers to replace or remove it,
 * rather than pretending to display a secret it does not have.
 */
const KeyField = ({
  runtime,
  method,
  stored,
  elsewhere,
  onBack,
}: {
  runtime: RuntimeId
  method: AuthMethod
  stored: boolean
  /**
   * Set when the agent already has this key somewhere HarnessDesk does not
   * own — its own credentials store, a `.env`, the launching environment.
   * The field stays open, because storing one here is still allowed and takes
   * precedence, but claiming the agent has nothing would be a lie.
   */
  elsewhere?: string
  /** Absent when this is the agent's only way in — there is nothing to go back to. */
  onBack?: () => void
}) => {
  const store = useStore()
  const protection = useSnapshot().credentialProtection
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const label = method.keyLabel ?? method.label
  const editing = !stored || replacing

  const save = async (): Promise<void> => {
    if (!value.trim() || busy) return
    setBusy(true)
    const ok = await store.storeApiKey(runtime, method.id, value)
    setBusy(false)
    if (ok) {
      setValue('')
      setReplacing(false)
    }
  }

  return (
    <div className={own.waiting}>
      <SectionHead
        name={label}
        action={onBack ? (
          <Button variant="outline" size="sm" onClick={onBack}>
            Other ways in
          </Button>
        ) : undefined}
      />

      {elsewhere && !stored ? (
        <StatusSummary
          tone="success"
          icon={<CheckIcon size={16} />}
          title="Already has a key"
          description={<>It reads one from {elsewhere}. Nothing to do — unless you want this window
            to supply a different one, which takes precedence.</>}
        />
      ) : null}

      {editing ? (
        <>
          <div className={own.keyRow}>
            <Text role="muted" className={own.keyIcon} aria-hidden="true">
              <KeyIcon size={13} />
            </Text>
            <Input
              ref={field}
              type="password"
              variant="code"
              className={own.keyInput}
              value={value}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              placeholder={`Paste your ${label}`}
              aria-label={label}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void save()
              }}
            />
            <Button variant="default" disabled={!value.trim() || busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            {stored ? <Button variant="secondary" onClick={() => setReplacing(false)}>Cancel</Button> : null}
          </div>
          <Note className={own.note}>
            {method.description ? `${method.description} ` : ''}
            The key is kept on this machine ({protection}) and handed to the agent when
            it starts; this window never sees it again.
            {method.helpUrl ? (
              <>
                {' '}
                <Button variant="ghost" size="inline"
                  type="button"
                  className={`break-all`}
                  onClick={() => openExternal(method.helpUrl!)}
                >
                  Where do I get one?
                </Button>
              </>
            ) : null}
          </Note>
        </>
      ) : (
        <>
          <StatusSummary
            tone="success"
            icon={<CheckIcon size={16} />}
            title={`${label} stored`}
            description={<>Kept on this machine ({protection}). Restart a conversation to pick up a
              change.</>}
          />
          <div className={own.row}>
            <Button variant="secondary"
              onClick={() => {
                setReplacing(true)
                queueMicrotask(() => field.current?.focus())
              }}
            >
              Replace
            </Button>
            <Button variant="destructive" onClick={() => void store.clearApiKey(runtime, method.id)}>
              Remove
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

const SignOut = ({ runtime, lead }: { runtime: RuntimeId; lead?: ReactNode }) => {
  const store = useStore()
  const [confirming, setConfirming] = useState(false)
  return (
    // One row for both actions. Two rows of one button each read as two
    // unrelated afterthoughts, and the one you want — adding an account — sat
    // above the one you don't with the same weight.
    <div className={own.actions}>
      {confirming ? (
        <>
          <Text role="muted" className={own.rowNote}>
            Sign out? Running conversations keep going until they finish.
          </Text>
          <Button variant="secondary" onClick={() => setConfirming(false)}>Keep</Button>
          <Button
            variant="destructive"
            onClick={() => {
              setConfirming(false)
              void store.signOutAgent(runtime)
            }}
          >
            Sign out
          </Button>
        </>
      ) : (
        <>
          {lead}
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            Sign out
          </Button>
        </>
      )}
    </div>
  )
}

/**
 * Waiting on the user, showing exactly what the runtime handed back.
 *
 * `alreadyAs` is the account this agent is already signed in as, and is set
 * only while a *second* account is being added. It is the one thing this pane
 * knows that the person at the browser does not: the sign-in page they are
 * being sent to will use whichever identity that browser is already in, and
 * an agent signed in twice as the same person is one account — so the row
 * they are watching would be taken away again the moment they finish. Said
 * before, where it can still be acted on, rather than afterwards in a notice.
 */
const Pending = ({
  runtime,
  login,
  alreadyAs,
}: {
  runtime: RuntimeId
  login: NonNullable<AppSnapshot['logins'][RuntimeId]>
  alreadyAs?: string | null
}) => {
  const store = useStore()
  const start = login.start
  return (
    <div className={own.waiting}>
      <StatusSummary
        tone="brand"
        icon={<Spinner size="sm" tone="brand" aria-hidden="true" />}
        title={start.type === 'browser' ? 'Waiting for you in the browser' : 'Enter this code'}
        description={start.type === 'browser'
          ? 'A sign-in page opened in your browser. This window updates on its own when you are done.'
          : `Open ${start.url} on any device, sign in, and enter the code below.`}
      />

      {start.type === 'browser' ? null : (
        /* Verbatim and selectable, on the code plate, at the page step so it
           can be read across a room and typed on another device. */
        <CodeText as="code" block ground="muted" className={own.code} aria-label="One-time code">
          <Text role="page" ink="primary">{start.code}</Text>
        </CodeText>
      )}

      <div className={own.row}>
        {/* Only where there is a page to open. An agent that opened the
            browser from inside its own `authenticate` never said which URL
            it used, so the button would have nowhere to go (#749); the wait
            and the cancel are the whole of what this flow offers then. */}
        {start.url ? (
          <Button variant="secondary" onClick={() => openExternal(start.url!)}>
            {start.type === 'browser' ? 'Open the page again' : 'Open the page'}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => void store.cancelLogin(runtime)}>
          Cancel
        </Button>
      </div>

      {alreadyAs ? (
        <div className={own.aside}>
          <SectionHead name="Sign in as somebody else" />
          <Note className={own.noteFlush}>
            This agent already has {alreadyAs}, and the page uses whichever account your
            browser is signed in to. Choose a different one there — one identity is one
            account here, and finishing as somebody it already has drops the extra row,
            whichever of the two you started from.
          </Note>
        </div>
      ) : null}

      <Note className={own.note}>
        HarnessDesk never sees your password — it reads only whether the agent's own
        sign-in worked.
      </Note>
    </div>
  )
}
