import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveCodexAccountId } from './codex-auth.js';

const temporaryDirectories: string[] = [];

function authFile(accountId = 'onecli-managed'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-routing-'));
  temporaryDirectories.push(dir);
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { account_id: accountId, access_token: 'onecli-managed', refresh_token: 'onecli-managed' },
    }),
  );
  return file;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Codex account routing through OneCLI', () => {
  it('resolves the sole default account without changing credential placeholders', async () => {
    const file = authFile();
    await resolveCodexAccountId(file, async (url, init) => {
      expect(url).toBe('https://chatgpt.com/backend-api/wham/accounts/check');
      expect(init.headers).toEqual({ Authorization: 'Bearer onecli-managed', 'ChatGPT-account-id': 'onecli-managed' });
      return Response.json({ accounts: [{ id: 'workspace-a' }], default_account_id: 'workspace-a' });
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      auth_mode: 'chatgpt',
      tokens: { account_id: 'workspace-a', access_token: 'onecli-managed', refresh_token: 'onecli-managed' },
    });
  });

  it('leaves an existing account selection untouched without making a request', async () => {
    const file = authFile('workspace-b');
    const original = fs.readFileSync(file, 'utf8');
    await resolveCodexAccountId(file, async () => {
      throw new Error('Unexpected discovery');
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('preserves the stub when discovery fails or cannot identify one default account', async () => {
    for (const response of [
      Response.json({}, { status: 401 }),
      Response.json({ accounts: [{ id: 'workspace-a' }, { id: 'workspace-b' }], default_account_id: 'workspace-a' }),
      Response.json({ accounts: [{ id: 'workspace-a' }], default_account_id: 'workspace-b' }),
      Response.json({ accounts: [] }),
      Response.json({ accounts: { 0: { id: 'workspace-a' }, length: 1 }, default_account_id: 'workspace-a' }),
    ]) {
      const file = authFile();
      const original = fs.readFileSync(file, 'utf8');
      await expect(resolveCodexAccountId(file, async () => response)).rejects.toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
    }
  });
});
