/**
 * Working-tree checkpoints (roadmap 4.1, issue #607).
 *
 * Snapshots of the working tree (including untracked files) stored under
 * `refs/gitnado/checkpoints/*`. Taking one never touches the index or HEAD;
 * restoring one makes the working tree match it and first backs up the state
 * it replaces.
 */

import type { CommandResult } from '../../types/api.types.ts';
import { invokeCommand } from '../tauri-api.ts';

export interface Checkpoint {
  id: string;
  oid: string;
  label: string;
  sessionId: string | null;
  headOid: string | null;
  branch: string | null;
  /** Unix timestamp (seconds). */
  createdAt: number;
  filesChanged: number;
}

export interface CheckpointFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'typechange';
}

export interface RestoreCheckpointResult {
  restored: Checkpoint;
  /** Automatic checkpoint of the state the restore replaced. */
  backup: Checkpoint;
}

export async function createCheckpoint(
  path: string,
  label?: string,
  sessionId?: string,
): Promise<CommandResult<Checkpoint>> {
  return invokeCommand<Checkpoint>("create_checkpoint", { path, label, sessionId });
}

export async function listCheckpoints(path: string): Promise<CommandResult<Checkpoint[]>> {
  return invokeCommand<Checkpoint[]>("list_checkpoints", { path });
}

export async function getCheckpointFiles(
  path: string,
  id: string,
): Promise<CommandResult<CheckpointFile[]>> {
  return invokeCommand<CheckpointFile[]>("get_checkpoint_files", { path, id });
}

export async function restoreCheckpoint(
  path: string,
  id: string,
): Promise<CommandResult<RestoreCheckpointResult>> {
  return invokeCommand<RestoreCheckpointResult>("restore_checkpoint", { path, id });
}

export async function deleteCheckpoint(path: string, id: string): Promise<CommandResult<void>> {
  return invokeCommand<void>("delete_checkpoint", { path, id });
}
