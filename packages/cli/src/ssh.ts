import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The SSH sign-in the desktop app does, done with the system `ssh` and `scp`.
 *
 * The app carries an SSH library because it has no terminal to prompt on; here
 * there is one, so shelling out is both smaller and better behaved — it picks up
 * ~/.ssh/config, your agent, jump hosts and known_hosts exactly as your own `ssh`
 * does, and key passphrase and sudo prompts appear where you expect them.
 */

export interface SshTarget {
  host: string;
  username: string;
  port: number;
  /** Explicit key file; empty means "whatever ssh would use by itself". */
  identityFile: string | null;
}

export interface RemoteResult {
  code: number;
  /** Everything the far end wrote, in the order it arrived. */
  output: string;
}

export class SshError extends Error {}

export function destination(target: SshTarget): string {
  return target.username ? `${target.username}@${target.host}` : target.host;
}

function commonArgs(target: SshTarget): string[] {
  const args = ['-o', 'StrictHostKeyChecking=accept-new'];
  if (target.identityFile) args.push('-o', 'IdentitiesOnly=yes', '-i', target.identityFile);
  return args;
}

type OnOutput = (text: string) => void;

function run(command: string, args: string[], onOutput: OnOutput): Promise<RemoteResult> {
  return new Promise((resolve, reject) => {
    // stdin is inherited so passphrase and sudo prompts can be answered; stdout and
    // stderr are piped so the transcript can be parsed, and echoed as they arrive.
    const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output += text;
      onOutput(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        new SshError(
          err.code === 'ENOENT'
            ? `No \`${command}\` command was found on this computer. Install an OpenSSH client and try again.`
            : err.message,
        ),
      );
    });
    child.once('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

/** Run a command on the server, without a terminal and without sudo. */
export function remoteExec(target: SshTarget, command: string, onOutput: OnOutput): Promise<RemoteResult> {
  return run('ssh', [...commonArgs(target), '-p', String(target.port), destination(target), command], onOutput);
}

/**
 * Run a bash script as root on the server.
 *
 * The script goes over the command line base64-encoded rather than on stdin,
 * because stdin has to stay free for the sudo prompt — which, thanks to `-t`,
 * lands on the terminal the user is sitting at.
 */
export function remoteScript(target: SshTarget, script: string, onOutput: OnOutput): Promise<RemoteResult> {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  // The script is about to be run as root, so it must not land at a path another
  // account on that server could have created first — a symlink at a predictable
  // /tmp name, or a file swapped in between the write and the sudo. `mktemp`
  // gives a fresh name nobody can guess, created 0600 under the caller's umask.
  const command = [
    'set -e',
    'umask 077',
    'LT_STEP="$(mktemp "${TMPDIR:-/tmp}/lt-cli-step.XXXXXXXXXX")"',
    'trap \'rm -f "$LT_STEP"\' EXIT',
    `printf %s '${encoded}' | base64 -d > "$LT_STEP"`,
    'if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi',
    '$SUDO bash "$LT_STEP"; STATUS=$?',
    'exit $STATUS',
  ].join('\n');
  return run(
    'ssh',
    ['-t', ...commonArgs(target), '-p', String(target.port), destination(target), command],
    onOutput,
  );
}

/** Copy a local file to the server, as the login user. */
export function upload(
  target: SshTarget,
  localPath: string,
  remotePath: string,
  onOutput: OnOutput,
): Promise<RemoteResult> {
  return run(
    'scp',
    [...commonArgs(target), '-P', String(target.port), localPath, `${destination(target)}:${remotePath}`],
    onOutput,
  );
}

/* ------------------------------------------------------------------- keys */

export interface PrivateKey {
  path: string;
  /** Basename, which is how people refer to their keys. */
  name: string;
  /** ssh-ed25519, ssh-rsa, … when the matching .pub says so. */
  type: string | null;
  /** The comment on the public key — usually who made it and where. */
  comment: string | null;
  encrypted: boolean;
}

const NOT_KEYS = new Set([
  'config',
  'known_hosts',
  'known_hosts.old',
  'authorized_keys',
  'authorized_keys2',
  'environment',
  'rc',
  'agent',
]);

export function sshDir(): string {
  return join(homedir(), '.ssh');
}

/**
 * The private keys sitting in ~/.ssh.
 *
 * Identified by reading the file rather than by naming convention, because keys
 * are called all sorts of things — `id_ed25519`, `oracle.key`, `Coders`. Newest
 * first, since a key made for this server is usually the one wanted.
 */
export function discoverPrivateKeys(dir = sshDir()): PrivateKey[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const keys: { key: PrivateKey; mtime: number }[] = [];
  for (const name of names) {
    if (name.endsWith('.pub') || NOT_KEYS.has(name) || name.startsWith('.')) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > 64 * 1024) continue;
      const text = readFileSync(path, 'utf8');
      const header = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----/.exec(text);
      if (!header) continue;
      keys.push({
        key: { path, name, encrypted: isEncrypted(text), ...describePublicKey(`${path}.pub`) },
        mtime: stat.mtimeMs,
      });
    } catch {
      // Unreadable (wrong owner, or a directory) — not a key this user can offer.
    }
  }

  return keys.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.key);
}

function isEncrypted(text: string): boolean {
  // Classic PEM says so in a header; OpenSSH's own format names the cipher in the
  // base64 body, where "none" means the key is not protected by a passphrase.
  if (/Proc-Type:\s*4,ENCRYPTED/.test(text)) return true;
  const body = text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  try {
    const decoded = Buffer.from(body, 'base64').subarray(0, 64).toString('latin1');
    if (decoded.startsWith('openssh-key-v1')) return !decoded.includes('none');
  } catch {
    /* not base64 we understand; fall through */
  }
  return false;
}

function describePublicKey(path: string): { type: string | null; comment: string | null } {
  try {
    const parts = readFileSync(path, 'utf8').trim().split(/\s+/);
    return { type: parts[0] ?? null, comment: parts.length > 2 ? parts.slice(2).join(' ') : null };
  } catch {
    return { type: null, comment: null };
  }
}

/* ---------------------------------------------------------------- parsing */

/** Pull a `MARKER {...}` line out of a remote transcript. */
export function markerPayload<T>(output: string, marker: string): T | null {
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.trim().startsWith(`${marker} `));
  if (!line) return null;
  try {
    return JSON.parse(line.trim().slice(marker.length + 1)) as T;
  } catch {
    return null;
  }
}

/** The `ERROR: …` line the scripts print for anything they detect themselves. */
export function remoteError(output: string): string | null {
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.trim().startsWith('ERROR: '));
  return line ? line.trim().slice(7).trim() : null;
}

/** Turn an exit status and a transcript into something worth reading. */
export function explainFailure(code: number, output: string): string {
  const explicit = remoteError(output);
  if (explicit) return explicit;
  if (code === 255 || /^ssh: /m.test(output)) {
    if (/Permission denied/i.test(output)) {
      return 'SSH refused the login. Check the username, and that this key is authorised on the server.';
    }
    if (/Could not resolve|Name or service not known|nodename nor servname/i.test(output)) {
      return 'That address could not be resolved.';
    }
    if (/Connection refused/i.test(output)) return 'Nothing accepted SSH on that address and port.';
    if (/Connection timed out|Operation timed out/i.test(output)) {
      return 'The SSH connection timed out. Check the address, and that port 22 is open in your provider\'s firewall.';
    }
    if (/HOST IDENTIFICATION HAS CHANGED/i.test(output)) {
      return 'The server\'s SSH host key has changed since you last connected. Resolve that in ~/.ssh/known_hosts first.';
    }
    return 'SSH could not connect — see the output above.';
  }
  if (/is not in the sudoers/i.test(output)) return 'That user is not allowed to run sudo on the server.';
  if (/Sorry, try again|password is required/i.test(output)) return 'sudo did not accept that password.';
  return `The server returned status ${code} — see the output above.`;
}
