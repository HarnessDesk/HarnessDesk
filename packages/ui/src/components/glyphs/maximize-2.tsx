// Vendored from lucide-animated (`maximize-2`); ./index.ts says what changed.

import { motion, type Transition } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const DEFAULT_TRANSITION: Transition = {
  type: 'spring',
  stiffness: 250,
  damping: 25,
}

export const Maximize2Glyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="maximize-2" {...props}>
    <motion.path
      animate={controls}
      d="M3 16.2V21m0 0h4.8M3 21l6-6"
      transition={DEFAULT_TRANSITION}
      variants={{
        normal: { translateX: '0%', translateY: '0%' },
        animate: { translateX: '-2px', translateY: '2px' },
      }}
    />
    <motion.path
      animate={controls}
      d="M21 7.8V3m0 0h-4.8M21 3l-6 6"
      transition={DEFAULT_TRANSITION}
      variants={{
        normal: { translateX: '0%', translateY: '0%' },
        animate: { translateX: '2px', translateY: '-2px' },
      }}
    />
  </Glyph>
)
