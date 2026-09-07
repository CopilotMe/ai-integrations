import { redirect } from 'next/navigation';
import { currentOperator } from '@/server/auth';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (await currentOperator()) redirect('/');

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark" />
          <span>
            <span className="brand-name">Operations Console</span>
          </span>
        </div>
        <h1 className="login-title">Sign in</h1>
        <p className="page-sub" style={{ marginBottom: 22 }}>
          Approvals are recorded against your account.
        </p>
        <LoginForm />
        <p className="login-hint">
          Local development seeds three accounts —{' '}
          <code className="mono">admin@example.com</code>,{' '}
          <code className="mono">agent@example.com</code>,{' '}
          <code className="mono">viewer@example.com</code> — all with the password printed by{' '}
          <code className="mono">npm run db:seed</code>.
        </p>
      </div>
    </div>
  );
}
