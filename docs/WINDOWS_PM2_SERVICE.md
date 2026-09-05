# Windows: Run the print-agent as a boot-time service (pm2)

Goal: the `print-agent` starts automatically after a **full power-off → power-on**, with
**no login required**, and auto-restarts if it crashes.

This is a Windows runbook. It was written against a real setup that got stuck several times —
every gotcha we hit is documented below with the fix. Follow it top to bottom and you won't
get stuck again.

> **Verified environment:** Windows 8.1 / Server 2012 R2 (build 9600), Node.js v22, pm2 via
> `@jessety/pm2-installer`. The same steps apply to Windows 10/11.

---

## TL;DR — the working sequence

Run **everything** below in an **Administrator** Command Prompt.

```cmd
:: 1. Node.js must be installed SYSTEM-WIDE (C:\Program Files\nodejs). Verify:
where node
node -v

:: 2. Install pm2 + the pm2-installer service (from the unzipped pm2-installer folder)
::    (Download: https://github.com/jessety/pm2-installer  ->  Code -> Download ZIP)
cd "C:\path\to\pm2-installer-main"
npm run setup
::    -> close and REOPEN the Administrator prompt afterwards so PM2_HOME takes effect

:: 3. FIX #1 — service needs node-windows in the global npm folder (MODULE_NOT_FOUND / exit 1067)
npm install -g node-windows

:: 4. FIX #2 — run the service as LocalSystem, not LocalService (permission crash / exit 1067)
sc config pm2.exe obj= LocalSystem

:: 5. Start the service and confirm it's alive
net start pm2.exe
sc query pm2.exe

:: 6. Register the app under the service and SAVE the dump
pm2 start "C:\Users\<YOU>\Desktop\printing_test-main\ecosystem.config.cjs"
pm2 status
pm2 save

:: 7. Stop the machine from sleeping (a sleeping print server is off the network)
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 0
::    ALSO: Control Panel -> Power Options -> "Choose what closing the lid does"
::          -> set BOTH to "Do nothing"

:: 8. PROVE it survives a cold boot
shutdown /r /t 0
::    ...after reboot, WITHOUT running resurrect:
pm2 status        :: print-agent must already be "online"
```

Note the **space after `obj=`** in step 4 — `sc` is picky about it.

---

## Key facts to remember

- **pm2 now lives under the service / system account.** Its home is
  `C:\ProgramData\pm2\home`, and the saved dump is
  `C:\ProgramData\pm2\home\dump.pm2` — **not** the old `C:\Users\<YOU>\.pm2\`.
- **Always run `pm2` commands from an Administrator prompt.** A normal prompt gives
  `EPERM ... C:\ProgramData\pm2\home\pm2.log` because your user can't write there.
- After changing which apps run, re-run `pm2 save` (elevated) so the boot dump matches.
- The service is a Windows service named **`pm2.exe`** (display name `PM2`), `AUTO_START`.

---

## What "working" looks like

- `sc query pm2.exe` → `STATE : 4  RUNNING`
- `sc qc pm2.exe`   → `START_TYPE : 2  AUTO_START` and `SERVICE_START_NAME : LocalSystem`
- `pm2 status` (elevated) → `print-agent` **online**, and the `@jessety/pm2-logrotate`
  module also online.
- After a cold reboot, `pm2 status` shows `print-agent` online **without** running
  `pm2 resurrect`.

---

## Troubleshooting — the exact errors we hit

### A. `EPERM: operation not permitted, open 'C:\ProgramData\pm2\home\pm2.log'`
**Cause:** running `pm2` from a non-elevated prompt. pm2's home is now a system folder.
**Fix:** open Command Prompt **as Administrator** (title bar reads
`Administrator: Command Prompt`) and re-run the command.

### B. `pm2 status` is empty right after boot; it prints `Spawning PM2 daemon...`
**Cause:** the service didn't resurrect the app, so your `pm2 status` started a fresh,
empty daemon. Diagnose the service — do **not** run `pm2 save` here (it would overwrite the
good dump with an empty list). Bring the app back with `pm2 resurrect` (safe: it only reads
the dump), then fix the service using C/D below.

### C. Service is `STOPPED` with `WIN32_EXIT_CODE : 1067` and the log shows
`Error: Cannot find module '...\node_modules\node-windows\lib\wrapper.js' (MODULE_NOT_FOUND)`
**Cause:** the pm2-installer service is built on the `node-windows` package, which wasn't
present in the global npm folder.
**Fix:**
```cmd
npm install -g node-windows
dir "C:\Users\<YOU>\AppData\Roaming\npm\node_modules\node-windows\lib\wrapper.js"
```
Confirm `wrapper.js` exists, then try `net start pm2.exe` again.
If `dir` can't find it, check `npm config get prefix` — globals may be installed elsewhere;
install node-windows to the path the log actually references.

### D. Service still `1067` after node-windows is installed
**Cause:** the service runs as `NT AUTHORITY\LocalService`, which can't read
`node-windows` under your `C:\Users\<YOU>\...` profile.
**Fix — give it a stronger account:**
```cmd
sc config pm2.exe obj= LocalSystem
net start pm2.exe
```
Re-read `C:\ProgramData\pm2\service\daemon\pm2.err.log` (newest lines at the bottom) if it
still won't start.

> The "Failed to log event in Windows Event Log" lines in `pm2.wrapper.log` are harmless
> noise (LocalService/LocalSystem can't write the Event Log). Ignore them — look for the
> real `throw err;` / `Error:` block instead.

---

## Fallback if the service refuses to cooperate

`pm2 resurrect` is reliable even when the service isn't. If pm2-installer keeps fighting you,
drop the service and use **Task Scheduler** instead:

```cmd
:: runs at every boot as SYSTEM, no login needed
schtasks /create /tn "PM2 Resurrect" /tr "cmd /c pm2 resurrect" /sc onstart /ru SYSTEM /rl highest /f
```

Or `/sc onlogon` if the machine is always logged into after power-on. This avoids
`node-windows` entirely. (You still need `pm2 save` done once so there's a dump to resurrect.)

---

## Daily operations (all from an Administrator prompt)

```cmd
pm2 status                 :: see the app
pm2 logs print-agent       :: tail logs
pm2 restart print-agent    :: restart after a code/config change
pm2 save                   :: persist the current list to the boot dump (do after changes)
net stop pm2.exe           :: stop the whole service
net start pm2.exe          :: start the whole service
```
