/**
 * The review board's camera: where the board sits under the viewport and how
 * large. A board point `p` is drawn at `p * scale + offset`.
 */
export type Camera = { readonly x: number; readonly y: number; readonly scale: number }
export type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export const MIN_SCALE = 0.05
export const MAX_SCALE = 4
const clamp = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))

/** Scale by `factor`, keeping the board point under `(px, py)` where it is. */
export const zoomAt = (camera: Camera, factor: number, px: number, py: number): Camera => {
  const scale = clamp(camera.scale * factor)
  const ratio = scale / camera.scale
  return { scale, x: px - (px - camera.x) * ratio, y: py - (py - camera.y) * ratio }
}

export const pan = (camera: Camera, dx: number, dy: number): Camera => ({ ...camera, x: camera.x + dx, y: camera.y + dy })

/** The camera that shows all of `rect` inside a `width × height` viewport, with `margin` around it. */
export const fit = (rect: Rect, width: number, height: number, margin = 48, ceiling = 1): Camera => {
  const scale = clamp(Math.min((width - margin * 2) / rect.width, (height - margin * 2) / rect.height, ceiling))
  return {
    scale,
    x: (width - rect.width * scale) / 2 - rect.x * scale,
    y: (height - rect.height * scale) / 2 - rect.y * scale,
  }
}

/** The part of the board a viewport shows, in board coordinates. */
export const visibleRect = (camera: Camera, width: number, height: number): Rect => ({
  x: -camera.x / camera.scale,
  y: -camera.y / camera.scale,
  width: width / camera.scale,
  height: height / camera.scale,
})

export const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** A wheel delta as a zoom factor: one notch of a mouse is about 10%. */
export const wheelFactor = (deltaY: number) => Math.exp(-deltaY * 0.0025)
