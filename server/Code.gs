/**
 * QuickCBT backend — runs free on Google Apps Script, stores everything in
 * the spreadsheet it is attached to, and emails codes from your own Gmail.
 *
 * SETUP (about 15 minutes, once)
 *   1. Make a new Google Sheet. Extensions > Apps Script.
 *   2. Delete whatever is in Code.gs and paste this whole file in. Save.
 *   3. Run the `setup` function once (pick it in the dropdown, press Run).
 *      Google will ask you to authorise it — that is normal, it is your own
 *      script asking to write to your own sheet and send your own mail.
 *   4. Deploy > New deployment > type: Web app.
 *        Execute as:      Me
 *        Who has access:  Anyone          <-- NOT "Anyone with a Google account"
 *      Copy the /exec URL it gives you.
 *   5. Paste that URL into data/access.json as "apiUrl", commit, push.
 *
 * WHENEVER YOU CHANGE THIS FILE you must Deploy > Manage deployments >
 * (pencil) > Version: New version > Deploy. Otherwise the live URL keeps
 * running the old code — this is the single most common thing to trip on.
 */

var TAB_ATTEMPTS = 'Attempts';
var TAB_SETTINGS = 'Settings';
var TAB_PAPERS = 'Papers';

/* One row per student per day. Column numbers are 1-based. */
var COL = {
  requestedAt: 1, email: 2, day: 3, code: 4, status: 5,
  startedAt: 6, endsAt: 7, submittedAt: 8,
  correct: 9, total: 10, percent: 11, secondsUsed: 12,
  timedOut: 13, tabSwitches: 14
};
var HEADERS = [
  'requestedAt', 'email', 'day', 'code', 'status',
  'startedAt', 'endsAt', 'submittedAt',
  'correct', 'total', 'percent', 'secondsUsed', 'timedOut', 'tabSwitches'
];

/* status moves: pending -> issued -> started -> done */

function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }

/* ------------------------------------------------------------------ *
 * Setup + menu
 * ------------------------------------------------------------------ */

function setup() {
  var book = ss();

  var att = book.getSheetByName(TAB_ATTEMPTS) || book.insertSheet(TAB_ATTEMPTS);
  if (att.getLastRow() === 0) {
    att.appendRow(HEADERS);
    att.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#efeaff');
    att.setFrozenRows(1);
    att.setColumnWidth(COL.email, 230);
  }

  var set = book.getSheetByName(TAB_SETTINGS) || book.insertSheet(TAB_SETTINGS);
  if (set.getLastRow() === 0) {
    set.appendRow(['key', 'value']);
    set.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#efeaff');
    set.setFrozenRows(1);
    set.setColumnWidth(1, 160);
    set.setColumnWidth(2, 380);
  }

  // Top up anything missing rather than only filling a blank tab, so re-running
  // setup() after an upgrade actually adds the new keys instead of skipping.
  var have = settings();
  var added = [];
  defaultSettings().forEach(function (r) {
    if (!(r[0] in have)) {
      set.appendRow(r);
      added.push(r[0]);
    }
  });

  var pap = book.getSheetByName(TAB_PAPERS) || book.insertSheet(TAB_PAPERS);
  if (pap.getLastRow() === 0) {
    pap.appendRow(['day', 'date', 'title', 'questionCount', 'durationMinutes', 'file', 'key']);
    for (var d = 1; d <= 7; d++) {
      pap.appendRow([d, '', 'Day ' + d, 40, 30, 'data/day' + d + '.json', '']);
    }
    pap.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#efeaff');
    pap.setFrozenRows(1);
    pap.setColumnWidth(2, 110);
    pap.setColumnWidth(3, 260);
    pap.setColumnWidth(6, 180);
    pap.setColumnWidth(7, 300);
  }

  book.toast(
    added.length
      ? 'Added settings: ' + added.join(', ') + '. Use QuickCBT > Show admin token.'
      : 'QuickCBT is set up. Now deploy this as a Web app.',
    'Ready', 10);
}

function newToken() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 24);
}

function defaultSettings() {
  return [
    ['day', 1],
    ['title', 'Day 1'],
    ['durationMinutes', 15],
    ['questionCount', 0],
    ['paperKey', ''],
    ['autoApprove', 'TRUE'],
    ['requestsOpen', 'TRUE'],
    ['fromName', 'OAU Post-UTME Prep'],
    ['siteUrl', ''],
    ['timezone', 'Africa/Lagos'],
    ['adminToken', newToken()]
  ];
}

/** Shows the token publish.py needs, creating one if it is missing. */
function showAdminToken() {
  var token = String(settings().adminToken || '');
  if (!token) {
    token = newToken();
    setSetting('adminToken', token);
  }
  SpreadsheetApp.getUi().alert(
    'Admin token',
    token +
    '\n\nPaste this into .quickcbt.json next to publish.py.' +
    '\nIt is also in the Settings tab, in the row named adminToken.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('QuickCBT')
    .addItem('Send pending codes', 'sendPendingCodes')
    .addItem('Move to the next day', 'nextDay')
    .addSeparator()
    .addItem('Show admin token', 'showAdminToken')
    .addItem('Check mail quota', 'showQuota')
    .addToUi();
}

/**
 * With autoApprove FALSE, requests land as "pending" and nothing is emailed
 * until you run this. Delete a pending row first if you do not want to let
 * that person in — this is your lever against a burst of fresh gmails.
 */
function sendPendingCodes() {
  var cfg = settings();
  var sheet = ss().getSheetByName(TAB_ATTEMPTS);
  var last = sheet.getLastRow();
  if (last < 2) return ss().toast('Nothing pending.', 'QuickCBT', 5);

  var rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var sent = 0;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][COL.status - 1]) !== 'pending') continue;
    if (String(rows[i][COL.day - 1]) !== String(activeDay())) continue;
    if (sendCodeEmail(rows[i][COL.email - 1], rows[i][COL.code - 1], cfg)) {
      sheet.getRange(i + 2, COL.status).setValue('issued');
      sent++;
    }
  }
  ss().toast('Sent ' + sent + ' code(s).', 'QuickCBT', 6);
}

/**
 * Rows are keyed by (email, day), so bumping the day lets everyone request a
 * fresh code while yesterday stays in the sheet as history. Nothing is deleted.
 */
function nextDay() {
  var cfg = settings();
  var next = (Number(cfg.day) || 1) + 1;
  setSetting('day', next);
  ss().toast('Now on day ' + next + '. Row ' + next + ' of the Papers tab is now live.', 'QuickCBT', 10);
}

function showQuota() {
  ss().toast(MailApp.getRemainingDailyQuota() + ' emails left today.', 'QuickCBT', 6);
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

function settings() {
  var sheet = ss().getSheetByName(TAB_SETTINGS);
  var out = {};
  if (!sheet || sheet.getLastRow() < 2) return out;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(function (r) {
    if (r[0] !== '' && r[0] != null) out[String(r[0]).trim()] = r[1];
  });
  return out;
}

function setSetting(key, value) {
  var sheet = ss().getSheetByName(TAB_SETTINGS);
  var rows = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === key) {
      sheet.getRange(i + 2, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

/**
 * The paper for one day. begin() only ever calls this with the CURRENT day, so
 * a key for any other day is unreachable no matter what a client sends.
 */
function paperFor(day) {
  var cfg = settings();
  var fallback = {
    title: String(cfg.title || ''),
    questionCount: Number(cfg.questionCount) || 0,
    durationMinutes: Number(cfg.durationMinutes) || 15,
    file: 'data/questions.json',
    key: String(cfg.paperKey || '')
  };
  var sheet = ss().getSheetByName(TAB_PAPERS);
  if (!sheet || sheet.getLastRow() < 2) return fallback;

  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === String(day)) {
      return {
        date: dateStr(rows[i][1]),
        title: String(rows[i][2] || fallback.title),
        questionCount: Number(rows[i][3]) || fallback.questionCount,
        durationMinutes: Number(rows[i][4]) || fallback.durationMinutes,
        file: String(rows[i][5] || fallback.file).trim(),
        key: String(rows[i][6] || '')
      };
    }
  }
  return fallback;
}

/* ------------------------------------------------------------------ *
 * Which paper is live today
 * ------------------------------------------------------------------ */

function tz() { return String(settings().timezone || 'Africa/Lagos'); }

function dateStr(v) {
  if (!v && v !== 0) return '';
  if (v instanceof Date) return Utilities.formatDate(v, tz(), 'yyyy-MM-dd');
  return String(v).trim().slice(0, 10);
}

function today() { return Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd'); }

/**
 * The live day is whichever Papers row carries today's date. If no row has a
 * date at all, fall back to the manual Settings "day" so the old flow keeps
 * working. If rows ARE dated and none matches today, nothing is live -- that
 * is what stops a day-3 paper being reachable on day 2.
 */
function activeDay() {
  var sheet = ss().getSheetByName(TAB_PAPERS);
  var now = today();
  var dated = false;

  if (sheet && sheet.getLastRow() > 1) {
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
    for (var i = 0; i < rows.length; i++) {
      var d = dateStr(rows[i][1]);
      if (d) dated = true;
      if (d && d === now) return String(rows[i][0]).trim();
    }
  }
  if (dated) return null;

  var manual = settings().day;
  return (manual === '' || manual == null) ? null : String(manual);
}

function isTrue(v) { return String(v).trim().toUpperCase() === 'TRUE'; }

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/* Must match normalizeEmail() in assets/js/app.js exactly, or a student's
   code will be issued against one spelling and checked against another. */
function normalizeEmail(raw) {
  var e = String(raw || '').trim().toLowerCase();
  var at = e.lastIndexOf('@');
  if (at < 1) return e;
  var local = e.slice(0, at), domain = e.slice(at + 1);
  var plus = local.indexOf('+');
  if (plus > -1) local = local.slice(0, plus);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return local + '@' + domain;
}

function isEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

/* No O/0/I/1 — students type these off a phone screen. */
function makeCode() {
  var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var out = '';
  for (var i = 0; i < 6; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return out;
}

function uniqueCode(day) {
  var sheet = ss().getSheetByName(TAB_ATTEMPTS);
  var taken = {};
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues().forEach(function (r) {
      if (String(r[COL.day - 1]) === String(day)) taken[String(r[COL.code - 1])] = true;
    });
  }
  for (var i = 0; i < 50; i++) {
    var c = makeCode();
    if (!taken[c]) return c;
  }
  return makeCode() + Math.floor(Math.random() * 9);
}

function findAttempt(email, day) {
  var sheet = ss().getSheetByName(TAB_ATTEMPTS);
  if (sheet.getLastRow() < 2) return null;
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues();
  for (var i = 0; i < values.length; i++) {
    if (normalizeEmail(values[i][COL.email - 1]) === email &&
        String(values[i][COL.day - 1]) === String(day)) {
      return { row: i + 2, values: values[i], sheet: sheet };
    }
  }
  return null;
}

function resultOf(found) {
  return {
    correct: Number(found.values[COL.correct - 1]) || 0,
    total: Number(found.values[COL.total - 1]) || 0,
    percent: Number(found.values[COL.percent - 1]) || 0,
    submittedAt: found.values[COL.submittedAt - 1]
      ? new Date(found.values[COL.submittedAt - 1]).toISOString() : null
  };
}

function millis(v) {
  if (!v) return 0;
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

/* ------------------------------------------------------------------ *
 * Email
 * ------------------------------------------------------------------ */

function sendCodeEmail(email, code, cfg) {
  var site = String(cfg.siteUrl || '');
  var title = String(paperFor(activeDay()).title || 'Today\'s practice test');
  var html =
    '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:28px 24px;color:#131728">' +
      '<div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#7c5cff;font-weight:700">' +
        htmlEscape(cfg.fromName || 'QuickCBT') +
      '</div>' +
      '<h1 style="font-size:24px;margin:10px 0 6px">Your access code</h1>' +
      '<p style="margin:0 0 22px;color:#4d5570;font-size:15px;line-height:1.55">' +
        'Here is your code for <b>' + htmlEscape(title) + '</b>. It works once, on your email only.' +
      '</p>' +
      '<div style="font-size:34px;font-weight:700;letter-spacing:.22em;padding:18px;text-align:center;' +
        'background:#f4f5fb;border:1px solid #e2e5f0;border-radius:14px">' + htmlEscape(code) + '</div>' +
      (site
        ? '<p style="margin:22px 0 0;text-align:center">' +
            '<a href="' + htmlEscape(site) + '" style="display:inline-block;background:#7c5cff;color:#fff;' +
            'text-decoration:none;padding:13px 26px;border-radius:12px;font-weight:600">Open the test</a></p>'
        : '') +
      '<p style="margin:26px 0 0;color:#7b839c;font-size:13px;line-height:1.6">' +
        'The clock starts when you press Begin, and it does not stop if you close the tab. ' +
        'Sit it when you actually have the time.' +
      '</p>' +
    '</div>';

  try {
    MailApp.sendEmail({
      to: email,
      subject: 'Your access code: ' + code,
      htmlBody: html,
      body: 'Your access code for ' + title + ' is ' + code + '. It works once.' + (site ? ' ' + site : ''),
      name: String(cfg.fromName || 'QuickCBT')
    });
    return true;
  } catch (err) {
    console.error('mail failed for ' + email + ': ' + err);
    return false;
  }
}

function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ *
 * Web endpoints
 * ------------------------------------------------------------------ */

function doGet() {
  return HtmlService.createHtmlOutput(
    '<p style="font-family:sans-serif">QuickCBT backend is running. ' +
    'Day ' + htmlEscape(settings().day) + '.</p>'
  );
}

function doPost(e) {
  var reply;
  try {
    reply = handle(JSON.parse(e.postData.contents));
  } catch (err) {
    reply = { ok: false, error: 'server', detail: String(err) };
  }
  return ContentService
    .createTextOutput(JSON.stringify(reply))
    .setMimeType(ContentService.MimeType.JSON);
}

function handle(req) {
  switch (String(req.action || '')) {
    case 'ping':    return ping();
    case 'config':  return configure(req);
    case 'request': return requestCode(req);
    case 'start':   return startCheck(req);
    case 'begin':   return begin(req);
    case 'submit':  return submitResult(req);
    default:        return { ok: false, error: 'unknown_action' };
  }
}

/**
 * Written to only by publish.py, which holds the adminToken from the Settings
 * tab. Replaces the Papers rows wholesale so the sheet always mirrors the
 * files that were just published.
 */
function configure(req) {
  var cfg = settings();
  var token = String(cfg.adminToken || '');
  if (!token) return { ok: false, error: 'no_admin_token' };
  if (String(req.token || '') !== token) return { ok: false, error: 'bad_token' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (req.papers && req.papers.length) {
      var sheet = ss().getSheetByName(TAB_PAPERS) || ss().insertSheet(TAB_PAPERS);
      if (sheet.getLastRow() === 0) {
        sheet.appendRow(['day', 'date', 'title', 'questionCount', 'durationMinutes', 'file', 'key']);
      }
      if (sheet.getLastRow() > 1) {
        sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).clearContent();
      }
      var rows = req.papers.map(function (p) {
        return [p.day, p.date, p.title, p.questionCount, p.durationMinutes, p.file, p.key];
      });
      sheet.getRange(2, 1, rows.length, 7).setValues(rows);
      sheet.getRange(2, 2, rows.length, 1).setNumberFormat('@');   // keep dates as text
    }

    if (req.settings) {
      for (var k in req.settings) {
        if (Object.prototype.hasOwnProperty.call(req.settings, k)) setSetting(k, req.settings[k]);
      }
    }

    return { ok: true, papers: (req.papers || []).length, today: today(), activeDay: activeDay() };
  } finally {
    lock.releaseLock();
  }
}

function ping() {
  var cfg = settings();
  var day = activeDay();
  var paper = paperFor(day);
  return {
    ok: true,
    today: today(),
    day: day,
    live: day !== null,
    title: paper.title,
    durationMinutes: paper.durationMinutes,
    questionCount: paper.questionCount,
    paperFile: paper.file,
    paperEncrypted: !!paper.key,
    autoApprove: isTrue(cfg.autoApprove),
    requestsOpen: isTrue(cfg.requestsOpen),
    mailQuotaLeft: MailApp.getRemainingDailyQuota()
  };
}

/* --- one code per email per day, emailed straight to them --- */
function requestCode(req) {
  var cfg = settings();
  if (!isTrue(cfg.requestsOpen)) return { ok: false, error: 'closed' };

  var email = normalizeEmail(req.email);
  if (!isEmail(email)) return { ok: false, error: 'bad_email' };

  var day = activeDay();
  if (day === null) return { ok: false, error: 'no_paper_today' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var found = findAttempt(email, day);
    if (found) {
      var status = String(found.values[COL.status - 1]);
      if (status === 'done')    return { ok: false, error: 'done' };
      if (status === 'started') return { ok: false, error: 'in_progress' };
      if (status === 'pending') return { ok: true, pending: true };
      // Already issued: resend the SAME code rather than minting a second one.
      return sendCodeEmail(email, found.values[COL.code - 1], cfg)
        ? { ok: true, resent: true, email: email }
        : { ok: false, error: 'mail_failed' };
    }

    var code = uniqueCode(day);
    var auto = isTrue(cfg.autoApprove);
    ss().getSheetByName(TAB_ATTEMPTS).appendRow([
      new Date(), email, day, code, auto ? 'issued' : 'pending',
      '', '', '', '', '', '', '', '', ''
    ]);

    if (!auto) return { ok: true, pending: true, email: email };
    if (sendCodeEmail(email, code, cfg)) return { ok: true, sent: true, email: email };
    return { ok: false, error: 'mail_failed' };
  } finally {
    lock.releaseLock();
  }
}

/* --- checks a code WITHOUT consuming it, so the brief can be shown --- */
function startCheck(req) {
  var cfg = settings();
  var email = normalizeEmail(req.email);
  var code = String(req.code || '').trim().toUpperCase();
  var day = activeDay();
  if (day === null) return { ok: false, error: 'no_paper_today' };

  var found = findAttempt(email, day);
  if (!found || String(found.values[COL.code - 1]).toUpperCase() !== code) {
    return { ok: false, error: 'no_code' };
  }

  var status = String(found.values[COL.status - 1]);
  if (status === 'pending') return { ok: false, error: 'pending' };
  if (status === 'done')    return { ok: false, error: 'done', result: resultOf(found) };

  var paper = paperFor(day);
  var info = {
    ok: true,
    day: day,
    title: paper.title,
    durationMinutes: paper.durationMinutes,
    questionCount: paper.questionCount,
    resume: false
  };

  if (status === 'started') {
    var endsAt = millis(found.values[COL.endsAt - 1]);
    if (Date.now() >= endsAt) return { ok: false, error: 'expired' };
    info.resume = true;
    info.endsAt = endsAt;
  }
  return info;
}

/* --- consumes the code and starts the server-side clock --- */
function begin(req) {
  var cfg = settings();
  var email = normalizeEmail(req.email);
  var code = String(req.code || '').trim().toUpperCase();
  var day = activeDay();
  if (day === null) return { ok: false, error: 'no_paper_today' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var found = findAttempt(email, day);
    if (!found || String(found.values[COL.code - 1]).toUpperCase() !== code) {
      return { ok: false, error: 'no_code' };
    }

    var status = String(found.values[COL.status - 1]);
    if (status === 'pending') return { ok: false, error: 'pending' };
    if (status === 'done')    return { ok: false, error: 'done', result: resultOf(found) };

    var sheet = found.sheet;
    var endsAt;

    if (status === 'started') {
      endsAt = millis(found.values[COL.endsAt - 1]);
      if (Date.now() >= endsAt) return { ok: false, error: 'expired' };
    } else {
      var minutes = paperFor(day).durationMinutes;
      var now = new Date();
      endsAt = now.getTime() + minutes * 60000;
      sheet.getRange(found.row, COL.status).setValue('started');
      sheet.getRange(found.row, COL.startedAt).setValue(now);
      sheet.getRange(found.row, COL.endsAt).setValue(new Date(endsAt));
    }

    // paperFor(day) is called with the CURRENT day and nothing else, so no
    // request can ever draw out another day's file name or key.
    var active = paperFor(day);
    return {
      ok: true,
      endsAt: endsAt,
      serverNow: Date.now(),
      paperFile: active.file,
      paperKey: active.key
    };
  } finally {
    lock.releaseLock();
  }
}

function submitResult(req) {
  var cfg = settings();
  var email = normalizeEmail(req.email);
  var code = String(req.code || '').trim().toUpperCase();
  var day = activeDay();
  if (day === null) return { ok: false, error: 'no_paper_today' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var found = findAttempt(email, day);
    if (!found || String(found.values[COL.code - 1]).toUpperCase() !== code) {
      return { ok: false, error: 'no_code' };
    }
    // Already recorded — never overwrite a submitted score.
    if (String(found.values[COL.status - 1]) === 'done') {
      return { ok: true, already: true, result: resultOf(found) };
    }

    var sheet = found.sheet;
    var row = found.row;
    sheet.getRange(row, COL.status).setValue('done');
    sheet.getRange(row, COL.submittedAt).setValue(new Date());
    sheet.getRange(row, COL.correct).setValue(Number(req.correct) || 0);
    sheet.getRange(row, COL.total).setValue(Number(req.total) || 0);
    sheet.getRange(row, COL.percent).setValue(Number(req.percent) || 0);
    sheet.getRange(row, COL.secondsUsed).setValue(Number(req.secondsUsed) || 0);
    sheet.getRange(row, COL.timedOut).setValue(!!req.timedOut);
    sheet.getRange(row, COL.tabSwitches).setValue(Number(req.tabSwitches) || 0);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}
