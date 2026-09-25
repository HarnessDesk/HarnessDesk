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
import { Prose } from './Prose'
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
  Field,
  IconTile,
  Input,
  ListRow,
  ListRows,
  Note,
  RailSection,
  Row as SettingsRow,
  RowButton,
  Rows,
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
 * The rail is split by what each agent needs from you: the ones not
 * connected first, then the ones that are, each group counted. The reason
 * anyone opens this window is that one agent of many is asleep, and sorting
 * by that answer makes finding it the first glance rather than the task.
 *
 * Beside it, the selected agent is a sign-in card — its face, its name and
 * its ways in, one column wide and centred, the anatomy every sign-in page
 * shares — so a person who has signed in anywhere knows where to look.
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
  // Ways in this window cannot drive, and no account: signed out all the
  // same, and the way in is a step taken elsewhere — which is the line.
  if (methods.length > 0) {
    return { info, status: 'manual', state, detail: methods[0]!.label, methods, pending }
  }
  // No status at all is not an empty one. A runtime registered a moment ago
  // has not answered `runtime/account` yet, and calling that "runs without
  // one" put a starting account in the connected count and contradicted the
  // detail pane beside it, which says it is starting.
  if (status === undefined) {
    return { info, status: 'asking', state, detail: STATUS_LABEL.asking, methods, pending }
  }
  // An agent that refused to work signed out and offered no way in has not
  // "run without one" — it said the opposite, and its card says what it said.
  if (status.refusal) {
    return { info, status: 'out', state, detail: STATUS_LABEL.out, methods, pending }
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
  const nextUp = rows.find((entry) => entry.status === 'out' && entry.info.id !== row?.info.id)

  useEffect(() => {
    void store.loadAccounts()
  }, [store])

  const close = (): void => {
    onClose()
  }

  const groups = [
    { name: 'Not connected', rows: rows.filter((entry) => !isConnected(entry)) },
    { name: 'Connected', rows: rows.filter(isConnected) },
  ].filter((group) => group.rows.length > 0)

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
              dashboard stand their rosters on — under the dialog's own head. */}
          <AppWindowRail aria-label="Agents" className={own.rail}>
            <RailSection stretch="list" density="comfortable" className={own.railList}>
              {groups.map((group) => (
                <div key={group.name} role="group" aria-label={group.name} className={own.group}>
                  <SectionHead
                    name={group.name}
                    action={<Text role="meta" numeric>{group.rows.length}</Text>}
                  />
                  <ListRows size="sm">
                  {group.rows.map((entry) => (
                    <ListRow
                      key={entry.info.id}
                      as="button"
                      size="sm"
                      interactive
                      selected={entry.info.id === row?.info.id}
                      onClick={() => setSelected(entry.info.id)}
                      lead={<RuntimeMark runtime={entry.info} size={16} />}
                      title={<Text role="row">{entry.info.presentation.name}</Text>}
                      subtitle={railLine(entry)}
                      trail={entry.pending ? (
                        <Spinner size="sm" tone="brand" aria-hidden="true" />
                      ) : entry.state === 'limit' || entry.state === 'broken' ? (
                        <Dot state={entry.state} />
                      ) : undefined}
                    />
                  ))}
                  </ListRows>
                </div>
              ))}

              {registryRows.length > 0 && (
                <div role="group" aria-label="From the ACP registry" className={own.group}>
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
                </div>
              )}
              {registryRows.length === 0 && registry?.unavailable && (
                <div role="group" aria-label="From the ACP registry" className={own.group}>
                  <SectionHead name="From the ACP registry" />
                  <Text as="div" role="meta" className={own.railNote}>{registry.unavailable}</Text>
                </div>
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
              body, inset the dialog's step, that scrolls on its own. The
              card inside it is one column, centred, the width of a form. */}
          <DialogBody layout="reading" className={own.detail}>
            <div className={own.card} data-slot="sign-in-card">
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

              {row && isConnected(row) ? (
                <Alert tone="neutral" variant="soft" className={own.next}>
                  {/* The mark belongs to the alert's headline, and wears its ink. */}
                  <Text role="subject" className={own.nextMark}>
                    <RuntimeMark runtime={(nextUp ?? row).info} size={20} />
                  </Text>
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
            </div>
          </DialogBody>
        </div>
      </DialogContent>
    </DialogRoot>
  )
}

/**
 * Whether a row belongs under "Connected": it holds an account, or it answered
 * that it needs none. An account still starting is not connected and is not
 * signed out either — it has not answered — so it waits with the ones that
 * are not connected, where its "Starting…" is read. One whose only ways in
 * are taken elsewhere is signed out all the same.
 */
const isConnected = (row: Row): boolean => row.status !== 'out' && row.status !== 'asking' && row.status !== 'manual'

/**
 * A rail row's second line: only what its group does not already say. Under
 * "Not connected", a plain "Not connected" on every row is the group's own
 * sentence repeated, so the line is kept for what differs — a sign-in under
 * way, an agent starting, one that did not start, a way in taken elsewhere.
 */
const railLine = (row: Row): ReactNode => {
  if (row.pending) return <Text role="meta" tone="brand">Waiting…</Text>
  if (!isConnected(row)) {
    if (row.state === 'broken') return <Text role="meta" tone="danger">Did not start</Text>
    return row.status === 'asking' || row.status === 'manual' ? <Text role="meta">{row.detail}</Text> : undefined
  }
  // Nor under "Connected": an account with no name of its own says only that
  // it is signed in, which is the group's word again.
  if (row.detail === STATUS_LABEL.in) return undefined
  return (
    <Text role="meta" tone={row.state === 'limit' ? 'warning' : undefined}>
      {row.detail}
    </Text>
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

/** A state's round mark, as a row's lead: the same tile `StatusSummary` wears. */
const StateMark = ({ tone, children }: { tone: Tone; children: ReactNode }) => (
  <IconTile shape="round" size="sm" tone={tone}>{children}</IconTile>
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
const connectedHint = (account: Account): string | undefined => {
  const extra = account.email && account.email !== account.label ? account.email : null
  return [account.planType, extra].filter(Boolean).join(' · ') || undefined
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

/**
 * The top of the card: the agent's face in a tile, its name at the page's
 * step, and one line of what it is — centred, because it is the subject of
 * everything under it, the way every sign-in page opens on whose door this
 * is. The name is the subject's step, under the dialog's own title. The meta line is only for a registry entry, whose version and licence
 * are the facts that vary.
 */
const CardHead = ({
  mark,
  name,
  meta,
  children,
}: {
  mark: ReactNode
  name: string
  meta?: string
  children: ReactNode
}) => (
  <div className={own.head} data-slot="sign-in-head">
    {/* The mark stands in its name's ink: the tile's own is for glyphs. */}
    <IconTile size="lg" className={own.headTile}>
      <Text role="subject" className={own.headMark}>{mark}</Text>
    </IconTile>
    <Text as="h2" role="subject" align="center" className={own.headName}>{name}</Text>
    {meta ? <Text as="div" role="meta" align="center">{meta}</Text> : null}
    <Text as="p" role="muted" align="center" className={own.headLine}>{children}</Text>
  </div>
)

/**
 * The small print under the card, for what the card is doing rather than
 * what it is: a sign-in under way says what this window can and cannot see.
 */
const FinePrint = ({ children }: { children: ReactNode }) => (
  <Text as="p" role="meta" align="center" className={own.fine}>
    {children}
  </Text>
)

/**
 * One way in, as a drill row: what it opens, what it is called, and the
 * agent's own sentence under it, whole, when it has one — agents write real
 * sentences here, and a one-line button cut them (#749). The ways in are
 * actions, not a choice held open, so they are rows of one group card with
 * hairlines between them, never a radio list or a wall of framed boxes.
 */
const MethodRow = ({ method, onChoose }: { method: AuthMethod; onChoose: () => void }) => {
  const Glyph = METHOD_ICON[method.flow]
  return (
    <RowButton
      mark={<Glyph size={16} />}
      title={method.label}
      {...(method.description ? { desc: <Prose text={method.description} />, wrapDesc: true } : {})}
      onClick={onChoose}
    />
  )
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
  // The ways in that are a press come first, as rows. A key is a field, and
  // one key is not a choice — it is drawn open, under the rows. Two or more
  // keys are a choice again, and join the rows.
  const presses = driveable.filter((method) => method.flow !== 'apiKey')
  const keys = driveable.filter((method) => method.flow === 'apiKey')
  const inlineKey = keys.length === 1 ? keys[0]! : null
  const choices = inlineKey ? presses : driveable
  const [opened, setOpened] = useState<string | null>(null)
  const openedMethod = keys.find((method) => method.id === opened) ?? null

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
  const pending = login?.outcome.type === 'pending'
  const keyProps = {
    runtime: info.id,
    stored: account?.kind === 'apiKey',
    ...(account?.kind === 'externalKey' ? { elsewhere: account.planType ?? 'its own configuration' } : {}),
  }

  return (
    <>
      <CardHead mark={<RuntimeMark runtime={info} size={20} />} name={info.presentation.name}>
        {info.presentation.tagline ?? `${STATUS_LABEL[row.status]}.`}
      </CardHead>

      {/* What the agent said when it refused to work signed out. Said once,
          above every way in, because it answers all of them — and said even
          when it offered none, since then it is the only instruction there is. */}
      {status?.refusal && !signedIn && !pending ? (
        <Note className={own.noteFlush} icon={<AlertIcon size={14} />}><Prose text={status.refusal} /></Note>
      ) : null}

      {login && pending ? (
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
        <div className={own.stack}>
          <ActionError>{login.outcome.error}</ActionError>
          <div className={own.row}>
            <Button variant="secondary" onClick={() => store.dismissLogin(info.id)}>Try again</Button>
          </div>
        </div>
      ) : signedIn ? (
        <div className={own.stack}>
          <Rows>
            <SettingsRow
              data-slot="sign-in-account"
              mark={<StateMark tone="success"><CheckIcon size={14} /></StateMark>}
              title={account.label || 'Already connected'}
              {...(connectedHint(account) ? { desc: connectedHint(account) } : {})}
            />
          </Rows>
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
          <CredentialHome info={info} label="Credential" />
        </div>
      ) : openedMethod ? (
        <KeyField {...keyProps} method={openedMethod} onBack={() => setOpened(null)} />
      ) : driveable.length > 0 ? (
        <div className={own.stack}>
          {choices.length > 0 ? (
            <Rows role="group" aria-label="Ways to connect">
              {choices.map((method) => (
                <MethodRow
                  key={method.id}
                  method={method}
                  onChoose={() => {
                    if (method.flow === 'apiKey') setOpened(method.id)
                    else void store.startLogin(info.id, method.id)
                  }}
                />
              ))}
            </Rows>
          ) : null}
          {inlineKey ? (
            <KeyField {...keyProps} method={inlineKey} autoFocus={choices.length === 0} />
          ) : null}
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
          {method.description ? <Note className={own.noteFlush}><Prose text={method.description} /></Note> : null}
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
      {/* A signed-in agent that offers no way in has nothing missing: its
          account is the answer, and "needs no account" would contradict it. */}
      {row.methods.length === 0 && !account && !status?.refusal ? (
        status === null ? (
          broken ? (
            <div className={own.stack}>
              <StatusSummary
                tone="danger"
                icon={<AlertIcon size={16} />}
                title={`${info.presentation.name} did not start`}
                description={broken.message}
              />
              {broken.remediation ? <Note className={own.noteFlush}>{broken.remediation}</Note> : null}
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

      {pending ? (
        <FinePrint>
          HarnessDesk never sees your password — it reads only whether the agent's own
          sign-in worked.
        </FinePrint>
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
      <CardHead
        mark={<RuntimeMark runtime={{ id: agent.id, presentation: { name: agent.name } }} size={20} />}
        name={agent.name}
        meta={meta}
      >
        {agent.description ?? 'An agent from the public ACP registry.'}
      </CardHead>

      {error ? <ActionError className={own.actionError}>{error}</ActionError> : null}

      {agent.available ? (
        <div className={own.stack}>
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
          <Note className={own.noteFlush}>
            {agent.run === 'binary'
              ? 'The agent keeps its own account, configuration and history. Removing it from HarnessDesk later deletes the downloaded build and nothing else.'
              : 'Registering points HarnessDesk at it and nothing more — the agent keeps its own account, configuration and history, and removing it later uninstalls nothing.'}
          </Note>
        </div>
      ) : (
        <div className={own.stack}>
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
  autoFocus = true,
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
  /** Take focus on arrival — when the key is the card's first way in, not one under a button. */
  autoFocus?: boolean
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
    <div className={own.stack} data-slot="sign-in-key">
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
          <Field
            label={label}
            hint={method.description || method.helpUrl ? (
              <>
                {method.description ? <Prose text={method.description} /> : null}
                {method.helpUrl ? (
                  <>
                    {method.description ? ' ' : ''}
                    <Button variant="ghost" size="inline"
                      type="button"
                      onClick={() => openExternal(method.helpUrl!)}
                    >
                      Where do I get one?
                    </Button>
                  </>
                ) : null}
              </>
            ) : undefined}
          >
            {(control) => (
              <Input
                {...control}
                ref={field}
                type="password"
                variant="code"
                value={value}
                autoFocus={autoFocus}
                spellCheck={false}
                autoComplete="off"
                placeholder={`Paste your ${label}`}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void save()
                }}
              />
            )}
          </Field>
          <div className={own.row}>
            <Button variant="default" className={own.grow} disabled={!value.trim() || busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save key'}
            </Button>
            {stored ? <Button variant="secondary" onClick={() => setReplacing(false)}>Cancel</Button> : null}
            {onBack ? <Button variant="ghost" onClick={onBack}>Other ways in</Button> : null}
          </div>
        </>
      ) : (
        <>
          <Rows>
            <SettingsRow
              data-slot="sign-in-account"
              mark={<StateMark tone="success"><CheckIcon size={14} /></StateMark>}
              title={`${label} stored`}
              desc={`Kept on this machine (${protection}). Restart a conversation to pick up a change.`}
              wrapDesc
            />
          </Rows>
          <div className={own.actions}>
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
            {onBack ? <Button variant="ghost" onClick={onBack}>Other ways in</Button> : null}
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
    <div className={own.stack}>
      <StatusSummary
        tone="brand"
        icon={<Spinner size="sm" tone="brand" aria-hidden="true" />}
        title={start.type === 'browser' ? 'Waiting for you in the browser' : 'Enter this code'}
        description={start.type === 'browser'
          ? 'A sign-in page opened in your browser. This window updates on its own when you are done.'
          : `Open ${start.url} on any device, sign in, and enter the code below.`}
      />

      {start.type === 'browser' ? null : (
        /* Verbatim and selectable, on the code plate, at the page step and
           spaced, so it can be read across a room and typed on another device. */
        <CodeText as="code" block ground="muted" spaced className={own.code} aria-label="One-time code">
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

    </div>
  )
}
