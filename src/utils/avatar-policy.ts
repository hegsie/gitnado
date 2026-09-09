/**
 * Avatar fetch policy
 *
 * Author avatars are images pulled from Gravatar — a third-party service that
 * receives an MD5 hash of every commit author's email address, plus this
 * machine's IP, every time the graph paints a new author. That is a network
 * request, so it has to answer to the same Security & Privacy settings as
 * every other network operation.
 *
 * Those requests are issued by the canvas renderer with `new Image()`, which
 * never passes through `git.service`'s `checkNetworkAllowed` gate — the gate
 * only guards Tauri command invocations. This module is the equivalent gate
 * for avatars, and the single place that decides whether an avatar request may
 * leave the machine. Every avatar consumer must ask it rather than reading
 * `showAvatars` directly.
 */

import { msg, str } from '@lit/localize';
import { settingsStore, type SettingsState } from '../stores/settings.store.ts';

/** The host every avatar request goes to. */
export const GRAVATAR_HOST = 'www.gravatar.com';

/** Why avatar fetching is off. `null` from the checks below means "allowed". */
export type AvatarBlockReason =
  /** The "Show Avatars" setting is off. */
  | 'disabled'
  /** Offline Mode is on — nothing may leave this machine. */
  | 'offline'
  /** An allowlist is configured and Gravatar is not on it. */
  | 'allowlist';

/** The slice of settings the policy reads. */
export type AvatarPolicyInput = Pick<
  SettingsState,
  'showAvatars' | 'offlineMode' | 'remoteAllowlist'
>;

/**
 * Reduce an allowlist entry to a bare host.
 *
 * Mirrors `git.service`'s allowlist matching: entries are domains, a leading
 * `*.` means "the domain and its subdomains" (which a bare entry already
 * means), and a full URL is accepted and reduced to its host.
 */
function allowlistEntryHost(entry: string): string {
  const normalized = entry.trim().toLowerCase().replace(/^\*\./, '');
  if (normalized === '') return '';
  try {
    return new URL(
      normalized.includes('://') ? normalized : `https://${normalized}`
    ).hostname.toLowerCase();
  } catch {
    return normalized;
  }
}

/**
 * Whether `host` is permitted by a remote allowlist.
 *
 * An EMPTY allowlist permits everything — that is what "Leave empty to allow
 * all" in Settings means, and it matches `checkNetworkAllowed`, which returns
 * early for an empty list.
 *
 * Matching is on the host, not on a substring of it: `gravatar.com.evil.test`
 * must not pass because it contains "gravatar.com". A parent domain permits
 * its subdomains, so allowlisting `gravatar.com` permits `www.gravatar.com`.
 */
export function allowlistPermits(host: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  const target = host.trim().toLowerCase();
  if (target === '') return false;
  return allowlist.some((entry) => {
    const allowed = allowlistEntryHost(entry);
    return allowed !== '' && (target === allowed || target.endsWith(`.${allowed}`));
  });
}

/**
 * Why avatars may not be fetched, or `null` when they may be.
 *
 * Checked in the order a user would explain it: the feature is off, or the
 * machine is offline, or Gravatar is not allowlisted.
 */
export function avatarFetchBlockReason(settings: AvatarPolicyInput): AvatarBlockReason | null {
  if (!settings.showAvatars) return 'disabled';
  if (settings.offlineMode) return 'offline';
  if (!allowlistPermits(GRAVATAR_HOST, settings.remoteAllowlist)) return 'allowlist';
  return null;
}

/**
 * The effective "fetch avatars" flag: the user asked for avatars AND the
 * privacy settings permit the request.
 */
export function shouldFetchAvatars(settings: AvatarPolicyInput): boolean {
  return avatarFetchBlockReason(settings) === null;
}

/** `shouldFetchAvatars` against the live settings store. */
export function shouldFetchAvatarsNow(): boolean {
  return shouldFetchAvatars(settingsStore.getState());
}

/**
 * One sentence explaining why the "Show Avatars" control is unavailable, for
 * the Settings row. `null` when nothing is blocking it.
 */
export function avatarBlockedExplanation(settings: AvatarPolicyInput): string | null {
  const settingsWithFeatureOn = { ...settings, showAvatars: true };
  switch (avatarFetchBlockReason(settingsWithFeatureOn)) {
    case 'offline':
      return msg('Unavailable while Offline Mode is on — avatars are fetched from gravatar.com.');
    case 'allowlist':
      return msg(str`Unavailable: your remote allowlist does not include ${GRAVATAR_HOST}.`);
    default:
      return null;
  }
}
