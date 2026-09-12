import path from 'node:path'

import { withoutComments } from './without-comments.mjs'

/**
 * A component's CSS-module imports from its own directory, as
 * `import styles from './x.module.css'`, in either quote.
 *
 * The name is any file name a stylesheet has. A pattern of letters alone
 * skipped `panel-playground.module.css` and six more with a hyphen in them, so
 * the design audit never read them, and four classes that one does not define
 * went unreported (#91, #80). The source is read without its comments: a
 * commented-out import is not an import (review of #183). And an import is a
 * statement at the start of a line, so one quoted in a trailing comment is
 * not read either (round 2). Comments are found by the compiler's own parser,
 * shared with the layering gate; the line-at-a-time scan this used to carry
 * cut a `//` inside a multi-line template literal as though it opened one, and
 * a glob in a string opened a block comment (#229). `fileName` is what tells
 * the parser whether `<T>(x: T) => x` is a generic or a tag, so pass the real
 * one. An import from another folder is read too, by its path: one by `../`
 * went unread, so a screen could borrow another's stylesheet without being
 * counted (round 3). So is one through the UI's `@/` alias (round 4), which
 * `resolveStylesheet` turns into a relative path.
 */
export const stylesheetImports = (source, fileName = 'source.tsx', options = {}) =>
  [...withoutComments(source, fileName, options).matchAll(/^\s*import\s+(\w+)\s+from\s+(['"])((?:\.{1,2}|@)\/[\w./-]*\.module\.css)\2/gm)].map((match) => ({
    binding: match[1],
    // Relative to the importing file, and one in its own folder by its name alone.
    file: match[3].replace(/^\.\//, ''),
  }))

/**
 * Whether `sheet` is the stylesheet of the component in `file`: the one named
 * after the component, or after the folder it lives in.
 *
 * Compared without case, hyphens or underscores (review of #183), because a
 * component's stylesheet is spelled more than one way here: `Composer.tsx` beside `Composer.module.css`, and
 * `PanelPlayground.tsx` beside `panel-playground.module.css`. Compared as
 * written, the second reads as one screen borrowing another's stylesheet.
 * Before #91 those imports weren't read at all; read by name alone, the seven
 * showcase boards would have been counted as component libraries. `sheet` is
 * the import's path relative to `file`, so a stylesheet in another folder,
 * `../x/Name.module.css`, never matches, whatever it's called.
 */
export const ownsStylesheet = (file, sheet) => {
  const key = (name) => name.toLowerCase().replace(/[-_]/g, '')
  const names = [path.basename(file, '.tsx'), path.basename(path.dirname(file))]
  return names.some((name) => key(`${name}.module.css`) === key(sheet))
}

/**
 * An import's path relative to the importing file's folder, with the UI's
 * `@/` alias resolved against its source root first (review of #183, round
 * 4). A relative path comes back normalised, so `parts/../x.module.css` is
 * `x.module.css` and "another folder never matches" in `ownsStylesheet` holds
 * however the path is spelled (review of #183, round 5).
 */
export const resolveStylesheet = (dir, spec, uiSrc) =>
  spec.startsWith('@/') ? path.relative(dir, path.join(uiSrc, spec.slice(2))) : path.normalize(spec)
