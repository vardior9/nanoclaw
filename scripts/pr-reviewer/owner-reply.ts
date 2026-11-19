import { readEnvFile } from '../../src/env.js';
import {
  ensureBareClone,
  fetchPrRefs,
  getCommitDelta,
  getPrDetail,
  getUnresolvedSelfReviewThreads,
  loadState,
  parsePrKey,
} from './lib.js';
import { formatOwnerReplyMessage } from './prompts.js';

const [, , key, wakeId] = process.argv;
if (!key || !wakeId) throw new Error('Expected a PR key and wake id');

const known = loadState()[key];
if (known) {
  const { owner, repo, number } = parsePrKey(key);
  const selfLogin = (process.env.PR_SELF_LOGIN ?? readEnvFile(['PR_SELF_LOGIN']).PR_SELF_LOGIN)?.trim();
  if (!selfLogin) throw new Error('PR_SELF_LOGIN is required for reviewer owner replies');

  const detail = getPrDetail(owner, repo, number);
  if (!detail.ok) throw new Error(detail.error);
  const pr = detail.data;
  if (!/^[0-9a-f]{40}$/.test(pr.head.sha)) throw new Error('GitHub did not return an exact PR head');
  const clone = ensureBareClone(owner, repo, false);
  if (!clone.ok) throw new Error(clone.error);
  const fetched = fetchPrRefs(owner, repo, number, pr.base.ref, false, pr.head.sha);
  if (!fetched.ok) throw new Error(fetched.error);

  const delta = known.head_sha === pr.head.sha ? null : getCommitDelta(owner, repo, known.head_sha, pr.head.sha);
  const threads = getUnresolvedSelfReviewThreads(owner, repo, number, selfLogin);
  const deltaContext = delta && (delta.ok ? delta.context : `Commit delta unavailable: ${delta.error}`);
  const unresolvedContext = threads.ok ? threads.context : `Thread context unavailable: ${threads.error}`;
  const text = formatOwnerReplyMessage(owner, repo, pr, deltaContext, unresolvedContext, wakeId);
  process.stdout.write(JSON.stringify({ headSha: pr.head.sha, text }));
}
