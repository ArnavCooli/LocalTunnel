import { execFile } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Registering the agent to start with the computer.
 *
 * Per-user services on every platform: no administrator prompt, and the agent only
 * ever reaches services the logged-in user could reach anyway.
 */

const LABEL = 'com.localtunnel.agent';

export interface ServiceTarget {
  /** Absolute path to the node executable. */
  execPath: string;
  /** Absolute path to the agent entrypoint. */
  scriptPath: string;
}

export function autostartPath(): string {
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    case 'win32':
      return join(
        process.env.APPDATA ?? homedir(),
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'Startup',
        'LocalTunnel Agent.cmd',
      );
    default:
      return join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
        'systemd',
        'user',
        'localtunnel-agent.service',
      );
  }
}

export async function installAutostart(target: ServiceTarget): Promise<string> {
  const path = autostartPath();
  mkdirSync(dirname(path), { recursive: true });

  switch (platform()) {
    case 'darwin': {
      writeFileSync(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${target.execPath}</string>
    <string>${target.scriptPath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- execPath is the Electron binary when installed from the app; this makes it
         run the agent as plain Node rather than opening a second window. -->
    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`,
      );
      await run('launchctl', ['unload', path]).catch(() => undefined);
      await run('launchctl', ['load', path]);
      return path;
    }

    case 'win32': {
      writeFileSync(
        path,
        `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nstart "" /b "${target.execPath}" "${target.scriptPath}"\r\n`,
      );
      return path;
    }

    default: {
      writeFileSync(
        path,
        `[Unit]
Description=LocalTunnel Agent
After=network-online.target

[Service]
Environment=ELECTRON_RUN_AS_NODE=1
ExecStart=${target.execPath} ${target.scriptPath}
Restart=always
RestartSec=5
# The agent needs no privileges beyond the user's own.
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`,
      );
      await run('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
      await run('systemctl', ['--user', 'enable', '--now', 'localtunnel-agent.service']).catch(
        () => undefined,
      );
      return path;
    }
  }
}

export async function removeAutostart(): Promise<void> {
  const path = autostartPath();
  if (platform() === 'darwin') {
    await run('launchctl', ['unload', path]).catch(() => undefined);
  } else if (platform() === 'linux') {
    await run('systemctl', ['--user', 'disable', '--now', 'localtunnel-agent.service']).catch(
      () => undefined,
    );
  }
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}
