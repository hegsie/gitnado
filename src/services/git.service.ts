/**
 * Git Service
 * Provides high-level Git operations via Tauri commands
 *
 * Re-exports all domain modules under `./git/` for full backwards compatibility.
 */

export {
  type NetworkBlockReason,
  isNetworkPolicyActive,
  checkOutboundHostAllowed,
  isNetworkGateRefusal,
  isOperationCancelled,
} from "./git/shared.ts";
export * from "./git/repository.ts";
export * from "./git/branches-tags.ts";
export * from "./git/diff-blame.ts";
export * from "./git/merge-rebase.ts";
export * from "./git/remotes.ts";
export * from "./git/security-credentials.ts";
export * from "./git/providers.ts";
export * from "./git/ai-workspace.ts";
export * from "./git/checkpoints.ts";
