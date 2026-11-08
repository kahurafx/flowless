/**
 * Sign-in identifiers. A user belongs to exactly one organization and signs in with its
 * organization code plus an email (owners and admins) or a username (other staff).
 * Shared by web and mobile so both build identical credentials.
 */

/** Organization codes are the organization's slug: letters and digits, any case when typed. */
export const ORGANIZATION_CODE_PATTERN = /^[a-z0-9]{2,32}$/;

/** HTTP header that carries the organization code on sign-in requests. */
export const ORGANIZATION_CODE_HEADER = "x-flowless-organization";

/** "  MajiSafi " → "majisafi"; null when it cannot be a code. */
export function normalizeOrganizationCode(raw: string): string | null {
  const code = raw.trim().toLowerCase();
  return ORGANIZATION_CODE_PATTERN.test(code) ? code : null;
}

/** Local staff usernames: unique inside one organization only. */
export const LOCAL_USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;

/**
 * Usernames are stored qualified by the organization code ("kilima.baraka"), so two
 * organizations can each have a "baraka" while the identity store stays globally unique.
 */
export function qualifiedUsername(code: string, localUsername: string): string {
  return `${code}.${localUsername.trim().toLowerCase()}`;
}

/** An email signs in as an owner or admin; anything else is a local username. */
export function isEmailIdentifier(identifier: string): boolean {
  return identifier.includes("@");
}

/**
 * URL scheme of the mobile app (`scheme` in apps/mobile/app.json). Better Auth trusts it as an
 * origin so the Expo client can sign in; the two must match.
 */
export const MOBILE_APP_SCHEME = "flowless";
