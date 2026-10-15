import { createAgentDomainReviewApplication, createLocalAgentDomainDemoApplication } from './agent-domain-review-application';
import { IndexedDbAgentDomainReviewAdapter } from './indexeddb-agent-domain-review-adapter';

const adapter = new IndexedDbAgentDomainReviewAdapter();
export const localAgentDomainReviewApplication = {
  ...createAgentDomainReviewApplication(adapter),
  ...createLocalAgentDomainDemoApplication(adapter),
};
