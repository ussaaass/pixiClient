import type { Sequelize } from 'sequelize';

/** 0019 — register Admin capabilities for Support claim and resolve routes. */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    INSERT INTO \`admin_permission\`
      (\`status\`, \`permission_code\`, \`name\`, \`http_method\`, \`path_pattern\`)
    VALUES
      (1, 'admin.support.claim', '领取客服工单', 'POST', '/api/v1/admin/support/conversations/:id/claim'),
      (1, 'admin.support.resolve', '关闭客服工单', 'POST', '/api/v1/support/conversations/:id/resolve')
    ON DUPLICATE KEY UPDATE
      \`name\` = VALUES(\`name\`),
      \`http_method\` = VALUES(\`http_method\`),
      \`path_pattern\` = VALUES(\`path_pattern\`)
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  // Roll back only these exact code+route entries; preserve any unrelated catalog data.
  await context.query(`
    DELETE FROM \`admin_permission\`
    WHERE \`permission_code\` IN ('admin.support.claim', 'admin.support.resolve')
      AND (\`http_method\`, \`path_pattern\`) IN (
        ('POST', '/api/v1/admin/support/conversations/:id/claim'),
        ('POST', '/api/v1/support/conversations/:id/resolve')
      )
  `);
}
