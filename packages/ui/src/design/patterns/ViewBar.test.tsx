import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ViewBar } from './ViewBar'

it('keeps a reading page summary on the page gutter', () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<ViewBar summary="12 open" />)
  expect(host.querySelector('header')?.getAttribute('data-content-inset')).toBe('page')
  expect(host.querySelector('header > div')?.textContent).toBe('12 open')
})

it('lets a table summary share the first cell text edge without repeating the page title', () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<ViewBar contentInset="reading-table" summary="4 jobs" actions={<button>New job</button>} />)
  expect(host.querySelector('header')?.getAttribute('data-content-inset')).toBe('reading-table')
  expect(host.querySelector('header > div')?.textContent).toBe('4 jobs')
  expect(host.querySelector('button')?.textContent).toBe('New job')
  expect(host.querySelector('h1, h2, h3')).toBeNull()
})
