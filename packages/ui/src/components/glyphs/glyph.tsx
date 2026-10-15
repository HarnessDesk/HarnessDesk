import { motion, type LegacyAnimationControls, type SVGMotionProps } from 'motion/react'
import { Children, cloneElement, isValidElement, type ReactNode, type Ref, type SVGProps } from 'react'
import type { LucideProps } from 'lucide-react'

/**
 * The frame every animated glyph is drawn in — Lucide's own: a 24 unit box,
 * a 2 unit round stroke, `currentColor`. It is the frame `lucide-react` builds,
 * written once here so the sixty-nine vendored drawings carry only their
 * paths and their motion.
 *
 * It keeps `lucide lucide-<name>` on the element because the static glyphs from
 * `lucide-react` wear the same class, and a test or a rule that asks "which
 * glyph is this" should not have to know which of the two drew it.
 */

export type GlyphProps = Omit<LucideProps, 'ref' | 'size'> & {
  readonly ref?: Ref<SVGSVGElement>
  readonly size?: number
  /** The Lucide name, kebab-case — it becomes the `lucide-<name>` class. */
  readonly name?: string
  /** Drives the paths' `normal` and `animate` variants; owned by `Animated`. */
  readonly controls: LegacyAnimationControls
}

type FrameProps = Omit<GlyphProps, 'controls'>

// Lucide marks an icon decorative unless the caller gave it a name.
const named = (props: Record<string, unknown>) =>
  Object.keys(props).some((key) => key.startsWith('aria-') || key === 'role' || key === 'title')

const frame = ({ name, size = 24, color = 'currentColor', strokeWidth = 2, absoluteStrokeWidth, nonScalingStroke: _n, className, ...rest }: FrameProps) => ({
  xmlns: 'http://www.w3.org/2000/svg',
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: color,
  strokeWidth: absoluteStrokeWidth ? Number(strokeWidth) * 24 / Number(rest.width ?? size) : strokeWidth,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className: ['lucide', name && `lucide-${name}`, className].filter(Boolean).join(' '),
  ...(named(rest) ? {} : { 'aria-hidden': true as const }),
  ...rest,
})

// vector-effect is not inherited. Apply it to the paths themselves, including
// motion paths inside groups, just as Lucide does for its static drawing.
const drawing = (children: ReactNode, nonScalingStroke?: boolean): ReactNode => nonScalingStroke
  ? Children.map(children, child => isValidElement<SVGProps<SVGElement>>(child)
    ? cloneElement(child, { vectorEffect: 'non-scaling-stroke' }, drawing(child.props.children, true))
    : child)
  : children

/** A glyph whose drawing moves as a whole is still one element. */
export const Glyph = ({ children, nonScalingStroke, ...props }: FrameProps & { children?: ReactNode }) => <svg {...frame(props)}>{drawing(children, nonScalingStroke)}</svg>

/**
 * A glyph that rotates, shakes or scales as one — the `svg` itself is the
 * moving part, so it is a `motion.svg`. Every other glyph moves its children
 * and keeps the plain element, which is most of what is on screen.
 */
export const MotionGlyph = ({
  children,
  nonScalingStroke,
  ...props
}: FrameProps & Pick<SVGMotionProps<SVGSVGElement>, 'animate' | 'initial' | 'variants' | 'transition' | 'style'> & { children?: ReactNode }) => (
  <motion.svg {...(frame(props as FrameProps) as SVGMotionProps<SVGSVGElement>)}>{drawing(children, nonScalingStroke)}</motion.svg>
)
