/* ==========================================================================
   Project dashboard — script.js
   Plain JavaScript. Reads the projects through the Google Sheet's share link;
   saves changes and reads each project's history (the Logs tab) through the
   Sheet's own Apps Script web app, so nobody signs in.
   ========================================================================== */
'use strict';

/* --------------------------------------------------------------------------
   CONFIG: comes from config.js (name, logo, colour, Sheet, starting names)
   -------------------------------------------------------------------------- */
const USER_CONFIG = window.APP_CONFIG || {};
const CONFIG = {
  APP_NAME: 'Project Monitor',
  APP_DESCRIPTION: '',
  LOGO_URL: '',
  FAVICON_URL: '',
  ACCENT_COLOR: '',
  SPREADSHEET_ID: '',
  SHEET_NAME: 'Projects',
  SHEET_GID: '0',
  SCRIPT_URL: '',
  ...USER_CONFIG,
};
CONFIG.APP_NAME = String(CONFIG.APP_NAME || '').trim() || 'Project Monitor';

/** Names list from config.js, or the fallback when it's missing or empty. */
function configNames(list, fallback) {
  const names = Array.isArray(list) ? list.map((n) => String(n).trim()).filter(Boolean) : [];
  return names.length ? names : fallback;
}

/* --------------------------------------------------------------------------
   Constants
   -------------------------------------------------------------------------- */
const HEADERS = [
  'ID', 'Project Name', 'Client / Department', 'Project Manager', 'Start Date', 'Due Date',
  'Completion Date', 'Stage', 'Progress (%)', 'Status', 'Priority', 'Budget', 'Remarks', 'Last Updated', 'Developer',
];
const FIELDS = [
  'id', 'name', 'client', 'manager', 'startDate', 'dueDate',
  'completionDate', 'stage', 'progress', 'status', 'priority', 'budget', 'remarks', 'lastUpdated', 'developer',
];
const STAGES = ['Planning', 'Design', 'Review', 'Development', 'Testing', 'Deployment', 'Completed'];
const STATUSES = ['On Track', 'At Risk', 'Delayed', 'On Hold', 'Completed'];
// Short step names for small screens (the full name shows on hover).
// How much of a project is done at each step. Moving a step sets progress to this.
const STAGE_PERCENT = { Planning: 10, Design: 25, Review: 40, Development: 60, Testing: 75, Deployment: 90, Completed: 100 };
const STAGE_SHORT = { Planning: 'Plan', Design: 'Design', Development: 'Dev', Testing: 'Test', Review: 'Review', Deployment: 'Deploy', Completed: 'Done' };
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];

const DATE_FIELDS = new Set(['startDate', 'dueDate', 'completionDate']);

// Plain-language meaning of each status, shown in dropdowns and the help.
const STATUS_HELP = {
  'On Track': 'going as planned',
  'At Risk': 'might be late',
  'Delayed': 'behind schedule',
  'On Hold': 'paused for now',
  'Completed': 'finished',
};

// People who make changes. Shown in every "Your name" dropdown, each with a fixed color.
// Starting list; Admin → Team replaces it for everyone (saved in the Admin tab).
const DEFAULT_TEAM = configNames(CONFIG.TEAM, ['Team member']);
let TEAM = DEFAULT_TEAM.slice();
// Developer dropdown; Admin → Team replaces it for everyone (saved in the Admin tab).
const DEFAULT_DEVELOPERS = configNames(CONFIG.DEVELOPERS, DEFAULT_TEAM.slice());
let DEVELOPERS = DEFAULT_DEVELOPERS.slice();
// "Who is in charge?" dropdown; Admin → Team replaces it for everyone (saved in the Admin tab).
const DEFAULT_MANAGERS = configNames(CONFIG.MANAGERS, DEFAULT_TEAM.slice(0, 1));
let MANAGERS = DEFAULT_MANAGERS.slice();
const PERSON_COLORS = 8; // --person-0 … --person-7 in style.css

/** Normalised header text -> field key (tolerant of spacing/punctuation/case). */
const FIELD_BY_HEADER = HEADERS.reduce((map, header, i) => {
  map[normalizeHeader(header)] = FIELDS[i];
  return map;
}, {});

/* --------------------------------------------------------------------------
   State
   -------------------------------------------------------------------------- */
const state = {
  projects: [],
  headers: [],          // header row exactly as it is in the Sheet
  lastSynced: null,
  loading: false,
  hasLoadedOnce: false,
  loadError: null,      // message of the last failed load, shown when there's no data
  sample: false,        // true while showing the built-in sample projects (the Sheet is empty)
  busy: false,          // a save or delete is in progress
  editingId: null,      // ID of the project open in the edit popup (null = adding)
  pendingDeleteId: null,
  drawerId: null,       // project open in the details panel
  drawerPane: 'overview',
  apis: [],              // every project's API integrations (APIs tab)
  logFilter: 'all',     // History tab filter: all | changes | notes
  activityFilter: 'all',
  activityLimit: 60,
  allLogs: [],          // every project's history, newest first (Logs tab)
  logsStatus: 'idle',   // idle | loading | ok | unsupported | nosetup | error | sample
  scriptReads: undefined, // true once the script serves ?action=data (v3); false for older scripts
  sheetGid: null,       // the projects tab's gid, as reported by the script
  deepLinkHandled: false,
  filters: { quick: 'all', search: '', stage: '' }, // quick: all | active | done | overdue | week
  sort: { key: 'dueDate', dir: 'asc' },
};

let syncLabelTimer = null;

/** Error with a category so the UI can show the right message. */
class AppError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/* --------------------------------------------------------------------------
   DOM helpers
   -------------------------------------------------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const els = {};
function cacheElements() {
  [
    'lastSynced', 'syncDot', 'addBtn', 'activityBtn', 'activityCount',
    'notice', 'noticeTitle', 'noticeText', 'noticeAction',
    'statTotal', 'statTotalNote', 'statAvg', 'statAvgNote', 'statAvgBar', 'pipeline', 'pipelineHint', 'clearStageBtn',
    'tableBody', 'teamStatus', 'teamSaveBtn', 'teamModal', 'openTeamBtn', 'noteDeleteModal', 'noteDeletePreview', 'noteDeleteConfirm', 'appTitle', 'adminModal', 'openClearBtn', 'clearModal', 'clearProjects', 'clearLogs',
    'clearProjectsName', 'clearProjectsCount', 'clearLogsCount', 'confirmClearBtn', 'emptyState', 'resultCount',
    'toasts', 'moreDetails', 'giveUpdateBtn',
    'drawerStepOf',
    'stageMove', 'nextStageBtn', 'stageMoveForm', 'stageMoveTitle', 'stageMoveHint', 'stageMoveReason', 'stageMoveBy',
    'stageMoveCancel', 'stageMoveConfirm',
    'projectModal', 'projectForm', 'saveBtn', 'modalTitle', 'fName', 'fDeveloper', 'fManager', 'fStart', 'fDue',
    'fStage', 'fCompletion', 'fStatus', 'fPriority', 'fProgress', 'fProgressOut', 'fBudget',
    'fRemarks', 'fIdDisplay', 'fReason', 'fReasonLabel', 'fBy',
    'confirmModal', 'confirmText', 'confirmDeleteBtn', 'deleteReason', 'deleteBy', 'busyOverlay', 'busyText',
    'projectDrawer', 'drawerId', 'drawerTitle', 'drawerChips', 'drawerFoot', 'tabOverview', 'tabHistory', 'historyCount',
    'tabApis', 'apiCount', 'paneApis', 'apiTiles', 'apiList', 'apiAddBtn', 'apiModal', 'apiForm', 'apiModalTitle',
    'apiModalProject', 'apiName', 'apiNameList', 'apiStatusChoices', 'apiReviewChoices', 'apiNote', 'apiDeveloper',
    'apiEnvironment', 'apiBy', 'apiRemoveBtn', 'apiSaveBtn',
    'paneOverview', 'paneHistory', 'drawerProgressTrack', 'drawerProgressFill', 'drawerProgressNum', 'drawerStages',
    'drawerDetails', 'drawerLatest', 'drawerEditBtn', 'drawerDeleteBtn',
    'drawerRefreshLogs', 'noteForm', 'noteText', 'mentionMenu', 'noteBy', 'noteSubmit', 'drawerLogs',
    'activityDrawer', 'activityList', 'activityRefresh',
  ].forEach((id) => { els[id] = document.getElementById(id); });
}

/** Same person -> same color everywhere. Team members get fixed colors; anyone else is hashed. */
function personColor(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return 'var(--muted)';
  const i = TEAM.findIndex((t) => t.toLowerCase() === key);
  if (i !== -1) return `var(--person-${i % PERSON_COLORS})`; // team members keep their colour when renamed
  let h = 0;
  for (let c = 0; c < key.length; c += 1) h = (h * 31 + key.charCodeAt(c)) >>> 0;
  return `var(--person-${h % PERSON_COLORS})`;
}

function personName(name) {
  const n = String(name || '').trim();
  return n ? `<strong class="person" style="--p:${personColor(n)}">${escapeHtml(n)}</strong>` : '<strong class="person">Someone</strong>';
}

function avatarHtml(name, kind) {
  const n = String(name || '').trim();
  const initial = n ? escapeHtml(n[0].toUpperCase()) : '?';
  return `<span class="avatar" style="--p:${personColor(n)}" aria-hidden="true">${initial}<span class="avatar-badge">${LOG_ICONS[kind] || ''}</span></span>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slug(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalizeHeader(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* --------------------------------------------------------------------------
   Date & value helpers
   -------------------------------------------------------------------------- */
const pad = (n, len = 2) => String(n).padStart(len, '0');

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Google Sheets serial number (days since 1899-12-30) -> Date read in UTC. */
function serialToUtcDate(serial) {
  return new Date(Math.round((Number(serial) - 25569) * 86400000));
}

/** Any date-ish cell value -> 'YYYY-MM-DD' (or '' if it can't be read). */
function toIsoDate(value) {
  if (value === '' || value == null) return '';
  if (typeof value === 'number' && isFinite(value)) {
    const d = serialToUtcDate(value);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const text = String(value).trim();
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`;
  const parsed = new Date(text);
  if (!isNaN(parsed)) return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
  return '';
}

/** Any date-time cell value -> 'YYYY-MM-DD HH:mm'. */
function toDateTime(value) {
  if (value === '' || value == null) return '';
  if (typeof value === 'number' && isFinite(value)) {
    const d = serialToUtcDate(value);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  return String(value).trim();
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatTime(date) {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function clampProgress(value) {
  let n = typeof value === 'number' ? value : parseFloat(String(value).replace('%', ''));
  if (!isFinite(n)) n = 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Match a cell value to one of the allowed options, case-insensitively. */
function matchOption(value, options) {
  const text = String(value ?? '').trim();
  const found = options.find((o) => o.toLowerCase() === text.toLowerCase());
  return found || text;
}

function activeSheetName() {
  return CONFIG.SHEET_NAME;
}

/* --------------------------------------------------------------------------
   Project helpers
   -------------------------------------------------------------------------- */
function isCompleted(p) {
  return p.stage === 'Completed' || p.status === 'Completed';
}

function isOverdue(p) {
  return !isCompleted(p) && !!p.dueDate && p.dueDate < todayIso();
}

function emptyProject() {
  return FIELDS.reduce((obj, key) => { obj[key] = ''; return obj; }, { progress: 0, rowNumber: null });
}

/* --------------------------------------------------------------------------
   Google Sheet links
   -------------------------------------------------------------------------- */
function sheetUrl(row) {
  const gid = state.sheetGid || CONFIG.SHEET_GID;
  const base = `https://docs.google.com/spreadsheets/d/${CONFIG.SPREADSHEET_ID}/edit#gid=${gid}`;
  return row ? `${base}&range=A${row}` : base;
}

/** First empty row after the data, for "Add project". */
function nextEmptyRow() {
  if (state.sample) return state.headers.length ? 2 : 1;
  const last = state.projects.reduce((max, p) => Math.max(max, p.rowNumber || 0), 1);
  return last + 1;
}


/* --------------------------------------------------------------------------
   Read the Sheet through its share link (Google Visualization CSV endpoint).
   Works when the Sheet is shared as "Anyone with the link: Viewer".
   -------------------------------------------------------------------------- */
const SHARE_HINT = 'Ask the person who set up the dashboard to check its data sharing, then refresh.';

async function fetchSheet() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new AppError('network', 'You’re offline. Check your internet connection and try again.');
  }
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(CONFIG.SPREADSHEET_ID)}/gviz/tq`
    + `?tqx=out:csv&headers=1&sheet=${encodeURIComponent(CONFIG.SHEET_NAME)}&t=${Date.now()}`;
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (err) {
    // A private Sheet answers with a sign-in page, which the browser blocks: it surfaces here.
    throw new AppError('access', `Couldn’t load the projects. ${SHARE_HINT}`);
  }
  if (res.status === 404) {
    throw new AppError('notfound', 'The project list couldn’t be found. Ask the person who set up the dashboard to check it.');
  }
  if (!res.ok) throw new AppError('access', `The projects couldn’t be loaded (error ${res.status}). ${SHARE_HINT}`);
  const text = await res.text();
  if (/^\s*</.test(text)) throw new AppError('access', `The projects can’t be read. ${SHARE_HINT}`);
  return parseValues(parseCsv(text));
}

/** RFC 4180 CSV -> array of rows (handles quotes, commas and line breaks inside cells). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else { quoted = false; }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function parseValues(values) {
  const headerRow = (values[0] || []).map((h) => String(h ?? '').trim());
  const hasHeaders = headerRow.some((h) => FIELD_BY_HEADER[normalizeHeader(h)]);
  const headers = hasHeaders ? headerRow : [];
  const columnFields = headers.map((h) => FIELD_BY_HEADER[normalizeHeader(h)] || null);

  const projects = [];
  for (let i = 1; i < values.length && hasHeaders; i += 1) {
    const row = values[i] || [];
    if (!row.some((cell) => String(cell).trim() !== '')) continue;

    const p = emptyProject();
    p.rowNumber = i + 1; // 1-based row number in the Sheet
    columnFields.forEach((field, col) => {
      if (field) p[field] = normalizeCell(field, row[col]);
    });
    if (!p.id && !p.name) continue;
    projects.push(p);
  }
  return { headers, projects };
}

function normalizeCell(field, value) {
  if (value == null || value === '') return field === 'progress' ? 0 : '';
  if (DATE_FIELDS.has(field)) return toIsoDate(value);
  switch (field) {
    case 'lastUpdated': return toDateTime(value);
    case 'progress': return clampProgress(value);
    case 'stage': return matchOption(value, STAGES);
    case 'status': return matchOption(value, STATUSES);
    case 'priority': return matchOption(value, PRIORITIES);
    case 'budget': {
      const n = Number(String(value).replace(/[, ]/g, ''));
      return String(value).trim() !== '' && isFinite(n) ? n : String(value).trim();
    }
    default: return String(value).trim();
  }
}

/* --------------------------------------------------------------------------
   Sample projects, shown while the Sheet is still empty (same as sample-data.tsv)
   -------------------------------------------------------------------------- */
const SAMPLE_TSV = "ID\tProject Name\tClient / Department\tProject Manager\tStart Date\tDue Date\tCompletion Date\tStage\tProgress (%)\tStatus\tPriority\tBudget\tRemarks\tLast Updated\nPRJ-0001\tCompany Website Redesign\tMarketing\tPriya Sharma\t2026-08-01\t2026-12-15\t\tDevelopment\t60\tOn Track\tHigh\t18000\tHomepage and product pages in build\t2026-11-02 10:15:00\nPRJ-0002\tERP Inventory Module\tOperations\tRahul Mehta\t2026-06-10\t2026-10-31\t\tTesting\t80\tDelayed\tCritical\t65000\tVendor API fixes pending; UAT slipped\t2026-11-05 16:40:00\nPRJ-0003\tCustomer Mobile App\tSales\tAnita Desai\t2026-09-15\t2027-03-30\t\tDesign\t25\tOn Track\tHigh\t42000\tWireframes approved, UI in progress\t2026-11-04 09:05:00\nPRJ-0004\tHR Onboarding Portal\tHuman Resources\tVikram Rao\t2026-10-01\t2027-01-31\t\tPlanning\t10\tOn Track\tMedium\t12000\tRequirements workshop scheduled\t2026-11-01 11:30:00\nPRJ-0005\tData Warehouse Migration\tIT\tSneha Kulkarni\t2026-04-01\t2026-11-30\t\tReview\t90\tAt Risk\tCritical\t90000\tSecurity review findings to close\t2026-11-06 14:20:00\nPRJ-0006\tPayment Gateway Integration\tFinance\tArjun Nair\t2026-07-15\t2026-11-20\t\tDeployment\t95\tOn Track\tHigh\t25000\tGo-live window booked\t2026-11-07 18:00:00\nPRJ-0007\tWarehouse Barcode System\tLogistics\tKiran Patel\t2026-03-01\t2026-07-31\t2026-07-28\tCompleted\t100\tCompleted\tMedium\t30000\tDelivered three days early\t2026-07-28 17:45:00\nPRJ-0008\tInternal Knowledge Base\tCustomer Support\tMeera Iyer\t2026-05-01\t2026-09-30\t\tDevelopment\t45\tOn Hold\tLow\t8000\tPaused until support tool decision\t2026-10-12 12:10:00\nPRJ-0009\tQuarterly Sales Dashboard\tSales\tRohan Gupta\t2026-02-01\t2026-04-30\t2026-05-06\tCompleted\t100\tCompleted\tMedium\t6000\tFinished one week late\t2026-05-06 10:00:00\nPRJ-0010\tFactory IoT Sensors Pilot\tManufacturing\tDeepa Menon\t2026-08-20\t2026-10-15\t\tTesting\t65\tDelayed\tHigh\t55000\tSensor calibration issues\t2026-11-03 15:25:00";

function sampleData() {
  return parseValues(SAMPLE_TSV.split('\n').map((line) => line.split('\t')));
}

/** Write the header row and the 10 sample projects into the empty Sheet. */
function addSamplesToSheet() {
  runWrite('Adding sample projects…', async () => {
    const rows = SAMPLE_TSV.split('\n').map((line) => line.split('\t'));
    await callScript({ action: 'addSamples', rows });
    const added = sampleData();
    state.sample = false;
    state.headers = added.headers;
    state.projects = added.projects;
    hideNotice();
    toast('success', 'Added 10 example projects.');
  });
}

/* --------------------------------------------------------------------------
   Reading through the Sheet's script (v3+): projects and history in one request,
   no delay after saving. Older scripts, or a script that can't be reached, fall
   back to the share-link read above.
   -------------------------------------------------------------------------- */
async function fetchProjects() {
  if (!CONFIG.SPREADSHEET_ID && !CONFIG.SCRIPT_URL) {
    throw new AppError('setup', 'The dashboard isn’t connected to a Google Sheet yet. Fill in SPREADSHEET_ID and SCRIPT_URL in config.js (see SETUP.md).');
  }
  if (CONFIG.SCRIPT_URL && state.scriptReads !== false) {
    try {
      const data = await (await fetch(`${CONFIG.SCRIPT_URL}?action=data&t=${Date.now()}`)).json();
      if (data.ok && Array.isArray(data.values)) {
        state.scriptReads = true;
        state.scriptVersion = data.version;
        if (data.gid !== undefined && data.gid !== null) state.sheetGid = String(data.gid);
        if (data.sheetName) state.sheetTabName = data.sheetName;
        if (Array.isArray(data.team) && data.team.length) applyTeam(data.team);
        if (Array.isArray(data.developers) && data.developers.length) applyDevelopers(data.developers);
        if (Array.isArray(data.managers) && data.managers.length) applyManagers(data.managers);
        state.incomingApis = Array.isArray(data.apis) ? data.apis : null; // applied in loadData (unless a save started meanwhile)
        if (Array.isArray(data.logs)) {
          state.allLogs = data.logs;
          state.logsStatus = 'ok';
        }
        return parseValues(data.values.map((row) => row.map((v) => (v == null ? '' : v))));
      }
      if (data.ok) state.scriptReads = false; // script is older than v3: use the share link
      else throw new Error(data.error || 'script error');
    } catch (err) {
      // Network hiccup or script error: use the share link this time, try the script again next time.
      console.warn('Reading through the script failed; using the share link.', err);
    }
  }
  return fetchSheet();
}

/* --------------------------------------------------------------------------
   Loading & syncing
   -------------------------------------------------------------------------- */
/**
 * Live updates: check the Sheet every few seconds while the dashboard is on screen,
 * pause while the tab is hidden (saves Google's quota), and check at once on return.
 */
const LIVE_INTERVAL_MS = 5000;
let liveTimer = null;

function startApp() {
  if (loadCache()) {
    state.fromCache = true;
    renderAll(); // instant: last known data
    els.lastSynced.textContent = 'Updating…';
  }
  loadData();
  clearInterval(liveTimer);
  liveTimer = setInterval(() => {
    if (!document.hidden && !state.busy && !state.loading) loadData({ silent: true });
  }, LIVE_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadData({ silent: true });
  });
  window.addEventListener('online', () => loadData({ silent: true }));
}

/* Instant start: the last data this browser saw is shown at once, then updated from the Sheet. */
const CACHE_KEY = 'pmd-cache-v1';

function saveCache() {
  if (!state.hasLoadedOnce || state.loadError) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      url: CONFIG.SCRIPT_URL, time: Date.now(), sample: state.sample, headers: state.headers,
      projects: state.projects.filter((p) => !p._pending), logs: state.allLogs, team: TEAM, developers: DEVELOPERS, managers: MANAGERS, apis: state.apis.filter((a) => !a._pending),
    }));
  } catch (e) { /* storage full or unavailable: start-up just waits for the Sheet */ }
}

function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!c || c.url !== CONFIG.SCRIPT_URL || !Array.isArray(c.projects)) return false;
    state.sample = !!c.sample;
    state.headers = c.headers || [];
    state.projects = c.projects;
    state.allLogs = Array.isArray(c.logs) ? c.logs : [];
    if (Array.isArray(c.team) && c.team.length) TEAM = c.team.slice();
    if (Array.isArray(c.developers) && c.developers.length) DEVELOPERS = c.developers.slice();
    if (Array.isArray(c.managers) && c.managers.length) MANAGERS = c.managers.slice();
    if (Array.isArray(c.apis)) state.apis = c.apis;
    state.logsStatus = 'ok';
    state.hasLoadedOnce = true;
    state.lastSynced = new Date(c.time);
    return true;
  } catch (e) { return false; }
}

async function loadData({ silent = false } = {}) {
  if (state.loading) return;
  if (state.busy || state.pendingWrites) return; // a save is on its way: its result will arrive first
  state.loading = true;
  const writeSeq = state.writeSeq || 0;
  setSyncState('busy');
  if (!state.hasLoadedOnce) renderSkeleton();

  const firstLoad = !state.hasLoadedOnce;
  const prevProjects = state.projects;
  const prevLogs = state.allLogs;
  let changed = true;
  try {
    const sheet = await fetchProjects();
    // A save happened while this read was on its way: its result is older than the screen.
    const incomingApis = state.incomingApis;
    state.incomingApis = null;
    if ((state.writeSeq || 0) !== writeSeq) { state.allLogs = prevLogs; changed = false; setSyncState('ok'); return; }
    const nextApis = incomingApis || state.apis;
    const nextSample = !sheet.headers.length;
    const nextProjects = nextSample ? sampleData().projects : sheet.projects;
    // Nothing new? Keep the screen exactly as it is (no flicker, hover and scroll stay put).
    if (!firstLoad && nextSample === state.sample && !state.loadError
      && projectsSignature(nextProjects) === projectsSignature(prevProjects)
      && logsSignature(state.allLogs) === logsSignature(prevLogs)
      && apisSignature(nextApis) === apisSignature(state.apis)
      && !state.teamChanged) {
      changed = false;
      state.lastSynced = new Date();
      setSyncState('ok');
      return;
    }
    if (!firstLoad) {
      markChangedProjects(prevProjects, nextProjects);
      markNewLogs(prevLogs, state.allLogs);
    }
    state.sample = nextSample;
    state.headers = sheet.headers; // the real Sheet's header row (empty if it has none yet)
    state.projects = nextProjects;
    state.apis = nextApis;
    state.fromCache = false;
    state.teamChanged = false;
    state.lastSynced = new Date();
    state.hasLoadedOnce = true;
    state.loadError = null;
    hideNotice();
    if (state.sample) {
      showNotice('warn', 'These are example projects.',
        'There are no projects yet, so we’re showing 10 examples. Add them to try things out, or add your own project. They disappear as soon as you add real projects.',
        'Use these examples', addSamplesToSheet);
    }
    setSyncState('ok');
    if (!state.scriptReads) loadAllLogs(); // the script read already brought the history
    openFromHash();
  } catch (err) {
    const e = normalizeError(err);
    setSyncState('error', 'Sync failed');
    showNotice('error', 'We couldn’t load your projects.', e.message, 'Try again', () => loadData());
    if (!silent) toast('error', e.message);
    state.hasLoadedOnce = true;
    state.loadError = e.message;
  } finally {
    state.loading = false;
    if (changed) { renderAll(); saveCache(); }
  }
}

/* --------------------------------------------------------------------------
   Change tracking: what to redraw and what to highlight
   -------------------------------------------------------------------------- */
function projectsSignature(list) {
  return JSON.stringify((list || []).map((p) => FIELDS.map((f) => p[f])));
}

function logKey(l) {
  return [l.time, l.id, l.action, l.reason, l.by].join('|');
}

function logsSignature(list) {
  return (list || []).map(logKey).join('\n');
}

/** Projects that are new or different since the last read glow briefly in the list. */
function markChangedProjects(before, after) {
  const old = new Map(before.map((p) => [p.id, JSON.stringify(FIELDS.map((f) => p[f]))]));
  after.forEach((p) => {
    if (old.get(p.id) !== JSON.stringify(FIELDS.map((f) => p[f]))) flashProject(p.id);
  });
}

function flashProject(id) {
  state.flashIds = state.flashIds || new Set();
  state.flashIds.add(id);
  setTimeout(() => state.flashIds.delete(id), 1800);
}

/** Updates that weren't there before slide in. */
function markNewLogs(before, after) {
  const seen = new Set(before.map(logKey));
  state.freshLogKeys = new Set(after.filter((l) => !seen.has(logKey(l))).map(logKey));
  clearTimeout(state.freshLogTimer);
  state.freshLogTimer = setTimeout(() => { state.freshLogKeys = new Set(); }, 1500);
}

/** Count a number up (or down) to its new value. */
function animateNumber(el, to, suffix = '') {
  const from = Number(el.dataset.value);
  el.dataset.value = to;
  if (!Number.isFinite(from) || from === to || reduceMotion()) { el.textContent = `${to}${suffix}`; return; }
  const start = performance.now();
  const duration = 600;
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = `${Math.round(from + (to - from) * eased)}${suffix}`;
    if (t < 1 && Number(el.dataset.value) === to) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function reduceMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function setSyncState(kind, text) {
  if (kind === 'busy' && state.lastSynced) return; // background checks stay quiet
  els.syncDot.className = `sync-dot ${kind === 'ok' ? 'is-ok' : kind === 'error' ? 'is-error' : kind === 'busy' ? 'is-busy' : ''}`;
  if (text) {
    els.lastSynced.textContent = state.lastSynced ? `${text} · last synced ${formatTime(state.lastSynced)}` : text;
  } else if (kind === 'busy') {
    els.lastSynced.textContent = state.lastSynced ? `Syncing… · last synced ${relTime(state.lastSynced)}` : 'Loading projects…';
  } else {
    updateSyncLabel();
  }
}

function updateSyncLabel() {
  if (!state.lastSynced) return;
  els.lastSynced.textContent = `Live · updated ${relTime(state.lastSynced)}`;
  els.lastSynced.title = state.scriptReads ? 'Live' : 'Updates can take a few seconds to appear';
}

/* --------------------------------------------------------------------------
   History (the Sheet's Logs tab, served by the Apps Script)
   -------------------------------------------------------------------------- */
/** 'YYYY-MM-DD HH:mm:ss' (Sheet time) -> Date in this browser's time zone. */
function parseStamp(text) {
  const m = String(text || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

function relTime(date) {
  if (!date) return '';
  const s = Math.round((Date.now() - date.getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.floor((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

function dayLabel(date) {
  if (!date) return 'Earlier';
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * One project's history, newest first. If the ID was used before by a project that
 * was later deleted, stop at that "Deleted" entry so the old project's history
 * doesn't show up under the new one.
 */
function logsFor(id) {
  const all = state.allLogs.filter((l) => String(l.id) === String(id));
  if (!state.projects.some((p) => String(p.id) === String(id))) return all;
  const cut = all.findIndex((l) => logKind(l) === 'deleted');
  return cut === -1 ? all : all.slice(0, cut);
}

function lastLog(id) {
  return logsFor(id)[0] || null;
}

/** Load every project's history in one request (newest first). */
async function loadAllLogs() {
  if (state.sample) { state.logsStatus = 'sample'; return; }
  if (!CONFIG.SCRIPT_URL) { state.logsStatus = 'nosetup'; renderLogsEverywhere(); return; }
  const token = (state.logsToken || 0) + 1;
  state.logsToken = token;
  if (state.logsStatus === 'idle') state.logsStatus = 'loading';
  try {
    const data = await (await fetch(`${CONFIG.SCRIPT_URL}?action=logs&t=${Date.now()}`)).json();
    if (token !== state.logsToken) return;
    if (!data.ok) throw new Error(data.error || 'The script returned an error.');
    if (!Array.isArray(data.logs)) { state.logsStatus = 'unsupported'; renderLogsEverywhere(); return; }
    state.allLogs = data.logs;
    state.logsStatus = 'ok';
  } catch (err) {
    if (token !== state.logsToken) return;
    if (state.logsStatus !== 'ok') { state.logsStatus = 'error'; state.logsError = err.message || ''; }
  }
  renderLogsEverywhere();
}

/** Show a just-saved entry straight away (the Sheet already has it). */
function addLocalLog(entry) {
  const log = { time: nowStamp(), ...entry };
  state.allLogs = [log].concat(state.allLogs);
  state.freshLogKeys = new Set([logKey(log)]);
  clearTimeout(state.freshLogTimer);
  state.freshLogTimer = setTimeout(() => { state.freshLogKeys = new Set(); }, 1500);
  if (entry.id && entry.action !== 'Deleted' && entry.action !== 'Note') flashProject(entry.id);
  if (state.logsStatus !== 'unsupported' && state.logsStatus !== 'nosetup') state.logsStatus = 'ok';
  renderLogsEverywhere();
}

function renderLogsEverywhere() {
  if (!els.tableBody) return;
  renderTable();
  renderActivityCount();
  if (els.projectDrawer.open) renderDrawer();
  if (els.activityDrawer.open) renderActivity();
}

function logsUnavailableMessage() {
  switch (state.logsStatus) {
    case 'sample': return ['This is an example project', 'Updates start once you add real projects.'];
    case 'nosetup': return ['History isn’t set up', 'Set SCRIPT_URL in config.js (see SETUP.md).'];
    case 'unsupported': return ['Updates aren’t available yet', 'The dashboard’s server script needs updating (paste the latest Code.gs and deploy a new version).'];
    case 'error': return ['Couldn’t load the history', state.logsError || 'Check your connection and click Refresh.'];
    case 'idle':
    case 'loading': return ['Loading history…', ''];
    default: return null;
  }
}

const LOG_ICONS = {
  created: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  updated: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.6A8 8 0 1 1 21 12z"/></svg>',
  deleted: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 11v6M14 11v6M7 7l1 12h8l1-12M9 7V4h6v3"/></svg>',
  api: '<svg viewBox="0 0 24 24"><path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"/></svg>',
};

/** "added an API", "removed an API" or "updated an API", from the logged changes. */
function apiVerb(changes) {
  const c = String(changes || '');
  if (/^Added API:/.test(c)) return 'added an API';
  if (/^Removed API:/.test(c)) return 'removed an API';
  return 'updated an API';
}

function logKind(log) {
  const a = String(log.action || '').toLowerCase();
  return ['created', 'updated', 'note', 'deleted', 'api'].includes(a) ? a : 'updated';
}

/** "Stage: Design → Review; Progress (%): 25% → 40%" -> list items with before/after. */
function changesHtml(text) {
  const parts = String(text || '').split(/;\s*/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  return `<ul class="log-changes">${parts.map((part) => {
    const m = part.match(/^([^:]+):\s*(.*)$/);
    if (!m) return `<li>${escapeHtml(part)}</li>`;
    const field = m[1].replace(' (%)', '');
    const [from, to] = m[2].split(/\s*→\s*/);
    if (to === undefined) return `<li><span class="f">${escapeHtml(field)}</span><span class="to">${escapeHtml(from)}</span></li>`;
    return `<li><span class="f">${escapeHtml(field)}</span><span class="from">${escapeHtml(from)}</span><span class="arrow">→</span><span class="to">${escapeHtml(to)}</span></li>`;
  }).join('')}</ul>`;
}

function logEntryHtml(log, { showProject = false, isLast = false } = {}) {
  const kind = logKind(log);
  const who = personName(log.by);
  const nChanges = String(log.changes || '').split(/;\s*/).filter((s) => s.includes('→')).length;
  const verb = showProject
    ? { created: 'added', updated: 'updated', note: 'posted an update on', deleted: 'deleted', api: 'updated APIs on' }[kind]
    : {
      created: 'added this project',
      updated: nChanges ? `changed ${nChanges} thing${nChanges === 1 ? '' : 's'}` : 'saved the project',
      note: 'posted an update',
      deleted: 'deleted this project',
      api: apiVerb(log.changes),
    }[kind];
  const exists = state.projects.some((p) => String(p.id) === String(log.id));
  const projectRef = showProject
    ? ` ${exists ? `<button type="button" class="log-project" data-open-project="${escapeHtml(log.id)}">${escapeHtml(log.name || log.id)}</button>` : `<strong>${escapeHtml(log.name || log.id)}</strong>`}`
    : '';
  const when = parseStamp(log.time);
  const quoteLabel = kind === 'deleted' ? 'Why it was deleted' : '';
  const showChanges = kind === 'updated' || kind === 'api' || (kind === 'created' && !showProject);
  const nShown = showProject && kind === 'updated' && nChanges ? ` <span class="log-time">(${nChanges} change${nChanges === 1 ? '' : 's'})</span>` : '';
  const logIndex = state.allLogs.indexOf(log);
  const canDelete = kind === 'note' && logIndex !== -1 && !state.sample;
  const fresh = state.freshLogKeys && state.freshLogKeys.has(logKey(log)) ? ' log-new' : '';
  return `<article class="log-entry is-${kind}${isLast ? ' is-last' : ''}${fresh}">
    ${canDelete ? `<button type="button" class="log-delete" data-delete-note="${logIndex}" title="Delete this message" aria-label="Delete this message">${ICON_TRASH_SM}</button>` : ''}
    ${avatarHtml(log.by, kind)}
    <div class="log-main">
      <div class="log-line">${who} ${verb}${projectRef}${nShown}
        <span class="log-time" title="${escapeHtml(log.time || '')}">· ${escapeHtml(relTime(when) || log.time || '')}</span></div>
      ${log.reason ? `<div class="log-quote">${quoteLabel ? `<span class="q-label">${quoteLabel}</span>` : ''}${mentionHtml(log.reason)}</div>` : ''}
      ${showChanges ? changesHtml(log.changes) : ''}
    </div>
  </article>`;
}

const ICON_TRASH_SM = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

/**
 * Ask first (in the page's own popup: browser confirm() boxes are blocked in some
 * browsers), then delete one posted message. Shown at once; restored if the Sheet refuses.
 */
function deleteNote(index) {
  const log = state.allLogs[index];
  if (!log || logKind(log) !== 'note') return;
  state.pendingNoteDelete = log; // keep the message itself: list positions change on every live update
  const text = String(log.reason || '');
  els.noteDeletePreview.textContent = `“${text.length > 160 ? `${text.slice(0, 160)}…` : text}”${log.by ? ` — ${log.by}` : ''}`;
  els.noteDeleteModal.showModal();
}

async function confirmDeleteNote() {
  const log = state.pendingNoteDelete;
  state.pendingNoteDelete = null;
  els.noteDeleteModal.close();
  if (!log) return;
  state.allLogs = state.allLogs.filter((l) => l !== log);
  state.writeSeq = (state.writeSeq || 0) + 1; // a read already on its way must not bring it back
  state.pendingWrites = (state.pendingWrites || 0) + 1;
  showSaving(true);
  renderLogsEverywhere();
  try {
    // A message deleted while it's still saving: let that save finish first, or the delete
    // could reach the server before the message does and the message would come back.
    for (let i = 0; state.pendingWrites > 1 && i < 300; i += 1) await new Promise((r) => setTimeout(r, 100));
    await callScript({ action: 'deleteNote', entry: { time: log.time, id: log.id, reason: log.reason, by: log.by } });
    toast('success', 'Message deleted.');
  } catch (err) {
    if (/no longer there/i.test(err.message || '')) { // someone (or another click) already removed it
      toast('success', 'Message deleted.');
      return;
    }
    state.allLogs = state.allLogs.concat(log).sort((a, b) => String(b.time).localeCompare(String(a.time)));
    renderLogsEverywhere();
    if (/unknown action/i.test(err.message || '')) {
      reportError(new AppError('setup', 'Deleting messages needs the latest server script (version 5). Paste the new Code.gs and deploy a new version, then try again.'));
    } else {
      reportError(err);
    }
  } finally {
    state.pendingWrites -= 1;
    if (!state.pendingWrites) { showSaving(false); saveCache(); setTimeout(() => loadData({ silent: true }), 400); }
  }
}

/** Entries grouped under Today / Yesterday / date headings. */
function timelineHtml(logs, opts = {}) {
  let html = '';
  let lastDay = null;
  logs.forEach((log, i) => {
    const label = dayLabel(parseStamp(log.time));
    if (label !== lastDay) {
      html += `<div class="day-label">${escapeHtml(label)}</div>`;
      lastDay = label;
    }
    const nextLabel = logs[i + 1] ? dayLabel(parseStamp(logs[i + 1].time)) : null;
    html += logEntryHtml(log, { ...opts, isLast: nextLabel !== label });
  });
  return html;
}

function filterLogs(logs, filter) {
  if (filter === 'notes') return logs.filter((l) => logKind(l) === 'note');
  if (filter === 'changes') return logs.filter((l) => logKind(l) !== 'note');
  return logs;
}

function emptyTimeline(title, text) {
  return `<div class="timeline-empty"><strong>${escapeHtml(title)}</strong>${text ? `<span>${escapeHtml(text)}</span>` : ''}</div>`;
}

/* ---- Activity badge & feed (all projects) ---- */
const SEEN_KEY = 'pmd-activity-seen';

function activitySeen() {
  try { return localStorage.getItem(SEEN_KEY) || ''; } catch (e) { return ''; }
}

/**
 * What's new shows only projects that still exist: deleted projects (their "deleted"
 * entry and everything before it) stay in the Sheet's Logs tab but not on the dashboard.
 * logsFor() also drops history from before a reused project number was deleted.
 */
function activityLogs() {
  const keep = new Set();
  state.projects.forEach((p) => { if (!p._pending) logsFor(p.id).forEach((l) => keep.add(l)); });
  return state.allLogs.filter((l) => keep.has(l));
}

function renderActivityCount() {
  const seen = activitySeen();
  const fresh = state.logsStatus === 'ok' ? activityLogs().filter((l) => String(l.time) > seen).length : 0;
  els.activityCount.hidden = !fresh;
  els.activityCount.textContent = fresh > 99 ? '99+' : String(fresh);
  els.activityBtn.title = fresh ? `${fresh} new update${fresh === 1 ? '' : 's'} since you last looked` : 'Recent activity across all projects';
}

function openActivity() {
  state.activityLimit = 60;
  renderActivity();
  els.activityDrawer.showModal();
  try { localStorage.setItem(SEEN_KEY, nowStamp()); } catch (e) { /* storage unavailable */ }
  renderActivityCount();
}

function renderActivity() {
  $$('[data-activity-filter]').forEach((b) => b.classList.toggle('is-active', b.dataset.activityFilter === state.activityFilter));
  const unavailable = state.logsStatus === 'ok' ? null : logsUnavailableMessage();
  if (unavailable) { els.activityList.innerHTML = emptyTimeline(...unavailable); return; }
  const logs = filterLogs(activityLogs(), state.activityFilter);
  if (!logs.length) {
    els.activityList.innerHTML = emptyTimeline('Nothing here yet', 'Updates and changes to your projects appear here.');
    return;
  }
  const shown = logs.slice(0, state.activityLimit || 60);
  els.activityList.innerHTML = timelineHtml(shown, { showProject: true })
    + (logs.length > shown.length ? `<button type="button" class="btn btn-ghost btn-sm timeline-more" data-more-activity>Show more (${logs.length - shown.length})</button>` : '');
}

/* --------------------------------------------------------------------------
   Filtering & sorting
   -------------------------------------------------------------------------- */
function projectsForTab(tab) {
  if (tab === 'ongoing') return state.projects.filter((p) => !isCompleted(p));
  if (tab === 'completed') return state.projects.filter(isCompleted);
  return state.projects.slice();
}

function matchesQuick(p, quick) {
  if (quick === 'active') return !isCompleted(p);
  if (quick === 'done') return isCompleted(p);
  if (quick === 'overdue') return matchesDue(p, 'overdue');
  if (quick === 'week') return matchesDue(p, 'week');
  return true;
}

function getVisibleProjects() {
  const { quick, search, stage } = state.filters;
  const q = search.trim().toLowerCase();
  const list = state.projects.filter((p) => {
    if (!matchesQuick(p, quick)) return false;
    if (stage && STAGES.indexOf(p.stage) < STAGES.indexOf(stage)) return false; // reached this step
    if (q && ![p.name, p.client, p.manager, p.id].some((v) => String(v).toLowerCase().includes(q))) return false;
    return true;
  });
  return sortProjects(list);
}

/** Due-date filter: overdue, due within 7 / 30 days (not completed), or no due date. */
function matchesDue(p, due) {
  if (due === 'none') return !p.dueDate;
  if (!p.dueDate || isCompleted(p)) return false;
  const days = Math.round((startOfDay(parseStamp(p.dueDate)) - startOfDay(new Date())) / 86400000);
  if (due === 'overdue') return days < 0;
  if (due === 'week') return days >= 0 && days <= 7;
  if (due === 'month') return days >= 0 && days <= 30;
  return true;
}

function sortProjects(list) {
  const { key, dir } = state.sort;
  const factor = dir === 'asc' ? 1 : -1;
  const rank = (arr, v) => { const i = arr.indexOf(v); return i === -1 ? arr.length : i; };
  const valueOf = (p) => {
    switch (key) {
      case 'stage': return rank(STAGES, p.stage);
      case 'status': return rank(STATUSES, p.status);
      case 'priority': return rank(PRIORITIES, p.priority);
      case 'progress': return Number(p.progress) || 0;
      case 'dueDate': return p.dueDate || '9999-12-31'; // undated projects sort last
      case 'activity': { const l = lastLog(p.id); return l ? String(l.time) : ''; }
      default: return String(p[key] || '').toLowerCase();
    }
  };
  return list.sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    if (va < vb) return -1 * factor;
    if (va > vb) return 1 * factor;
    return String(a.name).localeCompare(String(b.name));
  });
}

function hasActiveFilters() {
  const f = state.filters;
  return !!(f.search || f.stage || f.quick !== 'all');
}

/* --------------------------------------------------------------------------
   Rendering
   -------------------------------------------------------------------------- */
function renderAll() {
  renderSummary();
  renderPipeline();
  renderTable();
  renderFilterState();
  renderActivityCount();
  if (els.projectDrawer.open) renderDrawer();
  if (els.activityDrawer.open) renderActivity();
}

function renderSummary() {
  const all = state.projects;
  const avg = all.length ? Math.round(all.reduce((sum, p) => sum + (Number(p.progress) || 0), 0) / all.length) : 0;
  const completed = all.filter(isCompleted).length;
  const overdue = all.filter(isOverdue).length;
  animateNumber(els.statTotal, all.length);
  els.statTotalNote.textContent = all.length
    ? (overdue ? `${overdue} overdue` : 'Nothing overdue')
    : 'No projects yet';
  els.statTotalNote.classList.toggle('is-alert', overdue > 0);
  animateNumber(els.statAvg, avg, '%');
  els.statAvgNote.textContent = all.length ? `${completed} of ${all.length} completed` : ' ';
  els.statAvgBar.style.width = `${avg}%`;
}

function renderPipeline() {
  const total = state.projects.length;
  const active = state.filters.stage;
  // Projects move through the steps in order, so a project at Design has also done Plan.
  // Each step counts the projects that have REACHED it (are at it or past it).
  const reachedCount = (i) => state.projects.filter((p) => STAGES.indexOf(p.stage) >= i).length;
  const reached = STAGES.map((_, i) => reachedCount(i));
  const before = state.shownReached || [];
  state.shownReached = reached;
  els.pipeline.innerHTML = STAGES.map((stage, i) => {
    const count = reached[i];
    const here = state.projects.filter((p) => p.stage === stage).length;
    const pct = total ? Math.round((count / total) * 100) : 0;
    const classes = ['stage-btn', `stage-${slug(stage)}`, count ? 'has-items' : '',
      active === stage ? 'is-active' : '', active && active !== stage ? 'is-dimmed' : ''].join(' ');
    const liClass = [count ? 'is-reached' : '', reached[i + 1] ? 'next-reached' : ''].join(' ').trim();
    const label = `${stage}: ${count} project${count === 1 ? '' : 's'} reached this step${here ? `, ${here} at it now` : ''}`;
    return `<li class="${liClass}"><button type="button" class="${classes}" data-stage="${escapeHtml(stage)}" aria-pressed="${active === stage}"
        title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
        <span class="stage-node${before.length && before[i] !== count ? ' pop' : ''}">${count}</span>
        <span class="stage-name" title="${escapeHtml(stage)}"><span class="sn-full">${escapeHtml(stage)}</span><span class="sn-short">${escapeHtml(STAGE_SHORT[stage] || stage)}</span></span>
        <span class="stage-share">${pct}%</span>
      </button></li>`;
  }).join('');
  els.clearStageBtn.hidden = !active;
  els.pipelineHint.hidden = !!active;
}

function renderFilterState() {
  $$('.projects th[data-sort]').forEach((th) => {
    if (th.dataset.sort === state.sort.key) th.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  });
}

function renderSkeleton() {
  const row = `<tr class="skeleton">${'<td><span></span></td>'.repeat(7)}</tr>`;
  els.tableBody.innerHTML = row.repeat(5);
  els.emptyState.hidden = true;
}

const ICON_EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>';
const ICON_DELETE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

function chipHtml(kind, value) {
  if (!value) return '<span class="cell-empty">—</span>';
  if (kind === 'stage') return `<span class="chip stage-${slug(value)}">${escapeHtml(value)}</span>`;
  if (kind === 'status') return `<span class="badge status-${slug(value)}">${escapeHtml(value)}</span>`;
  return `<span class="priority priority-${slug(value)}"><span class="priority-bars" aria-hidden="true"><i></i><i></i><i></i></span>${escapeHtml(value)}</span>`;
}

function activityCellHtml(p) {
  if (p._pending) return '<span class="activity-none saving-tag">Saving…</span>';
  if (state.sample) return '<span class="activity-none">—</span>';
  const log = lastLog(p.id);
  if (!log) {
    return state.logsStatus === 'ok'
      ? `<button type="button" class="activity-cell" data-action="history" data-id="${escapeHtml(p.id)}" title="No updates yet. Click to give one."><span class="a-sub">No updates yet</span></button>`
      : '<span class="activity-none">—</span>';
  }
  const kind = logKind(log);
  const label = { created: 'Added', updated: 'Changed', note: 'Message', deleted: 'Deleted', api: 'API' }[kind];
  const sub = log.reason || (log.changes ? String(log.changes).split(/;\s*/)[0] : '');
  return `<button type="button" class="activity-cell" data-action="history" data-id="${escapeHtml(p.id)}" title="See all updates">
    <span class="a-top"><span class="a-dot is-${kind}" aria-hidden="true"></span>${label} · ${escapeHtml(relTime(parseStamp(log.time)))}</span>
    ${sub ? `<span class="a-sub">${log.by ? `<b class="person" style="--p:${personColor(log.by)}">${escapeHtml(log.by)}</b>: ` : ''}${log.reason ? mentionHtml(sub) : escapeHtml(sub)}</span>` : ''}
  </button>`;
}

/** Width a row's bar starts from: its previous value, so the change glides. */
function prevWidth(id, now) {
  const before = state.shownProgress && state.shownProgress.get(id);
  return before === undefined ? now : before;
}

function glideBars() {
  state.shownProgress = state.shownProgress || new Map();
  const bars = $$('#tableBody .progress-fill[data-to]');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bars.forEach((bar) => { bar.style.width = `${bar.dataset.to}%`; });
  }));
  state.shownProgress = new Map(state.projects.map((p) => [p.id, clampProgress(p.progress)]));
}

function renderTable() {
  if (!state.hasLoadedOnce && state.loading) return; // skeleton stays visible
  const rows = getVisibleProjects();

  els.tableBody.innerHTML = rows.map((p) => {
    const overdue = isOverdue(p);
    const progress = clampProgress(p.progress);
    const name = escapeHtml(p.name || '(untitled)');
    const meta = (p.developer ? `<span class="dev-tag">${escapeHtml(p.developer)}</span>` : '') + apiSummaryHtml(p.id);
    const flash = state.flashIds && state.flashIds.has(p.id) ? ' row-flash' : '';
    const pending = p._pending ? ' is-pending' : '';
    return `<tr class="project-row${overdue ? ' is-overdue' : ''}${flash}${pending}" data-id="${escapeHtml(p.id)}" title="${p._pending ? 'Saving…' : 'Click to open'}">
      <td class="col-name"><div class="name-cell">
        <button type="button" class="pname-link" data-action="view" data-id="${escapeHtml(p.id)}">${name}</button>
        ${meta ? `<span class="pmeta">${meta}</span>` : ''}</div></td>
      <td class="cell-chip">${chipHtml('stage', p.stage)}</td>
      <td class="cell-progress">
        <div class="progress-cell stage-${slug(p.stage)}" title="${progress}% done">
          <div class="progress-track" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress">
            <div class="progress-fill" style="width:${prevWidth(p.id, progress)}%" data-to="${progress}"></div>
          </div>
          <span class="progress-num">${progress}%</span>
        </div>
      </td>
      <td class="cell-chip">${chipHtml('status', p.status)}</td>
      <td class="cell-due due">${p.dueDate ? escapeHtml(formatDate(p.dueDate)) : '<span class="cell-empty">—</span>'}${overdue ? '<span class="overdue-tag">Late</span>' : ''}</td>
      <td class="cell-activity">${activityCellHtml(p)}</td>
      <td class="col-open"><span class="open-chevron" aria-hidden="true">›</span></td>
    </tr>`;
  }).join('');

  if (!rows.length) {
    els.emptyState.hidden = false;
    if (!state.projects.length && state.loadError) {
      els.emptyState.innerHTML = `<strong>We couldn’t load your projects</strong><span>${escapeHtml(state.loadError)}</span>`;
    } else if (!state.projects.length) {
      els.emptyState.innerHTML = `<strong>No projects yet</strong><span>Add your first project to get started.</span>
        <button type="button" class="btn btn-primary btn-sm" data-empty-add>Add a project</button>`;
    } else {
      els.emptyState.innerHTML = `<strong>Nothing to show here</strong><span>No project matches what you picked.</span>
        <button type="button" class="btn btn-ghost btn-sm" data-empty-clear>Show all projects</button>`;
    }
  } else {
    els.emptyState.hidden = true;
  }

  glideBars();
  els.resultCount.textContent = state.projects.length
    ? `Showing ${rows.length} of ${state.projects.length} project${state.projects.length === 1 ? '' : 's'}`
    : '';
}

function sortLabel() {
  const labels = { name: 'name', stage: 'step', progress: 'progress', status: 'how it’s going', dueDate: 'due date', activity: 'latest update' };
  return `${labels[state.sort.key] || state.sort.key} (${state.sort.dir === 'asc' ? 'ascending' : 'descending'})`;
}

/** Status dropdown with a plain explanation, e.g. "At Risk – might be late". */
function fillStatusSelect(select) {
  select.innerHTML = STATUSES.map((st) => `<option value="${escapeHtml(st)}">${escapeHtml(st)}${STATUS_HELP[st] ? ` – ${escapeHtml(STATUS_HELP[st])}` : ''}</option>`).join('');
}

function fillSelect(select, options, firstLabel) {
  const first = firstLabel ? `<option value="">${escapeHtml(firstLabel)}</option>` : '';
  select.innerHTML = first + options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
}

/* --------------------------------------------------------------------------
   Project panel: Overview + History tabs
   -------------------------------------------------------------------------- */
function openDrawer(id, pane = 'overview') {
  if (!state.projects.some((p) => p.id === id)) return;
  state.drawerId = id;
  state.drawerPane = pane;
  state.logFilter = 'all';
  hideStageMove();
  els.noteText.value = '';
  fillPeople(els.noteBy);
  renderDrawer();
  els.projectDrawer.showModal(); // adds a Back step first, so the #project link goes on that step
  setHash(id, pane);
  if (pane === 'history' && !state.sample) setTimeout(() => els.noteText.focus(), 50);
}

/* Shareable links: #project=PRJ-0003 (Overview) or #project=PRJ-0003/history */
function projectLink(id, pane) {
  return `${location.origin}${location.pathname}#project=${encodeURIComponent(id)}${paneSuffix(pane)}`;
}

function paneSuffix(pane) {
  return pane === 'history' || pane === 'apis' ? `/${pane}` : '';
}

function setHash(id, pane) {
  const hash = id ? `#project=${encodeURIComponent(id)}${paneSuffix(pane)}` : '';
  if (location.hash !== hash) history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
}

function openFromHash() {
  if (state.deepLinkHandled) return;
  state.deepLinkHandled = true;
  const m = location.hash.match(/^#project=([^/]+)(?:\/(history|apis))?$/);
  if (!m) return;
  const id = decodeURIComponent(m[1]);
  if (state.projects.some((p) => p.id === id)) openDrawer(id, m[2] || 'overview');
  else toast('info', `Project ${id} doesn’t exist any more.`);
}

function setDrawerPane(pane) {
  state.drawerPane = pane;
  setHash(state.drawerId, pane);
  renderDrawer();
  els.projectDrawer.querySelector('.drawer-body').scrollTop = 0;
}

function dueText(p) {
  if (!p.dueDate) return '';
  const base = formatDate(p.dueDate);
  if (isCompleted(p)) return base;
  const days = Math.round((startOfDay(parseStamp(p.dueDate)) - startOfDay(new Date())) / 86400000);
  if (days < 0) return `${base} · ${-days} day${days === -1 ? '' : 's'} overdue`;
  if (days === 0) return `${base} · due today`;
  return `${base} · in ${days} day${days === 1 ? '' : 's'}`;
}

function renderDrawer() {
  if (!state.drawerId) return;
  const p = state.projects.find((x) => x.id === state.drawerId);
  if (!p) {
    els.drawerTitle.textContent = 'This project has been deleted';
    els.drawerChips.innerHTML = '';
    els.drawerFoot.hidden = true;
    state.drawerPane = 'history';
  } else {
    els.drawerFoot.hidden = state.sample;
    els.drawerId.textContent = p.id;
    els.drawerTitle.textContent = p.name || '(untitled)';
    els.drawerChips.innerHTML = [
      p.stage ? chipHtml('stage', p.stage) : '',
      p.status ? chipHtml('status', p.status) : '',
      p.priority ? chipHtml('priority', p.priority) : '',
      isOverdue(p) ? '<span class="overdue-tag">Overdue</span>' : '',
    ].join('');
    renderOverview(p);
  }

  // Tabs
  const pane = state.drawerPane || 'overview';
  els.paneOverview.hidden = pane !== 'overview' || !p;
  els.paneHistory.hidden = pane !== 'history';
  els.paneApis.hidden = pane !== 'apis' || !p;
  [[els.tabOverview, 'overview'], [els.tabHistory, 'history'], [els.tabApis, 'apis']].forEach(([tab, name]) => {
    tab.classList.toggle('is-active', name === pane);
    tab.setAttribute('aria-selected', String(name === pane));
  });
  els.tabOverview.hidden = !p;
  els.tabApis.hidden = !p;
  renderApis(p);
  const logs = logsFor(state.drawerId);
  els.historyCount.textContent = state.logsStatus === 'ok' ? logs.length : '–';
  renderHistory(logs, !!p);
}

function renderOverview(p) {
  els.giveUpdateBtn.hidden = state.sample || state.logsStatus === 'unsupported' || state.logsStatus === 'nosetup';
  const progress = clampProgress(p.progress);
  const stepIndex = STAGES.indexOf(p.stage);
  els.drawerStepOf.textContent = stepIndex === -1 ? 'Progress' : `Step ${stepIndex + 1} of ${STAGES.length} · ${p.stage}`;
  els.drawerProgressNum.textContent = `${progress}% complete`;
  renderStageMove(p);
  els.drawerProgressTrack.className = `progress-track progress-lg stage-${slug(p.stage)}`;
  els.drawerProgressTrack.setAttribute('aria-valuenow', progress);
  els.drawerProgressFill.style.width = `${progress}%`;
  const current = STAGES.indexOf(p.stage);
  els.drawerStages.innerHTML = STAGES.map((s, i) => {
    const cls = [`stage-${slug(s)}`, i < current ? 'is-done' : '', i === current ? 'is-current' : ''].join(' ');
    return `<li class="${cls}"${i === current ? ' aria-current="step"' : ''}>${escapeHtml(s)}</li>`;
  }).join('');

  const fact = (label, value, cls = '') => `<div class="${cls}"><dt>${label}</dt><dd class="${value ? '' : 'is-empty'}">${value ? escapeHtml(value) : '—'}</dd></div>`;
  const budget = p.budget === '' || p.budget == null ? '' : (isFinite(Number(p.budget)) ? Number(p.budget).toLocaleString() : String(p.budget));
  const updated = parseStamp(p.lastUpdated);
  els.drawerDetails.innerHTML = [
    fact('Developer', p.developer),
    fact('Person in charge', p.manager),
    `<div><dt>Due date</dt><dd class="${isOverdue(p) ? 'is-alert' : p.dueDate ? '' : 'is-empty'}">${p.dueDate ? escapeHtml(dueText(p)) : '—'}</dd></div>`,
    fact('How it’s going', p.status ? `${p.status}${STATUS_HELP[p.status] ? ` (${STATUS_HELP[p.status]})` : ''}` : ''),
    fact('Started on', formatDate(p.startDate)),
    fact('Finished on', formatDate(p.completionDate)),
    fact('Importance', p.priority),
    fact('Budget', budget),
    fact('Note', p.remarks, 'wide remarks'),
    fact('Last changed', updated ? relTime(updated) : p.lastUpdated, 'wide'),
  ].join('');

  // Latest update teaser -> History tab
  if (state.sample) { els.drawerLatest.hidden = true; return; }
  els.drawerLatest.hidden = false;
  const latest = lastLog(p.id);
  const count = logsFor(p.id).length;
  els.drawerLatest.innerHTML = `<div class="latest-head"><h3>Latest update</h3>
      ${count ? `<button type="button" class="link-btn" data-goto="history">See all ${count} update${count === 1 ? '' : 's'} →</button>` : ''}</div>
    ${latest ? logEntryHtml(latest, { isLast: true }) : `<p class="muted-sm">${state.logsStatus === 'ok' ? 'Nobody has posted an update yet. Click “Give an update” above to post the first one.' : escapeHtml((logsUnavailableMessage() || [''])[0])}</p>`}`;
}

function renderHistory(logs, projectExists) {
  els.noteForm.hidden = state.sample || !projectExists || state.logsStatus === 'unsupported' || state.logsStatus === 'nosetup';
  $$('[data-log-filter]').forEach((b) => b.classList.toggle('is-active', b.dataset.logFilter === state.logFilter));
  const unavailable = state.logsStatus === 'ok' ? null : logsUnavailableMessage();
  if (unavailable) { els.drawerLogs.innerHTML = emptyTimeline(...unavailable); return; }
  const shown = filterLogs(logs, state.logFilter);
  els.drawerLogs.innerHTML = shown.length
    ? timelineHtml(shown)
    : emptyTimeline(logs.length ? 'Nothing here' : 'No updates yet', logs.length ? 'Click “Everything” to see all updates.' : 'Write what happened in the box above and click “Post update”.');
}

/* --------------------------------------------------------------------------
   Move to the next step (from the project panel). Also sets the completed %.
   -------------------------------------------------------------------------- */
function nextStageOf(p) {
  const i = STAGES.indexOf(p.stage);
  return i === -1 ? STAGES[0] : STAGES[i + 1] || null;
}

function renderStageMove(p) {
  const next = nextStageOf(p);
  els.stageMove.hidden = state.sample || !next;
  if (!next) return;
  const pct = Math.max(clampProgress(p.progress), STAGE_PERCENT[next] || 0);
  els.nextStageBtn.innerHTML = `Move to ${escapeHtml(next)} <span class="next-pct">${pct}%</span> <span aria-hidden="true">→</span>`;
  els.nextStageBtn.className = `btn btn-sm next-stage-btn stage-${slug(next)}`;
  els.stageMoveTitle.textContent = `Move “${p.name}” to ${next}?`;
  els.stageMoveHint.textContent = `It will show as ${pct}% complete.`;
}

function showStageMove() {
  els.nextStageBtn.hidden = true;
  els.stageMoveForm.hidden = false;
  els.stageMoveReason.value = '';
  fillPeople(els.stageMoveBy);
  els.stageMoveReason.focus();
}

function hideStageMove() {
  els.stageMoveForm.hidden = true;
  els.nextStageBtn.hidden = false;
}

function confirmStageMove() {
  const p = state.projects.find((x) => x.id === state.drawerId);
  const next = p && nextStageOf(p);
  if (!next) return;
  const by = requireName(els.stageMoveBy);
  if (!by) return;
  const reason = els.stageMoveReason.value.trim();
  const form = {
    name: p.name, client: p.client, manager: p.manager, developer: p.developer, startDate: p.startDate, dueDate: p.dueDate,
    completionDate: p.completionDate, stage: next, status: p.status, priority: p.priority,
    progress: Math.max(clampProgress(p.progress), STAGE_PERCENT[next] || 0),
    budget: p.budget, remarks: p.remarks, lastUpdated: nowStamp(),
  };
  if (next === 'Completed') {
    form.progress = 100;
    form.status = 'Completed';
    if (!form.completionDate) form.completionDate = todayIso();
  }
  const id = p.id;
  hideStageMove();
  saveInBackground(() => {
    state.projects = state.projects.map((x) => (x.id === id ? { ...x, ...form } : x));
    addLocalLog({ id, name: p.name, action: 'Updated', changes: describeLocalChanges(p, form), reason, by });
  }, async () => {
    await callScript({ action: 'update', id, project: form, reason, by });
    toast('success', `“${p.name}” moved to ${next} · ${form.progress}% complete.`);
  });
}

/* --------------------------------------------------------------------------
   APIs: each project's API integrations, with a status and a review.
   Saved in the Sheet's "APIs" tab (server script v7); changes are logged on the project.
   -------------------------------------------------------------------------- */
const API_STATUSES = ['Not started', 'Building', 'Testing', 'Live', 'Issue'];
const API_REVIEWS = ['Pending', 'Approved', 'Changes needed'];
const API_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"/></svg>';

function apisFor(projectId) {
  return state.apis.filter((a) => String(a.projectId) === String(projectId));
}

function apisSignature(list) {
  return JSON.stringify((list || []).map((a) => [a.apiId, a.projectId, a.name, a.status, a.review, a.note,
    a.developer, a.environment, a.reviewedBy, a.lastUpdated]));
}

function apiStatusChip(status) {
  return `<span class="api-chip api-${slug(status || 'Not started')}">${escapeHtml(status || 'Not started')}</span>`;
}

function apiReviewChip(review) {
  const r = review || 'Pending';
  const icon = { Approved: '✓', 'Changes needed': '!', Pending: '…' }[r] || '';
  return `<span class="api-review review-${slug(r)}"><span aria-hidden="true">${icon}</span> ${escapeHtml(r)}</span>`;
}

/** "APIs 2/5 live" (+ "1 issue") for the project list. */
function apiSummaryHtml(projectId) {
  const list = apisFor(projectId);
  if (!list.length) return '';
  const live = list.filter((a) => a.status === 'Live').length;
  const issues = list.filter((a) => a.status === 'Issue').length;
  return `<span class="api-tag" title="${live} of ${list.length} APIs are live">${API_ICON}APIs ${live}/${list.length} live</span>`
    + (issues ? `<span class="api-tag is-issue">${issues} API issue${issues === 1 ? '' : 's'}</span>` : '');
}

function renderApis(p) {
  const list = p ? apisFor(p.id) : [];
  els.apiCount.textContent = list.length;
  const count = (s) => list.filter((a) => a.status === s).length;
  const tiles = [['Live', 'live'], ['Testing', 'testing'], ['Building', 'building'], ['Issue', 'issue']];
  els.apiTiles.innerHTML = list.length ? tiles.map(([s, cls]) => `<div class="api-tile api-tile-${cls}">
      <span>${s === 'Issue' ? 'Issues' : s}</span><strong>${count(s)}</strong></div>`).join('') : '';
  els.apiTiles.hidden = !list.length;
  const order = (a) => ({ Issue: 0, Testing: 1, Building: 2, 'Not started': 3, Live: 4 }[a.status] ?? 5);
  els.apiList.innerHTML = list.length
    ? list.slice().sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name)).map((a) => {
      const meta = [a.developer, a.environment, a.lastUpdated ? `updated ${relTime(parseStamp(a.lastUpdated))}` : '']
        .filter(Boolean).map(escapeHtml).join(' · ');
      const reviewer = a.reviewedBy ? `<b class="person" style="--p:${personColor(a.reviewedBy)}">${escapeHtml(a.reviewedBy)}</b>: ` : '';
      return `<button type="button" class="api-card is-${slug(a.status)}${a._pending ? ' is-pending' : ''}" data-api="${escapeHtml(a.apiId)}" title="Change status or review">
        <span class="api-card-top"><span class="api-name">${escapeHtml(a.name)}</span>${apiStatusChip(a.status)}</span>
        ${meta ? `<span class="api-meta">${meta}</span>` : ''}
        <span class="api-rev">${apiReviewChip(a.review)}${a.note ? `<span class="api-note">${reviewer}${mentionHtml(a.note)}</span>` : ''}</span>
      </button>`;
    }).join('')
    : `<div class="timeline-empty"><strong>No APIs yet</strong><span>Add the APIs this project connects to, like payments, SMS or email, to track their status and review.</span></div>`;
  els.apiAddBtn.hidden = state.sample || !p;
}

/* ---- the Add / edit popup ---- */
function choiceButtons(container, values, current) {
  container.innerHTML = values.map((v) => `<button type="button" role="radio" aria-checked="${v === current}"
    class="api-choice choice-${slug(v)}${v === current ? ' is-on' : ''}" data-value="${escapeHtml(v)}">${escapeHtml(v)}</button>`).join('');
}

function choiceValue(container) {
  const on = container.querySelector('.is-on');
  return on ? on.dataset.value : '';
}

function openApiModal(apiId) {
  const p = state.projects.find((x) => x.id === state.drawerId);
  if (!p) return;
  const api = apiId ? state.apis.find((a) => a.apiId === apiId) : null;
  if (apiId && !api) { toast('error', 'This API is no longer in the list. Someone may have removed it.'); return; }
  state.editingApiId = api ? api.apiId : null;
  els.apiModalTitle.textContent = api ? api.name : 'Add an API';
  els.apiModalProject.textContent = `${p.name} · ${p.id}`;
  els.apiName.value = api ? api.name : '';
  fillDatalist(els.apiNameList, state.apis.map((a) => a.name));
  choiceButtons(els.apiStatusChoices, API_STATUSES, api ? api.status || 'Not started' : 'Not started');
  choiceButtons(els.apiReviewChoices, API_REVIEWS, api ? api.review || 'Pending' : 'Pending');
  els.apiNote.value = api ? api.note || '' : '';
  const devs = DEVELOPERS.slice();
  const currentDev = api ? api.developer : p.developer || '';
  if (currentDev && !devs.some((n) => n.toLowerCase() === currentDev.toLowerCase())) devs.push(currentDev);
  els.apiDeveloper.innerHTML = '<option value="">Not assigned yet</option>'
    + devs.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  els.apiDeveloper.value = devs.find((n) => n.toLowerCase() === String(currentDev).toLowerCase()) || '';
  els.apiEnvironment.value = api ? api.environment || '' : '';
  fillPeople(els.apiBy);
  els.apiRemoveBtn.hidden = !api;
  els.apiRemoveBtn.textContent = 'Remove API';
  els.apiRemoveBtn.classList.remove('is-armed');
  els.apiModal.showModal();
  if (!api) setTimeout(() => els.apiName.focus(), 50);
}

/** "Status: Testing → Live; Review: Pending → Approved", the same way the server logs it. */
function describeApiChange(before, after) {
  if (!before) {
    return [`Added API: ${after.name}`, `Status: ${after.status}`, after.review !== 'Pending' ? `Review: ${after.review}` : '']
      .filter(Boolean).join('; ');
  }
  const parts = [`API: ${before.name !== after.name ? `${before.name} → ${after.name}` : after.name}`];
  [['status', 'Status'], ['review', 'Review'], ['developer', 'Developer'], ['environment', 'Environment']].forEach(([f, label]) => {
    if ((before[f] || '') !== (after[f] || '')) parts.push(`${label}: ${before[f] || '—'} → ${after[f] || '—'}`);
  });
  return parts.join('; ');
}

function saveApi() {
  const p = state.projects.find((x) => x.id === state.drawerId);
  if (!p) return;
  const name = els.apiName.value.trim();
  if (!name) { els.apiName.focus(); toast('error', 'Give the API a name.'); return; }
  const before = state.editingApiId ? state.apis.find((a) => a.apiId === state.editingApiId) : null;
  if (!before && apisFor(p.id).some((a) => a.name.toLowerCase() === name.toLowerCase())) {
    toast('error', `“${name}” is already in this project’s APIs.`);
    return;
  }
  const by = requireName(els.apiBy);
  if (!by) return;
  const draft = {
    apiId: before ? before.apiId : `tmp-${Date.now()}`,
    projectId: p.id,
    name,
    status: choiceValue(els.apiStatusChoices) || 'Not started',
    review: choiceValue(els.apiReviewChoices) || 'Pending',
    note: els.apiNote.value.trim(),
    developer: els.apiDeveloper.value,
    environment: els.apiEnvironment.value,
    reviewedBy: before ? before.reviewedBy || '' : '',
    lastUpdated: nowStamp(),
  };
  const reviewChanged = before ? draft.review !== before.review || draft.note !== (before.note || '')
    : draft.review !== 'Pending' || !!draft.note;
  if (reviewChanged) draft.reviewedBy = by;
  const changes = describeApiChange(before, draft);
  const noteChanged = before ? draft.note !== (before.note || '') : !!draft.note;
  if (before && changes === `API: ${draft.name}` && !noteChanged) { els.apiModal.close(); return; } // nothing changed
  els.apiModal.close();
  saveInBackground(() => {
    state.apis = before
      ? state.apis.map((a) => (a.apiId === before.apiId ? draft : a))
      : state.apis.concat({ ...draft, _pending: true });
    addLocalLog({ id: p.id, name: p.name, action: 'API', changes, reason: noteChanged ? draft.note : '', by });
  }, async () => {
    try {
      const res = await callScript({ action: 'saveApi', api: before ? draft : { ...draft, apiId: '' }, by });
      if (res.api) { state.apis = state.apis.map((a) => (a.apiId === draft.apiId ? res.api : a)); renderAll(); }
    } catch (err) {
      if (/unknown action/i.test(err.message || '')) {
        throw new AppError('setup', 'Saving APIs needs the latest server script (version 7). Paste the new Code.gs and deploy a new version, then try again.');
      }
      throw err;
    }
    toast('success', before ? `“${name}” is updated.` : `“${name}” is added.`);
  });
}

function removeApi() {
  const api = state.apis.find((a) => a.apiId === state.editingApiId);
  if (!api) return;
  // Ask once: the first click arms the button, the second one removes.
  if (!els.apiRemoveBtn.classList.contains('is-armed')) {
    els.apiRemoveBtn.classList.add('is-armed');
    els.apiRemoveBtn.textContent = 'Click again to remove';
    return;
  }
  const by = requireName(els.apiBy);
  if (!by) return;
  const p = state.projects.find((x) => x.id === api.projectId);
  els.apiModal.close();
  saveInBackground(() => {
    state.apis = state.apis.filter((a) => a.apiId !== api.apiId);
    addLocalLog({ id: api.projectId, name: p ? p.name : '', action: 'API', changes: `Removed API: ${api.name}`, by });
  }, async () => {
    try {
      await callScript({ action: 'deleteApi', apiId: api.apiId, by });
    } catch (err) {
      if (/no longer in the list/i.test(err.message || '')) return; // someone removed it already
      if (/unknown action/i.test(err.message || '')) {
        throw new AppError('setup', 'Removing APIs needs the latest server script (version 7). Paste the new Code.gs and deploy a new version, then try again.');
      }
      throw err;
    }
    toast('success', `“${api.name}” is removed.`);
  });
}

function bindApiEvents() {
  els.apiAddBtn.addEventListener('click', () => openApiModal(null));
  els.apiList.addEventListener('click', (e) => {
    const card = e.target.closest('[data-api]');
    if (card && !state.sample && !card.classList.contains('is-pending')) openApiModal(card.dataset.api);
  });
  [els.apiStatusChoices, els.apiReviewChoices].forEach((group) => group.addEventListener('click', (e) => {
    const btn = e.target.closest('.api-choice');
    if (!btn) return;
    group.querySelectorAll('.api-choice').forEach((b) => {
      b.classList.toggle('is-on', b === btn);
      b.setAttribute('aria-checked', String(b === btn));
    });
  }));
  els.apiForm.addEventListener('submit', (e) => { e.preventDefault(); saveApi(); });
  els.apiRemoveBtn.addEventListener('click', removeApi);
  els.apiBy.addEventListener('change', () => els.apiBy.classList.remove('needs-value', 'is-empty'));
  bindDialog(els.apiModal);
}

/* --------------------------------------------------------------------------
   @mentions in updates: type @ to pick a name; posted @Names are highlighted.
   -------------------------------------------------------------------------- */

/** Everyone who can be mentioned: team names, people in charge and developers. */
function mentionNames() {
  const seen = new Set();
  return [...TEAM, ...MANAGERS, ...DEVELOPERS].filter((n) => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Message text as HTML, with every @Name shown as a colored tag (stronger when it's you). */
function mentionHtml(text) {
  const raw = String(text || '');
  const names = mentionNames().sort((a, b) => b.length - a.length); // "Raj Kumar" before "Raj"
  if (!names.length || raw.indexOf('@') === -1) return escapeHtml(raw);
  const re = new RegExp(`@(${names.map(escapeRegExp).join('|')})(?![\\w])`, 'gi');
  const me = getEditorName().toLowerCase();
  let html = '';
  let last = 0;
  raw.replace(re, (match, name, offset) => {
    const real = names.find((n) => n.toLowerCase() === name.toLowerCase()) || name;
    html += escapeHtml(raw.slice(last, offset))
      + `<span class="mention${real.toLowerCase() === me ? ' is-me' : ''}" style="--p:${personColor(real)}">@${escapeHtml(real)}</span>`;
    last = offset + match.length;
    return match;
  });
  return html + escapeHtml(raw.slice(last));
}

const mention = { start: -1, items: [], active: 0 };

/** The "@abc" being typed right before the cursor, or null. */
function mentionQuery() {
  const ta = els.noteText;
  const before = ta.value.slice(0, ta.selectionStart);
  const m = before.match(/(^|\s)@([^\s@]{0,30})$/);
  return m ? { start: before.length - m[2].length - 1, text: m[2].toLowerCase() } : null;
}

function updateMentionMenu() {
  const q = mentionQuery();
  const items = q ? mentionNames().filter((n) => n.toLowerCase().startsWith(q.text)) : [];
  if (!q || !items.length) { closeMentionMenu(); return; }
  mention.start = q.start;
  mention.items = items;
  mention.active = Math.min(mention.active, items.length - 1);
  els.mentionMenu.innerHTML = items.map((n, i) => `<li role="option" id="mention-${i}" data-mention="${i}"
    class="${i === mention.active ? 'is-active' : ''}" aria-selected="${i === mention.active}">
    <span class="avatar" style="--p:${personColor(n)}" aria-hidden="true">${escapeHtml(n[0].toUpperCase())}</span>${escapeHtml(n)}</li>`).join('');
  els.mentionMenu.hidden = false;
  els.noteText.setAttribute('aria-expanded', 'true');
  els.noteText.setAttribute('aria-activedescendant', `mention-${mention.active}`);
}

function closeMentionMenu() {
  if (els.mentionMenu.hidden) return;
  els.mentionMenu.hidden = true;
  mention.active = 0;
  els.noteText.setAttribute('aria-expanded', 'false');
  els.noteText.removeAttribute('aria-activedescendant');
}

function pickMention(i) {
  const name = mention.items[i];
  if (!name) return;
  const ta = els.noteText;
  const after = ta.value.slice(ta.selectionStart);
  const insert = `@${name}${/^\s/.test(after) ? '' : ' '}`;
  ta.value = ta.value.slice(0, mention.start) + insert + after;
  const caret = mention.start + insert.length;
  ta.setSelectionRange(caret, caret);
  closeMentionMenu();
  ta.focus();
}

function onMentionKey(e) {
  if (els.mentionMenu.hidden) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const n = mention.items.length;
    mention.active = (mention.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    updateMentionMenu();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    pickMention(mention.active);
  } else if (e.key === 'Escape') {
    closeMentionMenu();
    e.stopPropagation(); // keep the panel open
  } else {
    return false;
  }
  e.preventDefault();
  return true;
}

/** Post a message about the project (to change the step, use "Move to …" in Details). */
async function submitNote() {
  const id = state.drawerId;
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;
  const note = els.noteText.value.trim();
  if (!note) {
    els.noteText.focus();
    toast('error', 'Write what happened first.');
    return;
  }
  const by = requireName(els.noteBy);
  if (!by) return;

  els.noteText.value = '';
  saveInBackground(() => {
    addLocalLog({ id, name: p.name, action: 'Note', reason: note, by });
  }, async () => {
    await callScript({ action: 'note', id, note, by });
  }, {
    onFail: () => { if (!els.noteText.value) els.noteText.value = note; }, // give the text back to try again
  });
}

/* --------------------------------------------------------------------------
   Saving: the Sheet's Apps Script web app (apps-script/Code.gs) does the
   writing as the Sheet's owner, so nobody has to sign in.
   -------------------------------------------------------------------------- */
const SCRIPT_HINT = 'Please try again in a moment. If it keeps happening, ask the person who set up the dashboard to check it.';

/** POST one change to the script (sent as text/plain, so the browser needs no CORS preflight). */
async function callScript(payload) {
  if (!CONFIG.SCRIPT_URL) {
    throw new AppError('setup', 'Saving isn’t set up yet: SCRIPT_URL in config.js is empty. See SETUP.md.');
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new AppError('network', 'You’re offline. Check your internet connection and try again.');
  }
  let res;
  try {
    res = await fetch(CONFIG.SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new AppError('network', `Couldn’t save right now. Check your internet connection and try again.`);
  }
  let data;
  try { data = await res.json(); } catch (err) {
    throw new AppError('setup', `The server didn’t answer properly. ${SCRIPT_HINT}`);
  }
  if (!data.ok) throw new AppError('script', data.error || 'The change couldn’t be saved.');
  return data;
}

/** Saves update the screen directly; nothing is re-read until Refresh is clicked. */
function holdReadsAfterWrite() {}

/** Run a save or delete with the busy overlay; `work` updates state.projects locally once the Sheet has it. */
/**
 * Instant save: show the change at once, send it to the Sheet in the background.
 * If the Sheet refuses, the screen goes back to how it was and the reason is shown.
 *   apply()       change state.projects / state.allLogs locally
 *   send()        talk to the Sheet; may return a function to run with the answer
 */
function saveInBackground(apply, send, { onFail } = {}) {
  const snapshot = { projects: state.projects, logs: state.allLogs, sample: state.sample, apis: state.apis };
  state.writeSeq = (state.writeSeq || 0) + 1;      // reads already on their way are now stale
  state.pendingWrites = (state.pendingWrites || 0) + 1;
  showSaving(true);
  apply();
  renderAll();
  return Promise.resolve()
    .then(send)
    .then(() => true)
    .catch((err) => {
      state.projects = snapshot.projects;
      state.allLogs = snapshot.logs;
      state.sample = snapshot.sample;
      state.apis = snapshot.apis;
      renderAll();
      if (onFail) onFail(err);
      reportError(err);
      return false;
    })
    .finally(() => {
      state.pendingWrites -= 1;
      if (!state.pendingWrites) {
        showSaving(false);
        saveCache();
        setTimeout(() => loadData({ silent: true }), 400); // pick up anything others changed meanwhile
      }
    });
}

/** "Saving…" in the status line while changes are on their way (the screen stays usable). */
function showSaving(on) {
  els.syncDot.className = `sync-dot ${on ? 'is-busy' : 'is-ok'}`;
  if (on) els.lastSynced.textContent = 'Saving…';
  else updateSyncLabel();
}

function runWrite(label, work) {
  if (state.busy) return Promise.resolve(false);
  state.writeSeq = (state.writeSeq || 0) + 1;
  setBusy(true, label);
  return Promise.resolve()
    .then(work)
    .then(() => { holdReadsAfterWrite(); renderAll(); return true; })
    .catch((err) => { reportError(err); return false; })
    .finally(() => setBusy(false));
}

/* --------------------------------------------------------------------------
   Add / edit popup and delete
   -------------------------------------------------------------------------- */
const NAME_KEY = 'pmd-editor-name';
/** Fill a "Your name" dropdown with the team (keeps any other remembered name as an extra option). */
function fillPeople(select) {
  const current = getEditorName();
  const names = TEAM.slice();
  if (current && !names.some((n) => n.toLowerCase() === current.toLowerCase())) names.push(current);
  select.innerHTML = '<option value="">Pick your name…</option>'
    + names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  select.value = names.find((n) => n.toLowerCase() === current.toLowerCase()) || '';
  select.classList.toggle('is-empty', !select.value);
}

/** The chosen name, or null after pointing the user at the dropdown. */
function requireName(select) {
  const name = select.value.trim();
  if (name) { setEditorName(name); return name; }
  select.classList.add('needs-value');
  select.focus();
  toast('error', 'Please pick your name, so everyone knows who made the change.');
  return null;
}

function getEditorName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; }
}
function setEditorName(name) {
  try { if (name) localStorage.setItem(NAME_KEY, name); } catch (e) { /* storage unavailable */ }
}

/** Next ID after the highest existing number, e.g. PRJ-0007 -> PRJ-0008 (shown in the popup). */
function nextId() {
  if (state.sample) return 'PRJ-0001';
  let max = 0;
  let prefix = 'PRJ-';
  state.projects.map((p) => p.id).concat(state.allLogs.map((l) => l.id)).forEach((pid) => {
    const m = String(pid).match(/^(.*?)(\d+)\s*$/);
    if (m && parseInt(m[2], 10) >= max) { max = parseInt(m[2], 10); prefix = m[1] || prefix; }
  });
  return `${prefix}${pad(max + 1, 4)}`;
}

function nowStamp() {
  const d = new Date();
  return `${todayIso()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Developer dropdown: the shared list, plus the project's current developer if it's not in it. */
function fillDeveloperSelect(current) {
  const names = DEVELOPERS.slice();
  if (current && !names.some((n) => n.toLowerCase() === String(current).toLowerCase())) names.push(current);
  els.fDeveloper.innerHTML = '<option value="">Not assigned yet</option>'
    + names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  els.fDeveloper.value = names.find((n) => n.toLowerCase() === String(current || '').toLowerCase()) || '';
}

/** "Who is in charge?" dropdown: the shared list, plus the project's current person if it's not in it. */
function fillManagerSelect(current, isNew) {
  const names = MANAGERS.slice();
  if (current && !names.some((n) => n.toLowerCase() === String(current).toLowerCase())) names.push(current);
  els.fManager.innerHTML = '<option value="">Not set yet</option>'
    + names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  const match = names.find((n) => n.toLowerCase() === String(current || '').toLowerCase());
  els.fManager.value = match || (isNew ? MANAGERS[0] || '' : '');
}

function fillDatalist(list, values) {
  list.innerHTML = [...new Set(values.filter(Boolean))].sort().map((v) => `<option value="${escapeHtml(v)}">`).join('');
}

function openProjectModal(project) {
  state.editingId = project ? project.id : null;
  els.projectForm.reset();
  els.modalTitle.textContent = project ? `Edit “${project.name || 'project'}”` : 'Add a project';
  els.saveBtn.textContent = project ? 'Save changes' : 'Add project';
  els.fIdDisplay.textContent = project ? `Project number ${project.id}.` : '';
  els.moreDetails.open = !!project;
  fillDeveloperSelect(project ? project.developer : '');

  const p = project || { startDate: todayIso(), stage: 'Planning', status: 'On Track', priority: 'Medium', progress: STAGE_PERCENT.Planning };
  els.fName.value = p.name || '';
  fillManagerSelect(p.manager, !project);
  els.fStart.value = p.startDate || '';
  els.fDue.value = p.dueDate || '';
  els.fCompletion.value = p.completionDate || '';
  setSelectValue(els.fStage, p.stage, STAGES);
  setSelectValue(els.fStatus, p.status, STATUSES);
  setSelectValue(els.fPriority, p.priority, PRIORITIES);
  els.fProgress.value = clampProgress(p.progress);
  els.fProgressOut.textContent = `${els.fProgress.value}%`;
  els.fBudget.value = p.budget === '' || p.budget == null || !isFinite(Number(p.budget)) ? '' : Number(p.budget);
  els.fRemarks.value = p.remarks || '';
  els.fReason.value = '';
  els.fReasonLabel.textContent = project ? 'Why are you making this change?' : 'Anything to add? (optional)';
  els.fReason.placeholder = project ? 'e.g. The client moved the deadline' : 'e.g. Kick-off meeting done with the client';
  fillPeople(els.fBy);

  clearFieldErrors();
  els.projectModal.showModal();
  els.projectModal.querySelector('.modal-body').scrollTop = 0;
  els.fName.focus();
}

/** Keep values from the Sheet that aren't in the option list instead of silently changing them. */
function setSelectValue(select, value, options) {
  $$('option[data-custom]', select).forEach((o) => o.remove());
  if (value && !options.includes(value)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    opt.dataset.custom = 'true';
    select.appendChild(opt);
  }
  select.value = value || '';
}

function readForm() {
  const p = {
    name: els.fName.value.trim(),
    developer: els.fDeveloper.value,
    manager: els.fManager.value.trim(),
    startDate: els.fStart.value,
    dueDate: els.fDue.value,
    completionDate: els.fCompletion.value,
    stage: els.fStage.value,
    status: els.fStatus.value,
    priority: els.fPriority.value,
    progress: clampProgress(els.fProgress.value),
    budget: els.fBudget.value,
    remarks: els.fRemarks.value.trim(),
    lastUpdated: nowStamp(),
  };
  // Rule: Completed stage means 100%, status Completed and a completion date.
  if (p.stage === 'Completed') {
    p.progress = 100;
    p.status = 'Completed';
    if (!p.completionDate) p.completionDate = todayIso();
  }
  return p;
}

function validateForm(p) {
  const errors = {};
  if (!p.name) errors.name = 'Please give the project a name.';
  if (!p.stage) errors.stage = 'Please pick a step.';
  if (!p.dueDate) errors.dueDate = 'Please pick a date.';
  if (p.startDate && p.dueDate && p.dueDate < p.startDate) errors.dueDate = 'This can’t be before the start date.';
  return errors;
}

function showFieldErrors(errors) {
  clearFieldErrors();
  Object.entries(errors).forEach(([field, message]) => {
    const slot = $(`[data-error-for="${field}"]`, els.projectForm);
    if (slot) { slot.textContent = message; slot.closest('.field').classList.add('has-error'); }
  });
  const input = els.projectForm.elements[Object.keys(errors)[0]];
  if (input) input.focus();
}

function clearFieldErrors() {
  $$('.field-error', els.projectForm).forEach((s) => { s.textContent = ''; });
  $$('.field.has-error', els.projectForm).forEach((f) => f.classList.remove('has-error'));
}

function onStageChange() {
  const pct = STAGE_PERCENT[els.fStage.value];
  if (pct !== undefined) {
    els.fProgress.value = pct;
    els.fProgressOut.textContent = `${pct}%`;
  }
  if (els.fStage.value === 'Completed') {
    els.fProgress.value = 100;
    els.fProgressOut.textContent = '100%';
    setSelectValue(els.fStatus, 'Completed', STATUSES);
    if (!els.fCompletion.value) els.fCompletion.value = todayIso();
  }
}

/** Save the popup: the script appends a new row, or overwrites the project's row (found by ID). */
function submitProject() {
  const form = readForm();
  const errors = validateForm(form);
  if (Object.keys(errors).length) { showFieldErrors(errors); return; }
  const editingId = state.editingId;
  const reason = els.fReason.value.trim();
  const by = requireName(els.fBy);
  if (!by) return;
  els.projectModal.close();
  if (editingId) {
    const before = state.projects.find((p) => p.id === editingId);
    saveInBackground(() => {
      state.projects = state.projects.map((p) => (p.id === editingId ? { ...p, ...form, id: editingId } : p));
      addLocalLog({ id: editingId, name: form.name, action: 'Updated', changes: describeLocalChanges(before, form), reason, by });
    }, async () => {
      await callScript({ action: 'update', id: editingId, project: form, reason, by });
      toast('success', `Your changes to “${form.name}” are saved.`);
    });
  } else {
    const tempId = `new-${Date.now()}`;
    saveInBackground(() => {
      if (state.sample) state.projects = []; // the Sheet had no projects; drop the preview
      state.sample = false;
      hideNotice();
      state.projects = state.projects.concat({ ...emptyProject(), ...form, id: tempId, _pending: true });
      flashProject(tempId);
    }, async () => {
      const res = await callScript({ action: 'create', project: form, reason, by });
      // Swap the placeholder for the real project number from the Sheet.
      state.projects = state.projects.map((p) => (p.id === tempId ? { ...p, id: res.id, rowNumber: res.row || null, _pending: false } : p));
      addLocalLog({ id: res.id, name: form.name, action: 'Created', changes: `Stage: ${form.stage}; Status: ${form.status || '—'}; Progress: ${form.progress}%; Due: ${form.dueDate}`, reason, by });
      flashProject(res.id);
      renderAll();
      toast('success', `“${form.name}” is added as ${res.id}.`);
    });
  }
}

/** Same wording as the Sheet's history ("Stage: Design → Review"), for the instant on-screen entry. */
function describeLocalChanges(before, after) {
  if (!before) return '';
  const labels = { name: 'Project Name', developer: 'Developer', manager: 'Project Manager', startDate: 'Start Date',
    dueDate: 'Due Date', completionDate: 'Completion Date', stage: 'Stage', progress: 'Progress (%)', status: 'Status',
    priority: 'Priority', budget: 'Budget', remarks: 'Remarks' };
  return Object.keys(labels).filter((f) => after[f] !== undefined).map((f) => {
    let a = String(before[f] ?? '').trim();
    let b = String(after[f] ?? '').trim();
    if (f === 'progress') { a = `${clampProgress(a)}%`; b = `${clampProgress(b)}%`; }
    return a === b ? '' : `${labels[f]}: ${a || '—'} → ${b || '—'}`;
  }).filter(Boolean).join('; ');
}

function askDelete(project) {
  state.pendingDeleteId = project.id;
  els.deleteReason.value = '';
  fillPeople(els.deleteBy);
  els.confirmText.textContent = `“${project.name}” will be removed for everyone.`;
  els.confirmModal.showModal();
  els.deleteReason.focus();
}

function deleteProject(id) {
  const project = state.projects.find((p) => p.id === id);
  const by = requireName(els.deleteBy);
  if (!by) return;
  const reason = els.deleteReason.value.trim();
  els.confirmModal.close();
  if (state.drawerId === id) els.projectDrawer.close();
  saveInBackground(() => {
    const gone = state.projects.find((p) => p.id === id);
    state.projects = state.projects
      .filter((p) => p.id !== id)
      .map((p) => (gone && p.rowNumber > gone.rowNumber ? { ...p, rowNumber: p.rowNumber - 1 } : p));
    addLocalLog({ id, name: project ? project.name : '', action: 'Deleted', reason, by });
  }, async () => {
    await callScript({ action: 'delete', id, reason, by });
    toast('success', `“${project ? project.name : id}” is deleted.`);
  });
}

function setBusy(on, text = 'Working…') {
  state.busy = on;
  els.busyText.textContent = text;
  els.busyOverlay.hidden = !on;
  els.saveBtn.disabled = on;
  els.confirmDeleteBtn.disabled = on;
  if (els.confirmClearBtn) els.confirmClearBtn.disabled = on || (!els.clearProjects.checked && !els.clearLogs.checked);
}

function normalizeError(err) {
  if (err instanceof AppError) return err;
  return new AppError('unknown', (err && err.message) || 'Something went wrong.');
}

function reportError(err) {
  const e = normalizeError(err);
  console.error(e.kind, e.message, err);
  toast('error', e.message);
}

/* --------------------------------------------------------------------------
   UI feedback: notices, toasts
   -------------------------------------------------------------------------- */
let noticeHandler = null;
function showNotice(kind, title, text, actionLabel, action) {
  els.notice.hidden = false;
  els.notice.className = `notice ${kind === 'error' ? 'is-error' : kind === 'warn' ? 'is-warn' : ''}`;
  els.noticeTitle.textContent = title;
  els.noticeText.textContent = text || '';
  noticeHandler = action || null;
  els.noticeAction.hidden = !action;
  els.noticeAction.textContent = actionLabel || '';
}

function hideNotice() {
  els.notice.hidden = true;
  noticeHandler = null;
}

function toast(kind, message) {
  const el = document.createElement('div');
  el.className = `toast is-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span class="toast-msg">${escapeHtml(message)}</span><button class="toast-close" type="button" aria-label="Dismiss">×</button>`;
  const remove = () => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 200); };
  el.querySelector('.toast-close').addEventListener('click', remove);
  els.toasts.appendChild(el);
  setTimeout(remove, kind === 'error' ? 7000 : 3500);
}

/* --------------------------------------------------------------------------
   Theme & interactions
   -------------------------------------------------------------------------- */
function setStageFilter(stage) {
  state.filters.stage = state.filters.stage === stage ? '' : stage;
  renderAll();
}

function clearFilters() {
  Object.assign(state.filters, { quick: 'all', search: '', stage: '' });
  renderAll();
}

/* --------------------------------------------------------------------------
   Admin (hidden): double-click / double-tap the app name -> Clear data
   -------------------------------------------------------------------------- */
function openAdmin() {
  els.adminModal.showModal();
}

/* Team names editor (Admin). Works on a draft; "Save names" stores it in the Sheet. */
function applyTeam(names) {
  const next = names.map((n) => String(n).trim()).filter(Boolean);
  if (!next.length || next.join('\n') === TEAM.join('\n')) return;
  TEAM = next;
  state.teamChanged = true;
}

function applyDevelopers(names) {
  const next = names.map((n) => String(n).trim()).filter(Boolean);
  if (!next.length || next.join('\n') === DEVELOPERS.join('\n')) return;
  DEVELOPERS = next;
  state.teamChanged = true;
}

function applyManagers(names) {
  const next = names.map((n) => String(n).trim()).filter(Boolean);
  if (!next.length || next.join('\n') === MANAGERS.join('\n')) return;
  MANAGERS = next;
  state.teamChanged = true;
}

/*
 * Team popup (Admin → Team → Edit…): two name lists edited together.
 *   team        "Who are you?" list           (saved with setTeam)
 *   managers    "Who is in charge?" list      (saved with setManagers)
 *   developers  Developer list on projects    (saved with setDevelopers)
 */
const NAME_LISTS = {
  team: { label: 'team name', action: 'setTeam', get: () => TEAM, set: (v) => { TEAM = v; } },
  managers: { label: 'person in charge', action: 'setManagers', get: () => MANAGERS, set: (v) => { MANAGERS = v; } },
  developers: { label: 'developer', action: 'setDevelopers', get: () => DEVELOPERS, set: (v) => { DEVELOPERS = v; } },
};

function openTeamModal() {
  state.drafts = {};
  Object.keys(NAME_LISTS).forEach((k) => {
    state.drafts[k] = NAME_LISTS[k].get().map((name) => ({ name, original: name }));
  });
  $$('#teamModal .team-add input').forEach((i) => { i.value = ''; });
  els.adminModal.close();
  renderTeamEditor();
  els.teamModal.showModal();
}

function listChanged(kind) {
  const d = state.drafts[kind];
  const list = NAME_LISTS[kind].get();
  return d.length !== list.length || d.some((x, i) => x.name.trim() !== list[i]);
}

function renderTeamEditor() {
  Object.keys(NAME_LISTS).forEach((kind) => {
    const draft = state.drafts[kind];
    const ul = els.teamModal.querySelector(`[data-list="${kind}"]`);
    ul.innerHTML = draft.map((m, i) => {
      const name = m.name.trim();
      const renamed = m.original && name !== m.original;
      const color = !name ? 'var(--muted)' : kind === 'team' ? `var(--person-${i % PERSON_COLORS})` : personColor(name);
      return `<li class="team-row${m.original ? '' : ' is-new'}">
        <span class="avatar" style="--p:${color}" aria-hidden="true">${escapeHtml((name[0] || '?').toUpperCase())}</span>
        <input type="text" class="team-name" data-kind="${kind}" data-index="${i}" value="${escapeHtml(m.name)}" maxlength="40" aria-label="${NAME_LISTS[kind].label} ${i + 1}">
        ${renamed ? `<span class="team-tag">was ${escapeHtml(m.original)}</span>` : m.original ? '' : '<span class="team-tag team-tag-new">new</span>'}
        <button type="button" class="row-btn danger" data-kind="${kind}" data-remove="${i}" title="Remove ${escapeHtml(name || 'this name')}" aria-label="Remove ${escapeHtml(name || 'this name')}"${draft.length <= 1 ? ' disabled' : ''}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </li>`;
    }).join('');
  });
  updateTeamButtons();
}

function updateTeamButtons() {
  const changed = Object.keys(NAME_LISTS).some(listChanged);
  els.teamSaveBtn.disabled = !changed;
  els.teamStatus.textContent = changed
    ? 'You have unsaved changes.'
    : 'Renaming doesn’t change names on updates already posted or projects already assigned.';
  els.teamStatus.classList.toggle('is-dirty', changed);
}

function namesProblem(names, label) {
  if (!names.length) return `Keep at least one ${label}.`;
  if (names.some((n) => !n)) return `A ${label} is empty. Type a name or remove that row.`;
  const seen = new Set();
  for (const n of names) {
    const k = n.toLowerCase();
    if (seen.has(k)) return `“${n}” is in the list twice.`;
    seen.add(k);
  }
  return '';
}

function addName(kind, input) {
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  if (state.drafts[kind].some((m) => m.name.trim().toLowerCase() === name.toLowerCase())) {
    toast('error', `“${name}” is already in the list.`);
    return;
  }
  state.drafts[kind].push({ name, original: '' });
  input.value = '';
  renderTeamEditor();
  input.focus();
}

function saveTeam() {
  const changedKinds = Object.keys(NAME_LISTS).filter(listChanged);
  if (!changedKinds.length) return;
  const next = {};
  for (const kind of changedKinds) {
    next[kind] = state.drafts[kind].map((m) => m.name.trim());
    const problem = namesProblem(next[kind], NAME_LISTS[kind].label);
    if (problem) { toast('error', problem); return; }
  }
  const before = {};
  changedKinds.forEach((k) => { before[k] = NAME_LISTS[k].get().slice(); });
  // Whoever was picked in "Who are you?" follows a rename.
  const me = getEditorName();
  const mine = next.team && state.drafts.team.find((m) => m.original && m.original.toLowerCase() === me.toLowerCase());
  els.teamModal.close();
  saveInBackground(() => {
    changedKinds.forEach((k) => NAME_LISTS[k].set(next[k]));
    if (mine) setEditorName(mine.name.trim());
  }, async () => {
    try {
      for (const kind of changedKinds) {
        await callScript({ action: NAME_LISTS[kind].action, names: next[kind] });
      }
    } catch (err) {
      changedKinds.forEach((k) => NAME_LISTS[k].set(before[k]));
      if (/unknown action/i.test(err.message || '')) {
        throw new AppError('setup', 'Saving these names needs the latest server script (version 6). Paste the new Code.gs and deploy a new version, then try again.');
      }
      throw err;
    }
    toast('success', 'Saved. Everyone now sees the new names.');
  });
}

async function openClear() {
  els.adminModal.close();
  els.clearProjects.checked = false;
  els.clearLogs.checked = false;
  els.confirmClearBtn.disabled = true;
  els.clearProjectsName.textContent = state.sheetTabName || 'Sheet1';
  els.clearProjectsCount.textContent = state.sample ? 0 : state.projects.length;
  els.clearLogsCount.textContent = state.allLogs.length;
  els.clearModal.showModal();
  // The tab's real name, when the script can tell us (older scripts may not).
  if (!state.sheetTabName && CONFIG.SCRIPT_URL) {
    try {
      const h = await (await fetch(`${CONFIG.SCRIPT_URL}?t=${Date.now()}`)).json();
      if (h.sheetName) { state.sheetTabName = h.sheetName; els.clearProjectsName.textContent = h.sheetName; }
    } catch (e) { /* keep the default label */ }
  }
}

function clearData() {
  const projects = els.clearProjects.checked;
  const logs = els.clearLogs.checked;
  if (!projects && !logs) return;
  runWrite('Clearing…', async () => {
    let res;
    try {
      res = await callScript({ action: 'clear', projects, logs });
    } catch (err) {
      if (/unknown action/i.test(err.message || '')) {
        throw new AppError('setup', 'Clearing needs the latest server script (version 4). Paste the new Code.gs and deploy a new version, then try again.');
      }
      throw err;
    }
    if (projects) {
      state.projects = [];
      state.sample = false;
      state.filters.stage = '';
      if (els.projectDrawer.open) els.projectDrawer.close();
    }
    if (logs) state.allLogs = [];
    hideNotice();
    els.clearModal.close();
    const parts = [];
    if (projects) parts.push(`${res.projectsCleared || 0} project${res.projectsCleared === 1 ? '' : 's'}`);
    if (logs) parts.push(`${res.logsCleared || 0} update${res.logsCleared === 1 ? '' : 's'}`);
    toast('success', `Cleared ${parts.join(' and ')}.`);
  });
}

/*
 * Popups and side panels fade/slide out instead of vanishing. close() plays a short
 * animation first; opening again during it simply cancels the close.
 */
(function animateDialogClose() {
  const proto = HTMLDialogElement.prototype;
  const realClose = proto.close;
  const realShowModal = proto.showModal;
  proto.close = function close(...args) {
    if (!this.open || reduceMotion() || !(this.classList.contains('modal') || this.classList.contains('drawer'))) {
      clearTimeout(this._closeTimer);
      this.classList.remove('is-closing');
      return realClose.apply(this, args);
    }
    if (this._closeTimer) return undefined;
    this.classList.add('is-closing');
    this._closeTimer = setTimeout(() => {
      this._closeTimer = null;
      this.classList.remove('is-closing');
      realClose.apply(this, args);
    }, 170);
    return undefined;
  };
  proto.showModal = function showModal(...args) {
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
      this.classList.remove('is-closing');
      return undefined; // was closing: just stay open
    }
    if (this.open) return undefined; // already open: nothing to do
    const result = realShowModal.apply(this, args);
    dialogStack.push(this);
    syncDialogHistory();
    return result;
  };
}());

/*
 * Phone Back button: every open popup or panel gets its own step in the browser history,
 * so Back closes the top one (panel → list) instead of leaving the dashboard.
 * Closing with ✕, Esc or a tap outside removes that step again.
 */
const dialogStack = [];

function openDialogCount() {
  return dialogStack.filter((d) => d.open && !d.classList.contains('is-closing')).length;
}

function historyDepth() {
  return (history.state && history.state.pmdLayers) || 0;
}

let historyBackTimer = null;
function syncDialogHistory() {
  const open = openDialogCount();
  if (open > historyDepth()) {
    clearTimeout(historyBackTimer);
    historyBackTimer = null;
    history.pushState({ pmdLayers: open }, '', location.href);
    return;
  }
  // Wait a moment: a popup that closes only to open another (Admin → Edit team) keeps its step.
  if (historyBackTimer) return;
  historyBackTimer = setTimeout(() => {
    historyBackTimer = null;
    const extra = historyDepth() - openDialogCount();
    if (extra > 0) history.go(-extra);
  }, 0);
}

function setupBackButton() {
  if (historyDepth()) history.replaceState({ pmdLayers: 0 }, '', location.href); // reload: nothing is open yet
  const realClose = HTMLDialogElement.prototype.close;
  HTMLDialogElement.prototype.close = function close(...args) {
    const result = realClose.apply(this, args);
    syncDialogHistory();
    return result;
  };
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('close', () => {
    const i = dialogStack.indexOf(d);
    if (i !== -1) dialogStack.splice(i, 1);
    syncDialogHistory();
  }));
  window.addEventListener('popstate', () => {
    // Back (or Forward) moved to a step with fewer popups: close from the top down.
    const depth = historyDepth();
    const open = dialogStack.filter((d) => d.open && !d.classList.contains('is-closing'));
    while (open.length > depth) open.pop().close();
  });
}

function bindDialog(dialog, { guardBusy = false } = {}) {
  dialog.addEventListener('click', (e) => {
    if ((e.target === dialog || e.target.closest('[data-close]')) && !(guardBusy && state.busy)) dialog.close();
  });
  if (guardBusy) dialog.addEventListener('cancel', (e) => { if (state.busy) e.preventDefault(); });
}

function bindEvents() {
  els.addBtn.addEventListener('click', () => openProjectModal(null));
  els.activityBtn.addEventListener('click', openActivity);
  els.noticeAction.addEventListener('click', () => { if (noticeHandler) noticeHandler(); });
  els.clearStageBtn.addEventListener('click', () => { state.filters.stage = ''; renderAll(); });

  els.pipeline.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-stage]');
    if (btn) setStageFilter(btn.dataset.stage);
  });

  $$('.projects th[data-sort] button').forEach((btn) => btn.addEventListener('click', () => {
    const key = btn.parentElement.dataset.sort;
    const firstDir = key === 'activity' ? 'desc' : 'asc'; // newest updates first
    state.sort = state.sort.key === key
      ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: firstDir };
    renderTable();
    renderFilterState();
  }));

  // Rows: click anywhere opens the project; buttons do their own thing
  els.tableBody.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    const row = e.target.closest('tr[data-id]');
    if (!btn && (!row || e.target.closest('a'))) return;
    const id = btn ? btn.dataset.id : row.dataset.id;
    const project = state.projects.find((p) => p.id === id);
    if (!project || project._pending) return; // still being saved
    const action = btn ? btn.dataset.action : 'view';
    if (action === 'view') openDrawer(id, 'overview');
    else if (action === 'history') openDrawer(id, 'history');
    else if (action === 'edit') openProjectModal(project);
    else if (action === 'delete') askDelete(project);
  });

  els.emptyState.addEventListener('click', (e) => {
    if (e.target.closest('[data-empty-add]')) openProjectModal(null);
    if (e.target.closest('[data-empty-clear]')) clearFilters();
  });

  // Project panel
  els.tabOverview.addEventListener('click', () => setDrawerPane('overview'));
  els.tabHistory.addEventListener('click', () => setDrawerPane('history'));
  els.tabApis.addEventListener('click', () => setDrawerPane('apis'));
  bindApiEvents();
  els.projectDrawer.addEventListener('click', (e) => {
    if (e.target.closest('[data-goto="history"]')) setDrawerPane('history');
    const f = e.target.closest('[data-log-filter]');
    if (f) { state.logFilter = f.dataset.logFilter; renderDrawer(); }
  });
  els.drawerEditBtn.addEventListener('click', () => {
    const project = state.projects.find((p) => p.id === state.drawerId);
    if (project) openProjectModal(project);
  });
  els.drawerDeleteBtn.addEventListener('click', () => {
    const project = state.projects.find((p) => p.id === state.drawerId);
    if (project) askDelete(project);
  });
  els.drawerRefreshLogs.addEventListener('click', loadAllLogs);
  els.noteForm.addEventListener('submit', (e) => { e.preventDefault(); submitNote(); });
  els.noteText.addEventListener('keydown', (e) => {
    if (onMentionKey(e)) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitNote(); }
  });
  els.noteText.addEventListener('input', updateMentionMenu);
  els.noteText.addEventListener('click', updateMentionMenu);
  els.noteText.addEventListener('blur', () => setTimeout(closeMentionMenu, 120));
  els.mentionMenu.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the box
  els.mentionMenu.addEventListener('click', (e) => {
    const li = e.target.closest('[data-mention]');
    if (li) pickMention(Number(li.dataset.mention));
  });
  bindDialog(els.projectDrawer);
  // Clear the #project link the moment the panel is dismissed (the close event can arrive late).
  els.projectDrawer.addEventListener('click', (e) => {
    if (e.target === els.projectDrawer || e.target.closest('[data-close]')) setHash(null);
  });
  els.projectDrawer.addEventListener('cancel', () => setHash(null));
  // The close event arrives a moment later; don't forget a project that was opened again since.
  els.projectDrawer.addEventListener('close', () => {
    if (!els.projectDrawer.open) { state.drawerId = null; setHash(null); }
  });
  window.addEventListener('hashchange', () => { state.deepLinkHandled = false; openFromHash(); });

  // Admin: double-click (or double-tap on phones) the title
  let lastTitleTap = 0;
  els.appTitle.addEventListener('dblclick', (e) => { e.preventDefault(); openAdmin(); });
  els.appTitle.addEventListener('touchend', () => {
    const now = Date.now();
    if (now - lastTitleTap < 350) openAdmin();
    lastTitleTap = now;
  });
  bindDialog(els.adminModal);
  els.openClearBtn.addEventListener('click', openClear);
  els.teamModal.addEventListener('input', (e) => {
    const input = e.target.closest('.team-name[data-kind]');
    if (!input) return;
    state.drafts[input.dataset.kind][Number(input.dataset.index)].name = input.value;
    input.closest('.team-row').querySelector('.avatar').textContent = (input.value.trim()[0] || '?').toUpperCase();
    updateTeamButtons();
  });
  els.teamModal.addEventListener('change', (e) => { if (e.target.closest('.team-name')) renderTeamEditor(); });
  els.teamModal.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    const list = state.drafts[btn.dataset.kind];
    if (list.length <= 1) return;
    list.splice(Number(btn.dataset.remove), 1);
    renderTeamEditor();
  });
  els.teamModal.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-add]');
    if (!form) return;
    e.preventDefault();
    addName(form.dataset.add, form.querySelector('input'));
  });
  els.teamSaveBtn.addEventListener('click', saveTeam);
  els.openTeamBtn.addEventListener('click', openTeamModal);
  bindDialog(els.teamModal);
  bindDialog(els.clearModal, { guardBusy: true });
  [els.clearProjects, els.clearLogs].forEach((box) => box.addEventListener('change', () => {
    els.confirmClearBtn.disabled = !els.clearProjects.checked && !els.clearLogs.checked;
  }));
  els.confirmClearBtn.addEventListener('click', clearData);

  // Warn before leaving while a change is still being saved
  window.addEventListener('beforeunload', (e) => {
    if (state.pendingWrites) { e.preventDefault(); e.returnValue = ''; }
  });

  // Delete a message: confirmation popup
  bindDialog(els.noteDeleteModal);
  els.noteDeleteConfirm.addEventListener('click', confirmDeleteNote);
  els.noteDeleteModal.addEventListener('close', () => { if (!els.noteDeleteModal.open) state.pendingNoteDelete = null; });

  // Delete a message (icon shows on hover)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-delete-note]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    deleteNote(Number(btn.dataset.deleteNote));
  }, true);

  // Move to the next step
  els.nextStageBtn.addEventListener('click', showStageMove);
  els.stageMoveCancel.addEventListener('click', hideStageMove);
  els.stageMoveForm.addEventListener('submit', (e) => { e.preventDefault(); confirmStageMove(); });

  // Give an update
  els.giveUpdateBtn.addEventListener('click', () => {
    setDrawerPane('history');
    setTimeout(() => els.noteText.focus(), 30);
  });

  // Activity feed
  bindDialog(els.activityDrawer);
  els.activityRefresh.addEventListener('click', loadAllLogs);
  els.activityDrawer.addEventListener('click', (e) => {
    const f = e.target.closest('[data-activity-filter]');
    if (f) { state.activityFilter = f.dataset.activityFilter; renderActivity(); }
    if (e.target.closest('[data-more-activity]')) { state.activityLimit += 60; renderActivity(); }
    const link = e.target.closest('[data-open-project]');
    if (link) { els.activityDrawer.close(); openDrawer(link.dataset.openProject, 'history'); }
  });

  // Name dropdowns: remember the choice, clear the warning
  [els.fBy, els.noteBy, els.deleteBy, els.stageMoveBy].forEach((sel) => sel.addEventListener('change', () => {
    sel.classList.remove('needs-value');
    sel.classList.toggle('is-empty', !sel.value);
    if (sel.value) setEditorName(sel.value);
  }));

  // Add / edit popup
  els.fProgress.addEventListener('input', () => { els.fProgressOut.textContent = `${els.fProgress.value}%`; });
  els.fStage.addEventListener('change', onStageChange);
  els.projectForm.addEventListener('submit', (e) => { e.preventDefault(); submitProject(); });
  els.projectForm.addEventListener('input', (e) => {
    const field = e.target.closest('.field');
    if (field && field.classList.contains('has-error')) {
      field.classList.remove('has-error');
      const slot = $('.field-error', field);
      if (slot) slot.textContent = '';
    }
  });
  bindDialog(els.projectModal, { guardBusy: true });
  els.projectModal.addEventListener('close', () => { state.editingId = null; });

  // Delete confirmation
  els.confirmDeleteBtn.addEventListener('click', () => { if (state.pendingDeleteId) deleteProject(state.pendingDeleteId); });
  bindDialog(els.confirmModal, { guardBusy: true });
  els.confirmModal.addEventListener('close', () => { state.pendingDeleteId = null; });

}

/* --------------------------------------------------------------------------
   Init
   -------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------
   Branding (white label): name, logo, favicon and colour from config.js
   -------------------------------------------------------------------------- */
function applyBranding() {
  const name = CONFIG.APP_NAME;
  document.title = name;
  els.appTitle.textContent = name;
  if (CONFIG.APP_DESCRIPTION) {
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', CONFIG.APP_DESCRIPTION);
  }
  if (CONFIG.LOGO_URL) {
    const mark = document.querySelector('.brand-mark');
    const img = document.createElement('img');
    img.className = 'brand-logo';
    img.src = CONFIG.LOGO_URL;
    img.alt = '';
    img.addEventListener('error', () => img.replaceWith(mark)); // a broken link falls back to the icon
    if (mark) mark.replaceWith(img);
  }
  const icon = CONFIG.FAVICON_URL || CONFIG.LOGO_URL;
  if (icon) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.href = icon;
  }
  const accent = String(CONFIG.ACCENT_COLOR || '').trim();
  // The built-in blue already has hand-tuned light/dark shades in style.css.
  if (accent && accent.toLowerCase() !== '#2546c7' && window.CSS && CSS.supports('color', accent)) {
    // Light theme uses the colour as given; dark theme uses a lighter tint of it so it stays readable.
    const style = document.createElement('style');
    style.id = 'brandColors';
    style.textContent = `:root, :root[data-theme="light"] {
  --accent: ${accent};
  --accent-hover: color-mix(in srgb, ${accent} 82%, black);
  --accent-soft: color-mix(in srgb, ${accent} 11%, white);
  --focus: ${accent};
}
:root[data-theme="dark"] {
  --accent: color-mix(in srgb, ${accent} 55%, white);
  --accent-hover: color-mix(in srgb, ${accent} 45%, white);
  --accent-soft: color-mix(in srgb, ${accent} 28%, #0d1219);
  --focus: color-mix(in srgb, ${accent} 45%, white);
}`;
    document.head.appendChild(style);
  }
}

function init() {
  cacheElements();
  applyBranding();
  fillSelect(els.fStage, STAGES, 'Pick a step…');
  fillStatusSelect(els.fStatus);
  fillSelect(els.fPriority, PRIORITIES);
  bindEvents();
  setupBackButton();
  renderSkeleton();
  renderPipeline();
  renderFilterState();
  startApp();
  // Keep "2 min ago" style labels current (no data is loaded here)
  syncLabelTimer = setInterval(() => {
    if (!state.loading && state.lastSynced) updateSyncLabel();
    if (state.logsStatus === 'ok' && !state.busy) renderTable();
  }, 30000);
}

// script.js loads synchronously at the end of <body>, so the DOM is ready.
init();
