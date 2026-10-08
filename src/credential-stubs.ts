import fs from 'fs';
import os from 'os';
import path from 'path';

const ONECLI_STUB_DIR = path.join(os.tmpdir(), 'onecli-stubs');

export function withWritableSessionStubs(gatewayArgs: string[], sessionStubDir: string): string[] {
  return gatewayArgs.map((arg, i) => {
    if (gatewayArgs[i - 1] !== '-v') return arg;
    const [hostPath, containerPath, mode] = arg.split(':');
    if (mode !== 'ro' || path.dirname(hostPath) !== ONECLI_STUB_DIR) return arg;
    fs.mkdirSync(sessionStubDir, { recursive: true });
    const sessionCopy = path.join(sessionStubDir, path.basename(hostPath));
    fs.copyFileSync(hostPath, sessionCopy);
    return `${sessionCopy}:${containerPath}`;
  });
}
