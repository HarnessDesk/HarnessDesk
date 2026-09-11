/**
 * Image attachments.
 *
 * The browser has no filesystem path to hand a runtime, so every image the
 * user attaches — picked, pasted, or dropped — travels as a `data:` URL. That
 * keeps one shape across every way an image can arrive and every runtime it
 * can go to; each adapter re-encodes it the way its agent wants.
 *
 * Everything here is pure so it can be tested without a composer: which files
 * count as images, which are too big, how a pasted screenshot gets a name, and
 * which URLs the transcript may render as an `<img>`.
 */

/** Per image. A data URL is ~4/3 the size of the bytes, and several can ride one message. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** Formats the rest of the UI show for images; the rest a model cannot read. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface RejectedImage {
  readonly file: File
  readonly reason: string
}

export interface VettedImages {
  readonly accepted: readonly File[]
  readonly rejected: readonly RejectedImage[]
}

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`

/**
 * Splits a list of files into the images that can be attached and the ones
 * that cannot, each with a reason the user can act on. The list is whatever
 * the file picker, the clipboard, or a drop delivered — including files that
 * are not images at all when the drop was a folder's worth of things.
 */
export const vetImageFiles = (files: Iterable<File>): VettedImages => {
  const accepted: File[] = []
  const rejected: RejectedImage[] = []
  for (const file of files) {
    const type = file.type.toLowerCase()
    if (!type.startsWith('image/')) {
      rejected.push({ file, reason: `${labelOf(file)} is not an image.` })
    } else if (!IMAGE_TYPES.has(type)) {
      rejected.push({
        file,
        reason: `${labelOf(file)} is ${type.slice('image/'.length).toUpperCase()}; agents read PNG, JPEG, GIF and WebP.`,
      })
    } else if (file.size > MAX_IMAGE_BYTES) {
      rejected.push({
        file,
        reason: `${labelOf(file)} is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_IMAGE_BYTES)}.`,
      })
    } else {
      accepted.push(file)
    }
  }
  return { accepted, rejected }
}

const labelOf = (file: File): string => (file.name.trim().length > 0 ? file.name : 'That file')

/**
 * A pasted screenshot arrives as `image.png` from every browser; the name
 * tells the user nothing, so it becomes the nth "Pasted image". A real file
 * keeps its own name.
 */
export const attachmentName = (file: File, pastedSoFar: number, pasted: boolean): string => {
  if (!pasted || (file.name.trim().length > 0 && file.name !== 'image.png')) {
    return file.name.trim().length > 0 ? file.name : `Image ${pastedSoFar + 1}`
  }
  const extension = file.type === 'image/jpeg' ? 'jpg' : file.type.slice('image/'.length) || 'png'
  return `Pasted image ${pastedSoFar + 1}.${extension}`
}

/**
 * Images from a clipboard or drag payload. Browsers put a pasted screenshot
 * in `items` and a dragged file in `files`; a file dragged out of another app
 * can show up in both. Each image is taken once.
 */
export const imageFilesOf = (transfer: DataTransfer | null): File[] => {
  if (!transfer) return []
  const seen = new Set<File>()
  const files: File[] = []
  const take = (file: File | null): void => {
    if (file && !seen.has(file) && file.type.startsWith('image/')) {
      seen.add(file)
      files.push(file)
    }
  }
  for (const file of Array.from(transfer.files ?? [])) take(file)
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind === 'file') take(item.getAsFile())
  }
  return files
}

/** Whether a drag carries files at all — the cue for the drop target to light up. */
export const dragHasFiles = (transfer: DataTransfer | null): boolean =>
  Boolean(transfer && Array.from(transfer.types ?? []).includes('Files'))

/** The image types an `<img>` draws, as they follow `image/`: one list for both tests below (review of #187, round 2). */
const DRAWN = 'png|jpeg|jpg|gif|webp|bmp|svg\\+xml|avif'

/**
 * Whether a stored image URL may be rendered. User attachments are data URLs
 * of an image type; a runtime's own history can hold an `https:` link. Anything
 * else — `javascript:`, `file:`, a data URL of another type — stays text.
 */
export const isRenderableImageUrl = (url: string): boolean =>
  new RegExp(`^data:image\\/(?:${DRAWN});base64,`, 'i').test(url) || /^https:\/\//i.test(url)

/**
 * Whether an `<img>` can draw an image part. A data URL carries its own type,
 * which the test above reads; a link carries none, so its declared type has
 * to be one an `<img>` draws: `https://…/report.pdf` declared
 * `application/pdf` was drawn as a broken image (review of #187, round 1). A
 * link that declares nothing is tried, and named if it doesn't draw (the
 * transcript's `onError`). An `http:` link isn't drawn, here or anywhere in the
 * renderer: an `<img>` is a request the renderer sends on an agent's say-so,
 * and over plain http it reaches a device on the local network that TLS would
 * have stopped (round 2).
 */
export const drawsAsImage = (url: string, mimeType?: string): boolean =>
  isRenderableImageUrl(url) && (url.startsWith('data:') || !mimeType || new RegExp(`^image\\/(?:${DRAWN})$`, 'i').test(mimeType))

/** The byte size a data URL stands for; for a link, nothing is known. */
export const dataUrlBytes = (url: string): number | null => {
  const comma = url.indexOf(',')
  if (!url.startsWith('data:') || comma < 0) return null
  // Percent-encoded unless its header says base64: counted as base64, its size
  // was simply wrong (review of #187, round 1). Each %XX is one byte.
  if (!/;base64$/i.test(url.slice(0, comma))) return url.slice(comma + 1).replace(/%[0-9a-f]{2}/gi, '%').length
  const payload = url.length - comma - 1
  const padding = url.endsWith('==') ? 2 : url.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((payload * 3) / 4) - padding)
}

/** The mime type a data URL declares, or null for anything else. */
export const dataUrlMimeType = (url: string): string | null => {
  const match = /^data:([^;,]+)/i.exec(url)
  return match?.[1]?.toLowerCase() ?? null
}

/**
 * What a tool result's image part says in the transcript when an `<img>` can't
 * draw it: its type and size. A PDF drawn as an image was a broken one (#79).
 */
export const unshownImage = (url: string, mimeType?: string): string => {
  const type = mimeType || dataUrlMimeType(url) || 'A file'
  const bytes = dataUrlBytes(url)
  return `${type}${bytes === null ? '' : `, ${formatBytes(bytes)}`}: can't be shown here.`
}

export { formatBytes }
