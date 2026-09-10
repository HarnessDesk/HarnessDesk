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
 * commented-out import is not an import (review of #183).
 */
export const stylesheetImports = (source) =>
  [...bareSource(source).matchAll(/import (\w+) from (['"])\.\/([\w-]+\.module\.css)\2/g)].map((match) => ({
    binding: match[1],
    file: match[3],
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
  const key = (name) => name.toLowerCase().replace(/[-_]/g, '')
  const names = [path.basename(file, '.tsx'), path.basename(path.dirname(file))]
  return names.some((name) => key(`${name}.module.css`) === key(sheet))
}
