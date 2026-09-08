import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'

/**
 * A locally installed extension's icon, as something a browser can show.
 *
 * Codex resolves the icons of installed plugins and skills to absolute paths
 * inside the installed package — files the renderer cannot reach over HTTP.
 * They are small brand marks, so the honest transport is a data URI read once
 * and cached; remote catalogue entries already carry URLs and never come
 * through here.
 */

const MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

/** An icon bigger than this is not an icon; refuse to inline it. */
const MAX_BYTES = 512 * 1024

const cache = new Map<string, { mtimeMs: number; uri: string | null }>()

export const iconDataUri = (path: string | null | undefined): string | null => {
  if (!path) return null
  const mime = MIME[extname(path).toLowerCase()]
  if (mime === undefined) return null
  try {
    const stat = statSync(path)
    const cached = cache.get(path)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.uri
    const uri =
      stat.size > MAX_BYTES
        ? null
        : `data:${mime};base64,${readFileSync(path).toString('base64')}`
    cache.set(path, { mtimeMs: stat.mtimeMs, uri })
    return uri
  } catch {
    return null
  }
}
