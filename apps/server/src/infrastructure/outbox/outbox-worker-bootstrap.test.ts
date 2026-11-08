import { describe, expect, it, vi } from 'vitest';
import type { SocketAuthHandles } from '../../socket/socket-auth.js';
import { createSocketNotifPort } from './outbox-worker-bootstrap.js';

function makeSocket(connected: boolean) {
  return { connected, emit: vi.fn() };
}

describe('createSocketNotifPort', () => {
  it('emits to connected sockets and prunes disconnected entries', async () => {
    const connectedSocket = makeSocket(true);
    const disconnectedSocket = makeSocket(false);
    const sockets = new Set([connectedSocket, disconnectedSocket]);
    const connectionsByUser = new Map([['user-1', sockets]]);
    const port = createSocketNotifPort({ connectionsByUser } as unknown as SocketAuthHandles);

    await port.notifyUser('user-1', 'wallet.transfer', { amount: '10' });

    expect(connectedSocket.emit).toHaveBeenCalledWith('wallet.transfer', { amount: '10', source: 'outbox' });
    expect(disconnectedSocket.emit).not.toHaveBeenCalled();
    expect(sockets).toEqual(new Set([connectedSocket]));
    expect(connectionsByUser.get('user-1')).toBe(sockets);
  });

  it('removes an empty user entry after pruning stale sockets', async () => {
    const sockets = new Set([makeSocket(false)]);
    const connectionsByUser = new Map([['user-1', sockets]]);
    const port = createSocketNotifPort({ connectionsByUser } as unknown as SocketAuthHandles);

    await port.notifyUser('user-1', 'wallet.transfer', {});

    expect(connectionsByUser.has('user-1')).toBe(false);
  });

  it('treats an offline user as a successful no-op', async () => {
    const port = createSocketNotifPort({ connectionsByUser: new Map() } as unknown as SocketAuthHandles);

    await expect(port.notifyUser('user-1', 'wallet.transfer', {})).resolves.toBeUndefined();
  });
});
