import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Row, Rows } from './Settings'
import styles from './Settings.module.css'
import sheet from './Settings.module.css?raw'

const render = (node: React.ReactNode) => {
  const box = document.createElement('div'); box.innerHTML = renderToStaticMarkup(node); return box
}
it('opts into inset row groups while preserving ordinary row cards', () => {
  const normal = render(<Rows><Row title="Setting" /></Rows>).firstElementChild!
  const inset = render(<Rows variant="inset"><Row title="Setting" /></Rows>).firstElementChild!
  expect(normal.className).toBe(styles.rows)
  expect(normal.hasAttribute('data-variant')).toBe(false)
  expect(inset.className).toBe(normal.className)
  expect(inset.getAttribute('data-variant')).toBe('inset')
  expect(sheet).toMatch(/\.rows\[data-variant='inset'\]\s*\{[^}]*border: none;[^}]*border-radius: 0;[^}]*background: transparent;[^}]*margin-bottom: 0/s)
})
