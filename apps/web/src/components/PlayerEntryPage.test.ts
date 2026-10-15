import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import PlayerEntryPage from './PlayerEntryPage.vue';
import type { PlayerEntryApplication } from '../platform/player-entry/player-entry-application';

async function flush(): Promise<void> {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

describe('PlayerEntryPage', () => {
  let app: ReturnType<typeof createApp> | undefined;
  let host: HTMLDivElement;

  afterEach(() => {
    app?.unmount();
    app = undefined;
    host?.remove();
    vi.unstubAllGlobals();
  });

  it('reads a recovery QR locally, submits it through the application, and returns after success', async () => {
    const recoverAccount = vi.fn().mockResolvedValue({
      ok: true,
      value: { source: 'BROWSER_DEV', outcome: 'RECOVERY_AUTHENTICATED' },
    });
    const application = { recoverAccount } as unknown as PlayerEntryApplication;
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: vi.fn() }));
    vi.stubGlobal('BarcodeDetector', class {
      async detect() { return [{ rawValue: 'encrypted-recovery-payload' }]; }
    });
    host = document.createElement('div');
    document.body.append(host);
    let returnedToLobby = false;
    app = createApp(PlayerEntryPage, { application, emblem: '/logo.svg', onBack: () => { returnedToLobby = true; } });
    app.mount(host);

    host.querySelector<HTMLButtonElement>('#entry-mode-recovery')!.click();
    await flush();
    const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [new File(['image'], 'account.png', { type: 'image/png' })] });
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(host.querySelector('.player-entry-feedback')?.textContent).toContain('二维码已在本机读取');

    const fields = host.querySelectorAll<HTMLInputElement>('.player-entry-content input[type="password"]');
    fields[0]!.value = 'qr-password';
    fields[0]!.dispatchEvent(new Event('input', { bubbles: true }));
    host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await flush();

    expect(recoverAccount).toHaveBeenCalledWith({
      credentialPayload: 'encrypted-recovery-payload',
      credentialPassword: 'qr-password',
    });
    expect(Array.from(fields).map((field) => field.value)).toEqual(['']);
    expect(returnedToLobby).toBe(true);
  });

  it('shows an application validation message when login is clicked with empty fields', async () => {
    const passwordLogin = vi.fn().mockResolvedValue({ ok: false, code: 'IDENTIFIER_REQUIRED' });
    const application = { passwordLogin } as unknown as PlayerEntryApplication;
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(PlayerEntryPage, { application, emblem: '/logo.svg' });
    app.mount(host);

    host.querySelector<HTMLButtonElement>('#entry-mode-password')!.click();
    await flush();
    host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await flush();

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('请输入用户名、邮箱或手机号');
    expect(passwordLogin).toHaveBeenCalledWith({ identifier: '', password: '' });
  });
});
