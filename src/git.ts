import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const execute = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execute('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return args.includes('-z') ? stdout : stdout.trimEnd();
  } catch (error) {
    const failure = error as Error & {
      stderr?: string;
      code?: number | string
    };
    throw Object.assign(
      new Error(`git ${args.join(' ')} 실패: ${failure.stderr || failure.message}`), { code: failure.code },
    );
  }
}
async function query(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch (error) {
    if (typeof (error as { code?: unknown }).code === 'number') return null;
    throw error;
  }
}
export async function isGitRepo(cwd: string): Promise<boolean> {
  return await query(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
}
export async function hasCommit(cwd: string): Promise<boolean> {
  return await resolveRef(cwd, 'HEAD') !== null;
}
export async function headSha(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', 'HEAD']);
}
export async function resolveRef(cwd: string, ref: string): Promise<string | null> {
  return query(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
}
export async function statusPorcelain(cwd: string): Promise<string> {
  return git(cwd, ['status', '--porcelain']);
}
const paths = (text: string) => text ? text.slice(0, -1).split('\0') : [];
export async function diffNameOnly(cwd: string, from: string, to = 'HEAD'): Promise<string[]> {
  return paths(await git(cwd, ['diff', '--name-only', '-z', from, to, '--']));
}
export async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}
export async function addExcludes(workspace: string, patterns: string[]): Promise<void> {
  const common = resolve(workspace, await git(workspace, ['rev-parse', '--git-common-dir']));
  const path = join(common, 'info', 'exclude');
  await mkdir(join(common, 'info'), { recursive: true });
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const existing = new Set(text.split(/\r?\n/));
  const missing = patterns.filter(pattern => {
    if (existing.has(pattern)) return false;
    existing.add(pattern);
    return true;
  });
  if (missing.length) await appendFile(path, (text && !text.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
}
export async function worktreeAdd(workspace: string, path: string, branch: string, startPoint: string): Promise<void> {
  await git(workspace, ['worktree', 'add', '-b', branch, path, startPoint]);
}
export async function worktreeRemove(workspace: string, path: string, force = false): Promise<void> {
  await git(workspace, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
}
export async function branchDelete(workspace: string, branch: string): Promise<void> {
  await git(workspace, ['branch', '-D', branch]);
}
async function commit(cwd: string, message: string): Promise<string | null> {
  try {
    await git(cwd, ['diff', '--cached', '--quiet']);
    return null;
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error;
  }
  await git(cwd, ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', message]);
  return headSha(cwd);
}
export async function commitAll(cwd: string, message: string): Promise<string | null> {
  await git(cwd, ['add', '-A']);
  return commit(cwd, message);
}
export async function squash(cwd: string, stageBase: string, message: string): Promise<string | null> {
  await git(cwd, ['reset', '--soft', stageBase]);
  return commit(cwd, message);
}
export async function restore(cwd: string, sha: string): Promise<void> {
  await git(cwd, ['reset', '--hard', sha]);
  await git(cwd, ['clean', '-fd']);
}
export async function merge(
  cwd: string, branch: string,
): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
  try {
    // merge가 만드는 커밋에도 서명과 훅을 비활성화한다.
    await git(cwd, ['-c', 'commit.gpgsign=false', 'merge', '--no-verify', '--no-ff', '--no-edit', branch]);
    return { ok: true };
  } catch (error) {
    const conflicts = paths(await git(cwd, ['diff', '--name-only', '-z', '--diff-filter=U']));
    if (!conflicts.length) throw error;
    await git(cwd, ['merge', '--abort']);
    return { ok: false, conflicts };
  }
}

export async function worktreePrune(workspace: string): Promise<void> {
  await git(workspace, ['worktree', 'prune']);
}
export async function laneBranches(workspace: string, runId: string): Promise<string[]> {
  return (await git(workspace, ['for-each-ref', '--format=%(refname:short)', `refs/heads/aw/${runId}-lane-*`]))
    .split('\n').filter(Boolean);
}
