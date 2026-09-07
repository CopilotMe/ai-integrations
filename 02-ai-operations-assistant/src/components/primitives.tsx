import type { BlastRadius } from '@/core/policy/autonomy';
import type { CaseState } from '@/core/domain/types';

export function StateBadge({ state }: { state: CaseState }) {
  return (
    <span className={`state state-${state} mono`} title={state}>
      {state.replace(/_/g, ' ')}
    </span>
  );
}

/**
 * Four segments filled to the severity of the proposed action.
 *
 * Deliberately readable before any of the words around it: an operator working
 * a queue needs to know "how bad is this if it's wrong" at a glance, and that
 * is a property of the action, not of the model's confidence.
 */
export function BlastMeter({ radius }: { radius: BlastRadius }) {
  return (
    <span className={`blast blast-${radius}`} title={`${radius} blast radius`}>
      <span className="blast-bars" aria-hidden="true">
        <i className="blast-bar" />
        <i className="blast-bar" />
        <i className="blast-bar" />
        <i className="blast-bar" />
      </span>
      <span className="blast-label mono">{radius}</span>
    </span>
  );
}

/** Confidence bar with a tick showing the threshold the action had to clear. */
export function ConfidenceGauge({ actual, required }: { actual: number; required: number }) {
  const markLeft = required > 1 ? null : `${Math.min(100, required * 100)}%`;
  return (
    <div>
      <span className="mono">{actual.toFixed(2)}</span>
      <span style={{ color: 'var(--ink-3)', fontSize: 11, marginLeft: 8 }}>
        {required > 1 ? 'no threshold clears this action' : `needs ${required.toFixed(2)}`}
      </span>
      <div className="gauge">
        <div className="gauge-fill" style={{ width: `${Math.min(100, actual * 100)}%` }} />
        {markLeft && <div className="gauge-mark" style={{ left: markLeft }} />}
      </div>
    </div>
  );
}

export function relativeTime(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export function absoluteTime(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return date.toISOString().replace('T', ' ').slice(0, 19);
}
