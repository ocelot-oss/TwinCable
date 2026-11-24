// The project's public addresses – shown in the sidebar, in Settings › About and on the stream overlays' coffee
// pop-up (shared/coffee.mjs). web/lib/links.mjs re-exports them for the app.
export const LINKS = {
  coffee: 'https://buymeacoffee.com/souldew',
  // the twincable Discord server (invite) – where "Find a SoulLink partner" posts go
  discord: 'https://discord.gg/kvVDCyzdpQ',
  // the memberships (Supporter, twincable+, Legend) – joining, switching and cancelling all happen there
  membership: 'https://buymeacoffee.com/souldew/membership',
  github: 'https://github.com/souldewapp/souldew',
  issues: 'https://github.com/souldewapp/souldew/issues/new/choose',
  releases: 'https://github.com/souldewapp/souldew/releases',
  streamApiDocs: 'https://github.com/souldewapp/souldew/blob/main/docs/STREAM_API.md',
  // what the anonymous "playing now" count sends (Settings › General): the privacy page (German, with an English line)
  // and docs/PRIVACY.md (English, the exact request)
  privacy: 'https://souldew.app/datenschutz.html#spielt-gerade',
  privacyDocs: 'https://github.com/souldewapp/souldew/blob/main/docs/PRIVACY.md',
  // the app's privacy policy – what twincable sends by itself and how to switch it off; the Windows installer's privacy
  // page (build/installer.nsh) and the welcome tour link to it
  privacyPolicy: 'https://souldew.app/privacy.html',
};
