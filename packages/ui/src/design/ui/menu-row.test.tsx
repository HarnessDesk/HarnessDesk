import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { MenuPresentation, MenuRowContent, MenuListboxOption, menuRowAttributes } from './menu-row'
import { CopyIcon } from '../../components/Icons'

test('a whole level suppresses optional leading icons', () => {
  const html = renderToStaticMarkup(<MenuPresentation icons="none"><MenuRowContent label="Open" icon={<CopyIcon size={16} />} /><MenuRowContent label="Keep" /></MenuPresentation>)
  expect(html).not.toContain('data-menu-icon')
  expect(html).not.toContain('<svg')
})
test('an icon level renders the icon slot and one trailing slot', () => {
  const html = renderToStaticMarkup(<MenuPresentation icons="all"><MenuRowContent label="Open" icon={<CopyIcon size={16} />} trailing="⌘O" hint="The files stay as they are." /></MenuPresentation>)
  expect(html.match(/data-menu-icon/g)).toHaveLength(1)
  expect(html.match(/data-menu-trailing/g)).toHaveLength(1)
  expect(html).toContain('data-menu-hint')
  expect(menuRowAttributes({ label: 'Open', hint: 'The files stay as they are.' })['data-has-hint']).toBe('')
})
test('an icon level rejects an unfilled icon slot', () => {
  expect(() => renderToStaticMarkup(<MenuPresentation icons="all"><MenuRowContent label="Open" /></MenuPresentation>)).toThrow('Every row in an icon menu needs an icon')
})

test('the listbox adapter keeps option semantics and canonical content without Button styling', () => {
  const html = renderToStaticMarkup(<MenuPresentation icons="none"><MenuListboxOption data={{ label: 'Restore conversation', hint: 'Restore it before sending.', trailing: <CopyIcon size={16} /> }} disabled aria-selected={false} /></MenuPresentation>)
  expect(html).toContain('role="option"')
  expect(html).toContain('data-menu-row=""')
  expect(html).toContain('data-menu-label="">Restore conversation')
  expect(html).toContain('data-menu-hint="">Restore it before sending.')
  expect(html).toContain('disabled=""')
  const box = document.createElement('div')
  box.innerHTML = html
  expect(box.querySelector('button')?.hasAttribute('class')).toBe(false)
})
