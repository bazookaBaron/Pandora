import { usePush } from '../../lib/usePush'
import { errorText } from '../../lib/errorText'

/** "Turn on notifications" for the AutoApply inbox (web push). Hidden when push cannot work here. */
export default function NotifyButton() {
    const { status, error, enable, disable } = usePush()
    if (status === 'unsupported' || status === 'unavailable') return null
    return (
        <div className="aa-notify">
            {status === 'on' ? (
                <button type="button" className="aa-btn" onClick={disable}>Notifications on · turn off</button>
            ) : (
                <button type="button" className="aa-btn is-primary" onClick={enable} disabled={status === 'working' || status === 'denied'}>
                    {status === 'working' ? 'Working…' : 'Turn on notifications'}
                </button>
            )}
            {status === 'denied' && <span className="aa-faint">Notifications are blocked in your browser settings for this site.</span>}
            {error && <span className="aa-faint" role="alert">{error.code === 'endpoint_owned' ? errorText(error) : `Could not change notifications: ${errorText(error)}`}</span>}
        </div>
    )
}
