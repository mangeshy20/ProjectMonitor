/* ==========================================================================
   config.js: your settings. This is the only file you need to edit.
   Change the name, logo, colour, Google Sheet and starting names here.
   ========================================================================== */
window.APP_CONFIG = {

  /* ---------- Branding ---------- */

  // Name shown in the top bar and the browser tab.
  APP_NAME: 'Project Monitor',

  // One line shown in search results and link previews.
  APP_DESCRIPTION: 'See every project at a glance, where it stands, and what happened to it.',

  // Your logo: a file next to index.html (e.g. 'logo.png') or a full https:// link.
  // Leave empty to use the built-in bar-chart icon.
  LOGO_URL: '',

  // Browser tab icon (e.g. 'favicon.png'). Leave empty to use the logo, or the built-in icon.
  FAVICON_URL: '',

  // Main colour for buttons, links and highlights (any CSS colour, e.g. '#2546c7').
  ACCENT_COLOR: '#2546c7',

  /* ---------- Google Sheet ---------- */

  // From the Sheet URL: https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit
  SPREADSHEET_ID: '',

  // Tab that holds the projects. If no tab has this name, Google uses the first tab.
  SHEET_NAME: 'Projects',

  // Number after "#gid=" in the Sheet URL when that tab is open (0 = the first tab).
  SHEET_GID: '0',

  // Web app URL of the Sheet's Apps Script (Deploy → Web app, ends in /exec).
  SCRIPT_URL: '',

  /* ---------- Starting names ---------- */
  // Used only until the Sheet's Admin tab has names. After that, edit them in the
  // dashboard: double-click the app name → Team.

  TEAM: ['Alex', 'Sam', 'Jordan', 'Taylor'],         // "Who are you?" and @tags
  MANAGERS: ['Alex'],                                 // "Who is in charge?"
  DEVELOPERS: ['Sam', 'Jordan'],                      // "Developer"
};
