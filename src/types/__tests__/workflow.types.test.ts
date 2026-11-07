import { expect } from '@open-wc/testing';
import { DEFAULT_GITFLOW_CONFIG } from '../workflow.types.ts';

describe('workflow.types', () => {
  describe('DEFAULT_GITFLOW_CONFIG', () => {
    it('should not be initialized', () => {
      expect(DEFAULT_GITFLOW_CONFIG.initialized).to.be.false;
    });

    it('should have main as default main branch', () => {
      expect(DEFAULT_GITFLOW_CONFIG.mainBranch).to.equal('main');
    });

    it('should have develop as default develop branch', () => {
      expect(DEFAULT_GITFLOW_CONFIG.developBranch).to.equal('develop');
    });

    it('should have feature/ as default feature prefix', () => {
      expect(DEFAULT_GITFLOW_CONFIG.featurePrefix).to.equal('feature/');
    });

    it('should have release/ as default release prefix', () => {
      expect(DEFAULT_GITFLOW_CONFIG.releasePrefix).to.equal('release/');
    });

    it('should have hotfix/ as default hotfix prefix', () => {
      expect(DEFAULT_GITFLOW_CONFIG.hotfixPrefix).to.equal('hotfix/');
    });

    it('should have v as default version tag prefix', () => {
      expect(DEFAULT_GITFLOW_CONFIG.versionTagPrefix).to.equal('v');
    });
  });
});

