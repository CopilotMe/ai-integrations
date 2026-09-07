'use client';

import { useRouter } from 'next/navigation';

export function SignOut() {
  const router = useRouter();
  return (
    <button
      type="button"
      style={{ padding: '5px 10px', fontSize: 11 }}
      onClick={async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        router.replace('/login');
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
