import assert from 'node:assert/strict'
import { test } from 'node:test'

import { printOptions, printResult } from './pdf.mjs'

test('the defaults print backgrounds, portrait', () => {
  assert.deepEqual(printOptions({}), { printBackground: true, landscape: false })
  assert.deepEqual(printOptions({ printBackground: false, landscape: true }), { printBackground: false, landscape: true })
})

test("CDP's inches are Electron's inches", () => {
  const options = printOptions({ paperWidth: 8.5, paperHeight: 11, marginTop: 0.4, marginLeft: 0.5, scale: 0.8, pageRanges: '1-2' })
  assert.deepEqual(options.pageSize, { width: 8.5, height: 11 })
  assert.deepEqual(options.margins, { top: 0.4, left: 0.5 })
  assert.equal(options.scale, 0.8)
  assert.equal(options.pageRanges, '1-2')
})

test('a header is only sent when it is asked to be drawn', () => {
  assert.equal(printOptions({ headerTemplate: '<span/>' }).headerTemplate, undefined)
  assert.equal(printOptions({ displayHeaderFooter: true, headerTemplate: '<span/>' }).headerTemplate, '<span/>')
})

test('the answer is the protocol’s shape', () => {
  assert.deepEqual(printResult(Buffer.from('%PDF-1.4')), { data: Buffer.from('%PDF-1.4').toString('base64') })
})
