import { getDb } from '@/db/client';
import { listAudit } from '@/db/repositories';
import { absoluteTime } from '@/components/primitives';

export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  const entries = await listAudit(getDb(), { limit: 300 });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p className="page-sub">
            Append-only. The database rejects updates and deletes on this table — see{' '}
            <code className="mono">drizzle/0001_audit_log_append_only.sql</code>.
          </p>
        </div>
        <span className="mono" style={{ color: 'var(--ink-3)', fontSize: 12 }}>
          {entries.length} most recent
        </span>
      </div>

      <div className="queue">
        <div className="queue-head" style={{ gridTemplateColumns: '168px 200px minmax(0,1fr) 190px' }}>
          <span>When</span>
          <span>Event</span>
          <span>Actor</span>
          <span>Transition</span>
        </div>
        {entries.length === 0 ? (
          <div className="empty">No audit entries yet.</div>
        ) : (
          entries.map((entry, index) => (
            <a
              key={entry.id}
              className="queue-row"
              href={entry.caseId ? `/cases/${entry.caseId}` : '#'}
              style={{
                gridTemplateColumns: '168px 200px minmax(0,1fr) 190px',
                animationDelay: `${Math.min(index * 8, 300)}ms`,
              }}
            >
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
                {absoluteTime(entry.createdAt)}
              </span>
              <span className="mono" style={{ fontSize: 12 }}>
                {entry.event}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 12,
                  color: entry.actorKind === 'operator' ? 'var(--signal)' : 'var(--ink-2)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {entry.actorLabel}
              </span>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
                {entry.fromState && entry.toState ? `${entry.fromState} → ${entry.toState}` : '—'}
              </span>
            </a>
          ))
        )}
      </div>
    </>
  );
}
