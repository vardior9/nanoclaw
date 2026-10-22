import fs from 'fs';
import path from 'path';

export async function resolveCodexAccountId(
  authPath = path.join(process.env.CODEX_HOME || path.join(process.env.HOME || '/home/node', '.codex'), 'auth.json'),
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  if (!fs.existsSync(authPath)) return;
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  if (auth.auth_mode !== 'chatgpt' || auth.tokens?.account_id !== 'onecli-managed') return;

  const response = await request('https://chatgpt.com/backend-api/wham/accounts/check', {
    headers: { Authorization: 'Bearer onecli-managed', 'ChatGPT-account-id': 'onecli-managed' },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Codex account discovery failed (HTTP ${response.status})`);
  const discovery = (await response.json()) as { accounts?: Array<{ id?: string }>; default_account_id?: string };
  const account = Array.isArray(discovery.accounts) ? discovery.accounts[0] : undefined;
  if (
    discovery.accounts?.length !== 1 ||
    typeof account?.id !== 'string' ||
    !account.id ||
    account.id !== discovery.default_account_id
  ) {
    throw new Error('Codex account discovery must identify exactly one default workspace');
  }

  fs.writeFileSync(authPath, JSON.stringify({ ...auth, tokens: { ...auth.tokens, account_id: account.id } }));
}
