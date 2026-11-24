// The texts of the page the system browser shows after "Sign in with Discord" (server/lib/accounts/authpage.mjs
// serves it from web/i18n/<lang>.json – this list is where the keys are declared, so they are extracted and translated
// like every other text). The app shows the first one itself too, as the toast after signing in.
import { t } from './i18n.mjs';

export const authTexts = () => ({
  okTitle: t('auth.okTitle', 'You’re signed in'),
  okText: t('auth.okText', 'You can close this tab and go back to twincable.'),
  failTitle: t('auth.failTitle', 'Signing in didn’t work'),
  failText: t('auth.failText', 'Go back to twincable and try again.'),
  deniedTitle: t('auth.deniedTitle', 'Sign-in cancelled'),
  deniedText: t('auth.cancelledText', 'You cancelled the sign-in – nothing was shared with twincable. You can close this tab.'),
  mismatchText: t('auth.mismatchText', 'This sign-in link doesn’t belong to the sign-in twincable started. Go back to twincable and start again.'),
  expiredText: t('auth.expiredText', 'This sign-in took too long. Go back to twincable and start again.'),
  offlineText: t('auth.offlineText', 'twincable couldn’t reach the account service. Check your internet connection, then try again in twincable.'),
  suspendedText: t('auth.suspendedText', 'This twincable account is suspended.'),
});
