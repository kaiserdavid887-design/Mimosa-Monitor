# Mimosa Monitor Web · version 0.2

A browser version of the Mimosa plant-care and electrical-recording science
project. **There is no Python installation or Mac launcher.** This app is ready
to try locally and contains the static files needed for GitHub Pages.

## Try it now — no account needed

1. Unzip `MimosaMonitorWeb.zip`.
2. Keep the whole `MimosaMonitorWeb` folder together.
3. Open **index.html** in Chrome. The demo starts automatically.

The demo needs no internet connection or installed packages. The HTML file loads
the JavaScript and stylesheet from the same folder. If you see a plain page with
no working controls, check that `app.js`, `core.js` and `styles.css` are next to
`index.html`. Open the actual extracted file, not its ZIP preview.

### First four things to try

1. **Dry soil** → wait about 6 seconds for a clearly labelled demo notice.
2. **Water** → wait about 3 seconds for a separate moisture-rise notice.
3. **Signal example** → an artificial peak and a manually triggered notice.
4. **Experiment** → wait 5 seconds for baseline, mark Touch or Sham, then wait
   10 seconds. Use **Stop & download** to save the complete recording as a ZIP.
   A **Save recording ZIP** link also appears above the tabs if your browser
   needs a direct click to save the file.

**Restart demo** starts a new recording; the previous recording remains in the
browser backup when storage is available. **Pause** closes the current session.
Changing timer, plant or calibration settings ends the old session so metadata
always matches the settings used for that recording.

## Put it on GitHub Pages

The app is prepared for GitHub, but no repository has been created or published
for you. These steps use GitHub's website; you do not need Git or GitHub Desktop.

1. Sign in to GitHub and create a repository named **mimosa-monitor**. A **public**
   repository works with GitHub Free. The source code and website will be public.
2. Open the repository and choose **uploading an existing file**, or
   **Add file → Upload files** if it already has files.
3. Upload these files **into the repository root**, then commit the changes:
   `index.html`, `styles.css`, `core.js`, `app.js`, and `icon.svg`.
   You can also add `README.md`, `tests/`, `package.json` and `firmware/` for the
   project source. Do not upload recordings or the ZIP as the website.
4. Open **Settings → Pages**.
5. Under **Build and deployment → Source**, select **Deploy from a branch**.
6. Select **main** and **/(root)**, then **Save**.
7. Once GitHub finishes publishing, use the website link shown on the Pages
   settings screen. It will normally look like
   `https://YOUR-USERNAME.github.io/mimosa-monitor/`.

Your sensor recordings are not uploaded by this app. They stay in this browser
or in the ZIP files you download. A GitHub Pages visit still contacts GitHub to
load the website; this is not an anonymous hosting service.

Official instructions:
- [What is GitHub Pages?](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [Configure a publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## What works now

- Care and Experiment tabs, shared connection and recording state.
- Artificial readings at a target of 20 samples/second, explicitly labelled.
- Electrical plots in raw **ADC counts**, with automatic display scaling.
- Dry-soil and sustained moisture-rise notices with separate reset thresholds
  and a cooldown to limit duplicate notices.
- Relative wetness from two calibration references, including either direction
  of the sensor output. References must be 0–1023 and at least 50 counts apart.
- Touch/sham capture: 5 seconds before the marker and 10 seconds after.
- Incomplete or gapped trials labelled **interrupted**.
- Browser backup about every 5 seconds when IndexedDB is available; previous
  recordings can be downloaded from the footer.
- One ZIP download containing samples, events, calibration, settings and trial
  CSV/JSON files. Every sample and trial identifies simulated or USB data.
- An optional Web Serial USB reader for the specified board protocol.
- In-app notices; optional desktop alerts requested only when you click Enable
  desktop alerts. Their availability depends on the browser and OS settings.

## Recording and notifications: the practical limits

**Keep this tab visible and your Mac awake.** Hiding the page pauses monitoring,
ends the recording and interrupts any active trial. This avoids claiming
continuous capture while the browser may throttle or suspend the page.
Opening a dialog inside the app does not hide the page.

GitHub Pages hosts the app files; it does not keep a sensor monitor running when
your browser or Mac is closed. This version has no phone push notifications,
email service, cloud sensor gateway or unattended background monitoring.

Browser storage is specific to the browser, device and website address. Opening
the local file and opening the hosted URL may use different backups. Private
browsing, storage limits, clearing website data, or browser settings may remove
or prevent backups. Download important recordings. A crash may lose data since
the last completed checkpoint; recovered sessions are labelled as recovered,
and any unfinished trial is exported as interrupted.

## USB — after the materials arrive

Use **desktop Chrome on your Mac**, preferably at the HTTPS GitHub Pages URL.
The browser must expose `navigator.serial`, the page must be a secure context,
and you must select the board and grant permission. This has not yet been tested
with your physical board, sensor, amplifier or Mac.

1. Confirm the actual board, pin mapping, ADC range, power supply, amplifier and
   sensor voltage compatibility before wiring. The supplied firmware targets a
   **classic 5 V Arduino Nano** with a **10-bit ADC**, not every board called Nano.
2. Upload `firmware/nano_capture/nano_capture.ino` with the appropriate Arduino
   tools and board settings. Firmware installation is separate from the website.
3. Close SpikeRecorder, Arduino Serial Monitor or other software using that
   serial port before connecting it in this app.
4. Click **Connect USB**, choose the board and approve access.
5. In **Settings**, add dry and wet moisture references from the same sensor
   and pot. The displayed index is relative, not volumetric water content or a
   plant-specific watering recommendation. Inspect the soil before watering.

The reader expects **115200 baud**, newline-terminated ASCII records:

```text
sample_ms,plant_adc,moisture_adc
50,512,580
100,513,581
```

The header is optional. The three fields must be unsigned integers. The two ADC
values must be 0–1023. The board timestamp must increase; normal 32-bit `millis()`
rollover is supported. Invalid or out-of-order lines are counted and rejected.
Five seconds without a valid record stops the session. Reconnect after a board
reset. The software does not automatically recognise SpikeRecorder's protocol
or make a plant electrode work without a suitable amplifier.

USB always uses the full design timers: wetness at or below 25% for 120 seconds
for the dry notice; above 40% for 120 seconds to rearm; a rise of at least 15
percentage points held for 30 seconds for a watering-rise notice. These are
prototype engineering thresholds and need experimental validation for the pot.
The short demo settings use 6-second dry/rearm and 3-second watering timers.

[Official Chrome Web Serial documentation](https://developer.chrome.com/docs/capabilities/serial)

## What still needs real research

**No AI model has been trained in this version.** The AI panel intentionally
says Awaiting real recordings and Not evaluated. Demo peaks and notices do not
represent AI detection. Completed demo trials are excluded from real-trial counts.

For the model stage, collect labelled touch and sham trials across separate
sessions/days, including cable-motion and electrical-interference controls. Keep
the final day's data separate for evaluation. A peak alone does not establish
touch, biological stress, damage, or a plant's need for water. Real electrical
signal quality, hardware compatibility, calibration and biological interpretation
remain unverified. The app is a recording foundation for the school project.

This changes the implementation in Criterion B from Python/Tkinter to browser
HTML/CSS/JavaScript, while retaining the Care/Experiment design. Update that
implementation description in the assignment when you adopt this version.

## Files and development

- `index.html`: structure and accessible controls.
- `styles.css`: responsive layout and visual design.
- `app.js`: UI, synthetic source, Web Serial, browser backup and downloads.
- `core.js`: care rules, calibration, parsing, trial recording and ZIP export.
- `tests/core.test.cjs`: meaningful automated logic checks using Node's built-in
  test runner. Node is optional and is **not required to run the app**.
- `firmware/`: optional future capture sketch.
- `TESTING.md`: exact verification scope and remaining limitations.

There are no runtime package downloads, API keys, remote scripts, fonts or
analytics in the app. If Node is installed, run the checks with:

```bash
node --test tests/core.test.cjs
```
