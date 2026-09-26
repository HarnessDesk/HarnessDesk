import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'

import { useSnapshot, useStore } from '../state/context'
import { chordOf, SHORTCUTS, type Shortcut } from '../lib/shortcuts'
import { emptyNoticePolicy, NOTICE_KINDS, NOTICE_USES, surfaceFor, SURFACE_LABEL, type NoticeSurface } from '../lib/notice-policy'
import { unreadCount } from '../lib/inbox'
import { SYSTEM_NOTIFICATION_KINDS, systemNotificationOn } from '../lib/system-notifications'
import { FONT_SIZES, installedFaces, TAB_SIZES } from '../lib/editor-prefs'
import { formatAge } from '../lib/usage'
import { AVATARS, isAvatarId, type AvatarId } from '../lib/avatars'
import {
  applyProfile,
  DEFAULT_PROFILE_NAME,
  editName,
  isDefaultProfile,
  profileName,
} from '../lib/profile'
import { EditorSample, ThemeCards, useResolvedDark } from './AppearancePreview'
import {
  Button,
  Card,
  DetailHead,
  Face,
  Input,
  Keycap,
  Note,
  RowValue,
  PageHead,
  Row,
  Rows,
  SectionHead,
  Segmented,
  NativeSelect,
  InboxList,
  UnreadMark,
  Switch,
  Text,
} from '../design'
import styles from './SettingsYou.module.css'

/**
 * The pages about the person rather than the agents.
 *
 * They sit at the top of the nav because that is the order a new window is
 * read in: who am I, what does this look like, what does it say to me, how do
 * I drive it — and only then, what can it do.
 */

/**
 * You: the name and the face the desk shows for you.
 *
 * The page the seat's menu opens and the settings rail starts with. Its head
 * is your face at a size you can see and your name as you type it, so the
 * page is its own preview, the way Appearance is — nothing on it needs a
 * sentence saying what it would change.
 *
 * Nothing here signs in and nothing here syncs: there is no HarnessDesk
 * account, and the page does not pretend to one. When there is, this is the
 * page it arrives on — the account brings the same two things, and the head
 * is where it will say whose they are.
 *
 * Three ways back, each where you would look for it: clear the field for the
 * name, the first face for the picture, and "Reset to default" for both —
 * shown only while there is something to reset.
 */
export const ProfileSection = () => {
  const store = useStore()
  const { profile } = useSnapshot()
  const stored = profile.name ?? ''
  /* The field keeps its own text until it is let go — Enter, a click
     elsewhere, the window closing. The store tidies a name (trims it, folds
     its runs of spaces), and tidying under the caret would eat the space
     between two words as it was typed; the account nickname field makes the
     same choice for the same reason. `latest` is the draft as of this
     instant, because a blur fires before the render that would carry it. */
  const [draft, setDraft] = useState(stored)
  const latest = useRef(draft)
  latest.current = draft
  const kept = useRef(stored)
  kept.current = stored
  const commit = (): void => {
    // Let go without an edit, the field writes nothing: a name a later build
    // wrote to its own rules survives being looked at. An edit is held to
    // this build's: the field lets a longer name be shortened any way — from
    // the middle, say — and whatever is left when it is let go is cut to
    // forty, so a single Backspace on a sixty-character name keeps forty.
    if (latest.current === kept.current) return
    store.setProfile({ name: latest.current })
    setDraft(applyProfile({}, { name: latest.current }).name ?? '')
  }
  // Reset puts the field back itself rather than waiting for the store to
  // answer. A draft nobody committed would otherwise outlive it — the stored
  // profile did not change, so nothing would tell the field to — and the
  // write on the way out below would read the stale draft back into the store.
  const reset = (): void => {
    latest.current = ''
    setDraft('')
    store.setProfile({ name: null, avatar: null })
  }
  // Any change from outside the field puts the field back.
  useEffect(() => setDraft(stored), [stored])
  // Leaving is letting go — of an edit, if there is one; a page opened and
  // closed again writes nothing. Leaving for another page unmounts this one.
  // A quit or a reload tears the page down without running React's cleanups,
  // so `pagehide` writes it on the way out too: best effort, because the write
  // is a message that has to leave before the page does, and a crash writes
  // nothing at all.
  useEffect(() => {
    const letGo = (): void => {
      if (latest.current !== kept.current) store.setProfile({ name: latest.current })
    }
    window.addEventListener('pagehide', letGo)
    window.addEventListener('beforeunload', letGo)
    return () => {
      window.removeEventListener('pagehide', letGo)
      window.removeEventListener('beforeunload', letGo)
      letGo()
    }
  }, [store])

  // The head previews what is typed, before it is let go — and while nothing
  // is, shows what is kept, as it is kept.
  const live = draft === stored ? profile : applyProfile(profile, { name: draft })
  const noteId = useId()
  const keeps = profile.avatar !== undefined && !isAvatarId(profile.avatar)

  return (
    <>
      <DetailHead
        mark={<Face avatar={profile.avatar} size={44} />}
        name={profileName(live)}
        blurb="Shown at the foot of the sidebar and beside what you say in a room. Kept on this Mac."
        actions={
          isDefaultProfile(live) ? undefined : (
            <Button variant="outline" onClick={reset}>
              Reset to default
            </Button>
          )
        }
      />

      <Rows>
        <Row
          title="Name"
          desc={`Leave it empty to use ${DEFAULT_PROFILE_NAME}.`}
          control={
            <Input
              className={styles.nameField}
              value={draft}
              placeholder={DEFAULT_PROFILE_NAME}
              aria-label="Your name"
              /* Capped by character, the count the store keeps. `maxLength`
                 counts UTF-16 units, and stopped an emoji name at twenty. */
              onChange={(event) => {
                const node = event.target
                const edit = editName(latest.current, node.value, node.selectionEnd)
                latest.current = edit.value
                setDraft(edit.value)
                // Setting a value puts the caret at its end, and React sets
                // one whenever the edit was cut: put the caret back after
                // what was kept of the edit, once React is done.
                if (edit.value !== node.value) queueMicrotask(() => node.setSelectionRange(edit.caret, edit.caret))
              }}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape' && draft !== stored) {
                  // The first Escape takes the edit back; the next is the window's.
                  event.stopPropagation()
                  latest.current = stored
                  setDraft(stored)
                  event.currentTarget.blur()
                }
              }}
            />
          }
        />
      </Rows>

      <SectionHead name="Picture" />
      <FacePicker
        value={profile.avatar}
        describedBy={keeps ? noteId : undefined}
        onChange={(avatar) => store.setProfile({ avatar })}
      />
      {keeps && (
        <Note id={noteId} className={styles.pageNote}>
          Your profile holds a face this version of HarnessDesk cannot draw, so it shows as the house mark. It is kept
          as it is until you choose one here.
        </Note>
      )}
    </>
  )
}

/**
 * Eight to a row: Default and the mark's six colourways fill the first row and
 * a tile over, and the twenty-three whales run on to the end of the fourth.
 * The grid takes its column count from here (`--face-columns`), so the step
 * Up and Down take and the row the eye sees are one number.
 */
const FACE_COLUMNS = 8

const ARROWS: ReadonlySet<string> = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])

const FACE_CHOICES: readonly { readonly id: AvatarId | null; readonly label: string; readonly about: string }[] = [
  { id: null, label: 'Default', about: 'The HarnessDesk mark' },
  ...AVATARS,
]

/**
 * Every face you could wear, as one radio group.
 *
 * One stop on the tab order, not thirty: Tab lands on the face you wear,
 * and the arrow keys walk the grid — across, and down a row of eight — the
 * way a radio group has always moved, choosing as they go. Home and End are
 * left out on purpose: in a group that chooses as it moves, a stray Home
 * would be a silent reset. For the same reason an arrow with nowhere to go —
 * Left on the first face, Right on the last, Up on the top row, Down on the
 * bottom one — does nothing, and keeps the key from the page: on the first
 * tile, holding a face this build keeps with nothing checked, a Left that
 * chose would be that same silent reset. Otherwise Left and Right run on
 * across the rows, in reading order. A face's name is its label and its description the
 * hover, because thirty captions under thirty pictures would turn a
 * glance into a read.
 *
 * A face this build cannot draw — one a later build stored — checks no tile at
 * all. Default is not what you have, and checking it would make pressing it
 * look like nothing while erasing what is kept; with nothing checked, the
 * first tile holds the tab stop, whatever you choose is a visible choice, and
 * the note that says why is the group's description.
 */
const FacePicker = ({
  value,
  describedBy,
  onChange,
}: {
  /** Whatever the profile stores; anything but a shipped id or nothing checks no tile. */
  value: unknown
  /** The note that explains the group, while there is one. */
  describedBy?: string | undefined
  onChange: (next: AvatarId | null) => void
}) => {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const current = FACE_CHOICES.findIndex((choice) => choice.id === (value ?? null))
  const stop = current === -1 ? 0 : current
  const last = FACE_CHOICES.length - 1
  const step = (from: number, key: string): number | null => {
    switch (key) {
      case 'ArrowRight':
        return from + 1 <= last ? from + 1 : null
      case 'ArrowLeft':
        return from - 1 >= 0 ? from - 1 : null
      case 'ArrowDown':
        return from + FACE_COLUMNS <= last ? from + FACE_COLUMNS : null
      case 'ArrowUp':
        return from - FACE_COLUMNS >= 0 ? from - FACE_COLUMNS : null
      default:
        return null
    }
  }

  return (
    <Card spacing="compact" radius="lg">
      <div
        className={styles.faces}
        style={{ '--face-columns': FACE_COLUMNS } as CSSProperties}
        role="radiogroup"
        aria-label="Picture"
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
      >
        {FACE_CHOICES.map((choice, index) => {
        const on = index === current
        return (
          <Button
            key={choice.id ?? 'default'}
            ref={(node) => {
              buttons.current[index] = node
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={choice.label}
            title={`${choice.label} — ${choice.about}`}
            tabIndex={index === stop ? 0 : -1}
            variant="ghost" size="inline" className={styles.faceChoice}
            data-swatch
            {...(on ? { 'data-on': '' } : {})}
            onClick={() => onChange(choice.id)}
            onKeyDown={(event) => {
              if (!ARROWS.has(event.key)) return
              // The arrows are the group's even with nowhere to go: left to
              // the page, one would scroll it under the tile.
              event.preventDefault()
              const next = step(index, event.key)
              const target = next === null ? undefined : FACE_CHOICES[next]
              if (next === null || !target) return
              onChange(target.id)
              buttons.current[next]?.focus()
            }}
          >
            <Face avatar={choice.id} size={44} className={styles.faceTile} />
          </Button>
        )
        })}
      </div>
    </Card>
  )
}

/**
 * This copy of HarnessDesk.
 *
 * There is no HarnessDesk account, so this page does not pretend to one. What
 * it says instead is the thing someone opening it is really asking: where
 * their things are — on this Mac, in one folder, going nowhere — and how to
 * take them along. The backup and support rows are the settings window's,
 * passed in, so the page that owns the wire also owns the buttons.
 */
export const GeneralSection = ({ rows }: { rows: ReactNode }) => (
  <>
    <PageHead title="General" blurb="What this Mac’s HarnessDesk keeps, and how to take it with you." />

    <SectionHead name="Your data" />
    <Rows>
      <Row
        title="Everything stays on this Mac"
        desc="Everything lives in ~/.harnessdesk; nothing syncs or uploads."
        control={<RowValue>Local</RowValue>}
      />
      <Row
        title="Agent sign-ins belong to the agents"
        desc="Each credential stays with its own agent; HarnessDesk never keeps a copy."
      />
    </Rows>

    {rows}
  </>
)

/*
 * The accents, as the colours they are — read from styles/shadcn-themes.css,
 * whose `body[data-hd-accent=…]` blocks are the source. A swatch cannot read
 * them live: the token is switched on `body`, so a descendant sees only the
 * accent that is on. "Default" is the palette's own, drawn from the live
 * token when it is the one in use and from the palette's value otherwise.
 *
 * Each carries both faces, because the sheet does and because one of them is
 * unusable without it: Mono in the dark theme is #e5e5e5, and a swatch row
 * that showed its light value drew a near-black circle on a near-black page —
 * an option you could select and could not see. The other four are lighter in
 * the dark face for the same reason the sheet lifts them, so showing the
 * light value there was merely wrong rather than invisible.
 */
const ACCENTS = [
  { value: 'default', label: 'Default', colour: null, dark: null },
  { value: 'violet', label: 'Violet', colour: '#7c3aed', dark: '#8b5cf6' },
  { value: 'green', label: 'Green', colour: '#16a34a', dark: '#22c55e' },
  { value: 'rose', label: 'Rose', colour: '#e11d48', dark: '#f43f5e' },
  { value: 'orange', label: 'Orange', colour: '#ea580c', dark: '#f97316' },
  { value: 'mono', label: 'Mono', colour: '#171717', dark: '#e5e5e5' },
] as const

/* Each palette's own accent, in both faces — the answer the Default swatch
   shows while some other accent is the one that is on. Neutral's is #171717
   in the light face and #e5e5e5 in the dark, which is the same invisibility
   the Mono swatch had and for the same reason. */
const PALETTE_ACCENT: Readonly<Record<string, readonly [light: string, dark: string]>> = {
  harnessdesk: ['rgb(86, 118, 232)', 'rgb(86, 118, 232)'],
  editorial: ['#c96442', '#d97757'],
  shadcn: ['#171717', '#e5e5e5'],
}

/** The accent as a row of colours, one of them ringed. */
const AccentSwatches = () => {
  const store = useStore()
  const { accent, palette } = useSnapshot()
  const dark = useResolvedDark()
  return (
    <span className={styles.swatches} role="radiogroup" aria-label="Accent">
      {ACCENTS.map((entry) => (
        <Button
          key={entry.value}
          type="button"
          role="radio"
          aria-checked={accent === entry.value}
          aria-label={entry.label}
          title={entry.label}
          variant="ghost" size="icon-circle"
          {...(accent === entry.value ? { 'data-on': '' } : {})}
          swatch={
            (dark ? entry.dark : entry.colour) ??
            /* "Default" is the palette's own accent: the live token while it
               is the one in use, and the palette's recorded value otherwise
               — the token on `body` would report whichever accent is on. */
            (accent === 'default'
              ? 'var(--hd-accent)'
              : (PALETTE_ACCENT[palette]?.[dark ? 1 : 0] ?? 'var(--hd-accent)'))
          }
          onClick={() => store.setAccent(entry.value)}
        />
      ))}
    </span>
  )
}

/**
 * How the window looks — with the effect on the page, not in a sentence.
 *
 * The theme cards and the code sample come first because they are the
 * preview: every row under them changes something in them, so no row needs
 * a paragraph saying what it would do. The descriptions that are left are
 * the ones the second-line rule keeps — a consequence the label cannot carry.
 */
export const AppearanceSection = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  // Asked of the machine once: the answer cannot change while the page is
  // open, and `document.fonts.check` is a layout read.
  const faces = useMemo(() => installedFaces(), [])
  const current = snapshot.editorPrefs.fontFamily
  const faceOptions = [
    { value: '', label: 'Default' },
    ...faces.map((face) => ({ value: face.stack, label: face.name })),
    // A face chosen on another machine and missing on this one stays
    // selectable by name, rather than silently becoming "Default".
    ...(current.trim() !== '' && !faces.some((face) => face.stack === current)
      ? [{ value: current, label: current.split(',')[0]?.replace(/['"]/g, '').trim() ?? current }]
      : []),
  ]

  return (
    <>
      <PageHead title="Appearance" blurb="How HarnessDesk looks. Every change shows here as you make it." />

      <SectionHead name="Theme" />
      <ThemeCards />
      <Rows>
        <Row
          title="Interface"
          desc="Studio reads as a dashboard: filled selection, taller controls."
          control={
            <Segmented
              label="Interface"
              value={snapshot.look}
              options={[
                { value: 'desk', label: 'Desk' },
                { value: 'studio', label: 'Studio' },
              ]}
              onChange={(next) => store.setLook(next)}
            />
          }
        />
        <Row
          title="Palette"
          control={
            <Segmented
              label="Palette"
              value={snapshot.palette}
              options={[
                { value: 'harnessdesk', label: 'Blueprint' },
                { value: 'editorial', label: 'Editorial' },
                { value: 'shadcn', label: 'Neutral' },
              ]}
              onChange={(next) => store.setPalette(next)}
            />
          }
        />
        <Row
          title="Accent"
          /* Earned under the second-line rule: the accent used to be every
             filled control in the app and is now the marks that say where you
             are, so the label alone would over-promise. */
          desc="The selected row, a switch that is on, a focus ring, a link."
          control={<AccentSwatches />}
        />
        <Row
          title="Corners"
          control={
            <Segmented
              label="Corners"
              value={snapshot.corners}
              options={[
                { value: 'square', label: 'Square' },
                { value: 'default', label: 'Default' },
                { value: 'round', label: 'Round' },
              ]}
              onChange={(next) => store.setCorners(next)}
            />
          }
        />
      </Rows>

      <SectionHead name="Code" />
      <EditorSample />
      <Rows>
        <Row
          title="Font"
          desc={faces.length === 0 ? 'No coding fonts were found on this Mac.' : 'Only fonts installed on this Mac are listed.'}
          control={
            <NativeSelect
              aria-label="Code font"
              value={current}
              onChange={(event) => store.setEditorPrefs({ fontFamily: event.target.value })}
            >
              {faceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </NativeSelect>
          }
        />
        <Row
          title="Size"
          control={
            <Segmented
              label="Code text size"
              value={String(snapshot.editorPrefs.fontSize)}
              options={FONT_SIZES.map((size) => ({ value: String(size), label: `${size}` }))}
              onChange={(next) => store.setEditorPrefs({ fontSize: Number(next) })}
            />
          }
        />
        <Row
          title="Line numbers"
          control={
            <Switch
              aria-label="Line numbers"
              checked={snapshot.editorPrefs.lineNumbers}
              onCheckedChange={(lineNumbers) => store.setEditorPrefs({ lineNumbers })}
            />
          }
        />
        <Row
          title="Wrap long lines"
          control={
            <Switch
              aria-label="Wrap long lines"
              checked={snapshot.editorPrefs.wrap}
              onCheckedChange={(wrap) => store.setEditorPrefs({ wrap })}
            />
          }
        />
        <Row
          title="Indent"
          desc="Spaces per level."
          control={
            <Segmented
              label="Indent width"
              value={String(snapshot.editorPrefs.tabSize)}
              options={TAB_SIZES.map((size) => ({ value: String(size), label: `${size}` }))}
              onChange={(next) => store.setEditorPrefs({ tabSize: Number(next) })}
            />
          }
        />
      </Rows>

      <SectionHead name="Session list" />
      <Rows>
        <Row
          title="Density"
          control={
            <Segmented
              label="Density"
              value={snapshot.listPrefs.density}
              options={[
                { value: 'compact', label: 'Compact' },
                { value: 'comfortable', label: 'Comfortable' },
              ]}
              onChange={(density) => store.setListPrefs({ density, densityPicked: true })}
            />
          }
        />
        <Row
          title="Sort by"
          control={
            <Segmented
              label="Sort"
              value={snapshot.listPrefs.sort}
              options={[
                { value: 'recency', label: 'Recent' },
                { value: 'name', label: 'Name' },
              ]}
              onChange={(sort) => store.setListPrefs({ sort })}
            />
          }
        />
      </Rows>
    </>
  )
}

/**
 * What the app is allowed to interrupt you about.
 *
 * This page exists because a banner needed somewhere to be turned back on. A
 * message you can silence and never restore is worse than one that nags: the
 * app has quietly stopped telling you something and there is no way to find
 * out what. So every kind that can be silenced is listed here whether or not
 * it has ever been shown, in the same words the banner uses, with the switch
 * beside it and the way back always in the same place.
 *
 * Each kind's one control says *where* it is shown, with Off as the last
 * choice: a place is the question a person actually has ("why is this over my
 * conversation?"), and a switch could only answer half of it. The page opens
 * on the map from purpose to place, so the choices below read as choices.
 *
 * What is not on this page is as deliberate as what is. A dropped connection
 * has no row, because it is the one thing the app must always be able to say —
 * it is put away for the moment and comes back the next time it is true. And
 * nothing here hides a *state*: silencing "out of quota" stops the banner, not
 * the meter, not the agent's row, and not what happens when a session is
 * started against a spent plan.
 */
export const NotificationsSection = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const policy = snapshot.noticePolicy
  const now = Date.now()
  const silenced = NOTICE_KINDS.filter((entry) => policy.muted.includes(entry.kind))
  const inboxUnread = unreadCount(snapshot.inbox)

  return (
    <>
      <PageHead
        title="Notifications"
        blurb="Where HarnessDesk tells you things, and which ones."
        actions={
          silenced.length > 0 ? (
            <Button
              variant="outline"
              onClick={() => {
                for (const entry of silenced) store.setNoticeSurface(entry.kind, surfaceFor(emptyNoticePolicy(), entry.kind))
              }}
            >
              Turn all back on
            </Button>
          ) : undefined
        }
      />

      {/* The map before the switches: what each kind of message is for, and
          where that puts it. Read once, it explains every control below. */}
      <SectionHead name="How messages reach you" />
      <Rows>
        <Row title="Something stops a turn" desc="Shown on the composer of the conversation it stops, and nowhere else." />
        <Row title="Something to do later" desc="Waits at the foot of the sidebar, one at a time, until you act or dismiss it." />
        <Row title="Worth keeping" desc="Goes to the inbox in your seat menu and stays until you clear it." />
        <Row title="An Agent writes to you" desc="Kept in the inbox, or on its own conversation when it is waiting on your decision." />
        <Row title="The result of what you did" desc="A toast in the corner that leaves on its own. Always on." />
        <Row title="The connection drops" desc="Said in the window's header until it is back. Always on." />
      </Rows>

      {NOTICE_USES.map((use) => {
        const kinds = NOTICE_KINDS.filter((entry) => entry.use === use.use)
        if (kinds.length === 0) return null
        return (
          <section key={use.use}>
            <SectionHead name={use.title} />
            <Rows>
              {kinds.map((entry) => {
                const record = policy.records[entry.kind]
                const surface = surfaceFor(policy, entry.kind)
                return (
                  <Row
                    key={entry.kind}
                    title={entry.title}
                    desc={
                      <>
                        {entry.detail}
                        {/* The count is why the row is worth reading twice: it
                            is the evidence for turning something off, and
                            afterwards the only record that it ever spoke. */}
                        {record ? (
                          <>
                            {' '}
                            <Text role="meta">
                              Put away {record.count === 1 ? 'once' : `${record.count} times`}
                              {record.at > 0 ? `, last ${formatAge(record.at, now)}` : ''}.
                            </Text>
                          </>
                        ) : null}
                      </>
                    }
                    control={
                      <NativeSelect
                        aria-label={`Where "${entry.title}" is shown`}
                        value={surface ?? 'off'}
                        onChange={(event) =>
                          store.setNoticeSurface(entry.kind, event.target.value === 'off' ? null : (event.target.value as NoticeSurface))
                        }
                      >
                        {entry.surfaces.map((option) => (
                          <option key={option} value={option}>
                            {entry.labels?.[option] ?? SURFACE_LABEL[option]}
                          </option>
                        ))}
                        <option value="off">Off</option>
                      </NativeSelect>
                    }
                  />
                )
              })}
            </Rows>
          </section>
        )
      })}

      <SectionHead
        name="Inbox"
        action={
          snapshot.inbox.length > 0 ? (
            <Button variant="outline" size="sm" onClick={() => store.clearInbox()}>
              Clear
            </Button>
          ) : undefined
        }
      />
      {/* What was kept, the same list the seat menu folds out — so a message
          put away there can be found here, and the count is the list's own. */}
      <Rows>
        <Row
          title="Kept messages"
          desc={
            snapshot.inbox.length === 0
              ? 'Nothing kept.'
              : `${snapshot.inbox.length} kept${inboxUnread > 0 ? `, ${inboxUnread} unread` : ''}.`
          }
          control={<UnreadMark count={inboxUnread} />}
        />
      </Rows>
      {snapshot.inbox.length > 0 ? (
        <InboxList
          messages={snapshot.inbox.map((entry) => ({
            id: entry.id,
            tone: entry.tone,
            title: entry.from ? `${entry.from.name}: ${entry.title}` : entry.title,
            ...(entry.body ? { body: entry.body } : {}),
            at: entry.at,
            read: entry.read,
            ...(entry.task ? { action: { label: 'Start as a task', onSelect: () => void store.startSuggestedTask(entry.id) } } : {}),
          }))}
          onOpen={(id) => store.markInboxRead(id)}
          onMarkAllRead={() => store.markInboxRead(null)}
        />
      ) : null}

      <SectionHead name="On your Mac" />
      <Rows>
        <Row
          title="System notifications"
          desc="Through macOS, when the window is not in front."
          control={
            <Switch
              aria-label="System notifications"
              checked={snapshot.systemNotifications['enabled'] !== false}
              onCheckedChange={(next) => store.setSystemNotification('enabled', next)}
            />
          }
        />
        {snapshot.systemNotifications['enabled'] !== false &&
          SYSTEM_NOTIFICATION_KINDS.map((entry) => (
            <Row
              key={entry.kind}
              title={entry.title}
              desc={entry.detail}
              control={
                <Switch
                  aria-label={`Notify for ${entry.title}`}
                  checked={systemNotificationOn(snapshot.systemNotifications, entry.kind)}
                  onCheckedChange={(next) => store.setSystemNotification(entry.kind, next)}
                />
              }
            />
          ))}
      </Rows>
    </>
  )
}

/**
 * Read off the table rather than repeated here.
 *
 * The page promises "every key the window answers to", and a hard-coded list
 * quietly breaks that promise the first time a shortcut is filed under a new
 * group: the chord works, and the only place that documents it does not
 * mention it. Insertion order keeps the grouping the table already implies.
 */
const GROUPS: readonly Shortcut['group'][] = [...new Set(SHORTCUTS.map((s) => s.group))]

const ChordRow = ({ shortcut }: { shortcut: Shortcut }) => (
  <Row
    title={shortcut.label}
    control={<Keycap className={styles.chord}>{chordOf(shortcut)}</Keycap>}
  />
)

/**
 * Every key the window answers to, read from the same table the handler
 * dispatches from — so a chord printed here is a chord that works.
 */
export const ShortcutsSection = () => (
  <>
    <PageHead
      title="Keyboard shortcuts"
      blurb="What the window answers to. Keys inside a pane belong to whatever has focus."
    />
    {GROUPS.map((group) => {
      const rows = SHORTCUTS.filter((shortcut) => shortcut.group === group)
      if (rows.length === 0) return null
      return (
        <div key={group}>
          <SectionHead name={group} />
          <Rows>
            {rows.map((shortcut) => (
              <ChordRow key={shortcut.action} shortcut={shortcut} />
            ))}
          </Rows>
        </div>
      )
    })}

    <SectionHead name="In the composer" />
    <Rows>
      <Row title="Send" control={<Keycap className={styles.chord}>↵</Keycap>} />
      <Row title="New line" control={<Keycap className={styles.chord}>⇧↵</Keycap>} />
      <Row title="Commands" control={<Keycap className={styles.chord}>/</Keycap>} />
      <Row title="Mention a file" control={<Keycap className={styles.chord}>@</Keycap>} />
    </Rows>
  </>
)
