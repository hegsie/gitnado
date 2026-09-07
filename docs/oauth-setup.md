# OAuth App Setup Guide

This guide covers how to register OAuth applications with each integration provider. The client IDs are hardcoded in the app, so users don't need to configure anything.

## GitHub OAuth App

1. Go to [GitHub Developer Settings](https://github.com/settings/applications/new)
2. Fill in:
   - **Application name**: Gitnado
   - **Homepage URL**: https://github.com/hegsie/gitnado (or your app's website)
   - **Authorization callback URL**: `http://127.0.0.1/callback`
     - GitHub's loopback redirect allows any port, so the app can dynamically allocate one
3. Click **Register application**
4. Copy the **Client ID** - this gets hardcoded in the app
5. **No client secret needed** - GitHub supports PKCE for public clients

### Notes
- GitHub automatically trusts any port on `127.0.0.1` for the callback, making loopback OAuth simple
- The app uses PKCE (Proof Key for Code Exchange) for secure authorization without a client secret

---

## GitLab OAuth Application

1. Go to [GitLab Applications](https://gitlab.com/-/user_settings/applications)
   - For self-hosted GitLab: `https://your-gitlab-instance/-/user_settings/applications`
2. Fill in:
   - **Name**: Gitnado
   - **Redirect URI**: `gitnado://oauth/gitlab/callback`
   - **Confidential**: **Unchecked** (this makes it a public client)
   - **Scopes**: Select `api` and `read_user`
3. Click **Save application**
4. Copy the **Application ID** - this gets hardcoded in the app

### Notes
- Users with self-hosted GitLab instances will need to register their own OAuth app on their instance
- The `api` scope provides full API access; `read_user` allows reading user profile info

---

## Azure DevOps (Microsoft Entra ID)

**No registration is required.** "Sign in with Microsoft" uses the OAuth 2.0
**authorization-code + PKCE flow** over a **loopback redirect** — the same
interactive flow as GitHub/GitLab — with Microsoft's **Visual Studio first-party
public client** (`872cd9fa-d31f-45e0-9eab-6e460a02d1f1`). The user clicks the
button, signs in in the browser, and Entra redirects back to a short-lived local
loopback server that captures the code and exchanges it.

This is the same client Microsoft's own **Git Credential Manager** embeds for
Azure DevOps. Because the Azure DevOps resource **pre-authorizes** it, sign-in
raises **no consent prompt** — no per-tenant **admin consent** and no app
registration — while the interactive browser flow (unlike device-code) still
satisfies tenant **Conditional Access** policies.

The app requests the Azure DevOps `user_impersonation` scope (resource
`499b84ac-1321-427f-aa17-267ca6975798`) plus `offline_access` (for refresh) under
the `organizations` authority. **Work or school accounts only** — this client
rejects personal Microsoft accounts (the `/consumers` authority).

### Notes
- The redirect URI is `http://localhost:<dynamic-port>/` at the **root path** —
  the Visual Studio client registers bare `http://localhost`, and Entra matches
  the path (so `/callback` would not match) while ignoring the port for
  `localhost`. The loopback server therefore accepts the callback on `/` (it
  identifies the callback by its `code`/`error` query, not a fixed path).
- The loopback server binds `127.0.0.1` and, best-effort, the IPv6 loopback
  `[::1]` on the same port, so the callback lands whether `localhost` resolves to
  the IPv4 or IPv6 loopback (e.g. `::1` first on Windows).
- If a tenant blocks OAuth outright, use the **Personal Access Token** tab as a
  fallback (as Git Credential Manager and GitKraken also do).
- Reusing the Visual Studio client is the Git Credential Manager pattern; it is
  not a contractual guarantee, so the PAT fallback is kept for resilience.

---

## Bitbucket OAuth Consumer

1. Go to your Bitbucket workspace settings:
   `https://bitbucket.org/YOUR_WORKSPACE/workspace/settings/oauth-consumers/new`
2. Fill in:
   - **Name**: Gitnado
   - **Callback URL**: `gitnado://oauth/bitbucket/callback`
   - **This is a private consumer**: **Unchecked** (makes it a public client)
   - **Permissions**:
     - Account: Read
     - Repositories: Read, Write
     - Pull requests: Read, Write
3. Click **Save**
4. Copy the **Key** (this is the client ID) - this gets hardcoded in the app

### Notes
- Bitbucket OAuth consumers are workspace-specific
- The "Key" is the client ID, and "Secret" is the client secret (not needed for public clients with PKCE)

---

## Updating the Hardcoded Client IDs

After registering the OAuth apps, update the client IDs in:

```
src/services/oauth.service.ts
```

Look for the `OAUTH_CLIENT_IDS` object near the top of the file:

```typescript
const OAUTH_CLIENT_IDS: Record<OAuthProvider, string> = {
  github: 'your-github-client-id',
  gitlab: 'your-gitlab-application-id',
  azure: 'your-azure-application-client-id', // optional: defaults to Microsoft's Visual Studio first-party client (no registration / admin consent)
  bitbucket: 'your-bitbucket-key',
};
```
