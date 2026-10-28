/**
 * Drive REST fidelity probe — run once in the STAGING Apps Script project.
 *
 *     Paste below Code.gs, select runFidelityProbe, Run, then copy the whole
 *     execution log back.
 *
 * WHY THIS EXISTS
 *
 * Stage 2 of 1.4 replaces sequential DriveApp reads with batched Drive REST
 * calls over UrlFetchApp, and the test harness will grow a fake of that API.
 * A fake is a *hypothesis about Google*, and stages 2 and 6 are built on it —
 * so tests passing against a wrong fake are worse than no tests at all.
 *
 * Every expectation below is written down BEFORE being measured, on purpose.
 * Reading the answer first and then writing the expectation produces a fake
 * that agrees with whatever happened to be observed, including the accidents.
 *
 * THE EXPECTATIONS, one line each
 *
 *   E1  ScriptApp.getOAuthToken() is accepted by Drive REST v3 as a Bearer token.
 *   E2  The scopes DriveApp already forces cover files.list and alt=media,
 *       so no manifest change and NO RE-CONSENT by any detachment.
 *   E3  files.list with "'<id>' in parents and trashed=false" returns children.
 *   E4  pageSize caps at 1000; more than that needs nextPageToken paging.
 *   E5  fields=files(id,name),nextPageToken returns only those, and is smaller.
 *   E6  A single quote in a name must be escaped \' inside q; a backslash \\.
 *   E7  files/{id}?alt=media returns the raw body, not a JSON wrapper.
 *   E8  UrlFetchApp.fetchAll issues concurrently and preserves request order.
 *   E9  fetchAll survives a batch the size of a real detachment (~130).
 *   E10 Rate limiting is 403 with error.errors[0].reason rateLimitExceeded,
 *       or 429 — we need to know which, to retry correctly.
 *   E11 A missing file is 404 with a parseable JSON error body.
 *   E12 muteHttpExceptions:true is REQUIRED or UrlFetchApp throws on non-2xx.
 *   E13 supportsAllDrives is unnecessary for a My Drive folder.
 *
 * SAFETY
 *
 * Read-only against your data. It creates two probe files with awkward names
 * in a PROBE subfolder and trashes the whole subfolder at the end, in a
 * finally block. It never writes to or trashes anything else.
 */

var FP_API = 'https://www.googleapis.com/drive/v3/';

function fp_(label, value) { Logger.log(label + ': ' + value); }

function fp_get_(url, opts) {
  var o = opts || {};
  o.headers = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
  if (o.mute !== false) o.muteHttpExceptions = true;
  return UrlFetchApp.fetch(url, o);
}

function runFidelityProbe() {
  var props = PropertiesService.getScriptProperties();
  var root = props.getProperty('FOLDER_ID');
  if (!root) { Logger.log('NO FOLDER_ID in Script Properties — stop.'); return; }

  Logger.log('=== Drive REST fidelity probe ===');
  fp_('root folder', root);

  var probe = null;
  try {
    // ---- E1 / E2 : token and scope -------------------------------------
    var r = fp_get_(FP_API + 'files/' + root + '?fields=id,name,mimeType');
    fp_('E1 token accepted (expect 200)', r.getResponseCode());
    fp_('E2 scope sufficient, no re-consent', r.getResponseCode() === 200 ? 'YES' : 'NO -> ' + r.getContentText().slice(0, 200));

    // ---- E3 : listing children ------------------------------------------
    var q = encodeURIComponent("'" + root + "' in parents and trashed=false");
    var list = fp_get_(FP_API + 'files?q=' + q + '&fields=' + encodeURIComponent('files(id,name),nextPageToken') + '&pageSize=1000');
    fp_('E3 list code', list.getResponseCode());
    var body = JSON.parse(list.getContentText());
    fp_('E3 children found', (body.files || []).length);
    fp_('E5 first child shape', JSON.stringify((body.files || [])[0] || null));
    fp_('E5 extra keys present?', Object.keys((body.files || [])[0] || {}).join(',') + '  (want exactly id,name)');

    // ---- E4 : paging ------------------------------------------------------
    var tiny = fp_get_(FP_API + 'files?q=' + q + '&pageSize=2&fields=' + encodeURIComponent('files(id),nextPageToken'));
    var tinyBody = JSON.parse(tiny.getContentText());
    fp_('E4 pageSize=2 returned', (tinyBody.files || []).length);
    fp_('E4 nextPageToken present', tinyBody.nextPageToken ? 'YES' : 'no (folder may be small)');
    var over = fp_get_(FP_API + 'files?q=' + q + '&pageSize=2000&fields=' + encodeURIComponent('files(id)'));
    fp_('E4 pageSize=2000 code (expect 400)', over.getResponseCode());
    fp_('E4 pageSize=2000 says', over.getContentText().slice(0, 160));

    // ---- E6 : quoting ------------------------------------------------------
    probe = DriveApp.getFolderById(root).createFolder('FIDELITY-PROBE-DELETE-ME');
    var awkward = "o'brien \\ \"quoted\".json";
    probe.createFile(awkward, '{"probe":true}');
    probe.createFile('plain.json', '{"probe":true}');
    var pid = probe.getId();

    var escaped = awkward.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    var q6 = encodeURIComponent("'" + pid + "' in parents and name = '" + escaped + "' and trashed=false");
    var hit = fp_get_(FP_API + 'files?q=' + q6 + '&fields=' + encodeURIComponent('files(id,name)'));
    fp_('E6 escaped-name lookup code', hit.getResponseCode());
    fp_('E6 matched', JSON.stringify(JSON.parse(hit.getContentText()).files || []));

    var q6bad = encodeURIComponent("'" + pid + "' in parents and name = '" + awkward + "' and trashed=false");
    var bad = fp_get_(FP_API + 'files?q=' + q6bad);
    fp_('E6 UNescaped code (expect 400)', bad.getResponseCode());

    // ---- E7 : content ------------------------------------------------------
    var kids = JSON.parse(fp_get_(FP_API + 'files?q=' + encodeURIComponent("'" + pid + "' in parents and trashed=false") + '&fields=' + encodeURIComponent('files(id,name)')).getContentText()).files;
    var media = fp_get_(FP_API + 'files/' + kids[0].id + '?alt=media');
    fp_('E7 alt=media code', media.getResponseCode());
    fp_('E7 raw body', media.getContentText());

    // ---- E8 / E9 : fetchAll -----------------------------------------------
    var token = ScriptApp.getOAuthToken();
    var reqs = [];
    for (var i = 0; i < 60; i++) {
      reqs.push({
        url: FP_API + 'files/' + kids[i % kids.length].id + '?alt=media',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true
      });
    }
    var began = new Date().getTime();
    var all = UrlFetchApp.fetchAll(reqs);
    var took = new Date().getTime() - began;
    fp_('E8/E9 fetchAll count', all.length);
    fp_('E8/E9 fetchAll ms for ' + reqs.length, took);
    fp_('E8/E9 per request ms', Math.round(took / reqs.length));
    fp_('E8 order preserved', all[0].getResponseCode() + ' ... ' + all[all.length - 1].getResponseCode());

    // Sequential comparison, the number stage 2 has to beat.
    var seqBegan = new Date().getTime();
    for (var j = 0; j < 10; j++) fp_get_(FP_API + 'files/' + kids[j % kids.length].id + '?alt=media');
    var seqTook = new Date().getTime() - seqBegan;
    fp_('BASELINE sequential ms for 10', seqTook);
    fp_('BASELINE sequential per read ms', Math.round(seqTook / 10));

    // ---- E11 / E12 : errors -------------------------------------------------
    var missing = fp_get_(FP_API + 'files/definitelyNotARealFileId0000?alt=media');
    fp_('E11 missing code', missing.getResponseCode());
    fp_('E11 missing body', missing.getContentText().slice(0, 300));
    try {
      fp_get_(FP_API + 'files/definitelyNotARealFileId0000?alt=media', { mute: false });
      fp_('E12 without muteHttpExceptions', 'did NOT throw');
    } catch (e) {
      fp_('E12 without muteHttpExceptions', 'threw: ' + String(e).slice(0, 120));
    }

    // ---- E13 : shared drives -------------------------------------------------
    var noFlag = fp_get_(FP_API + 'files?q=' + q + '&fields=' + encodeURIComponent('files(id)'));
    var withFlag = fp_get_(FP_API + 'files?q=' + q + '&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=' + encodeURIComponent('files(id)'));
    fp_('E13 without flags', (JSON.parse(noFlag.getContentText()).files || []).length);
    fp_('E13 with flags', (JSON.parse(withFlag.getContentText()).files || []).length);

    Logger.log('=== probe complete ===');
  } catch (err) {
    Logger.log('PROBE THREW: ' + String(err));
  } finally {
    if (probe) { probe.setTrashed(true); Logger.log('probe folder trashed'); }
  }
}

/**
 * Second pass: the same questions against REAL documents.
 *
 * The first probe measured fetchAll against two 14-byte files in a folder it
 * had just created, so Drive served most of it from cache and the 54 ms figure
 * meant nothing. This walks the detachment's actual tree and measures distinct
 * documents of real size, which is the only number stage 2 can be judged on.
 *
 * Read-only. Creates nothing, trashes nothing.
 */
function runFidelityProbe2() {
  var root = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  Logger.log('=== fidelity pass 2: real documents ===');
  fp_('root folder', root);

  // Walk the tree for real .json documents, breadth-first, capped.
  var ids = [], queue = [root], guard = 0;
  while (queue.length && ids.length < 400 && guard++ < 200) {
    var parent = queue.shift();
    var page = null;
    do {
      var url = 'https://www.googleapis.com/drive/v3/files?q='
        + encodeURIComponent("'" + parent + "' in parents and trashed=false")
        + '&pageSize=1000&fields=' + encodeURIComponent('files(id,name,mimeType,size),nextPageToken')
        + (page ? '&pageToken=' + page : '');
      var res = fp_get_(url);
      if (res.getResponseCode() !== 200) { fp_('walk failed at ' + parent, res.getContentText().slice(0,120)); break; }
      var body = JSON.parse(res.getContentText());
      var rows = body.files || [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].mimeType === 'application/vnd.google-apps.folder') queue.push(rows[i].id);
        else ids.push({ id: rows[i].id, name: rows[i].name, size: Number(rows[i].size || 0) });
      }
      page = body.nextPageToken || null;
    } while (page);
  }

  fp_('documents found', ids.length);
  if (!ids.length) { Logger.log('STILL EMPTY — FOLDER_ID is not the app\'s folder.'); return; }

  var total = 0;
  for (var k = 0; k < ids.length; k++) total += ids[k].size;
  fp_('mean document bytes', Math.round(total / ids.length));
  fp_('largest document bytes', Math.max.apply(null, ids.map(function (d) { return d.size; })));

  // E4 paging, now that folders actually have children.
  var pg = fp_get_('https://www.googleapis.com/drive/v3/files?q='
    + encodeURIComponent("'" + root + "' in parents and trashed=false")
    + '&pageSize=1&fields=' + encodeURIComponent('files(id),nextPageToken'));
  var pgBody = JSON.parse(pg.getContentText());
  fp_('E4 pageSize=1 nextPageToken', pgBody.nextPageToken ? 'PRESENT' : 'absent');

  var token = ScriptApp.getOAuthToken();
  var N = Math.min(ids.length, 130);

  // Sequential, on DISTINCT documents.
  var t0 = new Date().getTime();
  for (var a = 0; a < Math.min(10, N); a++) {
    fp_get_('https://www.googleapis.com/drive/v3/files/' + ids[a].id + '?alt=media');
  }
  var seq = new Date().getTime() - t0;
  fp_('SEQUENTIAL ms for ' + Math.min(10, N), seq);
  fp_('SEQUENTIAL per read ms', Math.round(seq / Math.min(10, N)));

  // fetchAll, on DISTINCT documents, at detachment scale.
  var reqs = [];
  for (var b = 0; b < N; b++) {
    reqs.push({ url: 'https://www.googleapis.com/drive/v3/files/' + ids[b].id + '?alt=media',
                headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  }
  var t1 = new Date().getTime();
  var all = UrlFetchApp.fetchAll(reqs);
  var par = new Date().getTime() - t1;

  var ok = 0, bytes = 0, codes = {};
  for (var c = 0; c < all.length; c++) {
    var code = all[c].getResponseCode();
    codes[code] = (codes[code] || 0) + 1;
    if (code === 200) { ok++; bytes += all[c].getContentText().length; }
  }
  fp_('FETCHALL distinct documents', N);
  fp_('FETCHALL total ms', par);
  fp_('FETCHALL per document ms', Math.round(par / N));
  fp_('FETCHALL response codes', JSON.stringify(codes));
  fp_('FETCHALL bytes returned', bytes);
  fp_('SPEEDUP vs sequential', (Math.round(seq / Math.min(10, N)) / Math.round(par / N)).toFixed(1) + 'x');
  fp_('PROJECTED allResponses at ' + N + ' docs', 'sequential ' + Math.round((seq / Math.min(10, N)) * N / 1000)
    + 's  vs  fetchAll ' + Math.round(par / 1000) + 's  (+~2s fixed)');
  Logger.log('=== pass 2 complete ===');
}
