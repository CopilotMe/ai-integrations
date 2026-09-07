import { notFound } from 'next/navigation';
import { ACTION_BLAST_RADIUS } from '@/core/policy/autonomy';
import { getDb } from '@/db/client';
import { getCaseDetail } from '@/db/repositories';
import { currentOperator } from '@/server/auth';
import { ApprovalPanel } from '@/components/approval-panel';
import { Ledger } from '@/components/ledger';
import { BlastMeter, ConfidenceGauge, StateBadge, absoluteTime } from '@/components/primitives';

export const dynamic = 'force-dynamic';

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [detail, operator] = await Promise.all([getCaseDetail(getDb(), id), currentOperator()]);
  if (!detail) notFound();

  const classification = detail.classifications[0];
  const decision = detail.policyDecisions[0];
  const executed = detail.actions.find((a) => a.status === 'succeeded');
  const canAct = detail.state === 'pending_approval' && operator?.role !== 'viewer';

  return (
    <>
      <a className="back-link" href="/">
        ← Back to queue
      </a>

      <div className="page-head">
        <div>
          <h1>{detail.message.subject || '(no subject)'}</h1>
          <p className="page-sub mono">
            case {detail.id.slice(0, 8)} · v{detail.version} · opened {absoluteTime(detail.openedAt)}
          </p>
        </div>
        <StateBadge state={detail.state} />
      </div>

      <div className="grid-2">
        <div style={{ display: 'grid', gap: 20 }}>
          <section className="panel">
            <div className="panel-head">
              <span>Inbound message</span>
              <span className="mono">{detail.message.source}</span>
            </div>
            <div className="panel-body">
              <p className="email-subject">{detail.message.subject || '(no subject)'}</p>
              <p className="email-meta mono">
                {detail.message.fromName ? `${detail.message.fromName} · ` : ''}
                {detail.message.fromEmail} → {detail.message.toEmail}
              </p>
              <div className="email-body">{detail.message.body}</div>
            </div>
          </section>

          {classification && (
            <section className="panel">
              <div className="panel-head">
                <span>Classification</span>
                <span className="mono">
                  {classification.model} · {classification.promptVersion}
                  {classification.degraded ? ' · DEGRADED' : ''}
                </span>
              </div>
              <div className="panel-body">
                <dl className="dl">
                  <dt>Intent</dt>
                  <dd className="mono">{classification.intent}</dd>
                  <dt>Urgency</dt>
                  <dd className="mono">{classification.urgency}</dd>
                  <dt>Confidence</dt>
                  <dd>
                    <ConfidenceGauge
                      actual={Number(classification.confidence)}
                      required={decision ? Number(decision.requiredConfidence) : 1}
                    />
                  </dd>
                  <dt>Proposed</dt>
                  <dd className="mono">{classification.proposedAction.replace(/_/g, ' ')}</dd>
                  <dt>Blast radius</dt>
                  <dd>
                    <BlastMeter radius={ACTION_BLAST_RADIUS[classification.proposedAction]} />
                  </dd>
                  {classification.refundAmountEur && (
                    <>
                      <dt>Refund</dt>
                      <dd className="mono">EUR {Number(classification.refundAmountEur).toFixed(2)}</dd>
                    </>
                  )}
                  <dt>Summary</dt>
                  <dd>{classification.summary}</dd>
                  <dt>Reasoning</dt>
                  <dd style={{ color: 'var(--ink-2)' }}>{classification.reasoning}</dd>
                </dl>

                {classification.evidence.length > 0 && (
                  <div style={{ marginTop: 15 }}>
                    <div className="rail-label" style={{ padding: '0 0 7px' }}>
                      Evidence from the message
                    </div>
                    {classification.evidence.map((quote, i) => (
                      <p key={i} className="quote">
                        {quote}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}
        </div>

        <div style={{ display: 'grid', gap: 20 }}>
          {decision && (
            <section className="panel">
              <div className="panel-head">
                <span>Policy decision</span>
                <span className="mono">{decision.decidedBy}</span>
              </div>
              <div className="panel-body">
                <div className={`verdict verdict-${decision.verdict}`}>
                  <div className="verdict-title">
                    {decision.verdict === 'auto_execute' ? 'Executed automatically' : 'Held for a human'}
                  </div>
                  <div className="verdict-detail">
                    {decision.triggeredRules[0]?.detail ??
                      `Confidence ${Number(decision.actualConfidence).toFixed(2)} cleared the ${Number(decision.requiredConfidence).toFixed(2)} threshold for a ${decision.blastRadius}-blast-radius action.`}
                  </div>
                </div>

                {decision.triggeredRules.length > 0 && (
                  <div>
                    <div className="rail-label" style={{ padding: '0 0 7px' }}>
                      Rules that fired
                    </div>
                    {decision.triggeredRules.map((rule) => (
                      <span key={rule.rule} className="rule-chip mono">
                        {rule.rule}
                      </span>
                    ))}
                  </div>
                )}

                {executed?.externalRef && (
                  <dl className="dl" style={{ marginTop: 13 }}>
                    <dt>Reference</dt>
                    <dd className="mono">{executed.externalRef}</dd>
                  </dl>
                )}

                {canAct && classification && (
                  <ApprovalPanel
                    caseId={detail.id}
                    version={detail.version}
                    proposedAction={classification.proposedAction}
                    refundEur={classification.refundAmountEur ? Number(classification.refundAmountEur) : null}
                  />
                )}
                {detail.state === 'pending_approval' && operator?.role === 'viewer' && (
                  <p className="page-sub" style={{ marginTop: 13 }}>
                    Your account is read-only, so you cannot approve or reject.
                  </p>
                )}
              </div>
            </section>
          )}

          <section className="panel">
            <div className="panel-head">
              <span>Decision ledger</span>
              <span className="mono">{detail.audit.length} entries</span>
            </div>
            <div className="panel-body">
              <Ledger entries={detail.audit} />
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
