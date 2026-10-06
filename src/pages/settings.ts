// The Apple Music page in Elbert's Settings — the compact mirror of the
// section's setup flow: on/off, run-it-for-me versus a remote server, the
// live Apple session (with the sign-in form when it needs one), sign out, and
// whether plays are reported back to Apple.

import type { Page } from '@evolvedmesh/elbert-plugin-sdk';
import {
  onConnectionChange,
  refreshStatus,
  saveRemote,
  setEnabled,
  setManaged,
  setPlayHistoryEnabled,
  settings,
  status,
  storedApiKey,
  watchStatus,
} from '../connection';
import { orchard } from '../orchard/client';
import { managed, type Phase } from '../orchard/managed';
import { definePage, errorText, onClose, type PageData, update } from './common';
import { runPrivacyImport } from './privacy';
import { SignIn } from './setup';

interface State {
  signIn: SignIn;
  canHost: boolean;
  managedBusy: boolean;
  url: string;
  key: string;
  keyLoaded: boolean;
  resets: number;
  remoteBusy: boolean;
  test: { ok: boolean; text: string } | null;
}

type P = Page<PageData, State>;

function managedLine(phase: Phase): [icon: string, tone: string, text: string] {
  switch (phase) {
    case 'healthy':
      return ['circle-check', 'primary', `Running on ${managed.serverUrl}`];
    case 'downloading':
      return ['download', 'primary', 'Downloading…'];
    case 'starting':
    case 'extracting':
      return ['loader-circle', 'primary', 'Starting…'];
    case 'migrating':
      return ['loader-circle', 'primary', 'Moving your setup over…'];
    case 'stopped':
      return ['circle-pause', 'onSurfaceVariant', 'Stopped'];
    case 'error':
      return ['circle-x', 'error', managed.message ?? 'Failed to start'];
    default:
      return ['circle-dashed', 'onSurfaceVariant', 'Not started'];
  }
}

/** The session card: one status line, then sign out or the sign-in form. */
function session(s: State) {
  const st = status;
  if (!orchard.isConfigured) return { kind: 'line', icon: 'user-round-x', tone: 'onSurfaceVariant', text: 'Not connected to an Orchard server yet.' };
  if (!st) return { kind: 'line', spinner: true, text: 'Checking session…' };
  switch (st.wrapper.state) {
    case 'installing':
      return { kind: 'line', spinner: true, text: 'Installing the Apple Music component…' };
    case 'failed':
      return { kind: 'line', icon: 'triangle-alert', tone: 'error', text: st.wrapper.error ?? 'The Apple Music component failed to install.' };
    case 'unsupported':
      return { kind: 'line', icon: 'circle-x', tone: 'error', text: "This server's processor is not supported." };
  }
  if (st.state === 'ready') {
    return {
      kind: 'ready',
      icon: 'circle-check',
      tone: 'primary',
      text: st.storefront ? `Signed in · storefront ${st.storefront}` : 'Signed in',
      noSubscription: !st.subscribed,
    };
  }
  // unconfigured / failed / awaiting_2fa / starting: the form, which shows its
  // own progress — a separate spinner for `starting` would drop the code step.
  s.signIn.sync(st.state, st.state === 'failed' ? st.error : undefined);
  return {
    kind: 'signin',
    icon: st.state === 'failed' ? 'circle-x' : st.state === 'awaiting_2fa' ? 'shield-check' : 'user-round-x',
    tone: st.state === 'failed' ? 'error' : st.state === 'awaiting_2fa' ? 'primary' : 'onSurfaceVariant',
    text:
      st.state === 'failed'
        ? (st.error ?? 'Sign-in failed.')
        : st.state === 'awaiting_2fa'
          ? 'Enter the verification code Apple sent you.'
          : st.state === 'starting'
            ? 'Signing in…'
            : 'Not signed in to Apple Music yet.',
    form: s.signIn.data(st.state),
  };
}

function render(page: P) {
  const s = page.state;
  const [icon, tone, text] = managedLine(managed.phase);
  const showManaged = settings.orchardManaged && s.canHost;
  update(page, {
    enabled: settings.orchardEnabled,
    canHost: s.canHost,
    mode: settings.orchardManaged ? 'managed' : 'remote',
    showManaged,
    managed: { icon, tone, text, running: managed.phase === 'healthy', busy: s.managedBusy, startLabel: managed.phase === 'healthy' ? 'Restart' : 'Start' },
    url: s.url,
    key: s.key,
    keyReset: `k${s.resets}`,
    remoteBusy: s.remoteBusy,
    hasTest: s.test != null,
    testIcon: s.test?.ok ? 'circle-check' : 'circle-x',
    testTone: s.test?.ok ? 'primary' : 'error',
    testText: s.test?.text ?? '',
    session: session(s),
    history: settings.orchardPlayHistoryEnabled,
    historyText: settings.orchardPlayHistoryEnabled
      ? 'Apple Music tracks played here appear in your Recently Played and shape your recommendations.'
      : "Apple won't be told what you play here. Playback, streaming and downloads are unaffected.",
  });
}

async function showImported(page: P) {
  const at = await elbert.storage.get<number>('privacyImportedAt');
  if (!at) return update(page, { hasImported: false });
  const d = new Date(at);
  update(page, {
    hasImported: true,
    importedNote: `Last imported ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.`,
  });
}

definePage<PageData, State>('settings', {
  open(page) {
    const s = page.state;
    s.canHost = false;
    s.managedBusy = false;
    s.url = settings.orchardServerUrl;
    s.key = '';
    s.resets = 0;
    s.remoteBusy = false;
    s.test = null;
    s.signIn = new SignIn(() => render(page));
    onClose(page, () => s.signIn.dispose());
    onClose(page, watchStatus());
    onClose(
      page,
      onConnectionChange(() => render(page)),
    );
    onClose(
      page,
      managed.onChange(() => render(page)),
    );
    void managed.isSupported().then((v) => {
      s.canHost = v;
      render(page);
    });
    void storedApiKey().then((k) => {
      if (k && !s.key) {
        s.key = k;
        s.resets++;
        render(page);
      }
    });
    setTimeout(() => render(page), 0);
    void showImported(page);
    return {
      enabled: settings.orchardEnabled,
      canHost: false,
      mode: 'remote',
      showManaged: false,
      url: s.url,
      key: '',
      keyReset: 'k0',
      session: { kind: 'line', spinner: true, text: 'Checking session…' },
    };
  },
  events: {
    enabled(_page, { value }) {
      return setEnabled(!!value);
    },
    mode(_page, { id }) {
      return setManaged(id === 'managed');
    },
    async managed(page, { id }) {
      const s = page.state;
      s.managedBusy = true;
      render(page);
      try {
        if (id === 'stop') await managed.stop();
        else await managed.ensureRunning(true);
      } finally {
        s.managedBusy = false;
        render(page);
      }
    },
    url(page, { value }) {
      page.state.url = String(value ?? '');
    },
    key(page, { value }) {
      page.state.key = String(value ?? '');
    },
    async save(page, { test }) {
      const s = page.state;
      s.remoteBusy = true;
      s.test = null;
      render(page);
      try {
        const result = await saveRemote(s.url, s.key, !!test);
        if (result) s.test = { ok: result.success, text: result.success ? 'Connected to Orchard.' : (result.error ?? 'Connection failed') };
        await refreshStatus();
      } catch (e) {
        s.test = { ok: false, text: errorText(e) };
      } finally {
        s.remoteBusy = false;
        render(page);
      }
    },
    async logout(page) {
      try {
        await orchard.logout();
      } catch (e) {
        await elbert.ui.toast(errorText(e));
      }
      await refreshStatus();
      render(page);
    },
    setup(page, args) {
      return page.state.signIn.handle(String(args.action ?? ''), args.value);
    },
    async importHistory(page) {
      await runPrivacyImport();
      await showImported(page);
    },
    history(page, { value }) {
      return setPlayHistoryEnabled(!!value).then(() => render(page));
    },
  },
});
