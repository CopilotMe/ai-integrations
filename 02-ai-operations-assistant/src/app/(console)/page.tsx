import { CASE_STATES, type CaseState } from '@/core/domain/types';
import { ACTION_BLAST_RADIUS } from '@/core/policy/autonomy';
import { getDb } from '@/db/client';
import { countCasesByState, listCases } from '@/db/repositories';
import { BlastMeter, StateBadge, relativeTime } from '@/components/primitives';

export const dynamic = 'force-dynamic';

const FILTERS: Array<{ label: string; value: string }> = [
  { label: 'Needs approval', value: 'pending_approval' },
  { label: 'Executed', value: 'executed' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'Failed', value: 'failed' },
  { label: 'All', value: 'all' },
];

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const params = await searchParams;
  const selected = params.state ?? 'pending_approval';
  const db = getDb();

  const states =
    selected === 'all'
      ? undefined
      : CASE_STATES.includes(selected as CaseState)
        ? [selected as CaseState]
        : (['pending_approval'] as CaseState[]);

  const [rows, counts] = await Promise.all([listCases(db, { states, limit: 100 }), countCasesByState(db)]);
  const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Review queue</h1>
          <p className="page-sub">
            Every action the assistant proposed, and what the policy decided to do about it.
          </p>
        </div>
      </div>

      <div className="tiles">
        <Tile n={counts.pending_approval ?? 0} k="awaiting a human" waiting />
        <Tile n={counts.executed ?? 0} k="executed" />
        <Tile n={counts.rejected ?? 0} k="rejected" />
        <Tile n={(counts.failed ?? 0) + (counts.dead_lettered ?? 0)} k="failed" />
        <Tile n={total} k="cases total" />
      </div>

      <div className="filters">
        {FILTERS.map((filter) => (
          <a
            key={filter.value}
            className="filter"
            href={`/?state=${filter.value}`}
            aria-current={selected === filter.value}
          >
            {filter.label}
          </a>
        ))}
      </div>

      <div className="queue">
        <div className="queue-head">
          <span>State</span>
          <span>Message</span>
          <span>Proposed action</span>
          <span>Blast</span>
          <span style={{ textAlign: 'right' }}>Age</span>
        </div>

        {rows.length === 0 ? (
          <div className="empty">
            Nothing here. Post a message to <code className="mono">/api/v1/messages</code> or run{' '}
            <code className="mono">npm run demo</code>.
          </div>
        ) : (
          rows.map((row, index) => (
            <a
              key={row.case.id}
              className="queue-row"
              href={`/cases/${row.case.id}`}
              style={{ animationDelay: `${Math.min(index * 22, 400)}ms` }}
            >
              <StateBadge state={row.case.state} />
              <span className="queue-subject">
                {row.message.subject || '(no subject)'}
                <span className="queue-from mono" style={{ display: 'block' }}>
                  {row.message.fromEmail}
                </span>
              </span>
              <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                {row.classification?.proposedAction?.replace(/_/g, ' ') ?? '—'}
              </span>
              {row.classification ? (
                <BlastMeter radius={ACTION_BLAST_RADIUS[row.classification.proposedAction]} />
              ) : (
                <span className="mono" style={{ color: 'var(--ink-3)' }}>—</span>
              )}
              <span
                className="mono"
                style={{ textAlign: 'right', fontSize: 11.5, color: 'var(--ink-3)' }}
              >
                {relativeTime(row.case.openedAt)}
              </span>
            </a>
          ))
        )}
      </div>
    </>
  );
}

function Tile({ n, k, waiting }: { n: number; k: string; waiting?: boolean }) {
  return (
    <div className="tile">
      <div className={`tile-n mono ${waiting && n > 0 ? 'is-waiting' : ''}`}>{n}</div>
      <div className="tile-k">{k}</div>
    </div>
  );
}
