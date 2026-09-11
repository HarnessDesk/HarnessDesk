import path from 'node:path'

/**
 * Source with its comments taken out: block comments, and lines that are only
 * a line comment.
 *
 * The rules the design audit enforces are explained in comments in the very
 * files they govern — `Dialog.tsx`'s own doc comment says `aria-modal`, and a
 * note reading "do not hand-roll an overlay" contains every word the check
 * looks for. A check that fires on the prose describing it teaches people to
 * delete the prose.
 */
export const bareSource = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .split('\n')
    .map(withoutTrailingComment)
    .join('\n')

/**
 * A line without the comment that follows its code: a `//` after whitespace,
 * outside any quote on the line. `x = 1 // styles.gone` counted as a use of
 * `gone` (review of #183, round 4). A URL stays, whether quoted,
 * `'https://…'`, or after a colon, `http://`.
 */
function withoutTrailingComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '/' && line[i + 1] === '/' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

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
 * not read either (round 2). An import from another folder is read too, by its
 * path: one by `../` went unread, so a screen could borrow another's stylesheet
 * without being counted (round 3). So is one through the UI's `@/` alias
 * (round 4), which `resolveStylesheet` turns into a relative path.
 */
export const stylesheetImports = (source) =>
  [...bareSource(source).matchAll(/^\s*import\s+(\w+)\s+from\s+(['"])((?:\.{1,2}|@)\/[\w./-]*\.module\.css)\2/gm)].map((match) => ({
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
