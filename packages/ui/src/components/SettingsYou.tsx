import { useMemo, type ReactNode } from 'react'

import { useSnapshot, useStore } from '../state/context'
import { chordOf, SHORTCUTS, type Shortcut } from '../lib/shortcuts'
import { NOTICE_KINDS } from '../lib/notice-policy'
import { SYSTEM_NOTIFICATION_KINDS, systemNotificationOn } from '../lib/system-notifications'
import { FONT_SIZES, installedFaces, TAB_SIZES } from '../lib/editor-prefs'
import { formatAge } from '../lib/usage'
import { EditorSample, ThemeCards, useResolvedDark } from './AppearancePreview'
import {
  Btn,
  kit,
  PageHead,
  Row,
  Rows,
  SectionHead,
  Segmented,
  Select,
  Toggle,
} from '../design/primitives/Kit'
import styles from './SettingsYou.module.css'

/**
 * The four pages about the person rather than the agents.
 *
 * They sit at the top of the nav because that is the order a new window is
 * read in: who am I, what does this look like, what does it say to me, how do
 * I drive it — and only then, what can it do.
 */

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
        desc="Settings, registered agents and transcripts live in ~/.harnessdesk. Nothing syncs or uploads."
        control={<span className={kit.rowFixed}>Local</span>}
      />
      <Row
        title="Agent sign-ins belong to the agents"
        desc="Each credential stays with its own agent; HarnessDesk never keeps a copy."
      />
    </Rows>

    <SectionHead name="Pull requests" />
    <AttributionRows />

    {rows}
  </>
)

/**
 * The one line a pull request carries about where it came from. On by
 * default: a vendor's own client signs what its agent opens, and an agent
 * driven from here would otherwise sign as nothing, or as a client it is not
 * running in. The seat in brackets is read from the conversation — the agent,
 * its model by the agent's own label, its effort — so the switch is the only
 * thing here a person can set.
 */
const AttributionRows = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  return (
    <Rows>
      <Row
        title="Sign pull requests"
        desc="A pull request an agent opens from a conversation ends with “Generated with HarnessDesk”, naming the agent, model and effort that wrote it."
        control={
          <Toggle
            label="Sign pull requests"
            on={snapshot.attribution.pullRequests}
            onChange={(next) => store.setAttribution({ pullRequests: next })}
          />
        }
      />
    </Rows>
  )
}

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
        <button
          key={entry.value}
          type="button"
          role="radio"
          aria-checked={accent === entry.value}
          aria-label={entry.label}
          title={entry.label}
          className={styles.swatch}
          {...(accent === entry.value ? { 'data-on': '' } : {})}
          style={{
            background:
              (dark ? entry.dark : entry.colour) ??
              /* "Default" is the palette's own accent: the live token while it
                 is the one in use, and the palette's recorded value otherwise
                 — the token on `body` would report whichever accent is on. */
              (accent === 'default'
                ? 'var(--hd-accent)'
                : (PALETTE_ACCENT[palette]?.[dark ? 1 : 0] ?? 'var(--hd-accent)')),
          }}
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
          desc="The row you are on, a switch that is on, a focus ring, a link. Buttons are ink in every accent."
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
            <Select
              label="Code font"
              value={current}
              options={faceOptions}
              onChange={(next) => store.setEditorPrefs({ fontFamily: next })}
            />
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
            <Toggle
              label="Line numbers"
              on={snapshot.editorPrefs.lineNumbers}
              onChange={(lineNumbers) => store.setEditorPrefs({ lineNumbers })}
            />
          }
        />
        <Row
          title="Wrap long lines"
          control={
            <Toggle
              label="Wrap long lines"
              on={snapshot.editorPrefs.wrap}
              onChange={(wrap) => store.setEditorPrefs({ wrap })}
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
 * The switch reads *shown*, not *silenced*. A row titled with the message and
 * a switch that is on when the message is off would take a second read every
 * time, and settings are read quickly or not at all.
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

  return (
    <>
      <PageHead
        title="Notifications"
        blurb="What HarnessDesk tells you outside a conversation."
        actions={
          silenced.length > 0 ? (
            <Btn
              variant="outline"
              onClick={() => {
                for (const entry of silenced) store.setNoticeMuted(entry.kind, false)
              }}
            >
              Turn all back on
            </Btn>
          ) : undefined
        }
      />

      <SectionHead name="On your Mac" />
      <Rows>
        <Row
          title="System notifications"
          desc="Through macOS, when the window is not in front."
          control={
            <Toggle
              label="System notifications"
              on={snapshot.systemNotifications['enabled'] !== false}
              onChange={(next) => store.setSystemNotification('enabled', next)}
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
                <Toggle
                  label={`Notify for ${entry.title}`}
                  on={systemNotificationOn(snapshot.systemNotifications, entry.kind)}
                  onChange={(next) => store.setSystemNotification(entry.kind, next)}
                />
              }
            />
          ))}
      </Rows>

      <SectionHead name="In the app" />
      <Rows>
        {NOTICE_KINDS.map((entry) => {
          const record = policy.records[entry.kind]
          const muted = policy.muted.includes(entry.kind)
          return (
            <Row
              key={entry.kind}
              title={entry.title}
              desc={
                <>
                  {entry.detail}
                  {/* The count is why the row is worth reading twice: it is
                      the evidence for turning something off, and afterwards
                      the only record that it ever spoke. */}
                  {record ? (
                    <>
                      {' '}
                      <span className={styles.putAway}>
                        Put away {record.count === 1 ? 'once' : `${record.count} times`}
                        {record.at > 0 ? `, last ${formatAge(record.at, now)}` : ''}.
                      </span>
                    </>
                  ) : null}
                </>
              }
              control={
                <Toggle
                  label={`Show "${entry.title}"`}
                  on={!muted}
                  onChange={(next) => store.setNoticeMuted(entry.kind, !next)}
                />
              }
            />
          )
        })}
      </Rows>

      <p className={styles.pageNote}>
        A lost connection is not on this list: it is the one message the app must always make.
      </p>
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
    control={<kbd className={styles.chord}>{chordOf(shortcut)}</kbd>}
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
      <Row title="Send" control={<kbd className={styles.chord}>↵</kbd>} />
      <Row title="New line" control={<kbd className={styles.chord}>⇧↵</kbd>} />
      <Row title="Commands" control={<kbd className={styles.chord}>/</kbd>} />
      <Row title="Mention a file" control={<kbd className={styles.chord}>@</kbd>} />
    </Rows>
  </>
)
