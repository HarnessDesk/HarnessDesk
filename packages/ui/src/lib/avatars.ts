/**
 * The faces a person can wear on this desk.
 *
 * Two families, and the order is the order the picker reads in.
 *
 * First the house mark in a few colourways (`assets/brand/faces`, rendered by
 * `pnpm run icons`). The mark identifies *the product*, so wearing it is a
 * deliberate thing to be able to do rather than the only thing: it is the app's
 * own icon, in your colour, on your seat and on the Dock.
 *
 * Then twenty-three of the twenty-four whales in `assets/avatars` — the mark's
 * family, drawn as stickers (that folder's README says how and why). They
 * identify *somebody using* HarnessDesk.
 *
 * `black` is the one left out, on purpose. It is the mark with no colour and
 * no outline, so on a dark surface only its circuit traces come back — a face
 * you could pick in the light theme and lose in the dark one. Every face here
 * survives both surfaces: the plated ones carry their own background, and the
 * one without a plate is blue, the ink that holds on either. The face
 * nobody has chosen is a drawing of its own: the default is the mark on
 * `currentColor`, which follows the theme where a PNG cannot.
 *
 * An id is what gets stored, and it is what a HarnessDesk account would sync:
 * a short string that draws the same face on every machine, because every
 * copy of the app ships the same twenty-nine. The desktop shell keeps its own
 * copy of the list, because it puts the same face on the Dock and an IPC value
 * must never become a path (`packages/desktop/electron/dock-icon.mjs`); its
 * test holds that copy to this table.
 */
const MARKS = [
  { id: 'mark-paper', label: 'Paper', about: 'The mark in black, on white' },
  { id: 'mark-ink', label: 'Ink', about: 'The mark in white, on near-black' },
  { id: 'mark-steel', label: 'Steel', about: 'The mark in silver, on near-black' },
  { id: 'mark-blueprint', label: 'Blueprint', about: 'The mark in white, on Blueprint’s blue' },
  { id: 'mark-blueline', label: 'Blueline', about: 'The mark in Blueprint’s blue, on white' },
  { id: 'mark-plain', label: 'Plain', about: 'The mark on its own, with no plate at all' },
] as const

/** The stickers: the order they were drawn in, the mark in two colours first. */
const WHALES = [
  { id: 'blue', label: 'Blue', about: 'The mark in Blueprint’s blue' },
  { id: 'violet', label: 'Violet', about: 'The mark in violet' },
  { id: 'reviewer', label: 'Reviewer', about: 'Glasses, and the check it just signed off' },
  { id: 'guardian', label: 'Guardian', about: 'A shield with a lock in it' },
  { id: 'builder', label: 'Builder', about: 'Hard hat, wrench, and a spark' },
  { id: 'scout', label: 'Scout', about: 'A magnifier over the eye' },
  { id: 'lead', label: 'Lead', about: 'A crown, and the little graph it is directing' },
  { id: 'astronaut', label: 'Astronaut', about: 'Helmet, visor, orbit badge' },
  { id: 'ninja', label: 'Ninja', about: 'Red headband and shuriken' },
  { id: 'sprout', label: 'Sprout', about: 'Leaves growing out of the circuit brain' },
  { id: 'party', label: 'Party', about: 'Hat, confetti, and a star' },
  { id: 'wizard', label: 'Wizard', about: 'Starred hat and a star-tipped wand' },
  { id: 'samurai', label: 'Samurai', about: 'Gold kabuto crest, red scarf, katana' },
  { id: 'winter', label: 'Winter', about: 'Knit beanie, scarf, and falling snow' },
  { id: 'dj', label: 'DJ', about: 'Headphones, and the notes coming out of them' },
  { id: 'chef', label: 'Chef', about: 'Toque, spatula, and a neckerchief' },
  { id: 'scientist', label: 'Scientist', about: 'Goggles, lab coat, and a flask that is doing something' },
  { id: 'pilot', label: 'Pilot', about: 'Leather cap, goggles, a scarf, and the clouds behind it' },
  { id: 'shinobi', label: 'Shinobi', about: 'The other ninja: purple headband, and moving' },
  { id: 'cowboy', label: 'Cowboy', about: 'Hat with a star, bandana, and a lasso' },
  { id: 'alien', label: 'Alien', about: 'Antennae, and a ringed planet' },
  { id: 'knight', label: 'Knight', about: 'Visored helm and a blue shield' },
  { id: 'beach', label: 'Beach', about: 'Sunglasses, hibiscus, and a palm tree' },
] as const

/** Both families, in picker order. */
export const AVATARS = [...MARKS, ...WHALES] as const

export type AvatarId = (typeof AVATARS)[number]['id']

/**
 * Where each face is, as the bundler hands it out.
 *
 * Read from the folders rather than listed: `pnpm run avatars` and `pnpm run
 * icons` rewrite these files, and a list of paths here would be a second copy
 * of a folder that nothing keeps honest. The tables above are hand-written
 * because their words are, and `avatars.test.ts` holds the two to each other.
 *
 * 128px — the avatars README's working size — for every place a face is drawn.
 * It covers the largest one (44px, the profile page's head and the picker's
 * tiles) at nearly 3x and the seat's 24px at better than 3x, and one file per
 * face means the seat, the menu and the picker share a single download.
 * `black` is kept out of the build as well as out of the table: a file nothing
 * can draw is only weight.
 */
const MARK_FILES = import.meta.glob<string>('../../../../assets/brand/faces/128/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
})

const FILES = import.meta.glob<string>(
  ['../../../../assets/avatars/128/*.png', '!../../../../assets/avatars/128/black.png'],
  { eager: true, query: '?url', import: 'default' },
)

const MARK_FOLDER = '../../../../assets/brand/faces/128/'

const FOLDER = '../../../../assets/avatars/128/'

const IDS: ReadonlySet<string> = new Set(AVATARS.map((entry) => entry.id))

const MARK_IDS: ReadonlySet<string> = new Set(MARKS.map((entry) => entry.id))

/** Whether a stored value names a face this build ships. */
export const isAvatarId = (value: unknown): value is AvatarId =>
  typeof value === 'string' && IDS.has(value)

/**
 * The face's picture, for whatever the profile stores. Null for anything this
 * build does not ship — a later build's face, a picture it keeps, an id the
 * folder has lost — and a caller answers null with the house mark, never a
 * broken image.
 */
export const avatarSrc = (id: unknown): string | null => {
  if (!isAvatarId(id)) return null
  return (MARK_IDS.has(id) ? MARK_FILES[`${MARK_FOLDER}${id}.png`] : FILES[`${FOLDER}${id}.png`]) ?? null
}

/** The names in one folder, as the glob kept them. */
const named = (files: Readonly<Record<string, string>>, folder: string): readonly string[] =>
  Object.keys(files).map((file) => file.slice(folder.length, -'.png'.length))

/**
 * The faces the bundle carries, by id: what the globs above actually kept.
 * The test holds it to the tables, which is how the `black` exclusion is
 * checked rather than trusted.
 */
export const SHIPPED_FACES: readonly string[] = [...named(MARK_FILES, MARK_FOLDER), ...named(FILES, FOLDER)].sort()

/** The catalogue entry, for the words that go with a face. */
export const avatarOf = (id: AvatarId): (typeof AVATARS)[number] | undefined =>
  AVATARS.find((entry) => entry.id === id)
