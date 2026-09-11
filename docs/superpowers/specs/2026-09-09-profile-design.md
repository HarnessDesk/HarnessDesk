# Your profile: a name and a face

*2026-09-09. Design for the "you" half of the seat, and for the page that sets
it. Builds on `2026-09-09-identity-seat-design.md`, whose "Later" section this
fills in for a desk with no account.*

## What was missing

The seat already said the right thing about who you are — the desk, not an
agent's account — but it said it the same way for everybody: the house mark
and the word "HarnessDesk". There was nowhere to put your own name or face,
and the identity-seat design had already decided where they would go: "when a
HarnessDesk account exists, its picture and name take this slot and nothing
else on the row changes." Twenty-four avatars had been drawn for exactly this
(`assets/avatars`, "these identify *somebody using it*"), and nothing used
them.

## Principles

1. **A name and a face, because that is what is shown.** No bio, no email, no
   status: nothing on screen would read them. A later field earns its place
   by a surface that draws it.
2. **Local, and honest about it.** There is no HarnessDesk account. The page
   does not offer a sign-in that goes nowhere; it says "Kept on this Mac" and
   the seat's menu keeps its Local tag.
3. **One reader, so an account is a one-place change.** Every surface reads
   `profileName(snapshot.profile)` and `ProfileFace`, never the fields. When
   an account exists it supplies the same `Profile`, and the seat, its menu,
   the settings rail and the rooms follow at once.
4. **The default is the product, and it is always one step away.** `{}` is
   "HarnessDesk" and the house mark. Only what differs is stored, so Reset is
   shown exactly when there is something to reset.
5. **You are not an agent.** An agent's account stays a pen with a nickname
   and a ring (`lib/accounts.ts`, whose rule — no uploaded pictures on agent
   marks — is untouched). The face belongs to the person.

## The model

`packages/ui/src/lib/profile.ts`:

```ts
interface Profile {
  readonly name?: string
  readonly avatar?: unknown                           // an id this build ships, or whatever a later build stored
  readonly later?: Readonly<Record<string, unknown>> // every other stored field, written back as it was
}
```

- A patch uses `null` to put a field back; `{ name: null, avatar: null }` is
  Reset.
- Names are tidied on the way in — trimmed, runs of spaces folded, capped at
  40 characters as a person counts them — grapheme clusters, so a flag is one
  and none is cut in half — and a name
  equal to "HarnessDesk" is dropped, not stored.
- A stored profile is read defensively and forward: a hand edit this build
  cannot read is the default rather than a broken seat, and whatever a later
  build stored — a face this build does not ship, a picture, a field an
  account brings — is kept and written back whole. Only drawing falls back, to
  the house mark. (Review of #137: a whitelist read under a whole write lost a
  newer build's face on the next name edit.)
- The store writes the *whole* profile on every change
  (`app/state/set { patch: { profile } }`), because the host merges
  preferences one level deep — a name sent alone would replace the profile
  and forget the face.

`packages/ui/src/lib/avatars.ts` is the catalogue: id, label and a line about
each face, in the order they were drawn. The files are listed by the bundler
(`import.meta.glob` over `assets/avatars/128`), not copied into the package,
so `pnpm run avatars` stays the only thing that writes them; a test holds the
hand-written table to the folder.

**`black` is not on offer.** It is the mark with no colour and no outline, so
on a dark surface only its circuit traces come back — a face you could pick
in the light theme and lose in the dark. The default already is that drawing,
on `currentColor`, which follows the theme where a PNG cannot.

**An id is what syncs.** A short string that draws the same face on every
machine, because every copy of the app ships the same twenty-three.

## The surfaces

| Surface | What it shows |
| --- | --- |
| The seat (sidebar footer) | `ProfileFace` 24px + your name, then the default agent's badge as before |
| The seat's menu, top row | `ProfileFace` 30px + your name + Local; now a button that opens Settings › Profile |
| The settings rail | Your face and name first, above every group; selected on the Profile page; found by search for "picture", "name", "avatar" or your own name |
| Settings › Profile | The page (below) |
| A room's message rows | Your face in the sender tile, instead of the initial "Y"; the header still says "You" |
| ⌘K | "Profile" among the settings pages |

Deliberately **not** changed: the sidebar's header mark and the window title
(they name the product, and the avatars README is explicit that the product's
mark lives in `assets/brand`), and the conversation transcript, where your
own messages are bubbles with no avatar, as in Codex and Claude.

### The face

`Face` (in `design/primitives/Kit.tsx` — Kit's avatar, squared) is one squared tile
wherever a person is drawn, so the footprint never changes when the face
does. Squared because the avatars were drawn as squared tiles and a room
draws every sender in one; the corner is a step of the radius scale per size
(6px up to 32px, 10px up to 48px — the page's head is 44 — and 14px beyond) so one object does not
look sharper the larger it is drawn. The plate is the one the seat's disc
always wore: the platform module fill inside `--hd-hairline`. Without a
`size`, the tile fills the box it is put in and takes that box's corner —
which is how a room row's own tile holds it.

### Settings › Profile

- **Head**: your face at 44px, the size an account's detail page draws its mark, your name as you type it, one line on where it
  appears and that it stays on this Mac, and **Reset to default** while there
  is anything to reset.
- **Name**: a field whose placeholder is "HarnessDesk". It keeps its own text
  until it is let go — Enter, a click elsewhere, or the page closing — because
  tidying under the caret would eat the space between two words as they are
  typed (the account nickname field makes the same choice). The first Escape
  takes an edit back; the next one is the window's.
- **Picture**: Default and the twenty-three faces as one radio group, eight to
  a row — three even rows. One tab stop, the arrow keys walk the grid and
  choose as they go. Home and End are left out on purpose: in a group that
  chooses as it moves, a stray Home would be a silent reset. A face's name is its label
  and its line from the catalogue is the hover: twenty-four captions would
  turn a glance into a read. A face this build cannot draw — one a later build
  stored — checks no tile at all, and a note under the grid says it is kept
  until another is chosen.

## Later

- **An account.** It supplies `Profile` and the page gains a sign-in in its
  head; the rail row and the seat need nothing new. The Local tag becomes the
  plan or the tenant.
- **A picture of your own.** Not in this change, and deliberately: the
  preferences file is the wrong place for an image (a data URL is written on
  every preference change), and with an account it wants an upload endpoint.
  `avatar` already keeps whatever a build stores, so the build that adds a
  picture gives `Face` the one branch that draws it and nothing is lost on the
  way.

## Tests

- `lib/profile.test.ts` — default name, tidying, empty and default names not
  stored, the character-safe cap, patches keeping unmentioned fields, reading
  unreadable files as the default.
- `lib/avatars.test.ts` — the table equals the folder minus `black`; every
  offered face resolves to its file; ids recognised only when shipped.
- `state/store.profile.test.ts` — whole-profile writes; no write for no
  change; Reset writes `{}`; the profile comes back through `loadPreferences`.
- `components/SettingsYou.profile.test.tsx` — the head previews typing; the
  store hears a name only when let go; Enter, Escape, emptying, and closing
  mid-edit; picking and arrow-walking faces; Reset.
- `components/Sidebar.account.test.tsx` — the seat reads your name and wears
  your face beside the unchanged agent badge; the menu's top row opens
  Settings › Profile.
- `components/Settings.route.test.tsx` — the rail starts with you and routes
  to the page; search keeps you only while it could mean you.
- `design/patterns/ChannelMessage.test.tsx`, `components/Channel.test.tsx` —
  a caller's face replaces the initials and the tint; your room messages wear
  your face, or the house mark.
