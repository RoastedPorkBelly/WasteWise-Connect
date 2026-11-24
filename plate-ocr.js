/**
 * plate-ocr.js
 * Malaysian number-plate recognition with Tesseract.js.
 * WasteWise Connect — Desa Mentari Block 6.
 *
 * Everything here runs on the resident's phone. The photo never leaves the
 * device; only the recognised plate string is sent with the report.
 *
 * Load Tesseract before this file:
 *   <script src="https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js"></script>
 *   <script src="plate-ocr.js"></script>
 *
 * Minimal use:
 *   const img    = await PlateOCR.fileToImage(fileInput.files[0]);
 *   const result = await PlateOCR.read(img);
 *   // { ok: true, plate: "WXY 1234", confidence: 87, corrections: 1, raw: "WXY1Z34" }
 *
 * Call PlateOCR.dispose() when the user leaves the reporting flow — the
 * worker holds about 30 MB.
 */
var PlateOCR = (function () {
  'use strict';

  /* The guide box drawn on the camera screen sits at 78% width, 3:1, centred
     in a 4:3 frame. These fractions match it with a little padding, so we only
     ever run OCR on the plate instead of the whole street. */
  var DEFAULT_CROP = { x: 0.08, y: 0.30, w: 0.84, h: 0.40 };
  var DEFAULT_MIN_CONFIDENCE = 60;
  var UPSCALE = 2;

  /* Malaysian plates run letters-then-digits, so the same misread can be
     resolved by position: "0" is an O in the letter group and a zero in the
     digit group. */
  var AS_LETTER = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '6': 'G', '8': 'B' };
  var AS_DIGIT  = { 'O': '0', 'Q': '0', 'D': '0', 'I': '1', 'L': '1', 'Z': '2',
                    'S': '5', 'G': '6', 'B': '8' };

  var workerPromise = null;

  /* ---------------------------------------------------------------- worker */

  function getWorker(logger) {
    if (!workerPromise) {
      workerPromise = Tesseract.createWorker('eng', 1, logger ? { logger: logger } : undefined)
        .then(function (worker) {
          return worker.setParameters({
            /* Plates are uppercase alphanumerics only. Narrowing the charset
               is the single biggest accuracy win available here. */
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
            /* PSM 7: treat the crop as one line of text. */
            tessedit_pageseg_mode: '7'
          }).then(function () { return worker; });
        })
        .catch(function (err) {
          workerPromise = null;
          throw err;
        });
    }
    return workerPromise;
  }

  function dispose() {
    if (!workerPromise) return Promise.resolve();
    var p = workerPromise;
    workerPromise = null;
    return p.then(function (w) { return w.terminate(); }).catch(function () {});
  }

  /* ---------------------------------------------------------- preprocessing */

  function sourceSize(src) {
    if (src.naturalWidth) return { w: src.naturalWidth, h: src.naturalHeight };
    if (src.videoWidth)   return { w: src.videoWidth,   h: src.videoHeight };
    return { w: src.width, h: src.height };
  }

  /**
   * Crop to the guide box, upscale, convert to greyscale and stretch the
   * contrast so the full 0–255 range is used. Phone photos of plates are
   * usually low-contrast and slightly small for Tesseract; this fixes both.
   */
  function preprocess(source, crop, scale) {
    var size = sourceSize(source);
    var sx = Math.round(size.w * crop.x);
    var sy = Math.round(size.h * crop.y);
    var sw = Math.round(size.w * crop.w);
    var sh = Math.round(size.h * crop.h);

    var canvas = document.createElement('canvas');
    canvas.width  = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));

    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

    var image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var px = image.data;
    var grey = new Uint8ClampedArray(px.length / 4);
    var min = 255, max = 0;

    for (var i = 0, j = 0; i < px.length; i += 4, j++) {
      var v = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
      grey[j] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }

    var range = Math.max(1, max - min);
    for (var k = 0, m = 0; k < px.length; k += 4, m++) {
      var s = ((grey[m] - min) * 255 / range) | 0;
      px[k] = px[k + 1] = px[k + 2] = s;
    }

    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  /* ---------------------------------------------------------------- parsing */

  /**
   * Turn raw OCR text into a Malaysian plate.
   * Tries every plausible split between the letter group (1–3) and the digit
   * group (1–4), with an optional trailing letter, and keeps whichever needs
   * the fewest character corrections.
   */
  function parsePlate(rawText, confidence) {
    var conf = Math.round(confidence || 0);
    var s = String(rawText || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

    if (s.length < 2 || s.length > 8) {
      return { ok: false, confidence: conf, raw: rawText };
    }

    var best = null;

    for (var tail = 0; tail <= 1; tail++) {
      for (var n = 1; n <= 3; n++) {
        var digitCount = s.length - n - tail;
        if (digitCount < 1 || digitCount > 4) continue;

        var fixes = 0;
        var bad = false;
        var letters = '';
        var digits = '';
        var suffix = '';
        var c, idx;

        for (idx = 0; idx < n; idx++) {
          c = s.charAt(idx);
          if (c >= '0' && c <= '9') {
            if (!AS_LETTER[c]) { bad = true; break; }
            c = AS_LETTER[c];
            fixes++;
          }
          letters += c;
        }
        if (bad) continue;

        for (idx = n; idx < n + digitCount; idx++) {
          c = s.charAt(idx);
          if (c >= 'A' && c <= 'Z') {
            if (!AS_DIGIT[c]) { bad = true; break; }
            c = AS_DIGIT[c];
            fixes++;
          }
          digits += c;
        }
        if (bad) continue;

        if (tail) {
          c = s.charAt(s.length - 1);
          if (c >= '0' && c <= '9') {
            if (!AS_LETTER[c]) continue;
            c = AS_LETTER[c];
            fixes++;
          }
          suffix = c;
        }

        if (best === null || fixes < best.fixes) {
          best = { fixes: fixes, plate: letters + ' ' + digits + suffix };
        }
      }
    }

    if (!best) return { ok: false, confidence: conf, raw: rawText };

    return {
      ok: true,
      plate: best.plate,
      corrections: best.fixes,
      confidence: conf,
      raw: rawText
    };
  }

  /* ------------------------------------------------------------------- read */

  /**
   * @param {HTMLImageElement|HTMLVideoElement|HTMLCanvasElement} source
   * @param {object} [options] crop, scale, minConfidence, logger
   * @returns {Promise<{ok, plate?, confidence, corrections?, raw, canvas}>}
   */
  function read(source, options) {
    var opts = options || {};
    var crop = opts.crop || DEFAULT_CROP;
    var floor = opts.minConfidence == null ? DEFAULT_MIN_CONFIDENCE : opts.minConfidence;
    var canvas;

    try {
      canvas = preprocess(source, crop, opts.scale || UPSCALE);
    } catch (err) {
      return Promise.reject(err);
    }

    return getWorker(opts.logger)
      .then(function (worker) { return worker.recognize(canvas); })
      .then(function (out) {
        var parsed = parsePlate(out.data.text, out.data.confidence);
        parsed.canvas = canvas;

        /* Below the floor we deliberately return ok:false rather than a guess.
           A wrong plate on a dumping report is worse than no plate — the photo
           still reaches management, who can read it themselves. */
        if (parsed.ok && parsed.confidence < floor) {
          return {
            ok: false, confidence: parsed.confidence,
            raw: parsed.raw, canvas: canvas, reason: 'low-confidence'
          };
        }
        return parsed;
      });
  }

  /* ---------------------------------------------------------------- helpers */

  /** Turn a file from <input type="file" capture="environment"> into an <img>. */
  function fileToImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read that photo.')); };
      img.src = url;
    });
  }

  /** Preload the worker while the resident is still aiming the camera. */
  function warmUp() {
    return getWorker().then(function () { return true; }).catch(function () { return false; });
  }

  return {
    read: read,
    parsePlate: parsePlate,
    preprocess: preprocess,
    fileToImage: fileToImage,
    warmUp: warmUp,
    dispose: dispose,
    DEFAULT_CROP: DEFAULT_CROP
  };
})();


/* =======================================================================
   WIRING IT INTO THE REPORT PAGE

   <input type="file" accept="image/*" capture="environment" id="plateInput" hidden>
   <button id="shootPlate">Tap here</button>

   document.getElementById('shootPlate').addEventListener('click', function () {
     PlateOCR.warmUp();                       // starts the ~2 MB download early
     document.getElementById('plateInput').click();
   });

   document.getElementById('plateInput').addEventListener('change', async function (e) {
     const file = e.target.files[0];
     if (!file) return;

     showReadingState();

     try {
       const img = await PlateOCR.fileToImage(file);
       const r   = await PlateOCR.read(img, {
         logger: m => console.log(m.status, m.progress)
       });

       if (r.ok) {
         showPlate(r.plate, r.confidence);    // never as confirmed — see below
       } else {
         showUnreadable();                    // photo still goes with the report
       }
     } catch (err) {
       showUnreadable();                      // offline, or Tesseract failed to load
     }
   });

   Two rules worth keeping when you write the submit handler:

   1. Send the photo with the report whether or not OCR succeeded. The photo is
      the evidence; the plate string is only an index that lets management group
      repeat offenders.

   2. Never display the plate to the resident as confirmed, and never show
      another resident's plate at all. Label it "read from photo, not verified"
      and keep it visible to management only. Under the PDPA 2010 the plate is
      personal data once it is tied to a person, so management — not your group —
      must be the party holding it, with a stated retention period.
   ======================================================================= */
