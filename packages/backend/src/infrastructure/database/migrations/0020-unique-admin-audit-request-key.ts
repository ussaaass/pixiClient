import type { Sequelize } from 'sequelize';

/** 0020 — enforce the permission-change audit request_key idempotency contract. */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const [rows] = (await context.query(`
    SELECT \`request_key\`, COUNT(*) AS \`duplicate_count\`
    FROM \`admin_audit_event\`
    WHERE \`action_code\` = 'ADMIN_PERMISSIONS_UPDATED'
    GROUP BY \`request_key\`
    HAVING COUNT(*) > 1
    LIMIT 1
  `)) as unknown as [Array<{ request_key: string; duplicate_count: number }>];
  if (rows.length > 0) {
    throw new Error(`Cannot add unique admin audit request_key index: duplicate key ${rows[0]!.request_key}`);
  }
  await context.query(
    `ALTER TABLE \`admin_audit_event\` ADD UNIQUE KEY \`uq_admin_permission_audit_request_key\` (\`action_code\`, \`request_key\`)`,
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`ALTER TABLE \`admin_audit_event\` DROP INDEX \`uq_admin_permission_audit_request_key\``);
}
