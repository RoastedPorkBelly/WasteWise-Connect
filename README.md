# WasteWise Connect — setup

Desa Mentari Block 6. Everything below is free on a personal Google account.
No credit card, no hosting bill, no server.

## What the pieces do

| File | Runs where | Job |
|---|---|---|
| `index.html` | GitHub Pages | The real page a resident gets from the QR code |
| `api.js` | Resident's phone | Compresses the photo, posts the report |
| `plate-ocr.js` | Resident's phone | Optional number-plate read |
| `Code.gs` | Google Apps Script | Saves the report, notifies management |
| Google Sheet | Google | The database **and** the management dashboard |
| Drive folder | Google | Photo storage |
| `wastewise-connect.html` | Anywhere | Demo for the tutorial — simulated, needs no backend |

`index.html` is the one you deploy. `wastewise-connect.html` is the walkthrough
version for presenting: it fakes the camera and the plate read so it works on a
laptop with no internet, and it talks to nothing.

Management does not get an app. They get a Sheet and a Telegram group, both of
which they already know how to use.

---

## 1. Create the Sheet and the script

1. Go to **sheets.new** and name it `WasteWise Connect`.
2. **Extensions → Apps Script**. Delete the sample code.
3. Paste in all of `Code.gs` and save.
4. In the function dropdown pick **setup**, then **Run**.
5. Google will ask for permissions — approve them. You will see an
   "unverified app" warning because you are the developer; click **Advanced →
   Go to (project name)**. This is normal for your own script.

You should now have a `Reports` tab with headers, a Status dropdown, and a
`WasteWise Photos` folder in your Drive.

---

## 2. Deploy it as a web app

1. **Deploy → New deployment → Web app**.
2. Set these exactly:
   - **Execute as:** Me
   - **Who has access:** **Anyone**
3. **Deploy**, then copy the **Web app URL**. It looks like
   `https://script.google.com/macros/s/AKfy…/exec`.

"Anyone" is what lets residents submit without a Google account. It does not
give anyone access to your Sheet — only to the two actions in `doPost`.

> **The trap that catches everyone:** after you edit `Code.gs`, the old code
> keeps serving until you deploy again. Use **Deploy → Manage deployments →
> edit (pencil) → Version: New version → Deploy**. Creating a brand-new
> deployment instead gives you a different URL, which means re-printing your
> stickers.

Paste the URL into `index.html`, at the line marked
`1. PASTE YOUR APPS SCRIPT WEB APP URL HERE`. Until you do, the page shows a red
banner at the top saying so, and reports cannot be sent.

The hotspot list is right below it, at marker 2 — edit the five names to match
your actual stickers.

---

## 3. Put the page online

1. Create a GitHub repo called `wastewise`.
2. Upload **`index.html`**, `api.js` and `plate-ocr.js` — all three in the
   repo root, since the page loads the other two by relative path.
3. **Settings → Pages → Branch: main, folder: / (root) → Save**.
4. After a minute the page is live at
   `https://<your-username>.github.io/wastewise/`.

---

## 4. Give each hotspot its own QR code

The point of the QR sticker is that the resident never names a location. Each
sticker carries its hotspot in the URL:

```
https://<your-username>.github.io/wastewise/?h=TP-01   Main Bin Area
https://<your-username>.github.io/wastewise/?h=TP-02   Stairwell 6A
https://<your-username>.github.io/wastewise/?h=TP-03   Back Lane
https://<your-username>.github.io/wastewise/?h=TP-04   Carpark Edge
https://<your-username>.github.io/wastewise/?h=TP-05   Level 3 Corridor
```

Generate five QR codes from those five URLs with any free generator.

**Point them at a URL you control.** Because the destination is your own
GitHub Pages address, you can change the page, move the backend, or rename
things later without reprinting a single sticker. Free "dynamic QR" services
that promise the same thing usually start charging, and then your stickers
point at a dead link.

---

## 5. Telegram alerts (optional, 5 minutes)

This is the part that actually makes management's life easier — the report
lands in a chat they already check instead of a dashboard they have to open.

1. In Telegram, message **@BotFather** → `/newbot` → follow the prompts.
2. Copy the token it gives you into `TELEGRAM_TOKEN` in `Code.gs`.
3. Create a group with the Block 6 management and add your bot to it.
4. Send any message in the group, then open:
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
5. Find `"chat":{"id":-100…}` and put that number in `TELEGRAM_CHAT_ID`.
   Group IDs are negative — keep the minus sign.
6. Redeploy (see the trap in step 2).

For a Monday morning summary, add a trigger: in the Apps Script editor go to
**Triggers → Add Trigger → `weeklySummary` → Time-driven → Week timer**.

---

## 6. How management uses it

Working out of the Sheet, they only ever touch two columns:

- **Status** — a dropdown: New → Received → Assigned → Cleared
- **Assigned to** — who is doing it

Two columns they only read, both about the photo:

- **Photo from** — `Camera` means taken in the app just now. `Gallery` means
  chosen from the phone's photo roll, so it could be from any time or place.
- **Photo taken** — the photo's own EXIF timestamp, when it has one. A gallery
  photo with no timestamp here deserves more scepticism than one dated this
  morning.

> If you already ran `setup()` before these two columns existed, either add
> `Photo taken` and `Photo from` as columns K and L by hand, or clear the sheet
> and run `setup()` again. Add them at the **end** — `addPlate()` writes the
> plate to column 6 by position, so inserting a column earlier would put plates
> in the wrong place.

The resident's "Check your report" screen reads those straight back, which is
what closes the loop. No separate dashboard exists, and that is deliberate:
one fewer thing for anyone to learn, and one fewer thing for you to maintain
after the project ends.

For charts, connect the Sheet to **Looker Studio** (free) — reports per week,
reports per hotspot, median time to clear.

---

## Testing before you go to site

1. Open the deployed web app URL in a browser. You should see
   `{"ok":true,"service":"WasteWise Connect",…}`. If not, the deployment is
   wrong — recheck step 2.
2. Open your GitHub Pages URL with `?h=TP-01` on your own phone and send a
   real report. A row should appear in the Sheet within a few seconds, with a
   working photo link.
3. Check the Sheet's **Status** dropdown changes are picked up by the resident
   status screen.
4. Turn on airplane mode and try to send. You should get the "No connection"
   message, not a blank screen or a browser error.

Do this on a phone over mobile data, not on campus wifi. The upload path is
the part most likely to disappoint at Desa Mentari.

---

## Quotas

On a free personal account, per day:

- **URL Fetch calls:** 20,000
- **Script runtime:** 90 minutes total
- **Drive storage:** 15 GB shared across your account

At your target of 50 residents and roughly one report per hotspot per week,
you are using well under 1% of any of these. Compressed photos are about
250 KB, so 15 GB holds roughly 60,000 reports.

---

## Before you collect a single plate

The vehicle plate feature is the one part with a legal dimension. Under the
**PDPA 2010**, a plate becomes personal data once it is tied to a person.

- The Sheet must be owned by **Block 6 management**, not by your student group
- Agree a retention period in writing before you deploy — 90 days is defensible
- Plates are visible to management only, never shown back to residents
- Management acts on the **photo**; the plate string only groups repeat reports

Get this agreed with the community leaders at the same time you ask permission
to install the stickers. It is one conversation, and it is much harder to have
after you have already started collecting.
