// Vendored from lucide-animated (`git-commit-horizontal`); ./index.ts says what changed.

import { motion, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const VARIANTS: Variants = {
  normal: {
    pathLength: 1,
    opacity: 1,
  },
  animate: (custom: number) => ({
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      delay: 0.15 * custom,
      opacity: { delay: 0.1 * custom },
    },
  }),
}

export const GitCommitHorizontalGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="git-commit-horizontal" {...props}>
    <motion.circle
      animate={controls}
      custom={1}
      cx="12"
      cy="12"
      r="3"
      variants={VARIANTS}
    />
    <motion.line
      animate={controls}
      custom={0}
      variants={VARIANTS}
      x1="3"
      x2="9"
      y1="12"
      y2="12"
    />
    <motion.line
      animate={controls}
      custom={2}
      variants={VARIANTS}
      x1="15"
      x2="21"
      y1="12"
      y2="12"
    />
  </Glyph>
)
