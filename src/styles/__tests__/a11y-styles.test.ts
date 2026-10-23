/**
 * Accessibility styling contract: the reduced-motion clamp and the shared
 * keyboard focus ring.
 *
 * Both live in `sharedStyles` on purpose. Lit renders into shadow roots, so the
 * `@media (prefers-reduced-motion: reduce)` block in src/styles/tokens.css
 * cannot reach a component's own `animation:` declarations — only a fragment
 * adopted into the shadow root can. These tests therefore assert through the
 * CSSOM of a real shadow root rather than by string-matching the source, so
 * they fail if the fragment stops being composed in, or if a nesting mistake
 * means the browser never parses the rules.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
let cbId = 0;

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve([]),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import { LitElement, html as litHtml } from 'lit';
import { sharedStyles, focusRingStyles, reducedMotionStyles } from '../shared-styles.ts';
import '../../components/sidebar/gn-branch-list.ts';
import '../../components/common/gn-progress-indicator.ts';

function sheetsOf(root: ShadowRoot): CSSStyleSheet[] {
  return [...(root.adoptedStyleSheets ?? []), ...Array.from(root.styleSheets ?? [])];
}

/** Every top-level style rule adopted into a shadow root. */
function styleRules(root: ShadowRoot): CSSStyleRule[] {
  const out: CSSStyleRule[] = [];
  for (const sheet of sheetsOf(root)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule instanceof CSSStyleRule) out.push(rule);
    }
  }
  return out;
}

/** The prefers-reduced-motion media rules adopted into a shadow root. */
function reducedMotionRules(root: ShadowRoot): CSSMediaRule[] {
  const out: CSSMediaRule[] = [];
  for (const sheet of sheetsOf(root)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule instanceof CSSMediaRule && rule.conditionText.includes('prefers-reduced-motion')) {
        out.push(rule);
      }
    }
  }
  return out;
}

class A11yStylesProbe extends LitElement {
  static styles = [sharedStyles];
  render() {
    return litHtml`
      <button class="probe-button">press</button>
      <input class="probe-input" />
      <div class="probe-row" tabindex="0">row</div>
    `;
  }
}
customElements.define('a11y-styles-probe', A11yStylesProbe);

describe('shared accessibility styles', () => {
  describe('reduced motion', () => {
    it('exports a fragment that clamps animation and transition', () => {
      const text = reducedMotionStyles.cssText;
      expect(text).to.contain('prefers-reduced-motion');
      expect(text).to.contain('animation-duration');
      expect(text).to.contain('animation-iteration-count');
      expect(text).to.contain('transition-duration');
      expect(text).to.contain('scroll-behavior');
    });

    it('composes the fragment into sharedStyles', () => {
      expect(sharedStyles.cssText).to.contain(reducedMotionStyles.cssText.trim());
    });

    it('reaches a component shadow root, where a light-DOM rule could not', async () => {
      const el = await fixture<A11yStylesProbe>(html`<a11y-styles-probe></a11y-styles-probe>`);
      const media = reducedMotionRules(el.shadowRoot as ShadowRoot);
      expect(media.length, 'no prefers-reduced-motion rule in the shadow root').to.be.greaterThan(0);

      const declarations = media
        .flatMap((m) => Array.from(m.cssRules))
        .filter((r): r is CSSStyleRule => r instanceof CSSStyleRule);
      const clamped = declarations.find((r) => r.style.getPropertyValue('animation-iteration-count'));
      expect(clamped, 'reduced-motion block does not clamp animation-iteration-count').to.exist;
      expect(clamped?.style.getPropertyValue('animation-iteration-count')).to.equal('1');
      // !important is what lets it beat the component's own `animation:`
      // declarations, which come later in the styles array.
      expect(clamped?.style.getPropertyPriority('animation-iteration-count')).to.equal('important');
      expect(clamped?.style.getPropertyPriority('transition-duration')).to.equal('important');
    });
  });

  describe('focus ring', () => {
    it('drives the ring from the --gn-focus-ring custom properties', () => {
      const text = focusRingStyles.cssText;
      expect(text).to.contain('--gn-focus-ring-color');
      expect(text).to.contain('--gn-focus-ring-width');
      expect(text).to.contain('--gn-focus-ring-offset');
    });

    it('composes the fragment into sharedStyles', () => {
      expect(sharedStyles.cssText).to.contain(focusRingStyles.cssText.trim());
    });

    it('adopts an outlined :focus-visible rule covering buttons, fields and tabindex items', async () => {
      const el = await fixture<A11yStylesProbe>(html`<a11y-styles-probe></a11y-styles-probe>`);
      const focusRules = styleRules(el.shadowRoot as ShadowRoot).filter(
        (r) => r.selectorText.includes(':focus-visible') && r.style.getPropertyValue('outline')
      );
      expect(focusRules.length, 'no :focus-visible rule with an outline was adopted').to.be.greaterThan(0);

      const selectors = focusRules.map((r) => r.selectorText).join(' ');
      for (const selector of ['button', 'input', 'select', 'textarea', '[tabindex]']) {
        expect(selectors, `focus ring does not cover ${selector}`).to.contain(selector);
      }

      // !important is what lets the shared ring beat the per-component
      // `outline: none` rules this change exists to fix.
      const ringRule = focusRules.find((r) => r.selectorText.includes('button'));
      expect(ringRule?.style.getPropertyPriority('outline')).to.equal('important');
    });

    it('keeps mouse focus quiet', async () => {
      const el = await fixture<A11yStylesProbe>(html`<a11y-styles-probe></a11y-styles-probe>`);
      const quiet = styleRules(el.shadowRoot as ShadowRoot).find(
        (r) => r.selectorText.replace(/\s/g, '') === ':focus:not(:focus-visible)'
      );
      expect(quiet, 'missing :focus:not(:focus-visible) reset').to.exist;
      expect(quiet?.style.getPropertyValue('outline')).to.equal('none');
    });

    it('hugs form fields with a zero offset', async () => {
      const el = await fixture<A11yStylesProbe>(html`<a11y-styles-probe></a11y-styles-probe>`);
      const input = el.shadowRoot?.querySelector('.probe-input') as HTMLElement;
      expect(getComputedStyle(input).getPropertyValue('--gn-focus-ring-offset').trim()).to.equal('0px');
    });

    it('insets the ring on full-bleed list rows so a scroll container cannot clip it', async () => {
      const el = await fixture<LitElement>(html`<gn-branch-list></gn-branch-list>`);
      const rule = styleRules(el.shadowRoot as ShadowRoot).find(
        (r) => r.selectorText === '.group-header'
      );
      expect(rule, 'gn-branch-list has no .group-header rule').to.exist;
      expect(rule?.style.getPropertyValue('--gn-focus-ring-offset').trim()).to.equal('-2px');
    });
  });

  // An indeterminate bar animates by translating itself across its track. The
  // reduced-motion clamp stops it after one 0.01ms iteration, which would leave
  // it parked at its final keyframe — off the end of the track — so the
  // component paints a static full-width fill instead of nothing.
  describe('indeterminate progress with motion reduced', () => {
    it('keeps the progress indicator fill visible', async () => {
      const el = await fixture<LitElement>(html`<gn-progress-indicator></gn-progress-indicator>`);
      const overrides = reducedMotionRules(el.shadowRoot as ShadowRoot)
        .flatMap((media) => Array.from(media.cssRules))
        .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
        .filter((rule) => rule.selectorText.includes('.progress-fill'));

      expect(overrides.length, 'no reduced-motion override for the indeterminate fill').to.be.greaterThan(0);
      expect(overrides[0].style.getPropertyValue('width')).to.equal('100%');
      expect(overrides[0].style.getPropertyValue('transform')).to.equal('none');
    });
  });
});
