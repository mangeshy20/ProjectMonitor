/**
 * Project dashboard: saves dashboard changes into this Google Sheet and keeps
 * a history of them in a "Logs" tab.
 *
 * Lives in the Sheet (Extensions → Apps Script) and is deployed as a Web app
 * (Execute as: Me, Who has access: Anyone). It runs as the Sheet's owner, so
 * nobody using the dashboard has to sign in.
 */

const SCRIPT_VERSION = 7;
const SHEET_NAME = 'Projects';   // falls back to the first tab, same as the dashboard
const LOG_SHEET_NAME = 'Logs';   // created automatically on the first change
const API_SHEET_NAME = 'APIs';  // each project's API integrations, one row per API (created if missing)
const ADMIN_SHEET_NAME = 'Admin'; // every Admin → Team list, one column each (created if missing)
// Admin tab columns: heading in row 1, names below. Other spellings of a heading are also recognised.
// The defaults are written into the tab the first time a column is missing.
const ADMIN_LISTS = {
  team: { heading: 'Team names', aliases: ['team', 'teamname', 'whoareyou'], defaults: ['Alex', 'Sam', 'Jordan', 'Taylor'] },
  managers: { heading: 'In charge', aliases: ['whoisincharge', 'manager', 'managers', 'projectmanager'], defaults: ['Alex'] },
  developers: { heading: 'Developers', aliases: ['developer'], defaults: ['Sam', 'Jordan'] },
};
// Used only if the script isn't attached to the Sheet (made at script.google.com instead).
const SPREADSHEET_ID = ''; // paste the Sheet ID here only if the script is NOT attached to the Sheet

/**
 * GET ?action=data -> every project row plus the whole history, in one request.
 * GET ?action=logs&id=PRJ-0003 -> that project's history, newest first.
 * GET (no action) -> health check: open the Web app URL in a browser to see it.
 */
function doGet(e) {
  return respond_(() => {
    const params = (e && e.parameter) || {};
    if (params.action === 'data') return readAll_();
    if (params.action === 'logs') return { logs: readLogs_(params.id) };
    const sheet = getSheet_();
    return { sheetName: sheet.getName(), rows: Math.max(0, sheet.getLastRow() - 1) };
  });
}

function doPost(e) {
  return respond_(() => {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const lock = LockService.getScriptLock();
    lock.waitLock(20000); // one change at a time, so two people never get the same row or ID
    try {
      const sheet = getSheet_();
      const who = String(req.by || '').trim();
      const reason = String(req.reason || '').trim();
      switch (req.action) {
        case 'create': return createRow_(sheet, req.project, who, reason);
        case 'update': return updateRow_(sheet, req.id, req.project, who, reason);
        case 'delete': return deleteRow_(sheet, req.id, who, reason);
        case 'note': return addNote_(sheet, req.id, who, req.note);
        case 'addSamples': return addSamples_(sheet, req.rows, who);
        case 'clear': return clearData_(sheet, req);
        case 'deleteNote': return deleteNote_(req.entry);
        case 'setTeam': return setList_('team', req.names);
        case 'setDevelopers': return setList_('developers', req.names);
        case 'setManagers': return setList_('managers', req.names);
        case 'saveApi': return saveApi_(sheet, req.api, who);
        case 'deleteApi': return deleteApi_(sheet, req.apiId, who);
        default: throw new Error('Unknown action: ' + req.action);
      }
    } finally {
      lock.releaseLock();
    }
  });
}

/* ---------- project actions ---------- */

const HEADERS = ['ID', 'Project Name', 'Client / Department', 'Project Manager', 'Start Date', 'Due Date',
  'Completion Date', 'Stage', 'Progress (%)', 'Status', 'Priority', 'Budget', 'Remarks', 'Last Updated', 'Developer'];
const FIELDS = ['id', 'name', 'client', 'manager', 'startDate', 'dueDate',
  'completionDate', 'stage', 'progress', 'status', 'priority', 'budget', 'remarks', 'lastUpdated', 'developer'];
const DATE_FIELDS = ['startDate', 'dueDate', 'completionDate'];

/** Append a project; the next ID (e.g. PRJ-0012) is chosen here, under the lock. */
function createRow_(sheet, project, who, reason) {
  const headers = ensureHeaders_(sheet);
  const idCol = idColumn_(headers);
  const id = nextId_(sheet, idCol);
  const row = buildRow_(Object.assign({}, project, { id: id }), headers, null);
  sheet.appendRow(row);
  const summary = ['Stage: ' + (project.stage || '—'), 'Status: ' + (project.status || '—'),
    'Progress: ' + (Number(project.progress) || 0) + '%', 'Due: ' + (project.dueDate || '—')].join('; ');
  log_('Created', id, project.name, summary, reason, who);
  return { id: id, row: sheet.getLastRow() };
}

/** Overwrite one project's row, found by ID, and log what changed. Unknown columns keep their content. */
function updateRow_(sheet, id, project, who, reason) {
  const headers = ensureHeaders_(sheet);
  const idCol = idColumn_(headers);
  const rowNumber = findRow_(sheet, idCol, id);
  const range = sheet.getRange(rowNumber, 1, 1, headers.length);
  const current = range.getValues()[0];
  const formulas = range.getFormulas()[0];
  const keep = current.map((v, i) => formulas[i] || v);
  const changes = describeChanges_(headers, current, project);
  range.setValues([buildRow_(Object.assign({}, project, { id: id }), headers, keep)]);
  log_('Updated', id, project.name, changes || 'No field changes', reason, who);
  return { id: id, row: rowNumber, changes: changes };
}

function deleteRow_(sheet, id, who, reason) {
  const headers = readHeaders_(sheet);
  const rowNumber = findRow_(sheet, idColumn_(headers), id);
  const nameCol = headers.findIndex((h) => normalize_(h) === 'projectname');
  const name = nameCol === -1 ? '' : sheet.getRange(rowNumber, nameCol + 1).getDisplayValue();
  sheet.deleteRow(rowNumber);
  log_('Deleted', id, name, '', reason, who);
  return { id: id };
}

/** A free-text update posted from the project's panel. */
function addNote_(sheet, id, who, note) {
  const text = String(note || '').trim();
  if (!text) throw new Error('Write an update before posting it.');
  const headers = readHeaders_(sheet);
  const rowNumber = findRow_(sheet, idColumn_(headers), id);
  const nameCol = headers.findIndex((h) => normalize_(h) === 'projectname');
  const name = nameCol === -1 ? '' : sheet.getRange(rowNumber, nameCol + 1).getDisplayValue();
  log_('Note', id, name, '', text, who);
  return { id: id };
}

/** Header row plus example projects, only into an empty tab. */
function addSamples_(sheet, rows, who) {
  if (sheet.getLastRow() > 1) throw new Error('The Sheet already has data, so the samples weren’t added.');
  if (!Array.isArray(rows) || !rows.length) throw new Error('No sample rows were sent.');
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  rows.slice(1).forEach((r) => log_('Created', r[0], r[1], 'Added as sample data', '', who));
  return { added: rows.length - 1 };
}

/**
 * Admin: empty the projects tab and/or the Logs tab. The header rows stay, so the
 * dashboard keeps working and new projects can be added straight away.
 */
function clearData_(sheet, req) {
  const out = { projectsCleared: 0, logsCleared: 0 };
  if (req.projects) {
    const last = sheet.getLastRow();
    if (last >= 2) {
      sheet.getRange(2, 1, last - 1, Math.max(1, sheet.getLastColumn())).clearContent();
      out.projectsCleared = last - 1;
    }
  }
  if (req.logs) {
    const logs = spreadsheet_().getSheetByName(LOG_SHEET_NAME);
    if (logs && logs.getLastRow() >= 2) {
      out.logsCleared = logs.getLastRow() - 1;
      logs.getRange(2, 1, logs.getLastRow() - 1, Math.max(1, logs.getLastColumn())).clearContent();
    }
  }
  return out;
}

/**
 * Delete one posted message (a "Note" row) from the Logs tab. The row is matched on
 * its time, project, author and text; automatic history entries can't be deleted.
 */
function deleteNote_(entry) {
  const e = entry || {};
  const sheet = spreadsheet_().getSheetByName(LOG_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) throw new Error('That message is no longer there.');
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, LOG_HEADERS.length).getDisplayValues();
  const same = (x, y) => String(x || '').trim() === String(y || '').trim();
  const isIt = (r) => same(r[3], 'Note') && same(r[1], e.id) && same(r[5], e.reason) && same(r[6], e.by);
  // Exact match first; otherwise the newest identical message (a just-posted one may carry the
  // browser's clock instead of the Sheet's).
  let index = -1;
  for (let i = rows.length - 1; i >= 0 && index === -1; i -= 1) if (isIt(rows[i]) && same(rows[i][0], e.time)) index = i;
  for (let i = rows.length - 1; i >= 0 && index === -1; i -= 1) if (isIt(rows[i])) index = i;
  if (index === -1) throw new Error('That message is no longer there. Someone may have deleted it already.');
  const rowNumber = index + 2;
  // A sheet can't lose all its unfrozen rows, so the last remaining row is emptied instead.
  if (sheet.getLastRow() === 2) sheet.getRange(rowNumber, 1, 1, LOG_HEADERS.length).clearContent();
  else sheet.deleteRow(rowNumber);
  return { deleted: true };
}

/* ---------- Admin tab (team names, people in charge, developers) ---------- */

/** The Admin tab, created with its headings if it doesn't exist yet. */
function adminSheet_() {
  const ss = spreadsheet_();
  const wanted = ADMIN_SHEET_NAME.toLowerCase();
  let sheet = ss.getSheets().find((sh) => sh.getName().trim().toLowerCase() === wanted);
  if (!sheet) {
    sheet = ss.insertSheet(ADMIN_SHEET_NAME);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Column number (1-based) of a list in the Admin tab; the heading is added at the end if missing. */
function adminColumn_(sheet, key, create) {
  const def = ADMIN_LISTS[key];
  const lastCol = sheet.getLastColumn();
  const headings = lastCol ? sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(normalize_) : [];
  const names = [normalize_(def.heading)].concat(def.aliases);
  const found = headings.findIndex((h) => h && names.indexOf(h) !== -1);
  if (found !== -1) return found + 1;
  if (!create) return 0;
  const col = lastCol + 1;
  sheet.getRange(1, col).setValue(def.heading).setFontWeight('bold');
  return col;
}

function readColumn_(sheet, col) {
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getDisplayValues()
    .map((r) => String(r[0]).trim()).filter(Boolean);
}

function writeColumn_(sheet, col, names) {
  if (sheet.getLastRow() >= 2) sheet.getRange(2, col, sheet.getLastRow() - 1, 1).clearContent();
  sheet.getRange(2, col, names.length, 1).setValues(names.map((n) => [/^[=+\-@]/.test(n) ? "'" + n : n]));
}

/** All Admin lists. A list whose column is missing or empty gets its default names written in. */
function readAdmin_() {
  const sheet = adminSheet_();
  const out = {};
  Object.keys(ADMIN_LISTS).forEach((key) => {
    const col = adminColumn_(sheet, key, true);
    let names = readColumn_(sheet, col);
    if (!names.length) {
      names = ADMIN_LISTS[key].defaults.slice();
      writeColumn_(sheet, col, names);
    }
    out[key] = names;
  });
  return out;
}

/** Replace one Admin list. Names are trimmed, blanks and duplicates dropped. */
function setList_(key, names) {
  if (!ADMIN_LISTS[key]) throw new Error('Unknown list: ' + key);
  const seen = {};
  const clean = (Array.isArray(names) ? names : [])
    .map((n) => String(n || '').trim().slice(0, 40))
    .filter((n) => {
      const k = n.toLowerCase();
      if (!n || seen[k]) return false;
      seen[k] = true;
      return true;
    });
  if (!clean.length) throw new Error('Keep at least one name in the list.');
  const sheet = adminSheet_();
  writeColumn_(sheet, adminColumn_(sheet, key, true), clean);
  const out = {};
  out[key] = clean;
  return out;
}

/* ---------- API integrations (APIs tab) ---------- */

const API_HEADERS = ['API ID', 'Project ID', 'API Name', 'Status', 'Review', 'Review Note', 'Developer',
  'Environment', 'Reviewed By', 'Last Updated'];
const API_FIELDS = ['apiId', 'projectId', 'name', 'status', 'review', 'note', 'developer',
  'environment', 'reviewedBy', 'lastUpdated'];
const API_LABELS = { status: 'Status', review: 'Review', developer: 'Developer', environment: 'Environment' };

function findApiSheet_() {
  const wanted = API_SHEET_NAME.toLowerCase();
  return spreadsheet_().getSheets().find((sh) => sh.getName().trim().toLowerCase() === wanted) || null;
}

/** The APIs tab, created with its headings the first time an API is added. */
function apiSheet_() {
  let sheet = findApiSheet_();
  if (!sheet) {
    sheet = spreadsheet_().insertSheet(API_SHEET_NAME);
    sheet.setFrozenRows(1);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, API_HEADERS.length).setValues([API_HEADERS]).setFontWeight('bold');
  }
  return sheet;
}

/** Every API row as an object (blank rows skipped). */
function readApis_() {
  const sheet = findApiSheet_();
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, API_HEADERS.length).getDisplayValues()
    .filter((r) => String(r[0]).trim() && String(r[1]).trim())
    .map((r) => {
      const o = {};
      API_FIELDS.forEach((f, i) => { o[f] = String(r[i]).trim(); });
      return o;
    });
}

function apiRowNumber_(sheet, apiId) {
  if (sheet.getLastRow() >= 2) {
    const ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues();
    for (let i = 0; i < ids.length; i += 1) if (String(ids[i][0]).trim() === String(apiId).trim()) return i + 2;
  }
  return 0;
}

/** The project's name; also checks the project still exists. */
function projectName_(sheet, projectId) {
  const headers = readHeaders_(sheet);
  const rowNumber = findRow_(sheet, idColumn_(headers), projectId);
  const nameCol = headers.findIndex((h) => normalize_(h) === 'projectname');
  return nameCol === -1 ? '' : sheet.getRange(rowNumber, nameCol + 1).getDisplayValue();
}

/** Add an API (no apiId) or change one. Logged on the project, so it shows in Updates. */
function saveApi_(sheet, api, who) {
  api = api || {};
  const name = String(api.name || '').trim().slice(0, 80);
  if (!name) throw new Error('Give the API a name.');
  const projectId = String(api.projectId || '').trim();
  const projectName = projectName_(sheet, projectId);
  const apis = apiSheet_();
  const tz = spreadsheet_().getSpreadsheetTimeZone();
  const now = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
  const clean = (v) => {
    const t = String(v === undefined || v === null ? '' : v).trim();
    return /^[=+\-@]/.test(t) ? "'" + t : t;
  };
  let apiId = String(api.apiId || '').trim();
  const rowNumber = apiId ? apiRowNumber_(apis, apiId) : 0;
  if (apiId && !rowNumber) throw new Error('This API is no longer in the list. Someone may have removed it.');
  const before = {};
  if (rowNumber) {
    const r = apis.getRange(rowNumber, 1, 1, API_HEADERS.length).getDisplayValues()[0];
    API_FIELDS.forEach((f, i) => { before[f] = String(r[i]).trim(); });
  } else {
    let max = 0;
    if (apis.getLastRow() >= 2) {
      apis.getRange(2, 1, apis.getLastRow() - 1, 1).getDisplayValues().forEach(([v]) => {
        const m = String(v).match(/(\d+)\s*$/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      });
    }
    // Never reuse a removed API's number (it could still be open in someone's popup).
    const props = PropertiesService.getScriptProperties();
    max = Math.max(max, parseInt(props.getProperty('lastApiNumber') || '0', 10));
    props.setProperty('lastApiNumber', String(max + 1));
    apiId = 'API-' + String(max + 1).padStart(4, '0');
  }
  const next = {
    apiId: apiId,
    projectId: projectId,
    name: name,
    status: String(api.status || 'Not started').trim(),
    review: String(api.review || 'Pending').trim(),
    note: String(api.note || '').trim().slice(0, 1000),
    developer: String(api.developer || '').trim(),
    environment: String(api.environment || '').trim(),
    reviewedBy: before.reviewedBy || '',
    lastUpdated: now,
  };
  const reviewChanged = rowNumber
    ? next.review !== before.review || next.note !== before.note
    : next.review !== 'Pending' || !!next.note;
  if (reviewChanged) next.reviewedBy = who;
  const row = API_FIELDS.map((f) => clean(next[f]));
  if (rowNumber) apis.getRange(rowNumber, 1, 1, API_HEADERS.length).setValues([row]);
  else apis.appendRow(row);

  const parts = [];
  if (!rowNumber) {
    parts.push('Added API: ' + name, 'Status: ' + next.status);
    if (next.review !== 'Pending') parts.push('Review: ' + next.review);
  } else {
    parts.push('API: ' + (before.name !== name ? before.name + ' → ' + name : name));
    ['status', 'review', 'developer', 'environment'].forEach((f) => {
      if ((before[f] || '') !== (next[f] || '')) parts.push(API_LABELS[f] + ': ' + (before[f] || '—') + ' → ' + (next[f] || '—'));
    });
  }
  const noteChanged = rowNumber ? next.note !== before.note : !!next.note;
  log_('API', projectId, projectName, parts.join('; '), noteChanged ? next.note : '', who);
  return { api: next };
}

/** Remove one API from its project. */
function deleteApi_(sheet, apiId, who) {
  const apis = apiSheet_();
  const rowNumber = apiRowNumber_(apis, apiId);
  if (!rowNumber) throw new Error('This API is no longer in the list. Someone may have removed it.');
  const r = apis.getRange(rowNumber, 1, 1, API_HEADERS.length).getDisplayValues()[0];
  apis.deleteRow(rowNumber);
  let projectName = '';
  try { projectName = projectName_(sheet, r[1]); } catch (e) { /* project already gone */ }
  log_('API', r[1], projectName, 'Removed API: ' + r[2], '', who);
  return { apiId: apiId };
}

/* ---------- history (Logs tab) ---------- */

const LOG_HEADERS = ['Timestamp', 'Project ID', 'Project Name', 'Action', 'Changes', 'Reason / Note', 'By'];

function getLogSheet_() {
  const ss = spreadsheet_();
  let sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME); // added after the existing tabs
    sheet.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function log_(action, id, name, changes, reason, who) {
  const tz = spreadsheet_().getSpreadsheetTimeZone();
  const stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
  const clean = (v) => {
    const t = String(v === undefined || v === null ? '' : v).trim();
    return /^[=+\-@]/.test(t) ? "'" + t : t;
  };
  getLogSheet_().appendRow([stamp, clean(id), clean(name), action, clean(changes), clean(reason), clean(who)]);
}

/**
 * The projects tab as rows (dates as 'yyyy-MM-dd HH:mm:ss' text, numbers as numbers)
 * plus all history, in one request.
 */
function readAll_() {
  const sheet = getSheet_();
  const tz = spreadsheet_().getSpreadsheetTimeZone();
  const values = sheet.getLastRow() === 0 ? [] : sheet.getDataRange().getValues().map((row) => row.map((v) =>
    v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm:ss') : v));
  const admin = readAdmin_();
  return { sheetName: sheet.getName(), gid: sheet.getSheetId(), values: values, logs: readLogs_(''),
    team: admin.team, developers: admin.developers, managers: admin.managers, apis: readApis_() };
}

/** One project's history (or everything when id is empty), newest first. Blank rows are skipped. */
function readLogs_(id) {
  const sheet = spreadsheet_().getSheetByName(LOG_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const wanted = String(id || '').trim();
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, LOG_HEADERS.length).getDisplayValues();
  return rows
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .filter((r) => !wanted || String(r[1]).trim() === wanted)
    .map((r) => ({ time: r[0], id: r[1], name: r[2], action: r[3], changes: r[4], reason: r[5], by: r[6] }))
    .reverse();
}

/** "Stage: Design → Review; Progress (%): 25% → 40%" for the fields that actually changed. */
function describeChanges_(headers, currentRow, project) {
  const tz = spreadsheet_().getSpreadsheetTimeZone();
  const fieldByHeader = {};
  HEADERS.forEach((h, i) => { fieldByHeader[normalize_(h)] = { field: FIELDS[i], label: h }; });
  const show = (field, v) => {
    if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    let t = String(v === undefined || v === null ? '' : v).trim();
    if (DATE_FIELDS.indexOf(field) !== -1) {
      const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (m) t = m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
    }
    if (field === 'progress' && t !== '') t = Math.round(Number(t) || 0) + '%';
    if (field === 'budget' && t !== '' && isFinite(Number(t))) t = String(Number(t));
    return t;
  };
  const parts = [];
  headers.forEach((h, i) => {
    const info = fieldByHeader[normalize_(h)];
    if (!info || info.field === 'id' || info.field === 'lastUpdated') return;
    if (project[info.field] === undefined) return;
    const before = show(info.field, currentRow[i]);
    const after = show(info.field, project[info.field]);
    if (before !== after) parts.push(info.label + ': ' + (before || '—') + ' → ' + (after || '—'));
  });
  return parts.join('; ');
}

/* ---------- helpers ---------- */

function spreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getSheet_() {
  const ss = spreadsheet_();
  const wanted = SHEET_NAME.trim().toLowerCase();
  return ss.getSheets().find((s) => s.getName().trim().toLowerCase() === wanted) || ss.getSheets()[0];
}

function normalize_(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function readHeaders_(sheet) {
  if (sheet.getLastColumn() === 0) return [];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h).trim());
}

/** Write the standard header row if row 1 is empty; add any newer heading (e.g. Developer) at the end. */
function ensureHeaders_(sheet) {
  const headers = readHeaders_(sheet);
  if (!headers.some((h) => h !== '')) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    return HEADERS.slice();
  }
  const have = headers.map(normalize_);
  const missing = HEADERS.filter((h) => have.indexOf(normalize_(h)) === -1 && h === 'Developer');
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    return headers.concat(missing);
  }
  return headers;
}

function idColumn_(headers) {
  const col = headers.findIndex((h) => normalize_(h) === 'id');
  if (col === -1) throw new Error('The Sheet has no "ID" column in row 1.');
  return col;
}

function findRow_(sheet, idCol, id) {
  const last = sheet.getLastRow();
  if (last >= 2) {
    const ids = sheet.getRange(2, idCol + 1, last - 1, 1).getDisplayValues();
    for (let i = 0; i < ids.length; i += 1) {
      if (String(ids[i][0]).trim() === String(id).trim()) return i + 2;
    }
  }
  throw new Error('This project is no longer in the Sheet. Someone may have deleted it.');
}

/** Next ID after the highest ever used, including deleted projects (from the Logs tab), so IDs are never reused. */
function nextId_(sheet, idCol) {
  let max = 0;
  let prefix = 'PRJ-';
  const consider = (v) => {
    const m = String(v).match(/^(.*?)(\d+)\s*$/);
    if (m && parseInt(m[2], 10) >= max) {
      max = parseInt(m[2], 10);
      prefix = m[1] || prefix;
    }
  };
  const last = sheet.getLastRow();
  if (last >= 2) sheet.getRange(2, idCol + 1, last - 1, 1).getDisplayValues().forEach(([v]) => consider(v));
  const logs = spreadsheet_().getSheetByName(LOG_SHEET_NAME);
  if (logs && logs.getLastRow() >= 2) logs.getRange(2, 2, logs.getLastRow() - 1, 1).getDisplayValues().forEach(([v]) => consider(v));
  return prefix + String(max + 1).padStart(4, '0');
}

/** Project -> row in the Sheet's column order. Unknown columns keep `keep[i]` (or stay blank). */
function buildRow_(project, headers, keep) {
  const fieldByHeader = {};
  HEADERS.forEach((h, i) => { fieldByHeader[normalize_(h)] = FIELDS[i]; });
  return headers.map((h, i) => {
    const field = fieldByHeader[normalize_(h)];
    if (!field) return keep ? keep[i] : '';
    const value = project[field];
    if (value === undefined) return keep ? keep[i] : '';
    if (field === 'progress') return Math.max(0, Math.min(100, Number(value) || 0));
    if (field === 'budget') {
      if (value === '' || value === null) return '';
      const n = Number(value);
      return isFinite(n) ? n : String(value);
    }
    const text = String(value === null ? '' : value).trim();
    return /^[=+\-@]/.test(text) ? "'" + text : text; // typed text is never run as a formula
  });
}

function respond_(fn) {
  let body;
  try {
    body = Object.assign({ ok: true, version: SCRIPT_VERSION }, fn());
  } catch (err) {
    body = { ok: false, version: SCRIPT_VERSION, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
