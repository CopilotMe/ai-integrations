'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ACTION_TYPES, type ActionType } from '@/core/domain/types';

/**
 * The approve/reject control.
 *
 * `version` is the version of the case as rendered on this page and is sent
 * with the decision. If anything moved the case in the meantime, the server
 * refuses and the operator is told to reload — approving a case you are not
 * currently looking at is the failure mode this exists to prevent.
 */
export function ApprovalPanel({
  caseId,
  version,
  proposedAction,
  refundEur,
}: {
  caseId: string;
  version: number;
  proposedAction: ActionType;
  refundEur: number | null;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [action, setAction] = useState<ActionType>(proposedAction);
  const [amount, setAmount] = useState(refundEur?.toString() ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null);

  async function decide(kind: 'approve' | 'reject') {
    if (kind === 'reject' && reason.trim().length === 0) {
      setError('A reason is required when rejecting.');
      return;
    }
    setBusy(kind);
    setError(null);

    const response = await fetch(`/api/v1/messages/${caseId}/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expected_version: version,
        reason: reason.trim() || undefined,
        ...(kind === 'approve' && action !== proposedAction ? { override_action: action } : {}),
        ...(kind === 'approve' && amount && action === 'issue_refund'
          ? { override_refund_eur: Number(amount) }
          : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body?.error?.message ?? 'Something went wrong.');
      setBusy(null);
      return;
    }

    router.refresh();
  }

  return (
    <div style={{ marginTop: 17, paddingTop: 15, borderTop: '1px solid var(--rule)' }}>
      <div className="field">
        <label htmlFor="action">Authorise action</label>
        <select id="action" value={action} onChange={(e) => setAction(e.target.value as ActionType)}>
          {ACTION_TYPES.map((type) => (
            <option key={type} value={type}>
              {type.replace(/_/g, ' ')}
              {type === proposedAction ? '  (proposed)' : ''}
            </option>
          ))}
        </select>
      </div>

      {action === 'issue_refund' && (
        <div className="field">
          <label htmlFor="amount">Refund amount (EUR)</label>
          <input
            id="amount"
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      )}

      <div className="field">
        <label htmlFor="reason">Reason {action !== proposedAction && '(overriding the proposal)'}</label>
        <textarea
          id="reason"
          rows={2}
          placeholder="Recorded in the audit trail. Required to reject."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>

      <div className="actions-row">
        <button type="button" className="btn-approve" disabled={busy !== null} onClick={() => decide('approve')}>
          {busy === 'approve' ? 'Executing…' : 'Approve & execute'}
        </button>
        <button type="button" className="btn-reject" disabled={busy !== null} onClick={() => decide('reject')}>
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}
    </div>
  );
}
