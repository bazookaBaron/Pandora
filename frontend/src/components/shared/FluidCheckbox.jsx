// FluidCheckbox: animated check with optimistic state (pure CSS — no animation lib)
// Props: checked (bool), onChange(newChecked), size (optional), label (optional accessible name,
// e.g. "Mark Two sum as solved"). The 44px touch target comes from .fluid-checkbox::after (index.css)
// or the caller's wrapper; the tick colour follows --check-tone (default --pop).
export default function FluidCheckbox({ checked, onChange, size = 20, label }) {
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
                border: `2px solid ${checked ? 'var(--check-tone, var(--pop))' : 'var(--subtle-strong)'}`,
                background: checked ? 'var(--check-tone, var(--pop))' : 'transparent',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                padding: 0,
                position: 'relative',
            }}
            title={checked ? 'Mark as unsolved' : 'Mark as solved'}
            aria-label={label || (checked ? 'Mark as unsolved' : 'Mark as solved')}
            aria-pressed={!!checked}
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
                        stroke="currentColor"
                        style={{ color: 'var(--surface)' }}
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
