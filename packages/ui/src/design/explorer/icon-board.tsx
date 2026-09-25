import { BrandMark } from '../../components/BrandIcons'
import { BRANDS } from '../../lib/brands'
import * as Icons from '../../components/Icons'
import styles from './explorer.module.css'

/**
 * Every glyph the app has, on one page.
 *
 * The IconTile board next to this one shows the *tile* — its tone, tint, size
 * and shape — using two or three sample glyphs, which is the right way to
 * judge a container and no way at all to judge a set. Until this board there
 * were eleven icons anywhere in the catalogue against a hundred and forty-eight
 * in `components/Icons.tsx`, so "look at the icons" was not a thing the design
 * page could be asked to do, and any judgement about the set as a whole — is it
 * one weight, does it have three different arrows, is there a duplicate — had
 * to be made by reading the source.
 *
 * Enumerated from the module rather than listed here. A hand-written list is a
 * second place to remember, and it would be wrong the first time somebody adds
 * a glyph; `import * as` means the board cannot fall behind the set it is
 * showing. That is also why the count is printed: it is read off the same
 * import, so it cannot disagree with what is drawn below it.
 *
 * Brand marks are kept apart on purpose. They are not ours to restyle — an
 * agent's mark belongs to that agent — so a change that sweeps the icon set
 * must not sweep these, and having them in the same grid is how that mistake
 * gets made. They are enumerated from `BRANDS`, not from the module's
 * exports: a brand mark is one component told *which* brand, so its exports
 * are five parameterised components rather than the marks themselves, and
 * rendering one bare — with no brand — throws.
 */

const isComponent = (value: unknown): value is React.ComponentType<{ className?: string }> =>
  typeof value === 'function'

const entries = (module: Record<string, unknown>) =>
  Object.entries(module)
    .filter((entry): entry is [string, React.ComponentType<{ className?: string }>] =>
      isComponent(entry[1]))
    .sort(([a], [b]) => a.localeCompare(b))

const Grid = ({ of }: { of: readonly [string, React.ComponentType<{ className?: string }>][] }) => (
  <div className={styles.iconGrid}>
    {of.map(([name, Glyph]) => (
      <div key={name} className={styles.iconCell} title={name}>
        <Glyph />
        <span className={styles.iconName}>{name.replace(/Icon$/, '')}</span>
      </div>
    ))}
  </div>
)

export const IconBoard = () => {
  const icons = entries(Icons as unknown as Record<string, unknown>)

  return (
    <>
      <p className={styles.boardAbout}>
        {icons.length} icons. One weight, one size at the source; a screen that wants
        another size says so where it uses it.
      </p>
      <Grid of={icons} />
      <p className={styles.boardAbout}>
        {BRANDS.length} brand marks — not ours to restyle, and deliberately not in the
        grid above.
      </p>
      <div className={styles.iconGrid}>
        {BRANDS.map((brand) => (
          <div key={brand} className={styles.iconCell} title={brand}>
            <BrandMark brand={brand} />
            <span className={styles.iconName}>{brand}</span>
          </div>
        ))}
      </div>
    </>
  )
}
