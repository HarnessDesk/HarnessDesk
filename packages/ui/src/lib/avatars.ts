/**
 * The faces a person can wear on this desk.
 *
 * Twenty-three of the twenty-four whales in `assets/avatars` — the house mark's
 * family, drawn as stickers (that folder's README says how and why). They
 * identify *somebody using* HarnessDesk. The mark itself identifies the
 * product and stays where the product is named: the app icon, the menu bar,
 * the top of the sidebar.
 *
 * `black` is the one left out, on purpose. It is the mark with no colour and
 * no outline, so on a dark surface only its circuit traces come back — a face
 * you could pick in the light theme and lose in the dark one. And the face
 * nobody has chosen is already that drawing: the default is the mark itself,
 * on `currentColor`, which follows the theme where a PNG cannot.
 *
 * The order is the order they were drawn in — the mark in two colours, then
 * the ones wearing a job — and it is the order the picker reads in.
 *
 * An id is what gets stored, and it is what a HarnessDesk account would sync:
 * a short string that draws the same face on every machine, because every
 * copy of the app ships the same twenty-three.
 */
export const AVATARS = [
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

export type AvatarId = (typeof AVATARS)[number]['id']

/**
 * Where each face is, as the bundler hands it out.
 *
 * Read from the folder rather than listed: `pnpm run avatars` rewrites these
 * files, and a list of paths here would be a second copy of the folder that
 * nothing keeps honest. The table above is hand-written because its words
 * are, and `avatars.test.ts` holds the two to each other.
 *
 * 128px — the README's working size — for every place a face is drawn. It
 * covers the largest one (44px, the profile page's head and the picker's tiles) at nearly 3x and the
 * seat's 24px at better than 3x, and one file per face means the seat, the
 * menu and the picker share a single download. `black` is kept out of the
 * build as well as out of the table: a file nothing can draw is only weight.
 */
const FILES = import.meta.glob<string>(
  ['../../../../assets/avatars/128/*.png', '!../../../../assets/avatars/128/black.png'],
  { eager: true, query: '?url', import: 'default' },
)

const FOLDER = '../../../../assets/avatars/128/'

const IDS: ReadonlySet<string> = new Set(AVATARS.map((entry) => entry.id))

/** Whether a stored value names a face this build ships. */
export const isAvatarId = (value: unknown): value is AvatarId =>
  typeof value === 'string' && IDS.has(value)

/**
 * The face's picture, for whatever the profile stores. Null for anything this
 * build does not ship — a later build's face, a picture it keeps, an id the
 * folder has lost — and a caller answers null with the house mark, never a
 * broken image.
 */
export const avatarSrc = (id: unknown): string | null =>
  isAvatarId(id) ? (FILES[`${FOLDER}${id}.png`] ?? null) : null

/**
 * The faces the bundle carries, by id: what the glob above actually kept.
 * The test holds it to the table, which is how the `black` exclusion is
 * checked rather than trusted.
 */
export const SHIPPED_FACES: readonly string[] = Object.keys(FILES)
  .map((file) => file.slice(FOLDER.length, -'.png'.length))
  .sort()

/** The catalogue entry, for the words that go with a face. */
export const avatarOf = (id: AvatarId): (typeof AVATARS)[number] | undefined =>
  AVATARS.find((entry) => entry.id === id)
