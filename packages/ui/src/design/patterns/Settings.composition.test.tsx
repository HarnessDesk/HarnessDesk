import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Row, Rows } from './Settings'
import styles from './Settings.module.css'
import sheet from './Settings.module.css?raw'
it('keeps ordinary row cards after decision details move into transcript prose', () => {
  const box = document.createElement('div'); box.innerHTML = renderToStaticMarkup(<Rows><Row title="Setting" /></Rows>)
  expect(box.firstElementChild?.className).toBe(styles.rows)
  expect(box.firstElementChild?.getAttribute('data-slot')).toBe('rows')
  expect(sheet).not.toContain("data-variant='inset'")
})
