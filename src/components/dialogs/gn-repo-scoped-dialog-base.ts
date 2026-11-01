import { LitElement } from 'lit';
import { property } from 'lit/decorators.js';

/**
 * Shared base class for repository-scoped dialogs.
 *
 * Centralises `open` and `repositoryPath` reactive properties, generation-based
 * stale-load cancellation when `repositoryPath` changes, and repository-pinned
 * `*-changed` CustomEvent dispatch.
 */
export abstract class GnRepoScopedDialogBase extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: String }) repositoryPath = '';

  protected loadGeneration = 0;

  protected nextLoadGeneration(): number {
    return ++this.loadGeneration;
  }

  protected isCurrentRepoLoad(generation: number, targetRepoPath: string): boolean {
    return generation === this.loadGeneration && this.repositoryPath === targetRepoPath;
  }

  protected dispatchRepoEvent<T extends Record<string, unknown> = Record<string, never>>(
    eventName: string,
    targetRepoPath: string,
    extraDetail?: T,
  ): void {
    this.dispatchEvent(
      new CustomEvent(eventName, {
        detail: { ...extraDetail, repositoryPath: targetRepoPath },
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected onRepositoryPathChanged(_prevPath: string | undefined): void {
    // Optional hook for subclasses
  }

  override updated(changedProperties: Map<string, unknown>): void {
    super.updated(changedProperties);
    if (changedProperties.has('repositoryPath')) {
      this.loadGeneration++;
      this.onRepositoryPathChanged(
        changedProperties.get('repositoryPath') as string | undefined,
      );
    }
  }
}
