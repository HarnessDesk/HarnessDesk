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
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

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
 * without being counted (round 3).
 */
export const stylesheetImports = (source) =>
  [...bareSource(source).matchAll(/^\s*import\s+(\w+)\s+from\s+(['"])(\.{1,2}\/[\w./-]*\.module\.css)\2/gm)].map((match) => ({
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
 * written, the second read as one screen borrowing another's stylesheet, and
 * seven showcase boards were counted as component libraries (#91).
 */
export const ownsStylesheet = (file, sheet) => {
  // A stylesheet in another folder is another screen's, whatever it's called (review of #183, round 3).
  if (path.dirname(sheet) !== '.') return false
  const key = (name) => name.toLowerCase().replace(/[-_]/g, '')
  const names = [path.basename(file, '.tsx'), path.basename(path.dirname(file))]
  return names.some((name) => key(`${name}.module.css`) === key(sheet))
}
