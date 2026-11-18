// Resolves which event stream a session belongs to, and where it lives on disk.
//
// The stream lives under the user's home directory, NOT in the project: ICs run in
// git worktrees, so a project-relative path would fragment the log into one stream
// per worktree and the analyst would only ever see a fraction of it.
//
// The name comes from `stream:` in the project profile, which is committed, so every
// worktree resolves the same name. Unconfigured projects fall back to the starting
// directory's name so two of them don't silently share one stream.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { profileKey } from './profile.mjs';

export function resolveStreamName(startDir) {
  const start = resolve(startDir || process.cwd());
  return profileKey(start, 'stream') || basename(start) || 'default';
}

export function streamDir(startDir) {
  const d = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'myco', 'ops', resolveStreamName(startDir));
  mkdirSync(d, { recursive: true });
  return d;
}
