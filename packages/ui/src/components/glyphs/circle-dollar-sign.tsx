// Vendored from lucide-animated (`circle-dollar-sign`); ./index.ts says what changed.

import { motion, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const DOLLAR_MAIN_VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
    transition: {
      duration: 0.4,
      opacity: { duration: 0.1 },
    },
  },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    transition: {
      duration: 0.6,
      opacity: { duration: 0.1 },
    },
  },
}

const DOLLAR_SECONDARY_VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
    pathOffset: 0,
    transition: {
      delay: 0.3,
      duration: 0.3,
      opacity: { duration: 0.1, delay: 0.3 },
    },
  },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    pathOffset: [1, 0],
    transition: {
      delay: 0.5,
      duration: 0.4,
      opacity: { duration: 0.1, delay: 0.5 },
    },
  },
}

export const CircleDollarSignGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="circle-dollar-sign" {...props}>
    <circle cx="12" cy="12" r="10" />
    <motion.path
      animate={controls}
      d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"
      initial="normal"
      variants={DOLLAR_MAIN_VARIANTS}
    />
    <motion.path
      animate={controls}
      d="M12 18V6"
      initial="normal"
      variants={DOLLAR_SECONDARY_VARIANTS}
    />
  </Glyph>
)
