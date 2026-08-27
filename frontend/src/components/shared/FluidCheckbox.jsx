import { motion, AnimatePresence } from 'framer-motion'

// FluidCheckbox: animated check with optimistic state
// Props: checked (bool), onChange(newChecked), size (optional)
export default function FluidCheckbox({ checked, onChange, size = 20 }) {
    const handleClick = (e) => {
        e.stopPropagation()
        onChange(!checked)
    }

    return (
        <motion.button
            onClick={handleClick}
            whileTap={{ scale: 0.82 }}
            style={{
                width: size,
                height: size,
                borderRadius: 5,
                border: `2px solid ${checked ? '#22d3ee' : '#3f3f46'}`,
                background: checked ? '#22d3ee' : 'transparent',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                padding: 0,
                overflow: 'hidden',
            }}
            animate={{
                backgroundColor: checked ? '#22d3ee' : 'rgba(0,0,0,0)',
                borderColor: checked ? '#22d3ee' : '#3f3f46',
            }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            title={checked ? 'Mark as unsolved' : 'Mark as solved'}
        >
            <AnimatePresence>
                {checked && (
                    <motion.svg
                        key="check"
                        width={size * 0.6}
                        height={size * 0.6}
                        viewBox="0 0 12 10"
                        fill="none"
                        initial={{ opacity: 0, scale: 0.5 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.5 }}
                        transition={{ duration: 0.18 }}
                    >
                        <motion.path
                            d="M1 5L4.5 8.5L11 1"
                            stroke="#09090b"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            initial={{ pathLength: 0 }}
                            animate={{ pathLength: 1 }}
                            transition={{ duration: 0.22, ease: 'easeOut' }}
                        />
                    </motion.svg>
                )}
            </AnimatePresence>
        </motion.button>
    )
}
