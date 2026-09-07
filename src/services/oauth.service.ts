/**
 * OAuth service for provider authentication
 *
 * Handles OAuth authentication flows for GitHub, GitLab, Azure DevOps, and Bitbucket.
 * All providers use a loopback server for the callback. GitHub/GitLab/Bitbucket
 * register a `127.0.0.1:port` redirect; Azure DevOps registers a `localhost:port`
 * redirect (Entra ignores the port only for `localhost`). The server binds
 * `127.0.0.1` and, best-effort, `[::1]`, so a `localhost` callback lands either way.
 */

import { onOpenUrl, getCurrent } from '@tauri-apps/plugin-deep-link';
import { open } from '@tauri-apps/plugin-shell';
import { listen } from '@tauri-apps/api/event';
import { invokeCommand } from './tauri-api.ts';
import { loggers } from '../utils/logger.ts';
import type {
  OAuthProvider,
  StartOAuthResponse,
  CallbackResponse,
  OAuthTokenResponse,
  PendingOAuth,
  OAuthFlowState,
} from '../types/oauth.types';

/**
 * OAuth Client IDs for each provider
 * See docs/oauth-setup.md for registration instructions
 */
const OAUTH_CLIENT_IDS: Partial<Record<OAuthProvider, string>> = {
  github: 'Ov23liQxX14fxt3fRq4u',
  gitlab: '90d3d02fefb79e0303aaa54e8c6794bf806e9e8a1de7526bebc4f14288e12fec',
  // Microsoft's Visual Studio first-party public client. It is pre-authorized for
  // the Azure DevOps resource in every tenant, so interactive sign-in needs NO
  // per-tenant admin consent and NO app registration — the same client Microsoft's
  // own Git Credential Manager embeds (redirect http://localhost, root path). Work
  // or school accounts only (the /organizations authority; personal MSAs are not
  // supported by this client).
  azure: '872cd9fa-d31f-45e0-9eab-6e460a02d1f1',
  bitbucket: 'Tv5UjEqLKK7GSYjAJn',
};

/**
 * OAuth Client Secrets for providers that require them
 *
 * SECURITY NOTE: These secrets are embedded in the compiled application
 * and can be extracted by anyone. This is a known limitation of desktop OAuth apps.
 *
 * Best Practices:
 * - For GitHub: Client secret is optional when using PKCE (Proof Key for Code Exchange).
 *   Consider removing it and using PKCE-only flow.
 * - For Bitbucket: May require client secret for token exchange depending on configuration.
 *
 * Possible Future Improvements:
 * 1. Use PKCE-only flows where supported (no client secret needed)
 * 2. Accept client secrets via build-time environment variables so developers
 *    building from source can substitute their own credentials
 * 3. Implement a backend proxy service to handle token exchange securely
 *
 * See: https://datatracker.ietf.org/doc/html/rfc7636 (OAuth PKCE)
 */
const OAUTH_CLIENT_SECRETS: Partial<Record<OAuthProvider, string>> = {
  github: '5b7d15b2c5658908e0ced1682e53168269513592',
  // Bitbucket requires client secret for token exchange
  bitbucket: 'HAqqaX24y8QSexmnvfbQkEPShUjskmUm',
};

const log = loggers.oauth;

/** Currently pending OAuth authentications, keyed by provider to prevent race conditions */
const pendingAuthByProvider = new Map<OAuthProvider, PendingOAuth>();

/** Listeners for OAuth state changes */
const stateListeners = new Set<(state: OAuthFlowState) => void>();

/** Notify all state listeners */
function notifyStateChange(state: OAuthFlowState): void {
  stateListeners.forEach((listener) => listener(state));
}

/**
 * Subscribe to OAuth state changes
 */
export function onOAuthStateChange(
  listener: (state: OAuthFlowState) => void
): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/**
 * Initialize OAuth deep link listener
 * Should be called once when the app starts
 */
export async function initOAuthListener(): Promise<void> {
  // Check if app was launched via deep link
  try {
    const urls = await getCurrent();
    if (urls?.length) {
      handleDeepLink(urls[0]);
    }
  } catch (e) {
    // Deep link plugin may not be available in dev mode
    log.debug('Deep link getCurrent not available:', e);
  }

  // Listen for deep links while app is running
  try {
    await onOpenUrl((urls: string[]) => {
      if (urls.length) {
        handleDeepLink(urls[0]);
      }
    });
  } catch (e) {
    log.debug('Deep link onOpenUrl not available:', e);
  }

  // Also listen for deep links via single-instance plugin (Windows/Linux)
  try {
    await listen<string>('deep-link', (event) => {
      handleDeepLink(event.payload);
    });
  } catch (e) {
    log.debug('Deep link event listener not available:', e);
  }
}

/**
 * OAuth callback deep-link prefixes. `leviathan://` is the scheme from before
 * the 0.9.0 rename; it stays registered (see `deep-link.desktop.schemes` in
 * tauri.conf.json) so a callback configured against the old name still lands.
 */
export const OAUTH_DEEP_LINK_PREFIXES = ['gitnado://oauth/', 'leviathan://oauth/'] as const;

/**
 * The provider segment of an OAuth callback deep link
 * (`<scheme>://oauth/{provider}/callback?…`), or `null` for any other URL.
 */
export function oauthDeepLinkProvider(url: string): OAuthProvider | null {
  const prefix = OAUTH_DEEP_LINK_PREFIXES.find((p) => url.startsWith(p));
  if (!prefix) return null;
  const segment = url.slice(prefix.length).split(/[/?#]/)[0];
  return segment ? (segment as OAuthProvider) : null;
}

/**
 * Handle incoming deep link
 */
async function handleDeepLink(url: string): Promise<void> {
  const providerSegment = oauthDeepLinkProvider(url);
  if (providerSegment === null) {
    // Don't log the raw URL — it may carry sensitive query params (code/state).
    log.debug('Ignoring non-OAuth deep link');
    return;
  }
  log.debug('Received OAuth deep link');

  const pending = pendingAuthByProvider.get(providerSegment);

  if (!pending) {
    log.warn('Received OAuth callback but no pending auth for provider:', providerSegment);
    return;
  }

  try {
    // Parse the URL: gitnado://oauth/{provider}/callback?code=xxx&state=yyy
    const parsed = new URL(url);
    const code = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state');
    const error = parsed.searchParams.get('error');
    const errorDescription = parsed.searchParams.get('error_description');

    if (error) {
      notifyStateChange({
        status: 'error',
        error: errorDescription || error,
        provider: pending.provider,
      });
      pendingAuthByProvider.delete(pending.provider);
      return;
    }

    if (!code) {
      notifyStateChange({
        status: 'error',
        error: 'No authorization code received',
        provider: pending.provider,
      });
      pendingAuthByProvider.delete(pending.provider);
      return;
    }

    // Verify state matches
    if (state !== pending.state) {
      notifyStateChange({
        status: 'error',
        error: 'State mismatch - possible CSRF attack',
        provider: pending.provider,
      });
      pendingAuthByProvider.delete(pending.provider);
      return;
    }

    // Exchange code for tokens. The server holds the PKCE verifier and the
    // redirect/instance details, keyed by `state` — we only pass state + code.
    notifyStateChange({
      status: 'exchanging',
      provider: pending.provider,
    });

    const tokens = await exchangeCode(pending.provider, state, code);

    notifyStateChange({
      status: 'success',
      provider: pending.provider,
    });

    // Dispatch event for the dialog to handle
    window.dispatchEvent(
      new CustomEvent('oauth-complete', {
        detail: {
          provider: pending.provider,
          tokens,
          instanceUrl: pending.instanceUrl,
        },
      })
    );

    pendingAuthByProvider.delete(pending.provider);
  } catch (e) {
    log.error('OAuth callback error:', e);
    notifyStateChange({
      status: 'error',
      error: e instanceof Error ? e.message : 'Unknown error',
      provider: pending.provider,
    });
    pendingAuthByProvider.delete(pending.provider);
  }
}

/**
 * Start OAuth flow for a provider
 */
export async function startOAuth(
  provider: OAuthProvider,
  clientId: string,
  instanceUrl?: string
): Promise<void> {
  try {
    notifyStateChange({ status: 'pending', provider });

    const cmdResult = await invokeCommand<StartOAuthResponse>('oauth_get_authorize_url', {
      provider,
      clientId,
      instanceUrl,
    });
    if (!cmdResult.success || !cmdResult.data) {
      throw new Error(cmdResult.error?.message ?? 'Failed to get authorize URL');
    }
    const response = cmdResult.data;

    pendingAuthByProvider.set(provider, {
      provider,
      state: response.state,
      instanceUrl,
      loopbackPort: response.loopbackPort,
      startedAt: Date.now(),
    });

    // Open the authorization URL in the browser
    await open(response.authorizeUrl);

    // For providers using loopback server, poll for the callback. Pass this
    // flow's `state` captured HERE (synchronously, before any further await) as
    // its identity — deriving it via a map lookup inside the callee would be
    // racy, since a cancel+restart during `await open()` above can replace the
    // pending entry before the poll runs.
    if (response.loopbackPort) {
      pollLoopbackCallback(provider, response.loopbackPort, response.state).catch((e) => {
        log.error(`OAuth polling error for ${provider}:`, e);
        pendingAuthByProvider.delete(provider);
        notifyStateChange({
          status: 'error',
          error: e instanceof Error ? e.message : 'OAuth polling failed',
          provider,
        });
      });
    }
  } catch (e) {
    log.error('Failed to start OAuth:', e);
    notifyStateChange({
      status: 'error',
      error: e instanceof Error ? e.message : 'Failed to start OAuth',
      provider,
    });
  }
}

/**
 * Poll for loopback callback (works for GitHub, GitLab, and any provider using loopback server)
 */
async function pollLoopbackCallback(
  provider: OAuthProvider,
  port: number,
  expectedState: string,
): Promise<void> {
  try {
    // Wait for the callback on the loopback server. The backend validates the
    // provider-echoed `state` against the pending flow before returning (M11).
    const callbackResult = await invokeCommand<CallbackResponse>('oauth_wait_for_callback', {
      port,
    });
    if (!callbackResult.success || !callbackResult.data) {
      throw new Error(callbackResult.error?.message ?? 'Failed to receive OAuth callback');
    }
    const { code, state } = callbackResult.data;

    // Re-check in case user cancelled while waiting for callback
    const current = pendingAuthByProvider.get(provider);
    if (!current) {
      return; // User cancelled or timeout
    }

    // If the flow THIS poll started was superseded (the user cancelled and
    // restarted, so `current` is now a different, still-in-progress flow), drop
    // this stale callback SILENTLY. Do NOT delete `current` or surface an error —
    // that would clobber the newer flow's pending state and show a spurious
    // "state mismatch" for the user's real, in-progress sign-in. Identity comes
    // from `expectedState` (captured at start), not a racy re-read.
    if (current.state !== expectedState) {
      return;
    }

    // Guard against stale/overlapping flows: the callback's state must match the
    // flow we started for this provider. The backend validates state too, but
    // checking here avoids exchanging the wrong flow when callbacks interleave.
    if (state !== current.state) {
      pendingAuthByProvider.delete(provider);
      notifyStateChange({
        status: 'error',
        error: 'OAuth state mismatch — ignoring a stale or unexpected callback',
        provider,
      });
      return;
    }

    notifyStateChange({
      status: 'exchanging',
      provider,
    });

    // Server derives verifier/redirect/instance from the stored flow keyed by state.
    const tokens = await exchangeCode(provider, state, code);

    // The user may have cancelled — or cancelled AND restarted — during the token
    // exchange network round-trip (after the pre-exchange re-check above). If the
    // pending flow for this provider is gone (cancelled) or has been replaced by a
    // newer flow (different state), do NOT dispatch: otherwise this abandoned
    // flow's tokens would surface as if they belonged to the current flow. Only
    // delete our own entry (the still-current flow below); leave a newer one alone.
    const afterExchange = pendingAuthByProvider.get(provider);
    if (!afterExchange || afterExchange.state !== state) {
      return;
    }

    notifyStateChange({
      status: 'success',
      provider,
    });

    window.dispatchEvent(
      new CustomEvent('oauth-complete', {
        detail: {
          provider,
          tokens,
          instanceUrl: current.instanceUrl,
        },
      })
    );

    pendingAuthByProvider.delete(provider);
  } catch (e) {
    log.error(`${provider} OAuth error:`, e);
    // Same guard as the success path: only surface/clean up if the flow THIS poll
    // served is still the current one. `cancelOAuth` aborts the backend wait via
    // `oauth_cancel_flow`, so the abandoned wait rejects promptly — often while
    // the user's restarted flow is already pending. That superseded flow's late
    // error must NOT fire a spurious error for the new flow or delete the new
    // flow's pending entry (which would silently drop the user's real,
    // in-progress sign-in).
    const current = pendingAuthByProvider.get(provider);
    if (!current || current.state !== expectedState) {
      return;
    }
    notifyStateChange({
      status: 'error',
      error: e instanceof Error ? e.message : `${provider} OAuth failed`,
      provider,
    });
    pendingAuthByProvider.delete(provider);
  }
}

/**
 * Exchange authorization code for tokens.
 *
 * The PKCE verifier, redirect URI, provider and instance URL are all held
 * server-side in the pending flow keyed by `state` (M5/M11), so the frontend
 * only supplies `state`, `code`, and the embedded client credentials. The
 * `provider` argument is used solely to look up those client credentials.
 */
export async function exchangeCode(
  provider: OAuthProvider,
  state: string,
  code: string
): Promise<OAuthTokenResponse> {
  // Get client ID and secret from config
  const clientId = getClientId(provider);
  const clientSecret = getClientSecret(provider);

  const cmdResult = await invokeCommand<OAuthTokenResponse>('oauth_exchange_code', {
    state,
    code,
    clientId,
    clientSecret,
  });
  if (!cmdResult.success || !cmdResult.data) {
    throw new Error(cmdResult.error?.message ?? 'Failed to exchange OAuth code');
  }

  const result = cmdResult.data;

  // Handle both camelCase and snake_case field names (Rust serde serialization edge case)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawResult = result as any;
  const normalizedResult: OAuthTokenResponse = {
    accessToken: rawResult.accessToken || rawResult.access_token,
    refreshToken: rawResult.refreshToken || rawResult.refresh_token,
    expiresIn: rawResult.expiresIn || rawResult.expires_in,
    tokenType: rawResult.tokenType || rawResult.token_type,
    scope: rawResult.scope,
    // Preserve the OIDC ID token — it's the only source of user identity for
    // Enterprise SSO accounts (decoded in the OIDC dialog for the cached user).
    idToken: rawResult.idToken || rawResult.id_token,
  };

  return normalizedResult;
}

/**
 * Refresh an OAuth token
 */
export async function refreshToken(
  provider: OAuthProvider,
  refreshTokenValue: string,
  instanceUrl?: string
): Promise<OAuthTokenResponse> {
  const clientId = getClientId(provider);
  // Bitbucket (like GitHub) authenticates the refresh grant with the client
  // secret, same as the code exchange; PKCE public clients (GitLab, Entra) have
  // none and send only the client id.
  const clientSecret = getClientSecret(provider);

  const result = await invokeCommand<OAuthTokenResponse>('oauth_refresh_token', {
    provider,
    refreshToken: refreshTokenValue,
    clientId,
    clientSecret,
    instanceUrl,
  });
  if (!result.success || !result.data) {
    throw new Error(result.error?.message ?? 'Failed to refresh OAuth token');
  }

  // Normalize snake_case/camelCase like exchangeCode (serde edge case),
  // so callers reliably read accessToken/refreshToken/expiresIn.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = result.data as any;
  return {
    accessToken: raw.accessToken || raw.access_token,
    refreshToken: raw.refreshToken || raw.refresh_token,
    expiresIn: raw.expiresIn || raw.expires_in,
    tokenType: raw.tokenType || raw.token_type,
    scope: raw.scope,
    idToken: raw.idToken || raw.id_token,
  };
}

/**
 * Release the backend loopback server for an abandoned flow.
 *
 * The backend's callback wait owns the socket until it times out (5 minutes),
 * which blocks a retry for providers pinned to a fixed port (Bitbucket's
 * registered redirect is 127.0.0.1:8085). Fire-and-forget: the local pending
 * state is already cleared, and a failure here only means the socket lingers
 * until that timeout, so it is not surfaced to the user.
 */
function releaseLoopbackServer(pending: PendingOAuth): void {
  const port = pending.loopbackPort;
  if (port === undefined) return;
  void invokeCommand('oauth_cancel_flow', { port }).then(
    (result) => {
      if (!result.success) {
        log.debug(`Failed to release OAuth loopback server on port ${port}:`, result.error?.message);
      }
    },
    (e) => {
      log.debug(`Failed to release OAuth loopback server on port ${port}:`, e);
    }
  );
}

/**
 * Cancel pending OAuth flow
 */
export function cancelOAuth(provider?: OAuthProvider): void {
  if (provider) {
    const pending = pendingAuthByProvider.get(provider);
    if (pending) {
      notifyStateChange({ status: 'idle', provider });
      pendingAuthByProvider.delete(provider);
      releaseLoopbackServer(pending);
    }
  } else {
    const cancelled = [...pendingAuthByProvider.values()];
    for (const [p] of pendingAuthByProvider) {
      notifyStateChange({ status: 'idle', provider: p });
    }
    pendingAuthByProvider.clear();
    cancelled.forEach(releaseLoopbackServer);
  }
}

/**
 * Check if an OAuth flow is pending
 */
export function isPendingOAuth(): boolean {
  return pendingAuthByProvider.size > 0;
}

/**
 * Get the pending OAuth provider
 */
export function getPendingProvider(): OAuthProvider | null {
  const first = pendingAuthByProvider.keys().next();
  return first.done ? null : first.value;
}

/**
 * Get client ID for a provider
 */
export function getClientId(provider: OAuthProvider): string {
  return OAUTH_CLIENT_IDS[provider] || '';
}

/**
 * Get client secret for a provider (if required)
 */
export function getClientSecret(provider: OAuthProvider): string | undefined {
  return OAUTH_CLIENT_SECRETS[provider];
}

/**
 * Check if OAuth is configured for a provider
 */
export function isOAuthConfigured(provider: OAuthProvider): boolean {
  return !!getClientId(provider);
}

// ========================================================================
// OIDC (Enterprise SSO)
// ========================================================================

export interface OidcDiscovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string | null;
  issuer: string;
  scopesSupported: string[];
}

export interface OidcUserInfo {
  sub: string;
  email: string | null;
  name: string | null;
  preferredUsername: string | null;
  picture: string | null;
}

/**
 * Discover OIDC provider configuration from an issuer URL
 */
export async function discoverOidcProvider(issuerUrl: string): Promise<OidcDiscovery> {
  const result = await invokeCommand<OidcDiscovery>('discover_oidc_provider', { issuerUrl });
  if (!result.success || !result.data) {
    throw new Error(result.error?.message ?? 'Failed to discover OIDC provider');
  }
  return result.data;
}

/**
 * Decode an OIDC ID token to extract user identity
 */
export async function decodeOidcIdToken(idToken: string): Promise<OidcUserInfo> {
  const result = await invokeCommand<OidcUserInfo>('decode_oidc_id_token', { idToken });
  if (!result.success || !result.data) {
    throw new Error(result.error?.message ?? 'Failed to decode OIDC ID token');
  }
  return result.data;
}
