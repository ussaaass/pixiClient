import { createAgentDownlineReadApplication } from './agent-downlines-application';
import { createAgentAuditReadApplication } from './agent-audit-application';
import { OfflineAgentDownlineAdapter } from './offline-agent-downline-adapter';

const adapter = new OfflineAgentDownlineAdapter();
export const agentDownlineReadApplication = createAgentDownlineReadApplication(adapter);
export const agentAuditReadApplication = createAgentAuditReadApplication(adapter);
