import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { withWritableSessionStubs } from './credential-stubs.js';

const stubPath = path.join(os.tmpdir(), 'onecli-stubs', `onecli-stub-test-${process.pid}.json`);
const caPath = path.join(os.tmpdir(), `onecli-proxy-ca-test-${process.pid}.pem`);
const sessionStubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-stubs-'));

afterEach(() => {
  fs.rmSync(stubPath, { force: true });
  fs.rmSync(caPath, { force: true });
  fs.rmSync(sessionStubDir, { recursive: true, force: true });
});

function gatewayArgs(): string[] {
  fs.mkdirSync(path.dirname(stubPath), { recursive: true });
  fs.writeFileSync(stubPath, '{"sentinel":true}', { mode: 0o600 });
  fs.writeFileSync(caPath, 'ca');
  return [
    '-e',
    'HTTPS_PROXY=http://proxy',
    '-v',
    `${caPath}:/tmp/onecli-proxy-ca.pem:ro`,
    '-v',
    `${stubPath}:/home/node/.codex/auth.json:ro`,
  ];
}

describe('withWritableSessionStubs', () => {
  it('mounts a writable per-session copy of each OneCLI credential stub', () => {
    const args = withWritableSessionStubs(gatewayArgs(), sessionStubDir);
    const sessionCopy = path.join(sessionStubDir, path.basename(stubPath));

    expect(args.at(-1)).toBe(`${sessionCopy}:/home/node/.codex/auth.json`);
    expect(fs.readFileSync(sessionCopy, 'utf8')).toBe('{"sentinel":true}');

    fs.writeFileSync(sessionCopy, '{"refreshed":true}');
    expect(fs.readFileSync(stubPath, 'utf8')).toBe('{"sentinel":true}');
  });

  it('leaves env flags and non-stub mounts untouched', () => {
    const original = gatewayArgs();
    const args = withWritableSessionStubs(original, sessionStubDir);

    expect(args.slice(0, 4)).toEqual(original.slice(0, 4));
  });

  it('replaces a previous session copy with the current stub', () => {
    const args = gatewayArgs();
    withWritableSessionStubs(args, sessionStubDir);
    fs.writeFileSync(path.join(sessionStubDir, path.basename(stubPath)), '{"refreshed":true}');

    withWritableSessionStubs(args, sessionStubDir);

    expect(fs.readFileSync(path.join(sessionStubDir, path.basename(stubPath)), 'utf8')).toBe('{"sentinel":true}');
  });
});
