import { ADMIN_DEVELOPMENT_DATABASE, openAdminDevelopmentDatabase } from '../browser-development-database';
import { createInitialAdminReferralWorkspace } from './admin-referral-application';
import type { AdminReferralWorkspaceRepository, AdminReferralWorkspaceSnapshot } from './admin-referral-types';

export function createIndexedDbAdminReferralRepository(databaseName = ADMIN_DEVELOPMENT_DATABASE): AdminReferralWorkspaceRepository {
  async function ensure(): Promise<AdminReferralWorkspaceSnapshot> {
    const database = await openAdminDevelopmentDatabase(databaseName);
    try {
      const transaction = database.transaction('admin_referral_workspace_snapshots', 'readwrite');
      const store = transaction.objectStore('admin_referral_workspace_snapshots');
      let snapshot = await store.get('workspace');
      if (!snapshot) { snapshot = createInitialAdminReferralWorkspace(); await store.put(snapshot); }
      await transaction.done;
      return snapshot;
    } finally { database.close(); }
  }
  return {
    read: ensure,
    async transact<T>(change: (current: AdminReferralWorkspaceSnapshot) => { next: AdminReferralWorkspaceSnapshot; result: T }): Promise<T> {
      const database = await openAdminDevelopmentDatabase(databaseName);
      try {
        const transaction = database.transaction('admin_referral_workspace_snapshots', 'readwrite');
        const store = transaction.objectStore('admin_referral_workspace_snapshots');
        let current = await store.get('workspace');
        if (!current) { current = createInitialAdminReferralWorkspace(); await store.put(current); }
        const transition = change(current);
        if (transition.next !== current) await store.put(transition.next);
        await transaction.done;
        return transition.result;
      } finally { database.close(); }
    },
  };
}
