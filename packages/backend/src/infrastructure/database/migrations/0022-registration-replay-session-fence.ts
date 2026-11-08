import type { Sequelize } from 'sequelize';

/** 0022 — bind registration replay ciphertext to its issued sid for durable logout invalidation. */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    ALTER TABLE \`registration_operation\`
      ADD COLUMN \`session_id\` VARCHAR(160) NULL COMMENT '注册响应对应的 Redis sid；登出时用于持久清除重放密文' AFTER \`device_id\`,
      ADD KEY \`ix_registration_operation_session_id\` (\`session_id\`)
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    ALTER TABLE \`registration_operation\`
      DROP INDEX \`ix_registration_operation_session_id\`,
      DROP COLUMN \`session_id\`
  `);
}
