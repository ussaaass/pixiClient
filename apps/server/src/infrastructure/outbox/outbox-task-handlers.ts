/**
 * §6.3 financial task handlers are intentionally not implemented here.
 *
 * Do not add placeholder handlers that return `true` without committing the
 * corresponding domain state and ledger entries in an idempotent transaction.
 * Until real handlers exist, `outbox-dispatcher.ts` classifies their topics as
 * tasks and fails them closed so they retry and eventually enter DEAD.
 *
 * This module remains as a documented boundary; implement each handler only
 * alongside its complete domain transaction, tests, and operational recovery.
 */
export {};
