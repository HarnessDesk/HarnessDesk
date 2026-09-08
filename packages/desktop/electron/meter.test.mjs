import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { test } from 'node:test'

import {
  FILL_ALPHA,
  GAP,
  MARK,
  METER_HEIGHT,
  METER_WIDTH,
  TRACK_ALPHA,
  drawTrayMeter,
  encodePng,
} from './meter.mjs'

const alpha = (value) => Math.round(value * 255)

/** The drawn image back as pixels: PNG in, RGBA rows out. */
const pixels = (png, width, height) => {
  const raw = inflateSync(png.subarray(png.indexOf(Buffer.from('IDAT')) + 4, png.length - 12))
  const stride = width * 4
  const out = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (stride + 1)], 0, 'rows are written with no filter')
    raw.copy(out, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1))
  }
  return { at: (x, y) => [...out.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)] }
}

const drawn = (fraction, options = {}) => {
  const scale = 2
  const result = drawTrayMeter({ fraction, scale, ...options })
  return {
    ...result,
    ...pixels(result.png, result.width * scale, result.height * scale),
    scale,
  }
}

test('a PNG the encoder makes has the signature and the chunks a decoder looks for', () => {
  const png = encodePng(2, 2, Buffer.alloc(16, 0xff))
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (const chunk of ['IHDR', 'IDAT', 'IEND']) assert.ok(png.includes(Buffer.from(chunk)), chunk)
})

test('every pixel is black, so macOS can tint the whole thing as a template', () => {
  const bar = drawn(0.5, { mark: { } })
  const scale = 2
  const mid = Math.round((MARK / 2) * scale)
  const barLeft = (MARK + GAP) * scale
  for (const x of [barLeft + 4, barLeft + METER_WIDTH * scale - 4]) {
    assert.deepEqual(bar.at(x, mid).slice(0, 3), [0, 0, 0], 'no colour of our own at ' + x)
  }
})

test('the slot for the mark is held open whether or not a mark was drawn', () => {
  const bare = drawTrayMeter({ fraction: 0.5 })
  const marked = drawTrayMeter({ fraction: 0.5, mark: Buffer.alloc(MARK * 2 * MARK * 2 * 4, 0xff) })
  assert.equal(bare.width, MARK + GAP + METER_WIDTH)
  assert.equal(bare.width, marked.width, 'a missing mark must not move the bar')
  assert.equal(bare.height, MARK)
})

test('a mark of the wrong size is left out rather than drawn into the wrong pixels', () => {
  const wrong = drawn(0.5, { mark: Buffer.alloc(8 * 8 * 4, 0xff) })
  assert.deepEqual(wrong.at(4, 4), [0, 0, 0, 0], 'nothing painted in the mark slot')
})

test('the fill replaces the track rather than stacking on it', () => {
  const bar = drawn(1)
  const barLeft = (MARK + GAP) * 2
  const mid = MARK
  assert.equal(bar.at(barLeft + 20, mid)[3], alpha(FILL_ALPHA), 'not FILL over TRACK')
  assert.ok(FILL_ALPHA < 1, 'and never as heavy as the mark beside it')
})

test('the bar fills with what is left, from the left edge of its own track', () => {
  const half = drawn(0.5)
  const scale = half.scale
  const barLeft = (MARK + GAP) * scale
  const mid = Math.round((MARK / 2) * scale)
  const span = METER_WIDTH * scale

  assert.equal(half.at(barLeft + 4, mid)[3], alpha(FILL_ALPHA), 'filled at the start')
  assert.equal(half.at(barLeft + span - 4, mid)[3], alpha(TRACK_ALPHA), 'empty at the end')

  const full = drawn(1)
  assert.equal(full.at(barLeft + span - 4, mid)[3], alpha(FILL_ALPHA), 'a full plan fills its track')
})

test('a reading of nearly nothing is still a sliver, and no reading is no bar', () => {
  const scale = 2
  const barLeft = (MARK + GAP) * scale
  const mid = Math.round((MARK / 2) * scale)
  // 1% of 72px is under a pixel. A fill thinner than its own round cap is a
  // smudge; the least a bar may say is "a sliver", at one cap's width.
  const sliver = drawn(0.01)
  assert.equal(sliver.at(barLeft + 2, mid)[3], alpha(FILL_ALPHA), 'one percent is visible')

  // No lane is no bar: an agent with nothing to report draws no track either,
  // but keeps the canvas, so its label starts where every other label does.
  const none = drawn(null)
  assert.equal(none.at(barLeft + 2, mid)[3], 0, 'no reading draws nothing at all')
  assert.equal(none.width, drawn(0.5).width, 'and still holds the column')
})

test('the bar is the header strip’s bar: five points tall with round ends', () => {
  const scale = 2
  const bar = drawn(1)
  const barLeft = (MARK + GAP) * scale
  const top = Math.round((MARK - METER_HEIGHT) / 2) * scale
  assert.equal(METER_HEIGHT, 5, 'PlanMeters.module.css draws a 5px track')
  assert.equal(bar.at(barLeft + 20, top - 1)[3], 0, 'nothing above the track')
  assert.equal(bar.at(barLeft + 20, top + METER_HEIGHT * scale)[3], 0, 'nothing below it')
  // A round end means the corner pixel is not painted.
  assert.ok(bar.at(barLeft, top)[3] < 255, 'the left end is rounded')
  assert.ok(bar.at(barLeft + METER_WIDTH * scale - 1, top)[3] < 255, 'and so is the right')
})
