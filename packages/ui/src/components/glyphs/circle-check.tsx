// Vendored from lucide-animated (`circle-check`); ./index.ts says what changed.

import { motion, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const PATH_VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
    transition: {
      duration: 0.3,
      opacity: { duration: 0.1 },
    },
  },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    transition: {
      duration: 0.4,
      opacity: { duration: 0.1 },
    },
  },
}

export const CircleCheckGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="circle-check" {...props}>
    <circle cx="12" cy="12" r="10" />
    <motion.path
      animate={controls}
      d="m9 12 2 2 4-4"
      initial="normal"
      variants={PATH_VARIANTS}
    />
  </Glyph>
)
