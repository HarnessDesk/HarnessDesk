import type { SVGProps } from 'react'

import harnessdesk from '../assets/brand/mark.svg?raw'
import codex from '@lobehub/icons-static-svg/icons/codex.svg?raw'
import claudecode from '@lobehub/icons-static-svg/icons/claudecode.svg?raw'
import cursor from '@lobehub/icons-static-svg/icons/cursor.svg?raw'
import geminicli from '@lobehub/icons-static-svg/icons/geminicli.svg?raw'
import githubcopilot from '@lobehub/icons-static-svg/icons/githubcopilot.svg?raw'
import github from '@lobehub/icons-static-svg/icons/github.svg?raw'
import antigravity from '@lobehub/icons-static-svg/icons/antigravity.svg?raw'
import cline from '@lobehub/icons-static-svg/icons/cline.svg?raw'
import windsurf from '@lobehub/icons-static-svg/icons/windsurf.svg?raw'
import opencode from '@lobehub/icons-static-svg/icons/opencode.svg?raw'
import openclaw from '@lobehub/icons-static-svg/icons/openclaw.svg?raw'
import kiro from '@lobehub/icons-static-svg/icons/kiro.svg?raw'
import kilocode from '@lobehub/icons-static-svg/icons/kilocode.svg?raw'
import devin from '@lobehub/icons-static-svg/icons/devin.svg?raw'
import trae from '@lobehub/icons-static-svg/icons/trae.svg?raw'
import amp from '@lobehub/icons-static-svg/icons/amp.svg?raw'
import codebuddy from '@lobehub/icons-static-svg/icons/codebuddy.svg?raw'
import goose from '@lobehub/icons-static-svg/icons/goose.svg?raw'
import hermesagent from '@lobehub/icons-static-svg/icons/hermesagent.svg?raw'
import junie from '@lobehub/icons-static-svg/icons/junie.svg?raw'
import pi from '@lobehub/icons-static-svg/icons/pi.svg?raw'
import poolside from '@lobehub/icons-static-svg/icons/poolside.svg?raw'
import qoder from '@lobehub/icons-static-svg/icons/qoder.svg?raw'
import openai from '@lobehub/icons-static-svg/icons/openai.svg?raw'
import claude from '@lobehub/icons-static-svg/icons/claude.svg?raw'
import anthropic from '@lobehub/icons-static-svg/icons/anthropic.svg?raw'
import deepseek from '@lobehub/icons-static-svg/icons/deepseek.svg?raw'
import gemini from '@lobehub/icons-static-svg/icons/gemini.svg?raw'
import gemma from '@lobehub/icons-static-svg/icons/gemma.svg?raw'
import google from '@lobehub/icons-static-svg/icons/google.svg?raw'
import grok from '@lobehub/icons-static-svg/icons/grok.svg?raw'
import xai from '@lobehub/icons-static-svg/icons/xai.svg?raw'
import meta from '@lobehub/icons-static-svg/icons/meta.svg?raw'
import mistral from '@lobehub/icons-static-svg/icons/mistral.svg?raw'
import qwen from '@lobehub/icons-static-svg/icons/qwen.svg?raw'
import kimi from '@lobehub/icons-static-svg/icons/kimi.svg?raw'
import zhipu from '@lobehub/icons-static-svg/icons/zhipu.svg?raw'
import minimax from '@lobehub/icons-static-svg/icons/minimax.svg?raw'
import doubao from '@lobehub/icons-static-svg/icons/doubao.svg?raw'
import cohere from '@lobehub/icons-static-svg/icons/cohere.svg?raw'
import perplexity from '@lobehub/icons-static-svg/icons/perplexity.svg?raw'
import microsoft from '@lobehub/icons-static-svg/icons/microsoft.svg?raw'
import langchain from '@lobehub/icons-static-svg/icons/langchain.svg?raw'
import snowflake from '@lobehub/icons-static-svg/icons/snowflake.svg?raw'
import openrouter from '@lobehub/icons-static-svg/icons/openrouter.svg?raw'
import ollama from '@lobehub/icons-static-svg/icons/ollama.svg?raw'
import groq from '@lobehub/icons-static-svg/icons/groq.svg?raw'
import huggingface from '@lobehub/icons-static-svg/icons/huggingface.svg?raw'

import { type Brand, brandForModel, brandForRuntime } from '../lib/brands'
import { AgentIcon, ModelIcon } from './Icons'

/**
 * The marks of the companies whose agents and models appear in the interface,
 * drawn from lobe-icons (https://github.com/lobehub/lobe-icons, MIT). The
 * collection is the one place a logo comes from, the way Lucide is the one
 * place a glyph comes from: every mark is the same 24-grid, filled on
 * `currentColor`, so it sits in a row beside Lucide's strokes at the same size
 * and in the same colour without a palette of its own.
 *
 * Which mark applies to what is decided in `lib/brands.ts`; this module only
 * draws. The files are inlined at build time (`?raw`) — nothing is fetched, as
 * the renderer's CSP requires — and each is trimmed to its paths here, so the
 * wrapper owns size, accessibility and class, not the file.
 *
 * The logos belong to their owners and identify them; see TRADEMARKS.md. Ours
 * is the exception and lives here too, generated from `assets/brand/svgs` by
 * `pnpm run icons`: wherever the interface names an agent by its mark, naming
 * HarnessDesk with a stock robot glyph made the app look like one more agent
 * in its own roster.
 */

const FILES: Record<Brand, string> = {
  codex,
  claudecode,
  cursor,
  geminicli,
  githubcopilot,
  antigravity,
  cline,
  windsurf,
  opencode,
  openclaw,
  kiro,
  kilocode,
  devin,
  trae,
  amp,
  codebuddy,
  goose,
  hermesagent,
  junie,
  pi,
  poolside,
  qoder,
  openai,
  claude,
  anthropic,
  deepseek,
  gemini,
  gemma,
  google,
  grok,
  xai,
  meta,
  mistral,
  qwen,
  kimi,
  zhipu,
  minimax,
  doubao,
  cohere,
  perplexity,
  microsoft,
  langchain,
  snowflake,
  openrouter,
  ollama,
  groq,
  huggingface,
}

/** The paths between the file's `<svg>` tags, with its `<title>` gone — the wrapper labels. */
const pathsOf = (file: string): string =>
  file
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/<title>[^<]*<\/title>/, '')

/**
 * The same drawing, with any id it carries made this brand's own.
 *
 * Two of these files define something and point at it — OpenClaw a clip path,
 * Poolside a mask and three gradients — and OpenClaw names them `a` through
 * `f`. Inlined, those ids land in the page's own document, where `url(#a)`
 * resolves to whatever `a` the document happens to hold first. Nothing in the
 * app collides with it today, which is exactly the kind of thing that stops
 * being true without anyone noticing.
 *
 * Per brand, not per instance: two OpenClaw marks on one screen still share
 * their ids, and share an identical definition, so the drawing is right and
 * only the strict reading of "unique in the document" is not. A render-time
 * id would fix that half too, at the cost of making every mark stateful.
 */
const withOwnIds = (markup: string, brand: Brand): string =>
  markup
    .replace(/id="([^"]*)"/g, (_, id: string) => `id="brand-${brand}-${id}"`)
    .replace(/url\(#([^)]*)\)/g, (_, id: string) => `url(#brand-${brand}-${id})`)

const PATHS: Record<Brand, string> = Object.fromEntries(
  (Object.keys(FILES) as Brand[]).map((brand) => [brand, withOwnIds(pathsOf(FILES[brand]), brand)]),
) as Record<Brand, string>

/**
 * Each mark's own box, rather than the 24-grid assumed for it.
 *
 * Nearly every file in the collection is drawn on 24×24, and reading the
 * number instead of writing it is what keeps that a fact rather than a hope:
 * a mark drawn on some other grid — lobe-icons has a few — is squashed into
 * a hardcoded viewBox with nothing to say it happened. The wrapper still
 * gives width and height one `size`, so a mark must be square; the test file
 * holds that line for the whole collection at once.
 */
const BOXES: Record<Brand, string> = Object.fromEntries(
  (Object.keys(FILES) as Brand[]).map((brand) => [
    brand,
    /viewBox="([^"]+)"/.exec(FILES[brand])?.[1] ?? '0 0 24 24',
  ]),
) as Record<Brand, string>

export type BrandMarkProps = Omit<SVGProps<SVGSVGElement>, 'ref' | 'children' | 'dangerouslySetInnerHTML'> & {
  readonly brand: Brand
  readonly size?: number
  /** Spoken name for readers, when the mark stands alone. Hidden otherwise, like every icon. */
  readonly label?: string
}

export const BrandMark = ({ brand, size = 16, label, className, ...rest }: BrandMarkProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox={BOXES[brand]}
    width={size}
    height={size}
    fill="currentColor"
    fillRule="evenodd"
    className={['brand', `brand-${brand}`, className].filter(Boolean).join(' ')}
    focusable="false"
    {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    {...rest}
    dangerouslySetInnerHTML={{ __html: PATHS[brand] }}
  />
)
BrandMark.displayName = 'BrandMark'

/**
 * GitHub's mark, for the forge rather than for an agent.
 *
 * Not a `Brand`: that union names the makers of agents and models, which is
 * what the sign-in and add pages list, and a forge is none of those. It is
 * drawn by the same wrapper so it sits in a chip beside Lucide's strokes at
 * the same size and in the same colour.
 */
const GITHUB_PATHS = pathsOf(github)
const GITHUB_BOX = /viewBox="([^"]+)"/.exec(github)?.[1] ?? '0 0 24 24'

export const GitHubMark = ({
  size = 16,
  label,
  className,
  ...rest
}: Omit<BrandMarkProps, 'brand'>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox={GITHUB_BOX}
    width={size}
    height={size}
    fill="currentColor"
    fillRule="evenodd"
    className={['brand', 'brand-github', className].filter(Boolean).join(' ')}
    focusable="false"
    {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    {...rest}
    dangerouslySetInnerHTML={{ __html: GITHUB_PATHS }}
  />
)
GitHubMark.displayName = 'GitHubMark'

/**
 * An agent's mark, or the generic agent glyph when it has none — the choice
 * every picker that lists runtimes would otherwise make for itself.
 */
export const RuntimeMark = ({
  runtime,
  size = 14,
  className,
}: {
  readonly runtime: { readonly id: string; readonly presentation: { readonly name: string; readonly brand?: string } }
  readonly size?: number
  readonly className?: string
}) => {
  const brand = brandForRuntime(runtime)
  return brand ? (
    <BrandMark brand={brand} size={size} {...(className ? { className } : {})} />
  ) : (
    <AgentIcon size={size} {...(className ? { className } : {})} />
  )
}

/** A model's mark by its maker, or the generic model glyph when unplaced. */
export const ModelMark = ({
  model,
  agent,
  size = 14,
  className,
}: {
  /** The model's id and label, or either; what `brandForModel` reads. */
  readonly model: string
  /** The agent offering it, for its own "Auto" choice. */
  readonly agent: Brand | null
  readonly size?: number
  readonly className?: string
}) => {
  const brand = brandForModel(model, agent)
  return brand ? (
    <BrandMark brand={brand} size={size} {...(className ? { className } : {})} />
  ) : (
    <ModelIcon size={size} {...(className ? { className } : {})} />
  )
}


/** The svg's own viewBox, so the mark is not squashed into a 24-grid. */
const MARK_BOX = /viewBox="([^"]+)"/.exec(harnessdesk)?.[1] ?? '0 0 24 24'

/**
 * HarnessDesk's own mark, drawn on `currentColor` like every other brand here.
 *
 * The crop is the menu-bar one — wider than it is tall — so it is given a
 * width rather than a square, and callers size it the way they size a word.
 */
export const HarnessMark = ({
  size = 16,
  label,
  className,
  ...rest
}: Omit<SVGProps<SVGSVGElement>, 'ref' | 'children' | 'dangerouslySetInnerHTML'> & {
  readonly size?: number
  readonly label?: string
}) => {
  const [, , width, height] = MARK_BOX.split(/\s+/).map(Number)
  const ratio = width && height ? width / height : 1
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={MARK_BOX}
      width={Math.round(size * ratio)}
      height={size}
      fill="currentColor"
      className={['brand', 'brand-harnessdesk', className].filter(Boolean).join(' ')}
      focusable="false"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      {...rest}
      dangerouslySetInnerHTML={{ __html: pathsOf(harnessdesk) }}
    />
  )
}
HarnessMark.displayName = 'HarnessMark'
