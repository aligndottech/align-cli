/**
 * The one upgrade line the CLI prints, only at the share moment (a team action tried with no team
 * login). One place for the booking link: the CLI links to a redirect Align owns, so routing the
 * call to someone else later is a site change and needs no CLI release (plan 2026-10-09, Open
 * Question 1). Flip TEAM_SIGNUP_OPEN when prod team signup opens.
 */
// Confirmed by Tom 2026-10-10: align.tech/demo?ref=cli redirects to the 30-minute booking page.
export const BOOK_CALL_URL = 'https://align.tech/demo?ref=cli';
export const TEAM_SIGNUP_URL = 'https://app.align.tech/signup';
export const TEAM_SIGNUP_OPEN = false;

export function teamCtaLine(open: boolean = TEAM_SIGNUP_OPEN): string {
  return open
    ? `Start a team graph: ${TEAM_SIGNUP_URL}`
    : `Bring this to your team. Book a 30-minute call: ${BOOK_CALL_URL}`;
}
