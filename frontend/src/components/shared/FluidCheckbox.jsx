// FluidCheckbox: animated check with optimistic state (pure CSS — no animation lib)
// Props: checked (bool), onChange(newChecked), size (optional)
export default function FluidCheckbox({ checked, onChange, size = 20 }) {
    const handleClick = (e) => {
        e.stopPropagation()
        onChange(!checked)
    }

    return (
        <button
            type="button"
            className="fluid-checkbox"
            onClick={handleClick}
            style={{
                width: size,
                height: size,
                borderRadius: 5,
                border: `2px solid ${checked ? '#22d3ee' : 'var(--subtle-strong)'}`,
                background: checked ? '#22d3ee' : 'transparent',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                padding: 0,
                overflow: 'hidden',
            }}
            title={checked ? 'Mark as unsolved' : 'Mark as solved'}
        >
            {checked && (
                <svg
                    className="fluid-checkbox-mark"
                    width={size * 0.6}
                    height={size * 0.6}
                    viewBox="0 0 12 10"
                    fill="none"
                >
                    <path
                        className="fluid-checkbox-path"
                        d="M1 5L4.5 8.5L11 1"
                        stroke="#09090b"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        pathLength="1"
                    />
                </svg>
            )}
        </button>
    )
}
