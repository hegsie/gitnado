/**
 * Workflow types for Git Flow and branch-age workflow support
 */

/**
 * Git Flow configuration for a repository
 */
export interface GitFlowConfig {
  /** Whether Git Flow is initialized */
  initialized: boolean;
  /** Main branch name (e.g., "main" or "master") */
  mainBranch: string;
  /** Development branch name (e.g., "develop") */
  developBranch: string;
  /** Feature branch prefix (e.g., "feature/") */
  featurePrefix: string;
  /** Release branch prefix (e.g., "release/") */
  releasePrefix: string;
  /** Hotfix branch prefix (e.g., "hotfix/") */
  hotfixPrefix: string;
  /** Version tag prefix (e.g., "v") */
  versionTagPrefix: string;
}

/**
 * Git Flow branch type
 */
export type GitFlowBranchType =
  | 'main'
  | 'develop'
  | 'feature'
  | 'release'
  | 'hotfix'
  | 'other';

/**
 * A step in a Git Flow operation
 */
export interface GitFlowOperationStep {
  /** Description of the step */
  description: string;
  /** Git command that will be executed */
  command: string;
  /** Whether this step is optional */
  optional: boolean;
}

/**
 * Preview of a Git Flow operation
 */
export interface GitFlowOperationPlan {
  /** Operation type (e.g., "start_feature", "finish_release") */
  operation: string;
  /** Branch name involved */
  branchName: string;
  /** Steps that will be executed */
  steps: GitFlowOperationStep[];
  /** Warnings about the operation */
  warnings: string[];
}

/**
 * Branch age status for trunk-based development
 */
export type BranchAgeStatus = 'ok' | 'warning' | 'critical';

/**
 * Branch age information for trunk-based development
 */
export interface BranchAgeInfo {
  /** Branch name */
  branchName: string;
  /** Age in hours since creation/last commit */
  ageHours: number;
  /** Status based on age */
  status: BranchAgeStatus;
}

/**
 * Default Git Flow configuration
 */
export const DEFAULT_GITFLOW_CONFIG: GitFlowConfig = {
  initialized: false,
  mainBranch: 'main',
  developBranch: 'develop',
  featurePrefix: 'feature/',
  releasePrefix: 'release/',
  hotfixPrefix: 'hotfix/',
  versionTagPrefix: 'v',
};
