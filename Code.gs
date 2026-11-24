/**
 * WasteWise Connect — backend
 * Google Apps Script, bound to a Google Sheet. Free on a personal account.
 *
 * Reports arrive here from the resident page, land as a row in the Sheet, and
 * the photo goes into a Drive folder. Management works out of the Sheet itself,
 * so there is no dashboard to build or host.
 *
 * FIRST RUN: open the editor, pick setup() from the function dropdown, Run,
 * and grant the permissions it asks for. Then deploy (see README.md).
 */

/* ----------------------------------------------------------------- config */

var SHEET_NAME  = 'Reports';
var FOLDER_NAME = 'WasteWise Photos';

/* Report numbers start just above this, so the first report is no. 148. */
var START_NUMBER = 147;

/* Optional. Leave both empty and the Telegram step is skipped.
   See README.md for how to get these from @BotFather. */
var TELEGRAM_TOKEN   = '';
var TELEGRAM_CHAT_ID = '';

var STATUSES = ['New', 'Received', 'Assigned', 'Cleared', 'Not found'];

/* Append new columns at the END. addPlate() writes column 6 by position, so
   inserting anywhere earlier would silently write the plate into the wrong
   column. */
var HEADERS = [
  'Report no.', 'Sent at', 'Hotspot', 'Problem', 'Photo',
  'Vehicle plate', 'Status', 'Assigned to', 'Cleared at', 'Notes',
  'Photo taken', 'Photo from'
];

/* ------------------------------------------------------------------ setup */

/**
 * Run this once by hand. Creates the sheet, the headers, the Drive folder and
 * the report counter. Safe to run again — it will not duplicate anything.
 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
  }

  var header = sheet.getRange(1, 1, 1, HEADERS.length);
  header.setFontWeight('bold').setBackground('#DAEBE1');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(3, 170);  // Hotspot
  sheet.setColumnWidth(4, 170);  // Problem
  sheet.setColumnWidth(5, 220);  // Photo
  sheet.setColumnWidth(10, 260); // Notes

  /* Status becomes a dropdown so management never has to type it. */
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUSES, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, 7, sheet.getMaxRows() - 1, 1).setDataValidation(rule);

  var props = PropertiesService.getScriptProperties();

  if (!props.getProperty('folderId')) {
    var existing = DriveApp.getFoldersByName(FOLDER_NAME);
    var folder = existing.hasNext() ? existing.next() : DriveApp.createFolder(FOLDER_NAME);
    props.setProperty('folderId', folder.getId());
  }

  if (!props.getProperty('lastReportNo')) {
    props.setProperty('lastReportNo', String(START_NUMBER));
  }

  return 'Setup complete. Folder: ' + FOLDER_NAME + ', sheet: ' + SHEET_NAME;
}

/* ------------------------------------------------------------- web app io */

/**
 * Everything is a POST so the browser never sends a CORS preflight.
 * The page must send Content-Type "text/plain;charset=utf-8" — see api.js.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: 'Empty request' });
    }

    var body = JSON.parse(e.postData.contents);

    if (body.action === 'submit')   return json(submitReport(body));
    if (body.action === 'status')   return json(lookupStatus(body.reportNo));
    if (body.action === 'addPlate') return json(addPlate(body.reportNo, body.plate));

    return json({ ok: false, error: 'Unknown action: ' + body.action });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

/** Visiting the URL in a browser just confirms the deployment is live. */
function doGet() {
  return json({ ok: true, service: 'WasteWise Connect', time: new Date().toISOString() });
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------------------------------------------------------------- reports */

/**
 * @param {{hotspot:string, problem:string, photo:string, plate:string}} body
 *        photo is base64 JPEG with no data: prefix.
 */
function submitReport(body) {
  var hotspot = String(body.hotspot || '').slice(0, 120);
  var problem = String(body.problem || '').slice(0, 120);
  var plate   = String(body.plate   || '').slice(0, 20);

  /* A gallery photo may be days old and from somewhere else, so management
     needs to see where it came from before sending anyone to look. */
  var source = body.source === 'gallery' ? 'Gallery' : 'Camera';
  var taken = parseTaken(body.takenAt);

  if (!hotspot || !problem) {
    return { ok: false, error: 'Missing hotspot or problem' };
  }

  /* Two residents can submit at the same moment; without the lock they would
     both read the same counter and collide on one report number. */
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    var props = PropertiesService.getScriptProperties();
    var reportNo = Number(props.getProperty('lastReportNo') || START_NUMBER) + 1;
    props.setProperty('lastReportNo', String(reportNo));

    var now = new Date();
    var photoUrl = '';
    var photoBlob = null;

    if (body.photo) {
      photoBlob = savePhoto(body.photo, reportNo, now);
      photoUrl = photoBlob.fileUrl;
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    sheet.appendRow([
      reportNo,
      now,
      hotspot,
      problem,
      photoUrl ? '=HYPERLINK("' + photoUrl + '","Open photo")' : '',
      plate,
      'New',
      '', '', '',
      taken,
      source
    ]);

    notifyTelegram(reportNo, hotspot, problem, plate,
                   photoBlob && photoBlob.blob, source, taken);

    return { ok: true, reportNo: reportNo, sentAt: now.toISOString() };
  } finally {
    lock.releaseLock();
  }
}

/** EXIF dates carry no timezone, so these land in the script's timezone. */
function parseTaken(value) {
  if (!value) return '';
  var d = new Date(value);
  return isNaN(d.getTime()) ? '' : d;
}

function savePhoto(base64, reportNo, when) {
  var props = PropertiesService.getScriptProperties();
  var folder = DriveApp.getFolderById(props.getProperty('folderId'));

  var stamp = Utilities.formatDate(when, Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  var name = 'report-' + reportNo + '-' + stamp + '.jpg';

  var blob = Utilities.newBlob(Utilities.base64Decode(base64), 'image/jpeg', name);
  var file = folder.createFile(blob);

  return { fileUrl: file.getUrl(), blob: blob };
}

/**
 * The resident is offered the plate step only after the report is already
 * filed, so the plate arrives in a second call and is written onto the
 * existing row.
 */
function addPlate(reportNo, plate) {
  var n = Number(reportNo);
  var p = String(plate || '').slice(0, 20).toUpperCase();
  if (!n || !p) return { ok: false, error: 'Need a report number and a plate' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  var last = sheet.getLastRow();
  if (last < 2) return { ok: false, error: 'Report not found' };

  var numbers = sheet.getRange(2, 1, last - 1, 1).getValues();

  for (var i = numbers.length - 1; i >= 0; i--) {
    if (Number(numbers[i][0]) !== n) continue;
    sheet.getRange(i + 2, 6).setValue(p);   /* column 6 = Vehicle plate */
    return { ok: true, reportNo: n, plate: p };
  }

  return { ok: false, error: 'Report not found' };
}

/* ----------------------------------------------------------------- status */

function lookupStatus(reportNo) {
  var n = Number(reportNo);
  if (!n) return { ok: false, error: 'No report number' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  var last = sheet.getLastRow();
  if (last < 2) return { ok: false, error: 'Report not found' };

  var rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();

  for (var i = rows.length - 1; i >= 0; i--) {
    if (Number(rows[i][0]) !== n) continue;

    return {
      ok: true,
      reportNo: n,
      sentAt: toIso(rows[i][1]),
      hotspot: rows[i][2],
      problem: rows[i][3],
      status: rows[i][6] || 'New',
      assignedTo: rows[i][7] || '',
      clearedAt: toIso(rows[i][8])
    };
  }

  return { ok: false, error: 'Report not found' };
}

function toIso(value) {
  if (!value) return '';
  return (value instanceof Date) ? value.toISOString() : String(value);
}

/* --------------------------------------------------------------- telegram */

/**
 * Posts the report into a Telegram group with the Block 6 management, so they
 * do not have to open anything. Photo bytes go straight to Telegram, which
 * means the Drive file can stay private.
 */
function notifyTelegram(reportNo, hotspot, problem, plate, blob, source, taken) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;

  var age = '';
  if (source === 'Gallery') {
    age = taken
      ? '\nFrom the gallery, taken ' +
        Utilities.formatDate(taken, Session.getScriptTimeZone(), 'd MMM, h:mm a')
      : '\nFrom the gallery — age unknown';
  }

  var caption =
    'Report no. ' + reportNo + '\n' +
    problem + '\n' +
    hotspot + age +
    (plate ? '\nVehicle: ' + plate + ' (read from photo, not verified)' : '');

  try {
    if (blob) {
      UrlFetchApp.fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendPhoto', {
        method: 'post',
        payload: { chat_id: TELEGRAM_CHAT_ID, caption: caption, photo: blob },
        muteHttpExceptions: true
      });
    } else {
      UrlFetchApp.fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
        method: 'post',
        payload: { chat_id: TELEGRAM_CHAT_ID, text: caption },
        muteHttpExceptions: true
      });
    }
  } catch (err) {
    /* A failed notification must never lose the report — the row is already
       written by this point. */
    console.error('Telegram failed: ' + err);
  }
}

/* ------------------------------------------------------------ maintenance */

/**
 * Optional. Add a weekly trigger for this and management gets a Monday summary.
 * Edit > Triggers > Add Trigger > weeklySummary > Time-driven > Week timer.
 */
function weeklySummary() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  var last = sheet.getLastRow();
  if (last < 2) return;

  var rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  var total = 0, cleared = 0;
  var byHotspot = {};

  rows.forEach(function (r) {
    var sentAt = r[1];
    if (!(sentAt instanceof Date) || sentAt < weekAgo) return;
    total++;
    if (String(r[6]) === 'Cleared') cleared++;
    var h = String(r[2] || 'Unknown');
    byHotspot[h] = (byHotspot[h] || 0) + 1;
  });

  var lines = Object.keys(byHotspot).sort(function (a, b) {
    return byHotspot[b] - byHotspot[a];
  }).map(function (h) {
    return '  ' + h + ': ' + byHotspot[h];
  });

  var text = 'WasteWise — last 7 days\n' +
    total + ' reports, ' + cleared + ' cleared\n' +
    (lines.length ? lines.join('\n') : '  no reports');

  UrlFetchApp.fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
    method: 'post',
    payload: { chat_id: TELEGRAM_CHAT_ID, text: text },
    muteHttpExceptions: true
  });
}
