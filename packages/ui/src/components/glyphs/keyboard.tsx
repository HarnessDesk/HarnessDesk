// Vendored from lucide-animated (`keyboard`); ./index.ts says what changed.

import { motion, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const KEYBOARD_PATHS = [
  'M10 8h.01',
  'M12 12h.01',
  'M14 8h.01',
  'M16 12h.01',
  'M18 8h.01',
  'M6 8h.01',
  'M7 16h10',
  'M8 12h.01',
]

const KEY_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: (index: number) => ({
    opacity: [1, 0.2, 1],
    transition: {
      duration: 1.5,
      times: [0, 0.5, 1],
      delay: index * 0.2 * Math.random(),
      repeat: 1,
      repeatType: 'reverse',
    },
  }),
}

export const KeyboardGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="keyboard" {...props}>
    <rect height="16" rx="2" width="20" x="2" y="4" />
    {KEYBOARD_PATHS.map((d, index) => (
      <motion.path animate={controls} custom={index} d={d} initial="normal" key={d} variants={KEY_VARIANTS} />
    ))}
  </Glyph>
)
