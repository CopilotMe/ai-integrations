import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getDb } from '@/db/client';
import { countCasesByState } from '@/db/repositories';
import { config } from '@/lib/config';
import { currentOperator } from '@/server/auth';
import { SignOut } from '@/components/sign-out';

export const dynamic = 'force-dynamic';

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const operator = await currentOperator();
  if (!operator) redirect('/login');

  const counts = await countCasesByState(getDb());
  const waiting = counts.pending_approval ?? 0;
  const c = config();

  return (
    <div className="shell">
      <nav className="rail">
        <div className="brand">
          <span className="brand-mark" />
          <span>
            <span className="brand-name">Operations Console</span>
            <br />
            <span className="brand-sub mono">AI triage · human approval</span>
          </span>
        </div>

        <div className="rail-group">
          <div className="rail-label">Queue</div>
          <a className="rail-link" href="/">
            <span>Needs approval</span>
            <span className={`rail-count mono ${waiting > 0 ? 'is-waiting' : ''}`}>{waiting}</span>
          </a>
          <a className="rail-link" href="/?state=executed">
            <span>Executed</span>
            <span className="rail-count mono">{counts.executed ?? 0}</span>
          </a>
          <a className="rail-link" href="/?state=rejected">
            <span>Rejected</span>
            <span className="rail-count mono">{counts.rejected ?? 0}</span>
          </a>
          <a className="rail-link" href="/?state=failed">
            <span>Failed</span>
            <span className="rail-count mono">{counts.failed ?? 0}</span>
          </a>
          <a className="rail-link" href="/?state=all">
            <span>All cases</span>
            <span className="rail-count mono">
              {Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0)}
            </span>
          </a>
        </div>

        <div className="rail-group">
          <div className="rail-label">Record</div>
          <a className="rail-link" href="/audit">
            <span>Audit log</span>
          </a>
        </div>

        <div className="rail-foot">
          <div>
            <div style={{ color: 'var(--ink-2)' }}>{operator.name}</div>
            <div className="mono">{operator.role}</div>
          </div>
          <div className="mono" style={{ fontSize: 10 }}>
            model: {c.LLM_PROVIDER} · exec: {c.TICKETING_PROVIDER}
          </div>
          <SignOut />
        </div>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
