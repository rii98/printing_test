# Windows: Full installation from scratch

Set up `print-agent` on a fresh Windows machine, from nothing installed to an
always-on service that auto-starts at boot and prints to the thermal printer(s).

Follow the sections in order. Steps 1–6 get it running by hand; step 7 makes it
survive reboots (that's a separate, more detailed runbook:
[`WINDOWS_PM2_SERVICE.md`](WINDOWS_PM2_SERVICE.md)).

> Tested on Windows 8.1 / Server 2012 R2 and applies to Windows 10/11. Do the
> install/service steps from an **Administrator** Command Prompt.

---

## 0. What you need

- A Windows PC that stays on, on the **same LAN** as the printer(s).
- The printer(s) reachable over the network on TCP port **9100** (ESC/POS).
- The project files (this repo) and, for the snackk integration, a **device key**
  from snackk → Settings → Printer Device.

---

## 1. Install Node.js (system-wide)

1. Download the **LTS Windows Installer (.msi)** from <https://nodejs.org>.
2. Run it and accept defaults. **Install for all users** so it lands in
   `C:\Program Files\nodejs` and is on the system PATH — this matters later:
   the boot service runs as a system account and must find `node`.
3. Verify in a **new** Command Prompt:
   ```cmd
   where node
   node -v
   npm -v
   ```
   `where node` must show `C:\Program Files\nodejs\node.exe`. If it shows a path
   under `C:\Users\...`, Node was installed per-user — uninstall and reinstall
   "for all users", or the boot service will fail.

> Git is optional. If you want `git clone`, install Git for Windows
> (<https://git-scm.com/download/win>). Otherwise just copy the project folder over.

---

## 2. Get the project onto the machine

Put the folder somewhere stable, e.g. the Desktop:

```cmd
:: with Git:
cd "C:\Users\<YOU>\Desktop"
git clone <your-repo-url> printing_test
cd printing_test

:: or without Git: copy the project folder to
::   C:\Users\<YOU>\Desktop\printing_test  (or printing_test-main from a ZIP)
```

Everything below assumes you are **inside the project folder** (the one with
`package.json`).

---

## 3. Install dependencies and run the tests

```cmd
npm install
npm test
```

`npm test` runs the full unit suite with in-memory fakes — **no printer or network
needed**. If it passes, the code is healthy on this machine. Preview sample
receipts in the terminal without a printer:

```cmd
npm run preview
```

---

## 4. Find the printer(s) and configure them

1. Discover printers on the LAN (prints an "I am …" slip on each showing IP + MAC):
   ```cmd
   npm run discover
   :: or, to print the identify slip on each printer:
   node bin/discover.js --identify
   ```
2. Create **`printers.json`** in the project root (it's git-ignored — per-site
   config). Bind each printer to a station by fixed `host` **or** by `mac`
   (recommended — survives IP changes):
   ```json
   {
     "shop": { "name": "NAMASTE RESTAURANT", "lines": ["Kathmandu", "01-5555555"] },
     "printers": {
       "cashier": { "station": "cashier", "host": "192.168.18.240", "width": 48 }
     }
   }
   ```
   `width`: **48** for 80mm paper, **32** for 58mm.
3. Print a real sample to confirm wiring:
   ```cmd
   npm run print bill
   ```

> Known printer for this deployment: POS-8360 thermal at static
> `192.168.18.240:9100`. See [`PRINTER_SETUP_GUIDE.md`](PRINTER_SETUP_GUIDE.md).

---

## 5. Configure the runtime (env / ecosystem)

The app is configured by env vars (`PRINT_*`, and `SNACKK_*` for the POS link).
For pm2 these live in `ecosystem.config.cjs`. **Copy the example and fill it in**
(the real file is git-ignored because it holds the device key):

```cmd
copy ecosystem.config.example.cjs ecosystem.config.cjs
notepad ecosystem.config.cjs
```

Set at least:

```js
env: {
  SNACKK_URL: 'https://biteo.tech',
  SNACKK_DEVICE_KEY: 'snkp_YOUR_DEVICE_KEY_HERE',  // from snackk → Settings → Printer Device
  PRINT_HTTP_PORT: 4010,
  PRINT_DISCOVERY: 'off',                          // 'off' when using fixed host in printers.json
}
```

Key env vars (see `README.md` → Configuration for the full list):
`PRINT_HTTP_PORT`, `PRINT_SHOP_NAME`, `PRINT_STORE_DIR` (`memory` to disable
persistence), `PRINT_DISCOVERY=off`, `PRINT_SUBNET`, `PRINT_LOG=json`.

---

## 6. Run it by hand once (sanity check)

```cmd
npm start
```

You should see it start the HTTP server (on `PRINT_HTTP_PORT`, e.g. 4010) and — if
`SNACKK_*` is set — connect outbound to snackk. Send a test print:

```cmd
curl -X POST http://localhost:4010/print -H "Content-Type: application/json" -d "{\"id\":\"test-1\",\"station\":\"cashier\",\"items\":[{\"name\":\"Test\",\"qty\":1}]}"
```

Stop it with `Ctrl+C`. Once this works, make it permanent in step 7.

---

## 7. Make it always-on (auto-start at boot)

This is the part with Windows-specific gotchas, so it has its own detailed
runbook: **[`WINDOWS_PM2_SERVICE.md`](WINDOWS_PM2_SERVICE.md)**.

Short version — all from an **Administrator** prompt:

```cmd
:: install pm2 + the pm2-installer Windows service (from the unzipped pm2-installer folder)
::   download: https://github.com/jessety/pm2-installer -> Code -> Download ZIP
cd "C:\path\to\pm2-installer-main"
npm run setup
::   -> then CLOSE and reopen the Administrator prompt

:: two fixes that this setup needs (both otherwise crash the service with exit 1067):
npm install -g node-windows
sc config pm2.exe obj= LocalSystem      :: note the space after obj=

:: start the service, register the app, save the boot dump
net start pm2.exe
pm2 start "C:\Users\<YOU>\Desktop\printing_test\ecosystem.config.cjs"
pm2 status
pm2 save

:: don't let a print server sleep (it drops off the network)
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 0
::   also: Power Options -> "Choose what closing the lid does" -> both "Do nothing"
```

**Prove it survives a cold boot:** `shutdown /r /t 0`, then after reboot (without
running resurrect) `pm2 status` must already show `print-agent` **online**.

> Remember: pm2 now lives at `C:\ProgramData\pm2\home`, so **always run `pm2`
> commands from an Administrator prompt**, and re-run `pm2 save` after any change.
> See the service runbook for the full 1067 troubleshooting tree.

---

## 8. Updating the app later

```cmd
cd "C:\Users\<YOU>\Desktop\printing_test"
git pull            :: or copy new files over
npm install         :: if dependencies changed

:: from an Administrator prompt:
pm2 restart print-agent
pm2 save
```

---

## Quick reference

| Task | Command (Administrator prompt) |
|---|---|
| See status | `pm2 status` |
| Tail logs | `pm2 logs print-agent` |
| Restart after a change | `pm2 restart print-agent` && `pm2 save` |
| Stop / start the service | `net stop pm2.exe` / `net start pm2.exe` |
| Discover printers | `node bin/discover.js --identify` |
| Preview receipts (no printer) | `npm run preview` |
| Run tests | `npm test` |
