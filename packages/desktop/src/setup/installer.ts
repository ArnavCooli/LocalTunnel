import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Client, type ConnectConfig } from 'ssh2';
import { agentSocket, secureKeyFile } from './ssh-keys.js';

/**
 * Installs the gateway on the user's VPS over SSH.
 *
 * This is the step that lets someone go from "I made a VM" to "I have a public
 * HTTPS endpoint" without opening a terminal. Every step reports progress so the
 * app can show what is happening rather than a spinner.
 */

export interface InstallTarget {
  host: string;
  port: number;
  username: string;
  /**
   * Path to the private key file, when one was chosen. Read for the duration of the
   * install and never copied into app storage. Optional: with `useAgent` the key
   * never leaves the SSH agent at all, which is the better option when available.
   */
  privateKeyPath?: string | null;
  /** Authenticate through the running SSH agent instead of reading a key file. */
  useAgent?: boolean;
  passphrase?: string;
  gatewayName: string;
  contactEmail?: string;
  /** Directory containing the built gateway (bundled with the app). */
  gatewayBundlePath: string;
  installerScriptPath: string;
  serviceUnitPath: string;
  /** Set by the integration tests to use a staging ACME directory. */
  acmeDirectoryUrl?: string;
}

export interface InstallStep {
  key: string;
  label: string;
}

export const INSTALL_STEPS: InstallStep[] = [
  { key: 'connect', label: 'Connecting to your server' },
  { key: 'verify-os', label: 'Checking the operating system' },
  { key: 'verify-arch', label: 'Checking the CPU architecture' },
  { key: 'verify-internet', label: 'Checking the server can reach the internet' },
  { key: 'upload', label: 'Uploading the LocalTunnel Gateway' },
  { key: 'dependencies', label: 'Installing dependencies' },
  { key: 'user', label: 'Creating a dedicated system user' },
  { key: 'config', label: 'Writing the configuration' },
  { key: 'identity', label: 'Generating the gateway identity' },
  { key: 'systemd', label: 'Installing the system service' },
  { key: 'firewall', label: 'Opening ports 80 and 443' },
  { key: 'start', label: 'Starting the gateway' },
  { key: 'verify-public', label: 'Testing the public endpoint' },
  { key: 'register', label: 'Registering the gateway' },
];

export interface InstallResult {
  ok: true;
  gatewayId: string;
  publicIp: string;
  adminToken: string;
  fingerprint: string;
  version: string;
}

export type InstallEvent =
  | { type: 'step'; key: string; label: string; state: 'running' | 'done' | 'failed' }
  | { type: 'output'; line: string }
  | { type: 'done'; result: InstallResult }
  | { type: 'error'; message: string; hint?: string };

export class GatewayInstaller extends EventEmitter {
  private client: Client | null = null;

  async run(target: InstallTarget): Promise<InstallResult> {
    this.validate(target);
    const client = new Client();
    this.client = client;

    try {
      this.step('connect', 'running');
      await this.connect(client, target);
      this.step('connect', 'done');

      // Steps 2-4 are checked here as well as in the script, so the app can give a
      // precise error before anything is uploaded.
      this.step('verify-os', 'running');
      const osRelease = await this.exec(client, 'cat /etc/os-release');
      if (!/ubuntu|debian|rocky|alma|centos|fedora|rhel/i.test(osRelease.stdout)) {
        throw new InstallError(
          'That server is not running a supported Linux distribution.',
          'LocalTunnel supports Ubuntu, Debian, Rocky, Alma and Fedora. Ubuntu 22.04 is the easiest choice.',
        );
      }
      this.emit('event', { type: 'output', line: firstLine(osRelease.stdout, 'PRETTY_NAME') });
      this.step('verify-os', 'done');

      this.step('verify-arch', 'running');
      const arch = (await this.exec(client, 'uname -m')).stdout.trim();
      if (!/x86_64|aarch64|arm64/.test(arch)) {
        throw new InstallError(`That server's CPU architecture (${arch}) is not supported.`);
      }
      this.emit('event', { type: 'output', line: `architecture: ${arch}` });
      this.step('verify-arch', 'done');

      this.step('verify-internet', 'running');
      const connectivity = await this.exec(
        client,
        'curl -fsS --max-time 15 -o /dev/null https://deb.nodesource.com/ && echo online || echo offline',
      );
      if (!connectivity.stdout.includes('online')) {
        throw new InstallError(
          'Your server cannot reach the internet.',
          'It needs outbound access to download Node.js and to request TLS certificates.',
        );
      }
      this.step('verify-internet', 'done');

      this.step('upload', 'running');
      await this.upload(client, target.gatewayBundlePath, '/tmp/localtunnel-gateway.tar.gz');
      await this.upload(client, target.installerScriptPath, '/tmp/localtunnel-install.sh');
      await this.upload(client, target.serviceUnitPath, '/tmp/localtunnel-gateway.service');
      this.step('upload', 'done');

      // The remaining steps happen inside install.sh, which streams progress lines
      // back. Mapping its "Step N/13" markers onto the UI keeps one source of truth.
      const result = await this.runInstaller(client, target);

      this.step('verify-public', 'running');
      const listening = await this.exec(client, "ss -ltn | grep -c ':443 ' || true");
      if (listening.stdout.trim() === '0') {
        throw new InstallError(
          'The gateway started but nothing is listening on port 443.',
          'Check `journalctl -u localtunnel-gateway -n 50` on the server.',
        );
      }
      this.step('verify-public', 'done');

      this.step('register', 'running');
      this.step('register', 'done');
      this.emit('event', { type: 'done', result });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = err instanceof InstallError ? err.hint : undefined;
      this.emit('event', { type: 'error', message, hint });
      throw err;
    } finally {
      this.client?.end();
      this.client = null;
    }
  }

  private validate(target: InstallTarget): void {
    if (!target.host.trim()) throw new InstallError('Enter your server\'s public IP address.');
    if (!target.username.trim()) throw new InstallError('Enter the SSH username (usually "ubuntu").');
    if (!target.useAgent && !target.privateKeyPath) {
      throw new InstallError(
        'Choose how to sign in to your server — your SSH agent, or a private key file.',
      );
    }
    if (target.privateKeyPath && !existsSync(target.privateKeyPath)) {
      throw new InstallError('That SSH private key file does not exist.');
    }
    if (target.useAgent && !agentSocket()) {
      throw new InstallError(
        'No SSH agent is available on this computer.',
        'Choose a private key file instead, or start an agent and run `ssh-add`.',
      );
    }
    if (!existsSync(target.gatewayBundlePath)) {
      throw new InstallError('The bundled gateway package is missing from this LocalTunnel install.');
    }
  }

  private connect(client: Client, target: InstallTarget): Promise<void> {
    return new Promise((resolve, reject) => {
      const config: ConnectConfig = {
        host: target.host,
        port: target.port || 22,
        username: target.username,
        readyTimeout: 25_000,
        // Trust on first use: the user just created this machine and typed its IP.
        // The gateway's own identity is pinned separately, after install.
        hostVerifier: () => true,
      };

      // Prefer the agent: the private key stays inside it and is never read by
      // LocalTunnel. A key file is used only when the user picked one, and both
      // may be set — ssh2 will try the agent first and fall back to the key.
      if (target.useAgent) config.agent = agentSocket() ?? undefined;
      if (target.privateKeyPath) {
        // Keys kept outside ~/.ssh (a provider download, say) are usually left
        // world-readable; tighten them so plain `ssh` works with them later too.
        secureKeyFile(target.privateKeyPath);
        config.privateKey = readFileSync(target.privateKeyPath);
        config.passphrase = target.passphrase;
      }

      client.once('ready', resolve);
      client.once('error', (err) => reject(translateSshError(err, target)));
      client.connect(config);
    });
  }

  private exec(client: Client, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        stream.on('close', (code: number) => resolve({ code: code ?? 0, stdout, stderr }));
      });
    });
  }

  private upload(client: Client, localPath: string, remotePath: string): Promise<void> {
    const size = statSync(localPath).size;
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(err);
        const readStream = createReadStream(localPath);
        const writeStream = sftp.createWriteStream(remotePath, { mode: 0o600 });
        let sent = 0;
        readStream.on('data', (chunk) => {
          sent += chunk.length;
          this.emit('event', {
            type: 'output',
            line: `uploading ${remotePath}: ${Math.round((sent / size) * 100)}%`,
          });
        });
        writeStream.on('close', () => resolve());
        writeStream.on('error', reject);
        readStream.on('error', reject);
        readStream.pipe(writeStream);
      });
    });
  }

  /** Run install.sh with sudo, mapping its progress markers onto the UI's steps. */
  private runInstaller(client: Client, target: InstallTarget): Promise<InstallResult> {
    const scriptStepToKey: Record<string, string> = {
      '4': 'dependencies',
      '5': 'upload',
      '6': 'user',
      '7': 'config',
      '8': 'identity',
      '9': 'systemd',
      '10': 'firewall',
      '12': 'start',
    };

    const flags = [
      '--bundle /tmp/localtunnel-gateway.tar.gz',
      `--public-ip ${shellQuote(target.host)}`,
      `--name ${shellQuote(target.gatewayName)}`,
    ];
    if (target.contactEmail) flags.push(`--email ${shellQuote(target.contactEmail)}`);
    if (target.acmeDirectoryUrl) flags.push(`--acme-directory ${shellQuote(target.acmeDirectoryUrl)}`);

    // install.sh reads its systemd unit from its own directory, so both files are
    // staged together under /tmp/lt-installer with the names the script expects.
    // `sudo -n` never waits for a password: on an image without passwordless sudo
    // it fails immediately with a message we can turn into a real explanation,
    // rather than hanging on a prompt that has no terminal to appear on.
    const command = [
      'set -e',
      'mkdir -p /tmp/lt-installer',
      'cp /tmp/localtunnel-install.sh /tmp/lt-installer/install.sh',
      'cp /tmp/localtunnel-gateway.service /tmp/lt-installer/localtunnel-gateway.service',
      'chmod +x /tmp/lt-installer/install.sh',
      'if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo -n"; fi',
      `$SUDO bash /tmp/lt-installer/install.sh ${flags.join(' ')}`,
    ].join('\n');

    return new Promise((resolve, reject) => {
      client.exec(command, { pty: false }, (err, stream) => {
        if (err) return reject(err);
        let buffer = '';
        let result: InstallResult | null = null;
        let lastStepKey: string | null = null;
        /** Kept so a failure can quote the server's own words back to the user. */
        const transcript: string[] = [];

        const consume = (text: string) => {
          buffer += text;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.trim()) transcript.push(line.trim());
            this.emit('event', { type: 'output', line: line.trimEnd() });

            const marker = /^==> Step (\d+)\/13:/.exec(line.trim());
            if (marker) {
              const key = scriptStepToKey[marker[1]];
              if (key) {
                if (lastStepKey && lastStepKey !== key) this.step(lastStepKey, 'done');
                this.step(key, 'running');
                lastStepKey = key;
              }
            }

            const payload = /^LOCALTUNNEL_RESULT (.+)$/.exec(line.trim());
            if (payload) {
              try {
                result = JSON.parse(payload[1]) as InstallResult;
              } catch {
                /* the close handler reports the failure */
              }
            }
          }
        };

        stream.on('data', (chunk: Buffer) => consume(chunk.toString()));
        stream.stderr.on('data', (chunk: Buffer) => consume(chunk.toString()));
        stream.on('close', (code: number) => {
          if (buffer.trim()) consume('\n');
          if (lastStepKey) this.step(lastStepKey, result ? 'done' : 'failed');
          if (result) return resolve(result);
          reject(explainInstallFailure(code, transcript));
        });
      });
    });
  }

  private step(key: string, state: 'running' | 'done' | 'failed'): void {
    const label = INSTALL_STEPS.find((s) => s.key === key)?.label ?? key;
    this.emit('event', { type: 'step', key, label, state });
  }
}

/**
 * Turn a failed install into something actionable.
 *
 * The script prints `ERROR: …` for anything it detects itself, so that line is the
 * best explanation available; otherwise fall back to the last thing the server said.
 * A generic "it did not finish" is the last resort, not the first.
 */
function explainInstallFailure(code: number, transcript: string[]): InstallError {
  const text = transcript.join('\n');
  const explicit = [...transcript].reverse().find((line) => line.startsWith('ERROR: '));

  if (/sudo: a password is required|is not in the sudoers/i.test(text)) {
    return new InstallError(
      'That account cannot run administrative commands without a password.',
      'LocalTunnel needs passwordless sudo, which cloud images normally provide. Use the image\'s default account — "ubuntu" on Ubuntu, "opc" on Oracle Linux, "root" on most others.',
    );
  }
  if (/No such file or directory/i.test(text) && /install\.sh/i.test(text)) {
    return new InstallError(
      'The installer could not be staged on your server.',
      'The upload may have been interrupted. Try again; if it persists, check there is free space in /tmp.',
    );
  }
  if (/No space left on device/i.test(text)) {
    return new InstallError('Your server has run out of disk space.', 'Free some space and try again.');
  }
  if (/Could not get lock|dpkg was interrupted|Unable to acquire the dpkg/i.test(text)) {
    return new InstallError(
      'Another program is installing packages on your server.',
      'Cloud images often run updates on first boot. Wait a couple of minutes and try again.',
    );
  }
  if (/Temporary failure resolving|Could not resolve host|network is unreachable/i.test(text)) {
    return new InstallError(
      'Your server could not reach the internet to download its dependencies.',
      'Check the instance has outbound access, then try again.',
    );
  }
  if (explicit) {
    return new InstallError(explicit.replace(/^ERROR:\s*/, ''), 'The server output below has the full detail.');
  }

  const lastLine = [...transcript].reverse().find((line) => !line.startsWith('==>'));
  return new InstallError(
    lastLine ? `The installation stopped: ${lastLine}` : 'The gateway installation did not finish.',
    `The installer exited with code ${code}. The server output below shows exactly where it stopped.`,
  );
}

export interface UninstallTarget {
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string | null;
  useAgent?: boolean;
  passphrase?: string;
}

export interface UninstallResult {
  ok: boolean;
  steps: string[];
  output: string[];
}

/**
 * Remove the gateway from the user's server, best-effort.
 *
 * The installer writes /opt/localtunnel/uninstall.sh, so that is the first choice.
 * If it is missing — an old or partial install — the same removal is done inline.
 * Every step is reported rather than silently swallowed, because "we tried to clean
 * up your server" is only trustworthy if it says what actually happened.
 */
export function uninstallGateway(
  target: UninstallTarget,
  onOutput?: (line: string) => void,
): Promise<UninstallResult> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const output: string[] = [];
    const say = (line: string) => {
      output.push(line);
      onOutput?.(line);
    };

    const script = [
      'set -u',
      'SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo -n"',
      'if [ -x /opt/localtunnel/uninstall.sh ]; then',
      '  echo "running the installer\'s own uninstall script"',
      '  $SUDO /opt/localtunnel/uninstall.sh',
      'else',
      '  echo "uninstall.sh not found — removing the pieces directly"',
      '  $SUDO systemctl disable --now localtunnel-gateway 2>/dev/null || true',
      '  $SUDO rm -f /etc/systemd/system/localtunnel-gateway.service',
      '  $SUDO systemctl daemon-reload 2>/dev/null || true',
      '  $SUDO rm -rf /opt/localtunnel /etc/localtunnel /var/lib/localtunnel /var/log/localtunnel',
      '  $SUDO userdel localtunnel 2>/dev/null || true',
      'fi',
      // Leave the machine as we found it, including the ports we opened.
      'command -v ufw >/dev/null 2>&1 && { $SUDO ufw delete allow 443/tcp; $SUDO ufw delete allow 80/tcp; } >/dev/null 2>&1 || true',
      'echo "LOCALTUNNEL_UNINSTALLED"',
      'echo "--- remaining:"',
      'ls -d /opt/localtunnel /etc/localtunnel /var/lib/localtunnel 2>/dev/null || echo "  nothing left"',
      'systemctl is-active localtunnel-gateway 2>/dev/null || echo "  service is gone"',
    ].join('\n');

    client.once('ready', () => {
      client.exec(script, (err, stream) => {
        if (err) {
          client.end();
          return reject(err);
        }
        let buffer = '';
        const consume = (text: string) => {
          buffer += text;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) if (line.trim()) say(line.trimEnd());
        };
        stream.on('data', (c: Buffer) => consume(c.toString()));
        stream.stderr.on('data', (c: Buffer) => consume(c.toString()));
        stream.on('close', () => {
          if (buffer.trim()) say(buffer.trim());
          client.end();
          const text = output.join('\n');
          const removed = text.includes('LOCALTUNNEL_UNINSTALLED');
          const steps: string[] = [];
          if (removed) {
            steps.push('Stopped and removed the gateway service');
            steps.push('Deleted /opt/localtunnel, /etc/localtunnel and /var/lib/localtunnel');
            steps.push('Removed the localtunnel system user');
            if (text.includes('nothing left')) steps.push('Verified nothing is left behind');
          }
          if (/sudo: a password is required|not in the sudoers/i.test(text)) {
            steps.push('That account could not run administrative commands — nothing was removed');
            resolve({ ok: false, steps, output });
            return;
          }
          resolve({ ok: removed, steps, output });
        });
      });
    });
    client.once('error', (err) => reject(translateSshError(err as NodeJS.ErrnoException, target as InstallTarget)));

    const config: ConnectConfig = {
      host: target.host,
      port: target.port || 22,
      username: target.username,
      readyTimeout: 25_000,
      hostVerifier: () => true,
    };
    if (target.useAgent) config.agent = agentSocket() ?? undefined;
    if (target.privateKeyPath) {
      secureKeyFile(target.privateKeyPath);
      config.privateKey = readFileSync(target.privateKeyPath);
      config.passphrase = target.passphrase;
    }
    client.connect(config);
  });
}

export class InstallError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'InstallError';
  }
}

function translateSshError(err: NodeJS.ErrnoException, target: InstallTarget): InstallError {
  const message = err.message ?? '';
  if (err.code === 'ECONNREFUSED') {
    return new InstallError(
      `Nothing accepted an SSH connection on ${target.host}:${target.port || 22}.`,
      'Check the IP address, and that the instance has finished starting.',
    );
  }
  if (err.code === 'ETIMEDOUT' || /timed out/i.test(message)) {
    return new InstallError(
      `${target.host} did not respond to SSH.`,
      'On Oracle Cloud, check that the VCN security list allows TCP 22 from 0.0.0.0/0, and that the instance is running.',
    );
  }
  if (/All configured authentication methods failed/i.test(message)) {
    return new InstallError(
      'The server refused that SSH key.',
      target.useAgent
        ? `Check the username — Oracle Ubuntu images use "ubuntu", Oracle Linux uses "opc", and most other providers use "root". If that is right, none of the keys in your SSH agent are authorised on this server: run \`ssh-add\` to load the matching key, or choose the key file instead.`
        : `Check the username — Oracle Ubuntu images use "ubuntu", Oracle Linux uses "opc", and most other providers use "root". Also make sure this is the private key that matches the public key you gave the provider.`,
    );
  }
  if (/Cannot parse privateKey|Encrypted private key/i.test(message)) {
    return new InstallError(
      'That private key could not be read.',
      'If the key has a passphrase, enter it. LocalTunnel needs the private key file (not the .pub file).',
    );
  }
  return new InstallError(message || 'The SSH connection failed.');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function firstLine(text: string, key: string): string {
  const line = text.split('\n').find((l) => l.startsWith(key));
  return line?.replace(`${key}=`, '').replace(/"/g, '') ?? text.split('\n')[0];
}
