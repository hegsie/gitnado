/**
 * The progress indicator's Cancel button and transfer counts.
 *
 * The Cancel button was unreachable dead code: `startOperation` defaults
 * `cancellable` to false and no call site passed `{cancellable: true}`, so
 * `op.cancellable` was never true and the button never rendered. The counts
 * were likewise never shown, because no backend code emitted the
 * `operation-progress` event that carries them.
 */

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(null),
  transformCallback: () => 0,
};

import { expect, fixture, html } from '@open-wc/testing';
import '../gn-progress-indicator.ts';
import type { GnProgressIndicator } from '../gn-progress-indicator.ts';
import type { ProgressOperation } from '../../../services/progress.service.ts';

async function indicatorWith(
  operations: ProgressOperation[],
): Promise<GnProgressIndicator> {
  const el = await fixture<GnProgressIndicator>(
    html`<gn-progress-indicator></gn-progress-indicator>`,
  );
  el.operations = operations;
  await el.updateComplete;
  return el;
}

const fetchRow: ProgressOperation = {
  id: 'op-1',
  type: 'fetch',
  message: 'Fetching from origin',
  progress: 42,
  cancellable: true,
};

describe('gn-progress-indicator', () => {
  describe('cancel button', () => {
    it('renders for a cancellable operation', async () => {
      const el = await indicatorWith([fetchRow]);
      expect(el.shadowRoot!.querySelector('.cancel-btn')).to.exist;
    });

    it('is absent for an operation that cannot be cancelled', async () => {
      const el = await indicatorWith([{ ...fetchRow, cancellable: false }]);
      expect(el.shadowRoot!.querySelector('.cancel-btn')).to.not.exist;
    });

    it('dispatches cancel-operation with the row id when clicked', async () => {
      const el = await indicatorWith([fetchRow]);
      const seen: string[] = [];
      el.addEventListener('cancel-operation', (e) => {
        seen.push((e as CustomEvent<{ id: string }>).detail.id);
      });

      el.shadowRoot!.querySelector<HTMLButtonElement>('.cancel-btn')!.click();

      expect(seen).to.deep.equal(['op-1']);
    });

    it('cancels only the row whose button was clicked', async () => {
      const el = await indicatorWith([
        fetchRow,
        { id: 'op-2', type: 'push', message: 'Pushing...', cancellable: true },
      ]);
      const seen: string[] = [];
      el.addEventListener('cancel-operation', (e) => {
        seen.push((e as CustomEvent<{ id: string }>).detail.id);
      });

      const buttons = el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.cancel-btn');
      expect(buttons).to.have.length(2);
      buttons[1].click();

      expect(seen).to.deep.equal(['op-2']);
    });

    it('bubbles out of the shadow root so app-shell can hear it', async () => {
      const el = await indicatorWith([fetchRow]);
      let heard = false;
      document.addEventListener('cancel-operation', () => {
        heard = true;
      }, { once: true });

      el.shadowRoot!.querySelector<HTMLButtonElement>('.cancel-btn')!.click();

      expect(heard, 'the event must be composed and bubbling').to.be.true;
    });
  });

  describe('transfer counts', () => {
    it('shows received and total objects with the transferred size', async () => {
      const el = await indicatorWith([
        {
          ...fetchRow,
          receivedObjects: 1234,
          totalObjects: 5000,
          receivedBytes: 2 * 1024 * 1024,
        },
      ]);

      const counts = el.shadowRoot!.querySelector('.progress-counts')!.textContent!.trim();
      expect(counts).to.contain('objects');
      expect(counts).to.contain('5,000');
      expect(counts).to.contain('1,234');
      expect(counts).to.contain('2.00 MiB');
    });

    it('omits the total until the remote has announced one', async () => {
      const el = await indicatorWith([
        { ...fetchRow, progress: undefined, receivedObjects: 7, totalObjects: 0 },
      ]);

      const counts = el.shadowRoot!.querySelector('.progress-counts')!.textContent!.trim();
      expect(counts).to.equal('7 objects');
    });

    it('shows no counts line before the first progress event', async () => {
      const el = await indicatorWith([fetchRow]);
      expect(el.shadowRoot!.querySelector('.progress-counts')).to.not.exist;
      // The percentage the caller supplied is still shown.
      expect(el.shadowRoot!.querySelector('.progress-percent-value')!.textContent).to.contain('42');
    });

    it('renders an indeterminate bar and still shows counts with no percent', async () => {
      const el = await indicatorWith([
        { ...fetchRow, progress: undefined, receivedObjects: 12, totalObjects: 0 },
      ]);

      expect(el.shadowRoot!.querySelector('.progress-fill.indeterminate')).to.exist;
      expect(el.shadowRoot!.querySelector('.progress-percent-value')).to.not.exist;
      expect(el.shadowRoot!.querySelector('.progress-counts')).to.exist;
    });

    it('formats sub-kilobyte transfers in bytes', async () => {
      const el = await indicatorWith([
        { ...fetchRow, receivedObjects: 1, totalObjects: 2, receivedBytes: 512 },
      ]);

      expect(el.shadowRoot!.querySelector('.progress-counts')!.textContent).to.contain('512 B');
    });
  });

  it('renders nothing when there are no operations', async () => {
    const el = await indicatorWith([]);
    expect(el.shadowRoot!.querySelector('.progress-container')).to.not.exist;
  });
});
