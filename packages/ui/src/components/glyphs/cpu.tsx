// Vendored from lucide-animated (`cpu`); ./index.ts says what changed.

import { motion, type Transition, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const TRANSITION: Transition = {
  duration: 0.5,
  ease: 'easeInOut',
  repeat: 1,
}

const Y_VARIANTS: Variants = {
  normal: {
    scale: 1,
    rotate: 0,
    opacity: 1,
  },
  animate: {
    scaleY: [1, 1.5, 1],
    opacity: [1, 0.8, 1],
  },
}
const X_VARIANTS: Variants = {
  normal: {
    scale: 1,
    rotate: 0,
    opacity: 1,
  },
  animate: {
    scaleX: [1, 1.5, 1],
    opacity: [1, 0.8, 1],
  },
}

export const CpuGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="cpu" {...props}>
    <rect height="16" rx="2" width="16" x="4" y="4" />
    <rect height="6" rx="1" width="6" x="9" y="9" />
    <motion.path
      animate={controls}
      d="M15 2v2"
      transition={TRANSITION}
      variants={Y_VARIANTS}
    />
    <motion.path
      animate={controls}
      d="M15 20v2"
      transition={TRANSITION}
      variants={Y_VARIANTS}
    />
    <motion.path
      animate={controls}
      d="M2 15h2"
      transition={TRANSITION}
      variants={X_VARIANTS}
    />
    <motion.path
      animate={controls}
      d="M2 9h2"
      transition={TRANSITION}
      variants={X_VARIANTS}
    />
    <motion.path
      animate={controls}
      d="M20 15h2"
      transition={TRANSITION}
      variants={X_VARIANTS}
    />
    <motion.path
      animate={controls}
      d="M20 9h2"
      transition={TRANSITION}
      variants={X_VARIANTS}
    />
    <motion.path
      animate={controls}
      d="M9 2v2"
      transition={TRANSITION}
      variants={Y_VARIANTS}
    />
    <motion.path
      animate={controls}
      d="M9 20v2"
      transition={TRANSITION}
      variants={Y_VARIANTS}
    />
  </Glyph>
)
