import { get } from 'node:https';

/**
 * Telling the user when a newer LocalTunnel exists.
 *
 * This checks and reports. It deliberately does not download, verify, unpack or
 * run anything: an updater that installs code is a second, permanently online
 * path for code to reach the user's machine, and this product already has one
 * high-value credential store and an SSH installer sitting behind the same
 * window. The user goes to the release page and installs the new version the
 * same way they installed the first one, with the OS package tooling and its
 * signature checks doing the work they are built for.
 *
 * Everything in a release document is attacker-controlled data as far as this
 * file is concerned — a compromised account, a typo'd repository, a proxy that
 * rewrites the response. So the version must parse as a version, the links must
 * point at the one repository this app knows about, and the text is never
 * treated as markup.
 */

/** The only repository this app will accept release information from. */
const REPO_OWNER = 'arnavko11';
const REPO_NAME = 'LocalTunnel';
const API_HOST = 'api.github.com';
const RELEASES_PATH = `/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

/** The release page a user is sent to. Built here, never taken from the response. */
export const RELEASES_PAGE = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;

const REQUEST_TIMEOUT_MS = 10_000;
/** A release document is a few kilobytes; anything vastly larger is not one. */
const MAX_RESPONSE_BYTES = 512 * 1024;
/** How long a result is reused before the network is touched again. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Release notes are shown as plain text; this bounds what the UI must render. */
const MAX_NOTES_CHARS = 4000;

export interface UpdateStatus {
  /** The version this app is running. */
  current: string;
  /** The newest published version, or null when the check has not succeeded. */
  latest: string | null;
  /** True only when `latest` is a strictly higher version than `current`. */
  updateAvailable: boolean;
  /** Where to go to get it. Always this app's own release page. */
  url: string;
  /** Plain-text release notes, truncated. Never HTML, never markdown-rendered. */
  notes: string | null;
  publishedAt: string | null;
  /** When the last successful check completed. */
  checkedAt: string | null;
  /** Why the last check did not succeed, in words a user can act on. */
  error: string | null;
}

/**
 * Parse a version out of a release tag.
 *
 * Strict on purpose: the tag is remote input that gets compared, stored and
 * displayed, so anything that is not a plain dotted version is not a version.
 */
export function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]{0,32})?$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Is `candidate` a strictly newer release than `current`? */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

/** Flatten release notes to something safe to drop into a text node. */
export function toPlainText(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value
    .replace(/\r\n/g, '\n')
    // Strip control characters apart from newline and tab: they cannot become
    // markup, but they can rewrite what a terminal or a log line looks like.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .slice(0, MAX_NOTES_CHARS)
    .trim();
}

interface GithubRelease {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

/**
 * Fetch the latest release document.
 *
 * Fixed host, fixed path, no redirect following. A redirect is how a response
 * moves the request somewhere the pinning above does not apply, so one arriving
 * here is treated as a failed check rather than followed.
 */
function fetchLatestRelease(userAgent: string): Promise<GithubRelease> {
  return new Promise((resolve, reject) => {
    const request = get(
      {
        host: API_HOST,
        path: RELEASES_PATH,
        protocol: 'https:',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          // GitHub requires a user agent. It names the app and its version and
          // nothing about the person running it.
          'user-agent': userAgent,
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          reject(new Error('The update service redirected the request, so the check was abandoned.'));
          return;
        }
        if (status === 404) {
          res.resume();
          reject(new Error('No releases have been published yet.'));
          return;
        }
        if (status === 403 || status === 429) {
          res.resume();
          reject(new Error('The update service is rate limiting this computer. Try again later.'));
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`The update service answered with status ${status}.`));
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            res.destroy();
            reject(new Error('The update service sent an implausibly large response.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as GithubRelease);
          } catch {
            reject(new Error('The update service sent a response LocalTunnel could not read.'));
          }
        });
        res.on('error', reject);
      },
    );

    request.on('timeout', () => {
      request.destroy();
      reject(new Error('The update check timed out.'));
    });
    request.on('error', () =>
      // The message from a failed TLS or DNS attempt is noise to a user, and the
      // only actionable reading of any of them is the same one.
      reject(new Error('LocalTunnel could not reach the update service.')),
    );
  });
}

export class UpdateChecker {
  private cached: UpdateStatus | null = null;
  private inFlight: Promise<UpdateStatus> | null = null;

  constructor(private readonly currentVersion: string) {}

  /** The last known state, without touching the network. */
  state(): UpdateStatus {
    return this.cached ?? this.empty();
  }

  private empty(error: string | null = null): UpdateStatus {
    return {
      current: this.currentVersion,
      latest: null,
      updateAvailable: false,
      url: RELEASES_PAGE,
      notes: null,
      publishedAt: null,
      checkedAt: null,
      error,
    };
  }

  /**
   * Check for a newer release.
   *
   * Cached for a few hours unless `force` is set, so opening Settings repeatedly
   * does not hammer the API — and so a failing network does not retry in a loop.
   */
  async check(force = false): Promise<UpdateStatus> {
    if (!force && this.cached?.checkedAt) {
      const age = Date.now() - Date.parse(this.cached.checkedAt);
      if (Number.isFinite(age) && age < CACHE_TTL_MS) return this.cached;
    }
    if (this.inFlight) return this.inFlight;

    const task = this.run().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = task;
    return task;
  }

  private async run(): Promise<UpdateStatus> {
    try {
      const release = await fetchLatestRelease(
        `LocalTunnel/${this.currentVersion} (+${RELEASES_PAGE})`,
      );

      // A draft or pre-release is not something to send people to.
      if (release.draft === true || release.prerelease === true) {
        this.cached = { ...this.empty(), checkedAt: new Date().toISOString() };
        return this.cached;
      }

      const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
      const version = parseVersion(tag);
      if (!version) {
        this.cached = this.empty('The newest release does not have a version LocalTunnel understands.');
        this.cached.checkedAt = new Date().toISOString();
        return this.cached;
      }

      const latest = version.join('.');
      const publishedAt =
        typeof release.published_at === 'string' && !Number.isNaN(Date.parse(release.published_at))
          ? release.published_at
          : null;

      this.cached = {
        current: this.currentVersion,
        latest,
        updateAvailable: isNewer(latest, this.currentVersion),
        // Built from constants. The response's own URLs are never followed or
        // handed to the shell, so a rewritten one cannot send anyone anywhere.
        url: RELEASES_PAGE,
        notes: toPlainText(release.body),
        publishedAt,
        checkedAt: new Date().toISOString(),
        error: null,
      };
      return this.cached;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Keep any previous good answer; a failed check is not new information
      // about which version is current.
      this.cached = { ...(this.cached ?? this.empty()), error: message };
      return this.cached;
    }
  }
}
