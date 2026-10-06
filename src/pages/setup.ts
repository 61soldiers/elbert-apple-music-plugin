// Getting from nothing to signed in: choose how Orchard runs, start it (or
// connect to one), then sign in to Apple — with the 2FA code step.
//
// One state machine behind two screens: the Apple Music Home tab shows it as
// full-page cards until the session is ready, and the settings page embeds
// just the sign-in form. Templates: `common:SetupFlow` / `common:SignInForm`.

import { connectRemote, onConnectionChange, refreshStatus, setEnabled, settings, status, useManaged, watchStatus } from '../connection';
import { orchard } from '../orchard/client';
import { managed, type Phase } from '../orchard/managed';
import { errorText } from './common';

type Stage = 'credentials' | 'code';

/** The sign-in form's own state. */
export class SignIn {
  stage: Stage = 'credentials';
  busy = false;
  error: string | null = null;
  appleId = '';
  password = '';
  code = '';
  /** Kept for "Send new code", which signs in again. */
  retained: string | null = null;
  secondsLeft = 0;
  /** Bumped to clear the code field. */
  codeReset = 0;
  private timer: number | null = null;

  constructor(private readonly changed: () => void) {}

  dispose() {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
  }

  /** The server moved to awaiting_2fa on its own (another device, a resumed session). */
  sync(serverState: string, serverError?: string) {
    if (serverState === 'awaiting_2fa' && this.stage !== 'code') this.toCode();
    if (serverState === 'failed' && serverError && !this.error && !this.busy) this.error = serverError;
  }

  private toCode() {
    this.stage = 'code';
    this.startCountdown();
  }

  private startCountdown() {
    this.secondsLeft = 60;
    if (this.timer != null) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.secondsLeft > 0) {
        this.secondsLeft--;
        this.changed();
      }
      if (this.secondsLeft <= 0 && this.timer != null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, 1000);
  }

  data(serverState: string) {
    const expired = this.stage === 'code' && this.secondsLeft === 0;
    return {
      stage: this.stage === 'credentials' && (this.busy || serverState === 'starting') ? 'busy' : this.stage,
      busy: this.busy,
      error: this.error ?? '',
      hasError: !!this.error,
      expired,
      countdown: expired ? 'The code expired. Send a new one to continue.' : `Expires in ${this.secondsLeft}s`,
      resendLabel: this.retained == null ? 'Start over' : 'Send new code',
      codeReset: `c${this.codeReset}`,
      appleId: this.appleId,
    };
  }

  /** Template events: field changes and buttons. */
  async handle(action: string, value: unknown) {
    switch (action) {
      case 'appleId':
        this.appleId = String(value ?? '');
        return;
      case 'password':
        this.password = String(value ?? '');
        return;
      case 'code':
        this.code = String(value ?? '');
        return;
      case 'signIn':
        return this.submitCredentials();
      case 'verify':
        return this.submitCode();
      case 'resend':
        return this.resend();
    }
  }

  private async submitCredentials() {
    const id = this.appleId.trim();
    if (!id || !this.password) return this.fail('Enter your Apple ID and password.');
    if (id.includes(':')) return this.fail('An Apple ID cannot contain a colon.');
    await this.login(id, this.password);
  }

  private fail(message: string) {
    this.error = message;
    this.changed();
  }

  private async login(id: string, pw: string) {
    this.busy = true;
    this.error = null;
    this.changed();
    try {
      const s = await orchard.login(id, pw);
      if (s.state === 'ready') {
        await refreshStatus();
      } else if (s.state === 'awaiting_2fa') {
        this.retained = pw;
        this.toCode();
      } else {
        this.error = s.error ?? 'Apple rejected those credentials.';
      }
    } catch (e) {
      this.error = errorText(e);
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  private async submitCode() {
    const value = this.code.trim();
    if (!value) return this.fail('Enter the code Apple sent you.');
    this.busy = true;
    this.error = null;
    this.changed();
    try {
      const s = await orchard.submit2FA(value);
      if (s.state === 'ready') await refreshStatus();
      else if (s.state === 'awaiting_2fa') this.error = 'That code was not accepted. Try again.';
      else this.error = s.error ?? 'That code was not accepted.';
    } catch (e) {
      this.error = errorText(e);
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  private async resend() {
    this.code = '';
    this.codeReset++;
    if (this.retained == null) {
      this.stage = 'credentials';
      this.changed();
      return;
    }
    await this.login(this.appleId.trim(), this.retained);
    this.startCountdown();
  }
}

/** One full-page step of the flow, as `common:SetupFlow` draws it. */
interface Step {
  step: 'busy' | 'choose' | 'remote' | 'error' | 'signin';
  icon: string;
  title: string;
  message?: string;
  retryLabel?: string;
  retry?: string;
  canViewLogs?: boolean;
}

const busy = (icon: string, title: string, message?: string): Step => ({ step: 'busy', icon, title, message });
const failure = (title: string, message: string, retry?: string, retryLabel = 'Try again', icon = 'circle-alert'): Step => ({
  step: 'error',
  icon,
  title,
  message,
  retry,
  retryLabel,
});

function managedStep(phase: Phase): Step {
  switch (phase) {
    case 'idle':
    case 'downloading':
      return busy('download', 'Getting Apple Music ready', managed.message ?? 'Downloading what Apple Music needs. This happens once.');
    case 'extracting':
      return busy('package-open', 'Preparing Orchard…');
    case 'migrating':
      return busy('package-open', 'Moving your Apple Music setup', managed.message ?? 'Bringing your existing sign-in over. You stay signed in.');
    case 'starting':
      return busy('rocket', 'Starting Orchard…', managed.message ?? undefined);
    case 'stopped':
      return failure('Orchard is stopped', 'Start the local server again to keep using Apple Music.', 'restart', 'Start Orchard', 'circle-pause');
    case 'error':
      return { ...failure("Orchard didn't start", managed.message ?? 'Something went wrong starting Orchard.', 'restart'), canViewLogs: true };
    case 'unsupported':
      return failure('Not available here', "Elbert can't run the Apple Music server on this system yet. Connect to a remote Orchard server instead.");
    case 'healthy':
      return busy('plug-zap', 'Connecting to Orchard…');
  }
}

/** The whole flow for one page. */
export class SetupFlow {
  readonly signIn: SignIn;
  showRemote = false;
  remoteUrl = '';
  remoteKey = '';
  remoteBusy = false;
  remoteError: string | null = null;
  chooseBusy = false;
  logs: string | null = null;
  canHost = false;
  private releaseStatus: () => void;
  private releaseConn: () => void;

  constructor(private readonly changed: () => void) {
    this.signIn = new SignIn(changed);
    this.releaseStatus = watchStatus();
    this.releaseConn = onConnectionChange(changed);
    void managed.isSupported().then((v) => {
      this.canHost = v;
      changed();
    });
  }

  dispose() {
    this.signIn.dispose();
    this.releaseStatus();
    this.releaseConn();
  }

  /** Whether the section can show its content rather than this flow. */
  get ready() {
    if (!settings.orchardEnabled) return false;
    if (settings.orchardManaged && this.canHost && managed.phase !== 'healthy') return false;
    return orchard.isConfigured && status?.state === 'ready';
  }

  private step(): Step {
    if (!settings.orchardEnabled) {
      return this.canHost && !this.showRemote
        ? {
            step: 'choose',
            icon: 'music-4',
            title: 'Set up Apple Music',
            message: 'Elbert plays your Apple Music subscription through Orchard, a small local server that signs in as you.',
          }
        : { step: 'remote', icon: 'globe', title: 'Connect to Orchard', message: 'Enter the address and access key for your Orchard server.' };
    }
    if (settings.orchardManaged && this.canHost && managed.phase !== 'healthy') return managedStep(managed.phase);

    const s = status;
    if (!s) return busy('plug-zap', 'Connecting to Orchard…');
    switch (s.wrapper.state) {
      case 'installing':
        return busy('download', 'Installing the Apple Music component', 'About 50 MB, one time only. Hang tight.');
      case 'failed':
        return failure('Apple Music component failed to install', s.wrapper.error ?? "Check the machine's internet connection and try again.", 'status');
      case 'unsupported':
        return failure('Unsupported processor', "This machine's CPU isn't supported by Apple Music's decryption component (it needs 64-bit Intel/AMD or ARM).");
    }
    if (s.state === 'failed' && !orchard.isConfigured) return failure("Can't reach Orchard", s.error ?? 'No answer from the server.', 'status');
    if (s.state === 'unconfigured' && s.wrapper.state === 'absent') return busy('loader-circle', 'Finishing setup…');
    if (s.state === 'ready') return busy('circle-check', 'Signed in — loading your library…');
    this.signIn.sync(s.state, s.state === 'failed' ? s.error : undefined);
    const onCode = s.state === 'awaiting_2fa' || this.signIn.stage === 'code';
    return {
      step: 'signin',
      icon: onCode ? 'shield-check' : 'user-round',
      title: onCode ? 'Enter the verification code' : 'Sign in to Apple Music',
      message: onCode
        ? 'Apple sent a code to your trusted devices.'
        : 'Use the Apple ID with your Apple Music subscription. Your password is safe and never stored by elbert or orchard.',
    };
  }

  data() {
    const step = this.step();
    return {
      ...step,
      hasRetry: !!step.retry,
      canViewLogs: !!step.canViewLogs,
      hostSubtitle: 'Elbert starts and manages a local Orchard for you. Nothing else to install.',
      chooseBusy: this.chooseBusy,
      canGoBack: this.canHost,
      remoteBusy: this.remoteBusy,
      remoteError: this.remoteError ?? '',
      hasRemoteError: !!this.remoteError,
      logs: this.logs ?? '',
      hasLogs: this.logs != null,
      logsLabel: this.logs == null ? 'View logs' : 'Refresh logs',
      form: this.signIn.data(status?.state ?? 'unconfigured'),
    };
  }

  async handle(args: Record<string, unknown>) {
    const action = String(args.action ?? '');
    switch (action) {
      case 'local':
        this.chooseBusy = true;
        this.changed();
        try {
          settings.orchardEnabled = true;
          await elbert.storage.set('orchardEnabled', true);
          await useManaged();
        } finally {
          this.chooseBusy = false;
          this.changed();
        }
        return;
      case 'remote':
        this.showRemote = true;
        return this.changed();
      case 'back':
        this.showRemote = false;
        return this.changed();
      case 'url':
        this.remoteUrl = String(args.value ?? '');
        return;
      case 'key':
        this.remoteKey = String(args.value ?? '');
        return;
      case 'connect': {
        const url = this.remoteUrl.trim();
        const key = this.remoteKey.trim();
        if (!url || !key) {
          this.remoteError = 'Enter the server URL and API key.';
          return this.changed();
        }
        this.remoteBusy = true;
        this.remoteError = null;
        this.changed();
        try {
          await connectRemote(url, key);
        } catch (e) {
          this.remoteError = errorText(e);
        } finally {
          this.remoteBusy = false;
          this.changed();
        }
        return;
      }
      case 'restart':
        this.logs = null;
        this.changed();
        return managed.ensureRunning(true);
      case 'status':
        await refreshStatus();
        return this.changed();
      case 'logs':
        this.logs = await managed.logs();
        return this.changed();
      case 'disable':
        return setEnabled(false);
      default:
        return this.signIn.handle(action, args.value);
    }
  }
}
