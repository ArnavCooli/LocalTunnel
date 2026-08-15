import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { utils } from 'ssh2';

const run = promisify(execFile);

/**
 * Finding the SSH credentials the user already has.
 *
 * Most people setting up a VPS already have a key — either loaded in their agent or
 * sitting in ~/.ssh, with the public half already pasted into their provider. Making
 * them hunt for the private key in a file dialog is pointless friction, and it also
 * nudges people towards copying keys around, which is worse for them.
 */

export interface DetectedKey {
  path: string;
  /** ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256… */
  type: string;
  /** Encrypted keys need a passphrase before they can be used. */
  encrypted: boolean;
  /** Whether the matching .pub file is present — the half the provider needs. */
  hasPublicHalf: boolean;
  comment: string | null;
}

export interface AgentStatus {
  available: boolean;
  /** Identities the agent is currently holding. */
  identities: string[];
  /** The socket/pipe ssh2 should talk to. */
  socket: string | null;
  reason?: string;
}

export interface SshCredentials {
  agent: AgentStatus;
  keys: DetectedKey[];
  /** So the UI can shorten paths to `~/.ssh/…` — the renderer has no os access. */
  home: string;
}

/** The agent socket for this platform, if there is one. */
export function agentSocket(): string | null {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  // Windows OpenSSH exposes the agent as a named pipe; PuTTY users have Pageant.
  if (platform() === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent';
  return null;
}

export async function detectAgent(): Promise<AgentStatus> {
  const socket = agentSocket();
  if (!socket) {
    return { available: false, identities: [], socket: null, reason: 'No SSH agent is running.' };
  }
  try {
    const { stdout } = await run('ssh-add', ['-l'], { timeout: 5000 });
    const identities = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      // "256 SHA256:abc… you@host (ED25519)" — the comment is the useful part.
      .map((line) => {
        const parts = line.split(/\s+/);
        return parts.slice(2).join(' ') || line;
      });
    return { available: identities.length > 0, identities, socket };
  } catch (err) {
    // `ssh-add -l` exits 1 when the agent holds no keys, 2 when it cannot connect.
    const code = (err as { code?: number }).code;
    return {
      available: false,
      identities: [],
      socket,
      reason:
        code === 1
          ? 'Your SSH agent is running but has no keys loaded. Run `ssh-add` to add one.'
          : 'No SSH agent is running.',
    };
  }
}

const CANDIDATE_NAMES = ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa'];

/**
 * Private keys in ~/.ssh. Keys are parsed rather than pattern-matched, so a file
 * only shows up if it really is a usable private key.
 */
export function detectKeyFiles(dir = join(homedir(), '.ssh')): DetectedKey[] {
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const found: DetectedKey[] = [];
  for (const name of entries) {
    if (name.endsWith('.pub') || name === 'known_hosts' || name === 'config' || name === 'authorized_keys') {
      continue;
    }
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      // Private keys are small; skip anything implausible before reading it.
      if (statSync(path).size > 64 * 1024) continue;
      const contents = readFileSync(path, 'utf8');
      if (!contents.includes('PRIVATE KEY')) continue;

      const parsed = utils.parseKey(contents);
      if (parsed instanceof Error) {
        // An encrypted key parses only with its passphrase; that specific failure
        // still tells us it is a real key.
        if (/passphrase/i.test(parsed.message)) {
          found.push({
            path,
            type: guessType(contents),
            encrypted: true,
            hasPublicHalf: existsSync(`${path}.pub`),
            comment: null,
          });
        }
        continue;
      }
      const key = Array.isArray(parsed) ? parsed[0] : parsed;
      found.push({
        path,
        type: key.type,
        encrypted: false,
        hasPublicHalf: existsSync(`${path}.pub`),
        comment: key.comment || null,
      });
    } catch {
      /* unreadable file — skip it */
    }
  }

  // Conventional key names first, then the rest alphabetically.
  return found.sort((a, b) => {
    const rank = (k: DetectedKey) => {
      const base = k.path.split(/[\\/]/).pop()!;
      const index = CANDIDATE_NAMES.indexOf(base);
      return index === -1 ? CANDIDATE_NAMES.length : index;
    };
    return rank(a) - rank(b) || a.path.localeCompare(b.path);
  });
}

function guessType(contents: string): string {
  if (contents.includes('OPENSSH PRIVATE KEY')) return 'openssh';
  if (contents.includes('RSA PRIVATE KEY')) return 'ssh-rsa';
  if (contents.includes('EC PRIVATE KEY')) return 'ecdsa';
  return 'unknown';
}

export async function detectSshCredentials(): Promise<SshCredentials> {
  const [agent, keys] = await Promise.all([detectAgent(), Promise.resolve(detectKeyFiles())]);
  return { agent, keys, home: homedir() };
}
