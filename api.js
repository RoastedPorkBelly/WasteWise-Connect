/**
 * api.js
 * Talks to the WasteWise Connect Apps Script backend.
 * WasteWise Connect — Desa Mentari Block 6.
 *
 *   <script src="api.js"></script>
 *   WasteWise.ENDPOINT = 'https://script.google.com/macros/s/AKfy.../exec';
 *
 * Two calls:
 *   const r = await WasteWise.submit({ hotspot, problem, file, plate });
 *   const s = await WasteWise.status(148);
 */
var WasteWise = (function () {
  'use strict';

  /* Paste your Apps Script web app URL here, or set WasteWise.ENDPOINT. */
  var ENDPOINT = '';

  /* Residents here are on mobile data and older phones. A raw phone photo is
     3–5 MB; at these settings the same photo lands around 250 KB, still clear
     enough for management to identify a bin bay or read a plate. */
  var MAX_EDGE = 1600;
  var QUALITY = 0.75;

  var TIMEOUT_MS = 45000;

  /* ------------------------------------------------------------- transport */

  /**
   * Apps Script web apps do not answer CORS preflight requests. Sending
   * "text/plain" keeps this a simple request, so the browser skips the
   * preflight and the POST goes straight through. The body is still JSON and
   * the backend still parses it as JSON.
   */
  function post(payload) {
    var url = WasteWise.ENDPOINT || ENDPOINT;
    if (!url) return Promise.reject(new Error('WasteWise.ENDPOINT is not set'));

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, TIMEOUT_MS) : null;

    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: controller ? controller.signal : undefined
    })
      .then(function (res) {
        if (timer) clearTimeout(timer);
        if (!res.ok) throw new Error('Server returned ' + res.status);
        return res.json();
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        if (err.name === 'AbortError') throw new Error('The connection timed out.');
        throw err;
      });
  }

  /* ----------------------------------------------------------- compression */

  function loadImage(file) {
    /* imageOrientation honours the EXIF rotation tag, so photos taken in
       portrait do not arrive sideways. */
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return loadViaObjectUrl(file); });
    }
    return loadViaObjectUrl(file);
  }

  function loadViaObjectUrl(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read that photo.')); };
      img.src = url;
    });
  }

  /**
   * Downscale to MAX_EDGE on the long side and re-encode as JPEG.
   * @returns {Promise<string>} base64 with no data: prefix
   */
  function compress(file, maxEdge, quality) {
    maxEdge = maxEdge || MAX_EDGE;
    quality = quality || QUALITY;

    return loadImage(file).then(function (img) {
      var w = img.width, h = img.height;
      var scale = Math.min(1, maxEdge / Math.max(w, h));

      var canvas = document.createElement('canvas');
      canvas.width  = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));

      var ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      if (img.close) img.close();

      var dataUrl = canvas.toDataURL('image/jpeg', quality);
      return dataUrl.slice(dataUrl.indexOf(',') + 1);
    });
  }

  /* -------------------------------------------------------- when was it taken */

  /**
   * Read DateTimeOriginal out of a JPEG's EXIF block.
   *
   * A photo chosen from the gallery might be from this morning or from last
   * month, and management needs to tell the difference before sending someone
   * to look. Resolves to '' when the photo carries no EXIF (screenshots,
   * stripped images, some chat apps), and never rejects — a missing timestamp
   * must not cost the resident their report.
   *
   * @returns {Promise<string>} "2026-11-24T08:42:11" or ''
   */
  function takenAt(file) {
    return new Promise(function (resolve) {
      if (!file || !/jpe?g/i.test(file.type)) return resolve('');

      var reader = new FileReader();
      reader.onload = function () {
        try {
          resolve(parseExifDate(new DataView(reader.result)));
        } catch (e) {
          resolve('');
        }
      };
      reader.onerror = function () { resolve(''); };
      /* EXIF sits near the front of the file, so 128 KB is plenty and we never
         read a 5 MB photo into memory twice. */
      reader.readAsArrayBuffer(file.slice(0, 131072));
    });
  }

  function parseExifDate(view) {
    if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return '';

    var offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xFF) break;

      var marker = view.getUint8(offset + 1);
      if (marker === 0xE1) return readExifSegment(view, offset + 4);
      if (marker === 0xDA) break;             /* start of scan: no metadata past here */

      var size = view.getUint16(offset + 2);
      if (size < 2) break;
      offset += 2 + size;
    }
    return '';
  }

  function readExifSegment(view, start) {
    if (start + 8 > view.byteLength) return '';
    if (view.getUint32(start) !== 0x45786966) return '';   /* "Exif" */

    var tiff = start + 6;
    var little = view.getUint16(tiff) === 0x4949;          /* "II" = little-endian */
    if (view.getUint32(tiff + 4, little) !== 8) return '';

    var dir = tiff + 8;
    var count = view.getUint16(dir, little);

    for (var i = 0; i < count; i++) {
      var entry = dir + 2 + i * 12;
      if (entry + 12 > view.byteLength) break;

      /* 0x8769 is the pointer to the Exif sub-IFD, where the dates live. */
      if (view.getUint16(entry, little) !== 0x8769) continue;

      var sub = tiff + view.getUint32(entry + 8, little);
      if (sub + 2 > view.byteLength) return '';
      var subCount = view.getUint16(sub, little);

      for (var j = 0; j < subCount; j++) {
        var e = sub + 2 + j * 12;
        if (e + 12 > view.byteLength) break;

        var tag = view.getUint16(e, little);
        if (tag !== 0x9003 && tag !== 0x9004) continue;    /* Original / Digitized */

        var at = tiff + view.getUint32(e + 8, little);
        if (at + 19 > view.byteLength) return '';

        var text = '';
        for (var k = 0; k < 19; k++) text += String.fromCharCode(view.getUint8(at + k));
        return normaliseExifDate(text);
      }
    }
    return '';
  }

  /** EXIF writes "2026:11:24 08:42:11"; everything else expects ISO. */
  function normaliseExifDate(text) {
    var m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text);
    if (!m) return '';
    if (m[1] === '0000') return '';
    return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6];
  }

  /* ---------------------------------------------------------------- public */

  /**
   * @param {{hotspot:string, problem:string, file?:File, plate?:string,
   *          source?:'camera'|'gallery'}} report
   * @returns {Promise<{ok:boolean, reportNo?:number, error?:string}>}
   */
  function submit(report) {
    if (!report || !report.hotspot || !report.problem) {
      return Promise.reject(new Error('hotspot and problem are required'));
    }

    var steps = report.file
      ? [compress(report.file), takenAt(report.file)]
      : [Promise.resolve(''), Promise.resolve('')];

    return Promise.all(steps).then(function (out) {
      return post({
        action: 'submit',
        hotspot: report.hotspot,
        problem: report.problem,
        plate: report.plate || '',
        photo: out[0],
        source: report.source === 'gallery' ? 'gallery' : 'camera',
        takenAt: out[1]
      });
    });
  }

  function status(reportNo) {
    return post({ action: 'status', reportNo: Number(reportNo) });
  }

  /** Attach a plate to a report that has already been sent. */
  function addPlate(reportNo, plate) {
    return post({ action: 'addPlate', reportNo: Number(reportNo), plate: String(plate || '') });
  }

  /* Remember the resident's own report numbers so "Check your report" works
     without an account. Wrapped because storage throws in private windows. */
  function remember(reportNo) {
    try {
      var list = mine();
      if (list.indexOf(reportNo) === -1) {
        list.push(reportNo);
        localStorage.setItem('ww.reports', JSON.stringify(list.slice(-10)));
      }
    } catch (e) { /* no storage, status lookup just will not prefill */ }
  }

  function mine() {
    try {
      return JSON.parse(localStorage.getItem('ww.reports') || '[]');
    } catch (e) {
      return [];
    }
  }

  return {
    ENDPOINT: ENDPOINT,
    submit: submit,
    status: status,
    addPlate: addPlate,
    compress: compress,
    takenAt: takenAt,
    remember: remember,
    mine: mine
  };
})();


/* =======================================================================
   WIRING IT INTO THE REPORT PAGE

   The hotspot comes from the QR code, not from the resident. Give each
   sticker its own query string:

     https://yourname.github.io/wastewise/?h=TP-01

   const params  = new URLSearchParams(location.search);
   const HOTSPOT = ({
     'TP-01': 'Main Bin Area',
     'TP-02': 'Stairwell 6A',
     'TP-03': 'Back Lane',
     'TP-04': 'Carpark Edge',
     'TP-05': 'Level 3 Corridor'
   })[params.get('h')] || 'Block 6';

   Then on Send:

   sendBtn.addEventListener('click', async () => {
     sendBtn.disabled = true;
     showSending();

     try {
       const res = await WasteWise.submit({
         hotspot: HOTSPOT,
         problem: chosenProblem,       // "Bin is full" etc.
         file:    photoInput.files[0],
         plate:   plateResult?.plate || ''
       });

       if (res.ok) {
         WasteWise.remember(res.reportNo);
         showDone(res.reportNo);
       } else {
         showError(res.error);
       }
     } catch (err) {
       showError('No connection. Your photo is still on your phone — try again later.');
       sendBtn.disabled = false;
     }
   });

   Three things worth keeping:

   1. Compress before upload, always. An uncompressed photo on 3G in Desa
      Mentari is a 30-second wait and a resident who gives up.

   2. Never show a raw server error to a resident. "No connection, try again"
      is the whole message they need.

   3. The plate is optional in every sense — if OCR failed, send the report
      with an empty plate rather than blocking on it.
   ======================================================================= */
