import { expect, fixture, html } from '@open-wc/testing';
import { customElement } from 'lit/decorators.js';
import { GnRepoScopedDialogBase } from '../gn-repo-scoped-dialog-base.ts';

@customElement('test-repo-scoped-dialog')
class TestRepoScopedDialog extends GnRepoScopedDialogBase {
  public observedPrevPaths: Array<string | undefined> = [];

  public startLoad(): { gen: number; targetRepo: string } {
    return {
      gen: this.nextLoadGeneration(),
      targetRepo: this.repositoryPath,
    };
  }

  public checkLoad(gen: number, targetRepo: string): boolean {
    return this.isCurrentRepoLoad(gen, targetRepo);
  }

  public emitChanged<T extends Record<string, unknown> = Record<string, never>>(
    eventName: string,
    targetRepo: string,
    extra?: T,
  ): void {
    this.dispatchRepoEvent(eventName, targetRepo, extra);
  }

  protected override onRepositoryPathChanged(prevPath: string | undefined): void {
    this.observedPrevPaths.push(prevPath);
  }
}

describe('GnRepoScopedDialogBase', () => {
  it('validates isCurrentRepoLoad and invalidates in-flight loads when repositoryPath changes', async () => {
    const el = await fixture<TestRepoScopedDialog>(
      html`<test-repo-scoped-dialog ?open=${true} .repositoryPath=${'/repo/a'}></test-repo-scoped-dialog>`,
    );
    await el.updateComplete;

    const loadA = el.startLoad();
    expect(el.checkLoad(loadA.gen, loadA.targetRepo)).to.be.true;
    expect(el.checkLoad(loadA.gen, '/repo/other')).to.be.false;

    // Starting a newer load on the same repo invalidates the older generation
    const loadA2 = el.startLoad();
    expect(el.checkLoad(loadA.gen, loadA.targetRepo)).to.be.false;
    expect(el.checkLoad(loadA2.gen, loadA2.targetRepo)).to.be.true;

    // Changing repositoryPath automatically bumps loadGeneration and invokes onRepositoryPathChanged
    el.repositoryPath = '/repo/b';
    await el.updateComplete;

    expect(el.checkLoad(loadA2.gen, loadA2.targetRepo)).to.be.false;
    expect(el.observedPrevPaths).to.include('/repo/a');

    // Even if repositoryPath switches back to /repo/a, the pre-switch generation stays invalid
    el.repositoryPath = '/repo/a';
    await el.updateComplete;
    expect(el.checkLoad(loadA2.gen, loadA2.targetRepo)).to.be.false;
  });

  it('dispatches bubbling, composed CustomEvents with repositoryPath in detail', async () => {
    const wrapper = await fixture<HTMLDivElement>(
      html`<div><test-repo-scoped-dialog .repositoryPath=${'/repo/a'}></test-repo-scoped-dialog></div>`,
    );
    const el = wrapper.querySelector('test-repo-scoped-dialog') as TestRepoScopedDialog;
    await el.updateComplete;

    const captured: CustomEvent[] = [];
    wrapper.addEventListener('remotes-changed', (e) => {
      captured.push(e as CustomEvent);
    });
    wrapper.addEventListener('files-cleaned', (e) => {
      captured.push(e as CustomEvent);
    });

    el.emitChanged('remotes-changed', '/repo/a');
    el.emitChanged('files-cleaned', '/repo/b', { count: 4 });

    expect(captured).to.have.lengthOf(2);
    expect(captured[0].bubbles).to.be.true;
    expect(captured[0].composed).to.be.true;
    expect(captured[0].detail).to.deep.equal({ repositoryPath: '/repo/a' });
    expect(captured[1].detail).to.deep.equal({ count: 4, repositoryPath: '/repo/b' });
  });
});
