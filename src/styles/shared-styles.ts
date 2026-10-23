import { css } from 'lit';

/**
 * Reduced-motion fragment.
 *
 * Lit components render into shadow roots, so a `@media (prefers-reduced-motion)`
 * block in the light-DOM stylesheet (src/styles/tokens.css) can NOT reach the
 * animations declared inside a component's `static styles`. This fragment is
 * therefore interpolated into `sharedStyles`, which every animating component
 * already includes as the first entry of its styles array, so the rules are
 * adopted into each shadow root.
 *
 * `!important` is deliberate: `sharedStyles` comes first in every styles array,
 * so at equal specificity the component's own `animation:` / `transition:`
 * declarations would otherwise win — and the spinner markup in
 * gn-azure-devops-dialog sets `animation` in an inline `style` attribute, which
 * only an important declaration can override.
 *
 * Indeterminate progress bars translate themselves off-screen and would be left
 * parked at their final keyframe (invisible) by the blanket rule, so app-shell
 * and gn-progress-indicator each carry a small reduced-motion override that
 * paints them as a static filled bar instead.
 */
export const reducedMotionStyles = css`
  @media (prefers-reduced-motion: reduce) {
    :host,
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      animation-delay: 0ms !important;
      transition-duration: 0.01ms !important;
      transition-delay: 0ms !important;
      scroll-behavior: auto !important;
    }
  }
`;

/**
 * Keyboard focus ring fragment.
 *
 * Most components suppress the native ring with `outline: none` on `:focus`
 * (usually paired with a border-colour change that only reads for mouse users),
 * and those class-based rules out-specify a bare `:focus-visible` rule coming
 * from `sharedStyles`. The ring is therefore declared `!important` on an
 * explicit list of interactive selectors so keyboard users get an indicator
 * everywhere, while mouse focus stays quiet.
 *
 * The ring is expressed through the `--gn-focus-ring-*` custom properties
 * defined in src/styles/tokens.css (they inherit through shadow boundaries), so
 * a component can still tune it — e.g. set `--gn-focus-ring-offset: -2px` on a
 * full-bleed list row so the ring is not clipped by the scroll container —
 * without fighting the `!important`.
 *
 * `[tabindex="-1"]` is excluded on purpose: those elements only ever receive
 * programmatic focus (dialog containers, scroll panes) and should not flash a
 * ring when a dialog opens.
 */
export const focusRingStyles = css`
  a[href]:focus-visible,
  button:focus-visible,
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible,
  summary:focus-visible,
  [tabindex]:not([tabindex='-1']):focus-visible,
  [role='button']:focus-visible,
  [role='tab']:focus-visible,
  [role='option']:focus-visible,
  [role='menuitem']:focus-visible,
  [role='menuitemcheckbox']:focus-visible,
  [role='menuitemradio']:focus-visible,
  [role='checkbox']:focus-visible,
  [role='switch']:focus-visible {
    outline: var(--gn-focus-ring-width, 2px) solid
      var(--gn-focus-ring-color, var(--color-primary, #1a73e8)) !important;
    outline-offset: var(--gn-focus-ring-offset, 2px) !important;
  }

  /* Form fields sit flush against their own border, so the ring hugs the field
     rather than floating 2px off it (this preserves the offset the previous
     input focus rule used). Components can still override the property. */
  input,
  select,
  textarea {
    --gn-focus-ring-offset: 0px;
  }

  /* Hosts that put themselves in the tab order (gn-file-status, gn-diff-view)
     cannot be reached by the [tabindex] rule above from inside their own
     shadow root, so they get a matching inset ring here. */
  :host([tabindex]:not([tabindex='-1']):focus-visible) {
    outline: var(--gn-focus-ring-width, 2px) solid
      var(--gn-focus-ring-color, var(--color-primary, #1a73e8)) !important;
    outline-offset: calc(-1 * var(--gn-focus-ring-width, 2px)) !important;
  }

  /* Mouse/touch focus stays quiet — only :focus-visible paints a ring. */
  :focus:not(:focus-visible) {
    outline: none;
  }
`;

/**
 * Shared styles for Lit components
 * Import into component static styles array
 */
export const sharedStyles = css`
  :host {
    box-sizing: border-box;
  }

  :host *,
  :host *::before,
  :host *::after {
    box-sizing: inherit;
  }

  /* Focus styles — keyboard-only focus indicators (WCAG 2.4.7) */
  ${focusRingStyles}

  /* Honour the OS "reduce motion" setting inside this shadow root */
  ${reducedMotionStyles}

  /* Button reset */
  button {
    font-family: inherit;
    font-size: inherit;
    border: none;
    background: none;
    cursor: pointer;
    padding: 0;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* Input reset */
  input,
  textarea,
  select {
    font-family: inherit;
    font-size: inherit;
  }

  /* Link reset */
  a {
    color: var(--color-primary);
    text-decoration: none;
  }

  a:hover {
    text-decoration: underline;
  }

  /* Utility classes */
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mono {
    font-family: var(--font-family-mono);
  }

  /* "Adding to <profile>" breadcrumb shown in a provider/OIDC connect dialog when
     it was opened from the Profiles & Accounts manager's attach flow. */
  .attach-breadcrumb {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    padding: var(--spacing-xs) var(--spacing-sm);
    background: var(--color-bg-tertiary);
    border-radius: var(--radius-sm);
  }

  .attach-breadcrumb strong {
    color: var(--color-text-primary);
  }

  /* ===========================================================
     Forced colors (Windows High Contrast Mode)
     The OS replaces author colors with its own palette, which
     silently drops focus rings and any state shown only through a
     custom background. Restate them with system color keywords.
     =========================================================== */
  @media (forced-colors: active) {
    :focus-visible,
    input:focus-visible,
    textarea:focus-visible,
    select:focus-visible {
      outline: 2px solid Highlight;
      outline-offset: 2px;
    }

    /* Disabled state is conveyed by opacity, which forced colors does not
       adjust — a faded-but-still-forced color reads as enabled. */
    button:disabled,
    .btn:disabled,
    .input:disabled {
      opacity: 1;
      color: GrayText;
      border-color: GrayText;
    }
  }
`;

/**
 * Button styles mixin
 */
export const buttonStyles = css`
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--spacing-xs);
    padding: var(--spacing-xs) var(--spacing-sm);
    border-radius: var(--radius-md);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-medium);
    transition: all var(--transition-fast);
  }

  .btn-primary {
    background: var(--color-primary);
    color: var(--color-text-inverse);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }

  .btn-secondary {
    background: var(--color-bg-tertiary);
    color: var(--color-text-primary);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-bg-hover);
  }

  .btn-ghost {
    background: transparent;
    color: var(--color-text-primary);
  }

  .btn-ghost:hover:not(:disabled) {
    background: var(--color-bg-hover);
  }

  .btn-icon {
    padding: var(--spacing-xs);
    border-radius: var(--radius-md);
  }
`;

/**
 * Input styles mixin
 */
export const inputStyles = css`
  .input {
    width: 100%;
    padding: var(--spacing-xs) var(--spacing-sm);
    background: var(--color-bg-primary);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text-primary);
    font-size: var(--font-size-sm);
    transition: border-color var(--transition-fast);
  }

  .input:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .input::placeholder {
    color: var(--color-text-muted);
  }

  .input:disabled {
    background: var(--color-bg-tertiary);
    cursor: not-allowed;
  }
`;

/**
 * Animation styles mixin
 * Common animations used across dashboard and status components
 */
export const animationStyles = css`
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @keyframes slideDown {
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .animate-pulse {
    animation: pulse 1s ease-in-out infinite;
  }

  .animate-spin {
    animation: spin 1s linear infinite;
  }
`;
