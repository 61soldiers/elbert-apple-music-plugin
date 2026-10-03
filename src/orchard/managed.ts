// Running the Orchard server for the user, so nobody has to clone a repo or
// run `setup.sh`.
//
// A local Docker Compose project. The Orchard source ships inside this plugin
// (assets/orchard/orchard-src.tar.gz, made by tool/fetch_orchard_src.sh); it
// is extracted, given a key, and driven with `docker compose`. The plugin is
// desktop-only (manifest `platforms`), so there is no other backend.
//
// Everything keeps the paths and names Elbert used before Apple Music became
// a plugin — `<appSupport>/orchard`, compose project `elbert-orchard`, image
// `elbert-orchard:latest` — so a running, signed-in instance carries on: the
// Apple session lives in the project's named volume.

export type Phase =
  | 'idle'
  | 'unsupported'
  | 'checkingDocker'
  | 'dockerMissing'
  | 'dockerNotRunning'
  | 'extracting'
  | 'building'
  | 'updating'
  | 'starting'
  | 'healthy'
  | 'stopped'
  | 'error';

import { errorCode, errorText } from '../errors';

export const PORT = 8080;
export const SERVER_URL = `http://127.0.0.1:${PORT}`;

const PROJECT = 'elbert-orchard';
const IMAGE_TAG = 'elbert-orchard:latest';
const REF_LABEL = 'io.github.61soldiers.elbert.orchard-src-ref';
const SRC_ASSET = 'assets/orchard/orchard-src.tar.gz';
const REF_ASSET = 'assets/orchard/.orchard-src-ref';
const VERIFY_INTERVAL_MS = 30_000;

class SetupError extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function generateKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 64; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function keyFromEnv(env: string | null): string | null {
  if (!env) return null;
  for (const line of env.split(/\r?\n/)) {
    const m = /^\s*ORCHARD_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
    if (m && m[1].length >= 24) return m[1];
  }
  return null;
}

function tail(text: string, lines = 12): string | null {
  const t = text.trim();
  if (!t) return null;
  const split = t.split('\n');
  return split.length <= lines ? t : split.slice(-lines).join('\n');
}

interface Backend {
  readonly supported: boolean;
  ensure(force: boolean): Promise<void>;
  stop(): Promise<void>;
  staleness(): Promise<string | null>;
  logs(lines: number): Promise<string>;
}

export class ManagedOrchard {
  phase: Phase = 'idle';
  message: string | null = null;
  apiKey: string | null = null;
  readonly serverUrl = SERVER_URL;

  private backend: Backend | null = null;
  private inflight: Promise<void> | null = null;
  private lastVerified = 0;
  private listeners = new Set<() => void>();

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(phase: Phase, message: string | null = null) {
    this.phase = phase;
    this.message = message;
    for (const fn of this.listeners) fn();
  }

  get isHealthy() {
    return this.phase === 'healthy';
  }

  private async backendFor(): Promise<Backend> {
    if (this.backend) return this.backend;
    const platform = await elbert.native.platform();
    this.backend = platform.isDesktop ? new DockerBackend(this) : new NoBackend();
    return this.backend;
  }

  async isSupported(): Promise<boolean> {
    return (await this.backendFor()).supported;
  }

  /** Brings the server up, building on first run. Concurrent calls share one run. */
  async ensureRunning(force = false): Promise<void> {
    const backend = await this.backendFor();
    if (!backend.supported) return this.set('unsupported');
    if (this.inflight && !force) return this.inflight;
    const op = backend.ensure(force).finally(() => {
      this.inflight = null;
      this.lastVerified = Date.now();
    });
    this.inflight = op;
    return op;
  }

  /**
   * Re-checks that the running instance is the Orchard this plugin ships and
   * rebuilds it if not — quietly (no phase change for a current one), and at
   * most every 30 s, since opening the section calls it each time.
   */
  async ensureCurrent(): Promise<void> {
    const backend = await this.backendFor();
    if (!backend.supported) return this.set('unsupported');
    if (this.inflight) return this.inflight;
    if (this.phase === 'stopped') return;
    if (Date.now() - this.lastVerified < VERIFY_INTERVAL_MS) return;
    if (this.phase !== 'healthy') return this.ensureRunning();
    const stale = await backend.staleness();
    this.lastVerified = Date.now();
    if (!stale) return;
    console.info(`managed Orchard is out of date: ${stale}`);
    await this.ensureRunning(true);
  }

  async stop() {
    const backend = await this.backendFor();
    if (!backend.supported) return;
    try {
      await backend.stop();
      this.set('stopped');
    } catch (e) {
      this.set('error', errorText(e));
    }
  }

  restart() {
    return this.ensureRunning(true);
  }

  async logs(lines = 80) {
    return (await this.backendFor()).logs(lines);
  }

  async checkHealth(): Promise<boolean> {
    try {
      const res = await elbert.http.request({ url: `${SERVER_URL}/healthz`, responseType: 'none', timeoutMs: 6000 });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async waitHealthy(budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (await this.checkHealth()) return true;
      await sleep(2000);
    }
    return this.checkHealth();
  }
}

class NoBackend implements Backend {
  readonly supported = false;
  async ensure() {}
  async stop() {}
  async staleness() {
    return null;
  }
  async logs() {
    return '';
  }
}

// ---- Desktop: Docker Compose ----------------------------------------------------

type DockerStatus = 'missing' | 'notRunning' | 'noCompose' | 'ready';

class DockerBackend implements Backend {
  readonly supported = true;
  private dockerDir = '';
  private srcDir = '';
  private bundledRef: string | null = null;
  private useOverride = false;

  constructor(private readonly s: ManagedOrchard) {}

  private get composeFile() {
    return `${this.srcDir}/compose.yaml`;
  }
  private get overrideFile() {
    return `${this.dockerDir}/docker-compose.override.yml`;
  }
  private get envFile() {
    return `${this.srcDir}/.env`;
  }
  private get refMarker() {
    return `${this.srcDir}/.orchard-src-ref`;
  }

  private async init() {
    if (this.dockerDir) return;
    const paths = await elbert.fs.paths();
    this.dockerDir = elbert.fs.join(paths.appSupport, 'orchard');
    this.srcDir = elbert.fs.join(this.dockerDir, 'src');
    await elbert.fs.mkdir(this.dockerDir);
  }

  private compose(args: string[]) {
    return ['compose', '-p', PROJECT, '-f', this.composeFile, ...(this.useOverride ? ['-f', this.overrideFile] : []), ...args];
  }

  private docker(args: string[], timeoutMs: number) {
    return elbert.process.run('docker', args, { cwd: this.dockerDir, timeoutMs });
  }

  async ensure(force: boolean) {
    const s = this.s;
    try {
      await this.init();
      s.set('checkingDocker');
      switch (await this.dockerStatus()) {
        case 'missing':
          return s.set('dockerMissing');
        case 'notRunning':
          return s.set('dockerNotRunning');
        case 'noCompose':
          return s.set('error', 'Docker is running but the Compose v2 plugin is missing. Install Docker Compose and try again.');
      }

      await this.ensureSrc();
      await this.ensureEnv();
      await this.ensureOverride();

      // A container that already answers is only left alone if it was built
      // from the bundled source.
      let update = false;
      if (!force && (await s.checkHealth())) {
        const stale = await this.staleness();
        if (!stale) return s.set('healthy');
        update = true;
        console.info(`rebuilding the managed container: ${stale}`);
      }

      s.set(update ? 'updating' : 'building');
      // --force-recreate: compose otherwise leaves a running container with an
      // unchanged image alone — including one whose Apple session has wedged.
      // Volumes survive it, and with them the signed-in session.
      const up = await this.docker(this.compose(['up', '-d', '--build', ...(force || update ? ['--force-recreate'] : [])]), 12 * 60_000);
      if (up.exitCode !== 0) {
        return s.set('error', tail(up.stderr || up.stdout) ?? `docker compose up failed (exit ${up.exitCode}).`);
      }
      s.set('starting');
      if (await s.waitHealthy(3 * 60_000)) s.set('healthy');
      else s.set('error', 'Orchard started but never became healthy. Check the logs.');
    } catch (e) {
      s.set('error', errorText(e));
    }
  }

  async stop() {
    if (!this.srcDir) await this.init();
    await this.docker(this.compose(['stop']), 2 * 60_000);
  }

  async logs(lines: number) {
    try {
      await this.init();
      const r = await this.docker(this.compose(['logs', '--no-color', '--tail', `${lines}`]), 20_000);
      const out = `${r.stdout}\n${r.stderr}`.trim();
      return out || 'No logs yet.';
    } catch (e) {
      return `Could not read Orchard logs: ${errorText(e)}`;
    }
  }

  private async dockerStatus(): Promise<DockerStatus> {
    try {
      const info = await this.docker(['info', '--format', '{{.ServerVersion}}'], 20_000);
      if (info.exitCode !== 0) return 'notRunning';
      const compose = await this.docker(['compose', 'version', '--short'], 15_000);
      return compose.exitCode === 0 ? 'ready' : 'noCompose';
    } catch (e) {
      return errorCode(e) === 'timeout' ? 'notRunning' : 'missing';
    }
  }

  private async ensureSrc() {
    const want = (await elbert.fs.readAssetText(REF_ASSET))?.trim() ?? null;
    this.bundledRef = want;
    const composeOk = await elbert.fs.exists(this.composeFile);
    const have = (await elbert.fs.readText(this.refMarker))?.trim();
    if (composeOk && want && have === want) return;

    this.s.set('extracting');
    const archive = await elbert.fs.asset(SRC_ASSET);
    if (!(await elbert.fs.exists(archive))) {
      throw new SetupError('This copy of the Apple Music plugin was built without the Orchard server. Install a release build.');
    }
    // The key lives in src/.env; keep it across a refresh.
    const savedEnv = await elbert.fs.readText(this.envFile);
    await elbert.fs.remove(this.srcDir, { recursive: true });
    await elbert.fs.mkdir(this.srcDir);
    await elbert.fs.extract(archive, this.srcDir);
    if (savedEnv != null) await elbert.fs.writeText(this.envFile, savedEnv);
    if (want) await elbert.fs.writeText(this.refMarker, want);
  }

  private async ensureEnv() {
    const existing = await elbert.fs.readText(this.envFile);
    const key = keyFromEnv(existing) ?? generateKey();
    this.s.apiKey = key;
    if (!keyFromEnv(existing)) await elbert.fs.writeText(this.envFile, `ORCHARD_API_KEY=${key}\n`);
  }

  /**
   * Overrides layered on Orchard's own compose.yaml, rewritten every run:
   * our own image tag (a hand-run Orchard owns `orchard:latest`), the source
   * ref stamped on the image (the only way to ask a running container which
   * Orchard it was built from), and AppArmor unconfined on hosts that need it
   * for the daemon's user namespaces.
   */
  private async ensureOverride() {
    const lines = [
      '# Written by the Elbert Apple Music plugin — edits are overwritten on every start.',
      'services:',
      '  orchard:',
      `    image: ${IMAGE_TAG}`,
      '    build:',
      '      labels:',
      `        ${REF_LABEL}: "${(this.bundledRef ?? 'unknown').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    ];
    if ((await elbert.native.platform()).linuxAppArmor) {
      lines.push('    security_opt:', '      - seccomp=unconfined', '      - systempaths=unconfined', '      - apparmor=unconfined');
    }
    await elbert.fs.writeText(this.overrideFile, `${lines.join('\n')}\n`);
    this.useOverride = true;
  }

  /** Why the running container needs rebuilding, or null. Errs towards leaving a working one alone. */
  async staleness(): Promise<string | null> {
    await this.init();
    const id = await this.runningContainerId();
    // Something else answers on the port — an Orchard run by hand.
    if (!id) return null;
    const ref = await this.containerRef(id);
    if (!ref) return 'it was built before the source ref was stamped onto the image';
    if (this.bundledRef && ref !== this.bundledRef) return `the bundled Orchard source moved on (${ref} -> ${this.bundledRef})`;
    try {
      const img = await this.docker(['image', 'inspect', IMAGE_TAG, '--format', '{{.Id}}'], 25_000);
      if (img.exitCode !== 0) return `${IMAGE_TAG} is no longer in Docker`;
    } catch {
      // unknown: leave it
    }
    return null;
  }

  private async runningContainerId(): Promise<string | null> {
    try {
      const r = await this.docker(this.compose(['ps', '-q', 'orchard']), 25_000);
      if (r.exitCode !== 0) return null;
      return (
        r.stdout
          .split('\n')
          .map((l) => l.trim())
          .find(Boolean) ?? null
      );
    } catch {
      return null;
    }
  }

  private async containerRef(id: string): Promise<string | null> {
    try {
      const r = await this.docker(['inspect', '--format', `{{index .Config.Labels "${REF_LABEL}"}}`, id], 25_000);
      if (r.exitCode !== 0) return null;
      const ref = r.stdout.trim();
      return !ref || ref === '<no value>' ? null : ref;
    } catch {
      return null;
    }
  }
}

export const managed = new ManagedOrchard();
