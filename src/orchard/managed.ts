// Running the Orchard server for the user, so nobody has to clone a repo, run
// `setup.sh` or install anything.
//
// Orchard ships inside this plugin as a program per platform
// (assets/orchard/orchard-<os>-<arch>.tar.gz, made by tool/build_orchard.sh).
// It is unpacked on first run and started as a child process of Elbert. There is
// no container, no Docker and nothing to install.
//
// Apple's daemon is an Android program, so it needs a Linux kernel:
//  - Linux: Orchard sandboxes it with user namespaces itself.
//  - macOS, Windows (and Linux where namespaces are blocked and QEMU is
//    installed): it runs in a small Linux virtual machine. The plugin ships the
//    guest (assets/guest) and, for macOS and Windows, QEMU
//    (assets/qemu/<os>-<arch>.tar.gz); Orchard builds the rest.
//
// Everything keeps the paths and names Elbert used before Apple Music became a
// plugin — `<appSupport>/orchard`, the API key in a `.env` — so a signed-in
// instance carries on. A setup that was running in Docker is moved over once
// (see `migrateLegacy`): its Apple session, database and library are copied out
// of the old Docker volume, which is left in place as a backup.

export type Phase = 'idle' | 'unsupported' | 'extracting' | 'migrating' | 'starting' | 'healthy' | 'stopped' | 'error';

import { errorCode, errorText } from '../errors';

export const PORT = 8080;
export const SERVER_URL = `http://127.0.0.1:${PORT}`;

/** What Elbert's Docker setup was called; only read, to move it over. */
const LEGACY_PROJECT = 'elbert-orchard';
const LEGACY_VOLUME = 'elbert-orchard_orchard-data';

const BIN_REF_ASSET = 'assets/orchard/.orchard-bin-ref';
const VERIFY_INTERVAL_MS = 30_000;
const LOG_LINES = 400;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60_000;

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
    const os = platform.os;
    this.backend = os === 'linux' || os === 'macos' || os === 'windows' ? new NativeBackend(this, os) : new NoBackend();
    return this.backend;
  }

  async isSupported(): Promise<boolean> {
    return (await this.backendFor()).supported;
  }

  /** Brings the server up, unpacking it on first run. Concurrent calls share one run. */
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
   * Re-checks that the server still answers and brings it back if not —
   * quietly (no phase change for a healthy one), and at most every 30 s, since
   * opening the section calls it each time.
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
    console.info(`managed Orchard needs restarting: ${stale}`);
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

  async waitHealthy(budgetMs: number, stillWanted: () => boolean = () => true): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline && stillWanted()) {
      if (await this.checkHealth()) return true;
      await sleep(1000);
    }
    return stillWanted() && this.checkHealth();
  }
}

/** Platforms with no way to host the Apple Music daemon yet (Android, for now). */
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

// ---- Desktop: Orchard as a child process ----------------------------------------------

class NativeBackend implements Backend {
  readonly supported = true;

  private dir = '';
  private binDir = '';
  private dataDir = '';
  private proc: ElbertProcess | null = null;
  private alive = false;
  private stopping = false;
  private output: string[] = [];
  private restarts: number[] = [];
  private qemuDir = '';

  constructor(
    private readonly s: ManagedOrchard,
    private readonly os: 'linux' | 'macos' | 'windows',
  ) {}

  private get windows() {
    return this.os === 'windows';
  }
  /** The names assets and Go use for the OS. */
  private get goos() {
    return this.os === 'macos' ? 'darwin' : this.os;
  }
  private get exe() {
    return elbert.fs.join(this.binDir, this.windows ? 'orchard.exe' : 'orchard');
  }
  private get qemuExe() {
    return elbert.fs.join(this.qemuDir, this.windows ? 'qemu-system-x86_64.exe' : 'qemu-system-x86_64');
  }
  private get envFile() {
    return elbert.fs.join(this.dir, '.env');
  }
  /** Where Docker-era setups kept the key, beside the extracted source. */
  private get legacyEnvFile() {
    return elbert.fs.join(this.dir, 'src', '.env');
  }

  private async init() {
    if (this.dir) return;
    const paths = await elbert.fs.paths();
    this.dir = elbert.fs.join(paths.appSupport, 'orchard');
    this.binDir = elbert.fs.join(this.dir, 'bin');
    this.dataDir = elbert.fs.join(this.dir, 'data');
    this.qemuDir = elbert.fs.join(this.dir, 'qemu');
    await elbert.fs.mkdir(this.dir);
    await elbert.fs.mkdir(this.dataDir);
  }

  async ensure(force: boolean) {
    const s = this.s;
    try {
      await this.init();
      if (this.alive && !force && (await s.checkHealth())) return s.set('healthy');

      // Only a Linux setup could have had its session in a Docker volume the plugin
      // can reach; the others sign in afresh.
      if (this.os === 'linux') await this.migrateLegacy();
      await this.ensureEnv();

      // Something that isn't ours already answers on the port: an Orchard run by
      // hand. Use it as it is.
      if (!this.alive && !force && (await s.checkHealth())) return s.set('healthy');

      await this.stopProc();
      await this.ensureBinary();
      await this.ensureQemu();
      await this.checkSandbox();
      await this.startProc();
    } catch (e) {
      s.set('error', errorText(e));
    }
  }

  async stop() {
    await this.stopProc();
  }

  async logs(lines: number) {
    const out = this.output.slice(-lines).join('\n').trim();
    return out || 'No logs yet.';
  }

  async staleness(): Promise<string | null> {
    // A server this plugin started is the bundled one by construction. Ours
    // having died is the one thing worth acting on.
    if (this.proc && !this.alive && !this.stopping) return 'the Orchard process is no longer running';
    return null;
  }

  // ---- the program ------------------------------------------------------------------

  private async arch(): Promise<'amd64' | 'arm64'> {
    let m: string;
    if (this.windows) {
      // Windows on ARM runs the x64 build, so only "ARM64" vs not matters, and not even that.
      const r = await elbert.process.run('cmd', ['/c', 'echo', '%PROCESSOR_ARCHITECTURE%'], { timeoutMs: 10_000 });
      m = r.stdout.trim().toLowerCase();
      if (m === 'amd64' || m === 'x86_64' || m === 'arm64') return 'amd64';
    } else {
      const r = await elbert.process.run('uname', ['-m'], { timeoutMs: 10_000 });
      m = r.stdout.trim();
      if (m === 'x86_64' || m === 'amd64') return 'amd64';
      if (m === 'aarch64' || m === 'arm64') return 'arm64';
    }
    throw new SetupError(`Apple Music can't run on this kind of processor (${m || 'unknown'}).`);
  }

  private async ensureBinary() {
    const want = (await elbert.fs.readAssetText(BIN_REF_ASSET))?.trim() ?? null;
    const marker = elbert.fs.join(this.binDir, '.ref');
    const have = (await elbert.fs.readText(marker))?.trim();
    if (want && have === want && (await elbert.fs.exists(this.exe))) return;

    this.s.set('extracting');
    const archive = await elbert.fs.asset(`assets/orchard/orchard-${this.goos}-${await this.arch()}.tar.gz`);
    if (!(await elbert.fs.exists(archive))) {
      throw new SetupError('This copy of the Apple Music plugin was built without the Orchard server. Install a release build.');
    }
    await elbert.fs.remove(this.binDir, { recursive: true });
    await elbert.fs.mkdir(this.binDir);
    await elbert.fs.extract(archive, this.binDir);
    await this.makeExecutable(this.exe);
    if (want) await elbert.fs.writeText(marker, want);
  }

  /** The archive reader doesn't carry file modes across. */
  private async makeExecutable(file: string) {
    if (this.windows) return;
    const chmod = await elbert.process.run('chmod', ['755', file], { timeoutMs: 10_000 });
    if (chmod.exitCode !== 0) throw new SetupError(tail(chmod.stderr) ?? 'Could not make a bundled program executable.');
  }

  /**
   * macOS and Windows have no Linux kernel to sandbox Apple's daemon with, so it
   * runs in a virtual machine under the QEMU this plugin ships. (Linux uses the
   * system's QEMU only as a last resort, so there is nothing to unpack there.)
   */
  private async ensureQemu() {
    if (this.os === 'linux') return;
    const want = (await elbert.fs.readAssetText(BIN_REF_ASSET))?.trim() ?? null;
    const marker = elbert.fs.join(this.qemuDir, '.ref');
    const have = (await elbert.fs.readText(marker))?.trim();
    if (want && have === want && (await elbert.fs.exists(this.qemuExe))) return;

    this.s.set('extracting');
    const archive = await elbert.fs.asset(`assets/qemu/${this.goos}-${await this.arch()}.tar.gz`);
    if (!(await elbert.fs.exists(archive))) {
      throw new SetupError('This copy of the Apple Music plugin was built without the virtual machine runtime. Install a release build.');
    }
    await elbert.fs.remove(this.qemuDir, { recursive: true });
    await elbert.fs.mkdir(this.qemuDir);
    await elbert.fs.extract(archive, this.qemuDir);
    await this.makeExecutable(this.qemuExe);
    if (want) await elbert.fs.writeText(marker, want);
  }

  /** What tells Orchard where the virtual machine's pieces are. */
  private async vmEnv(): Promise<Record<string, string>> {
    const guest = await elbert.fs.asset('assets/guest');
    const haveGuest = await elbert.fs.exists(elbert.fs.join(guest, 'vmlinuz'));
    if (this.os === 'linux') {
      // Only ever used if user namespaces are blocked and QEMU is installed.
      return haveGuest ? { ORCHARD_QEMU: 'auto', ORCHARD_GUEST_DIR: guest } : {};
    }
    if (!haveGuest) throw new SetupError('This copy of the Apple Music plugin was built without the virtual machine image. Install a release build.');
    return { ORCHARD_QEMU: this.qemuExe, ORCHARD_QEMU_SHARE: elbert.fs.join(this.qemuDir, 'share'), ORCHARD_GUEST_DIR: guest };
  }

  /**
   * Asks Orchard whether the daemon can be hosted here (by namespaces on Linux, by
   * the virtual machine elsewhere), so a failure is explained up front instead of
   * the daemon dying with no word.
   */
  private async checkSandbox() {
    const r = await elbert.process.run(this.exe, ['__check-sandbox'], { timeoutMs: 20_000, env: await this.vmEnv() });
    if (r.exitCode === 0) return;
    const why = tail(r.stderr) ?? 'The sandbox Apple Music needs is not available here.';
    if (this.os !== 'linux') throw new SetupError(why);
    throw new SetupError(
      `${why}\n\n` +
        'Your system has to allow it, once. In a terminal, run the line that matches your system, then try again:\n' +
        '  Ubuntu 24.04 and newer:  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\n' +
        '  Debian, or an older kernel:  sudo sysctl -w kernel.unprivileged_userns_clone=1\n' +
        '  Any distro, if that is already on:  sudo sysctl -w user.max_user_namespaces=15000\n' +
        'To keep it across reboots, put the same setting (without "sudo sysctl -w", as name=value) in a file under /etc/sysctl.d/.\n' +
        'Or install QEMU (the qemu-system-x86 package), which Apple Music then runs in instead.',
    );
  }

  private async ensureEnv() {
    if (this.apiKey()) return;
    // Keep the key a Docker-era setup used, so clients that already have it carry on.
    const key = keyFromEnv(await elbert.fs.readText(this.envFile)) ?? keyFromEnv(await elbert.fs.readText(this.legacyEnvFile)) ?? generateKey();
    this.s.apiKey = key;
    await elbert.fs.writeText(this.envFile, `ORCHARD_API_KEY=${key}\n`);
  }

  private apiKey() {
    return this.s.apiKey;
  }

  // ---- the process ----------------------------------------------------------------------

  private async startProc() {
    const s = this.s;
    const key = this.apiKey();
    if (!key) throw new SetupError('No API key.');
    s.set('starting', 'The first start also downloads Apple’s music library (about 50 MB).');

    this.output = [];
    this.stopping = false;
    const vm = await this.vmEnv();
    const proc = await elbert.process.start(this.exe, [], {
      cwd: this.dir,
      env: {
        ...vm,
        ORCHARD_API_KEY: key,
        ORCHARD_DATA_DIR: this.dataDir,
        ORCHARD_ADDR: `127.0.0.1:${PORT}`,
        // Elbert owns this process: when it goes, so must the server and the
        // signed-in daemon it holds.
        ORCHARD_EXIT_WITH_PARENT: '1',
      },
    });
    this.proc = proc;
    this.alive = true;
    proc.onOutput((line) => {
      this.output.push(line);
      if (this.output.length > LOG_LINES) this.output.splice(0, this.output.length - LOG_LINES);
    });
    proc.onExit((code) => {
      if (this.proc !== proc) return;
      this.alive = false;
      if (this.stopping) return;
      this.exited(code);
    });

    // The first start downloads the daemon before listening, so be patient.
    if (await s.waitHealthy(5 * 60_000, () => this.alive && this.proc === proc)) return s.set('healthy');
    if (!this.alive) throw new SetupError(tail(this.output.join('\n')) ?? 'Orchard stopped right after starting.');
    throw new SetupError('Orchard started but never became healthy. Check the logs.');
  }

  /** The process died by itself. Bring it back a few times, then give up and say so. */
  private exited(code: number) {
    const s = this.s;
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (s.phase === 'starting') return; // startProc reports it
    if (this.restarts.length >= MAX_RESTARTS) {
      return s.set('error', `Orchard keeps stopping (exit ${code}). ${tail(this.output.join('\n'), 4) ?? ''}`.trim());
    }
    this.restarts.push(now);
    console.warn(`Orchard exited (${code}); restarting`);
    setTimeout(() => void s.ensureRunning(true), 2000);
  }

  private async stopProc() {
    const proc = this.proc;
    if (!proc || !this.alive) {
      this.proc = null;
      return;
    }
    this.stopping = true;
    const gone = new Promise<void>((resolve) => proc.onExit(() => resolve()));
    await proc.kill('term').catch(() => false);
    await Promise.race([gone, sleep(10_000)]);
    if (this.alive) await proc.kill('kill').catch(() => false);
    this.alive = false;
    this.proc = null;
  }

  // ---- moving a Docker setup over ---------------------------------------------------------

  /**
   * Elbert used to run Orchard in Docker, with the signed-in Apple session in a
   * named volume. Copy that session, the database and the downloaded library into
   * this setup once, so nobody signs in again — and stop the old container, which
   * would otherwise hold the port. The volume and the container are left in place
   * as a backup; this is the only time Docker is looked at, and a machine without
   * it simply skips this.
   */
  private async migrateLegacy() {
    const marker = elbert.fs.join(this.dataDir, '.migrated');
    if (await elbert.fs.exists(marker)) return;
    // Already signed in here: nothing to bring over, and nothing to overwrite.
    const signedIn = elbert.fs.join(this.dataDir, 'wrapper/rootfs/data/data/com.apple.android.music/files/STOREFRONT_ID');
    if (await elbert.fs.exists(signedIn)) return this.markMigrated(marker, 'already signed in');

    const docker = (args: string[], timeoutMs = 30_000) => elbert.process.run('docker', args, { timeoutMs });

    let volumes: string;
    try {
      const r = await docker(['volume', 'ls', '-q', '--filter', `name=^${LEGACY_VOLUME}$`], 20_000);
      // Docker is there but not answering: we can't tell, so ask again next time.
      if (r.exitCode !== 0) return;
      volumes = r.stdout.trim();
    } catch (e) {
      // No Docker on this machine means no Docker setup to move.
      if (errorCode(e) === 'not_found') return this.markMigrated(marker, 'no docker');
      return;
    }
    if (!volumes) return this.markMigrated(marker, 'no legacy volume');

    this.s.set('migrating', 'Moving your Apple Music setup out of Docker. You stay signed in.');
    const ps = await docker(['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${LEGACY_PROJECT}`]);
    const containers = ps.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    // Stopped first so the database and the session are copied at rest, and
    // told not to come back, so the port stays free after a reboot.
    if (containers.length) {
      await docker(['update', '--restart=no', ...containers]);
      await docker(['stop', '-t', '30', ...containers], 90_000);
    }

    const staging = elbert.fs.join(this.dir, 'migrate');
    try {
      const image = await this.legacyImage(containers, docker);
      const uid = (await elbert.process.run('id', ['-u'], { timeoutMs: 10_000 })).stdout.trim();
      const gid = (await elbert.process.run('id', ['-g'], { timeoutMs: 10_000 })).stdout.trim();
      await elbert.fs.remove(staging, { recursive: true });
      await elbert.fs.mkdir(staging);
      // Root inside the container (the volume's files belong to its own user),
      // handed to us on the way out.
      const script = [
        'set -e',
        'mkdir -p /out/wrapper/rootfs',
        'cp -a /data/orchard.db /out/ 2>/dev/null || true',
        'cp -a /data/orchard.db-wal /out/ 2>/dev/null || true',
        'cp -a /data/orchard.db-shm /out/ 2>/dev/null || true',
        'if [ -d /data/library ]; then cp -a /data/library /out/library; fi',
        'if [ -d /data/wrapper/rootfs/data ]; then cp -a /data/wrapper/rootfs/data /out/wrapper/rootfs/data; fi',
        `chown -R ${uid}:${gid} /out`,
      ].join('\n');
      const copy = await docker(
        ['run', '--rm', '--user', '0', '-v', `${LEGACY_VOLUME}:/data:ro`, '-v', `${staging}:/out:z`, '--entrypoint', 'sh', image, '-c', script],
        30 * 60_000,
      );
      if (copy.exitCode !== 0) throw new SetupError(tail(copy.stderr || copy.stdout) ?? `docker run failed (exit ${copy.exitCode})`);
      if (!(await elbert.fs.exists(elbert.fs.join(staging, 'wrapper/rootfs/data')))) {
        // The old setup was never signed in: nothing worth keeping beyond the key.
        await elbert.fs.remove(staging, { recursive: true });
        return this.markMigrated(marker, 'legacy volume had no session');
      }
      for (const entry of await elbert.fs.list(staging)) {
        if (entry.name === 'wrapper') continue;
        const dest = elbert.fs.join(this.dataDir, entry.name);
        await elbert.fs.remove(dest, { recursive: true });
        await elbert.fs.rename(entry.path, dest);
      }
      // Only the session is taken from the old daemon tree; Orchard fetches the
      // daemon itself.
      const sessionDest = elbert.fs.join(this.dataDir, 'wrapper/rootfs/data');
      await elbert.fs.mkdir(elbert.fs.join(this.dataDir, 'wrapper'));
      await elbert.fs.mkdir(elbert.fs.join(this.dataDir, 'wrapper/rootfs'));
      await elbert.fs.remove(sessionDest, { recursive: true });
      await elbert.fs.rename(elbert.fs.join(staging, 'wrapper/rootfs/data'), sessionDest);
      await elbert.fs.remove(staging, { recursive: true });
      await this.markMigrated(marker, 'copied from docker');
    } catch (e) {
      // Leave things as they were: the old container back up, nothing half-copied here.
      await elbert.fs.remove(staging, { recursive: true }).catch(() => false);
      if (containers.length) await docker(['start', ...containers]).catch(() => null);
      throw new SetupError(`Couldn't move your existing Apple Music setup out of Docker (it was left as it was): ${errorText(e)}`);
    }
  }

  private async legacyImage(containers: string[], docker: (a: string[], t?: number) => Promise<{ exitCode: number; stdout: string }>) {
    for (const id of containers) {
      const r = await docker(['inspect', '--format', '{{.Config.Image}}', id], 20_000);
      if (r.exitCode === 0 && r.stdout.trim()) return r.stdout.trim();
    }
    const img = await docker(['image', 'inspect', 'elbert-orchard:latest', '--format', '{{.Id}}'], 20_000);
    if (img.exitCode === 0) return 'elbert-orchard:latest';
    throw new SetupError('The old Orchard image is gone from Docker, so its data could not be read.');
  }

  private async markMigrated(marker: string, why: string) {
    await elbert.fs.writeText(marker, `${new Date().toISOString()} ${why}\n`);
  }
}

type ElbertProcess = Awaited<ReturnType<typeof elbert.process.start>>;

export const managed = new ManagedOrchard();
