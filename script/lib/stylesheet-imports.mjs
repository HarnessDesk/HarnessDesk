import path from 'node:path'

/**
 * A component's CSS-module imports from its own directory, as
 * `import styles from './x.module.css'`.
 *
 * The name is any file name a stylesheet has. A pattern of letters alone
 * skipped `panel-playground.module.css` and six more with a hyphen in them, so
 * the design audit never read them, and four classes that one does not define
 * went unreported (#91, #80).
 */
export const stylesheetImports = (source) =>
  [...source.matchAll(/import (\w+) from '\.\/([\w-]+\.module\.css)'/g)].map((match) => ({
    binding: match[1],
    file: match[2],
  }))

/**
 * Whether `sheet` is the stylesheet of the component in `file`: the one named
 * after the component, or after the folder it lives in.
 *
 * Compared without case or hyphens, because a component's stylesheet is spelled
 * either way here: `Composer.tsx` beside `Composer.module.css`, and
 * `PanelPlayground.tsx` beside `panel-playground.module.css`. Compared as
 * written, the second read as one screen borrowing another's stylesheet, and
 * seven showcase boards were counted as component libraries (#91).
 */
export const ownsStylesheet = (file, sheet) => {
  const key = (name) => name.toLowerCase().replaceAll('-', '')
  const names = [path.basename(file, '.tsx'), path.basename(path.dirname(file))]
  return names.some((name) => key(`${name}.module.css`) === key(sheet))
}
