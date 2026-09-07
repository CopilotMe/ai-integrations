import type { AuditLogRow } from '@/db/schema';
import { absoluteTime } from './primitives';

const TONE: Record<string, 'good' | 'bad' | undefined> = {
  'action.succeeded': 'good',
  'approval.granted': 'good',
  'classification.succeeded': 'good',
  'action.failed': 'bad',
  'approval.denied': 'bad',
  'classification.failed': 'bad',
  'case.dead_lettered': 'bad',
  'auth.login_failed': 'bad',
};

const LABEL: Record<string, string> = {
  'message.received': 'Message received',
  'message.duplicate_ignored': 'Duplicate delivery ignored',
  'classification.succeeded': 'Classified',
  'classification.failed': 'Classification failed',
  'classification.degraded': 'Classified in degraded mode',
  'policy.evaluated': 'Policy evaluated',
  'approval.requested': 'Sent for approval',
  'approval.granted': 'Approved',
  'approval.denied': 'Rejected',
  'action.started': 'Action started',
  'action.succeeded': 'Action succeeded',
  'action.failed': 'Action failed',
  'case.dead_lettered': 'Dead-lettered',
  'case.reclassified': 'Re-classified',
};

/**
 * The case's flight recorder.
 *
 * Rendered oldest-first and never summarised: the value of an audit trail is
 * that it shows what happened rather than someone's account of what happened.
 * Operator actions get an amber node so a human decision is visible at a glance
 * in a column of machine events.
 */
export function Ledger({ entries }: { entries: AuditLogRow[] }) {
  if (entries.length === 0) return <p className="page-sub">No entries yet.</p>;

  return (
    <div className="ledger">
      {entries.map((entry) => {
        const detail = entry.detail as Record<string, unknown>;
        const interesting = pickInteresting(detail);
        return (
          <div key={entry.id} className="ledger-entry" data-actor={entry.actorKind} data-tone={TONE[entry.event]}>
            <div className="ledger-event">
              {LABEL[entry.event] ?? entry.event}
              {entry.fromState && entry.toState && (
                <span className="mono" style={{ color: 'var(--ink-3)', fontSize: 11, marginLeft: 8 }}>
                  {entry.fromState} → {entry.toState}
                </span>
              )}
            </div>
            <div className="ledger-meta mono">
              <span>{absoluteTime(entry.createdAt)}</span>
              <span style={{ color: entry.actorKind === 'operator' ? 'var(--signal)' : undefined }}>
                {entry.actorLabel}
              </span>
            </div>
            {interesting && <div className="ledger-detail mono">{interesting}</div>}
          </div>
        );
      })}
    </div>
  );
}

/** Show the fields a person would ask about; hide the bookkeeping. */
function pickInteresting(detail: Record<string, unknown>): string | null {
  const keys = [
    'explanation',
    'reason',
    'error',
    'note',
    'external_ref',
    'approved_action',
    'overridden',
    'refund_amount_eur',
  ];
  const parts = keys
    .filter((key) => detail[key] !== undefined && detail[key] !== null && detail[key] !== false)
    .map((key) => `${key}: ${String(detail[key])}`);
  return parts.length > 0 ? parts.join('\n') : null;
}
