// Pulsing placeholder rows for the profile cards while data loads.
export default function Skeleton({ rows = 2, last = '100%' }) {
    return (
        <div className="profile-skel" aria-hidden="true">
            {Array.from({ length: rows }, (_, i) => (
                <span key={i} style={i === rows - 1 ? { width: last } : undefined} />
            ))}
        </div>
    )
}
