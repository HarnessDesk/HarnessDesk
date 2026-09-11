import { describe, expect, test } from 'vitest'

import {
  attachmentName,
  dataUrlBytes,
  dataUrlMimeType,
  dragHasFiles,
  drawsAsImage,
  imageFilesOf,
  isRenderableImageUrl,
  MAX_IMAGE_BYTES,
  unshownImage,
  vetImageFiles,
} from './images'

const file = (name: string, type: string, size = 10): File => {
  const blob = new File([new Uint8Array(size)], name, { type })
  return blob
}

describe('vetImageFiles', () => {
  test('keeps the formats agents read and says why the rest were left out', () => {
    const { accepted, rejected } = vetImageFiles([
      file('a.png', 'image/png'),
      file('b.jpg', 'image/jpeg'),
      file('c.webp', 'image/webp'),
      file('d.gif', 'image/gif'),
      file('notes.txt', 'text/plain'),
      file('e.tiff', 'image/tiff'),
    ])
    expect(accepted.map((entry) => entry.name)).toEqual(['a.png', 'b.jpg', 'c.webp', 'd.gif'])
    expect(rejected.map((entry) => entry.reason)).toEqual([
      'notes.txt is not an image.',
      'e.tiff is TIFF; agents read PNG, JPEG, GIF and WebP.',
    ])
  })

  test('an image over the limit is refused with both sizes', () => {
    const big = file('huge.png', 'image/png', MAX_IMAGE_BYTES + 1)
    const { accepted, rejected } = vetImageFiles([big])
    expect(accepted).toEqual([])
    expect(rejected[0]?.reason).toBe('huge.png is 10.0 MB; the limit is 10.0 MB.')
  })

  test('a nameless file is still described', () => {
    const { rejected } = vetImageFiles([file('', 'text/plain')])
    expect(rejected[0]?.reason).toBe('That file is not an image.')
  })
})

describe('attachmentName', () => {
  test('a pasted screenshot is numbered, with the extension its type implies', () => {
    expect(attachmentName(file('image.png', 'image/png'), 0, true)).toBe('Pasted image 1.png')
    expect(attachmentName(file('image.png', 'image/jpeg'), 2, true)).toBe('Pasted image 3.jpg')
  })

  test('a pasted real file keeps its name', () => {
    expect(attachmentName(file('design.png', 'image/png'), 0, true)).toBe('design.png')
  })

  test('a picked file keeps its name; a nameless one is numbered', () => {
    expect(attachmentName(file('shot.jpg', 'image/jpeg'), 0, false)).toBe('shot.jpg')
    expect(attachmentName(file('', 'image/png'), 4, false)).toBe('Image 5')
  })
})

describe('imageFilesOf', () => {
  const transfer = (files: File[], items: File[]): DataTransfer =>
    ({
      files,
      items: items.map((entry) => ({ kind: 'file', getAsFile: () => entry })),
      types: files.length > 0 ? ['Files'] : [],
    }) as unknown as DataTransfer

  test('takes images from files and items, each once, and skips the rest', () => {
    const shared = file('a.png', 'image/png')
    const found = imageFilesOf(transfer([shared, file('t.txt', 'text/plain')], [shared, file('b.png', 'image/png')]))
    expect(found.map((entry) => entry.name)).toEqual(['a.png', 'b.png'])
  })

  test('no payload is no images', () => {
    expect(imageFilesOf(null)).toEqual([])
  })

  test('dragHasFiles reads the Files type', () => {
    expect(dragHasFiles(transfer([file('a.png', 'image/png')], []))).toBe(true)
    expect(dragHasFiles(transfer([], []))).toBe(false)
    expect(dragHasFiles(null)).toBe(false)
  })
})

describe('isRenderableImageUrl', () => {
  test('image data URLs and https links render; anything else does not', () => {
    expect(isRenderableImageUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
    expect(isRenderableImageUrl('data:image/webp;base64,UklGRg==')).toBe(true)
    expect(isRenderableImageUrl('https://example.com/a.png')).toBe(true)
    expect(isRenderableImageUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe(false)
    expect(isRenderableImageUrl('javascript:alert(1)')).toBe(false)
    expect(isRenderableImageUrl('file:///etc/passwd')).toBe(false)
    expect(isRenderableImageUrl('http://example.com/a.png')).toBe(false)
  })
})

describe('data URL arithmetic', () => {
  test('bytes are recovered from the base64 length', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const base64 = Buffer.from(bytes).toString('base64')
    expect(dataUrlBytes(`data:image/png;base64,${base64}`)).toBe(5)
    expect(dataUrlBytes('https://example.com/a.png')).toBeNull()
  })

  test('the mime type is read off the prefix', () => {
    expect(dataUrlMimeType('data:image/JPEG;base64,AAAA')).toBe('image/jpeg')
    expect(dataUrlMimeType('https://example.com/a.png')).toBeNull()
  })

  test('a percent-encoded data URL is counted by its bytes, not as base64 (review of #187, round 1)', () => {
    expect(dataUrlBytes('data:text/plain,hello%20world')).toBe(11)
    expect(dataUrlBytes('data:text/plain;charset=utf-8,%E2%82%AC')).toBe(3)
  })
})

describe('drawsAsImage', () => {
  test('a link whose declared type is not one an img draws is not drawn (review of #187, round 1)', () => {
    expect(drawsAsImage('https://example.test/report.pdf', 'application/pdf')).toBe(false)
    expect(drawsAsImage('https://example.test/chart', 'image/png')).toBe(true)
    expect(drawsAsImage('https://example.test/chart')).toBe(true)
    expect(drawsAsImage('data:image/avif;base64,AAAA', 'image/avif')).toBe(true)
    expect(drawsAsImage('data:application/pdf;base64,JVBERg==', 'application/pdf')).toBe(false)
  })

  test('an http link is not drawn, and an https link that declares nothing is tried (review of #187, round 2)', () => {
    expect(drawsAsImage('http://localhost:3000/shot.png', 'image/png')).toBe(false)
    expect(drawsAsImage('https://example.test/chart')).toBe(true)
  })
})

describe('unshownImage', () => {
  test('names the type, and the size when the bytes are there (review of #187, round 1)', () => {
    expect(unshownImage('data:application/pdf;base64,JVBERi0xLjcK', 'application/pdf')).toBe("application/pdf, 1 KB: can't be shown here.")
    expect(unshownImage('https://example.test/report.pdf', 'application/pdf')).toBe("application/pdf: can't be shown here.")
    expect(unshownImage('https://example.test/report')).toBe("A file: can't be shown here.")
  })
})
