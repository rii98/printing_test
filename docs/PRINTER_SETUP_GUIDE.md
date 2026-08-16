# Printer Setup & Operations Guide(Don't trust this blindly need verificationa)

A complete reference for setting up, configuring, and running the print-agent with
thermal printers at a restaurant site.

---

## Table of Contents

- [0. Fresh Windows Setup (from scratch)](#0-fresh-windows-setup-from-scratch)
- [1. Network & Printer Setup](#1-network--printer-setup)
- [2. Discovering Printers](#2-discovering-printers)
- [3. Setting a Static IP on the Printer](#3-setting-a-static-ip-on-the-printer)
- [4. Configuring printers.json](#4-configuring-printersjson)
- [5. Two-Printer Setup (Bar+Counter / Kitchen)](#5-two-printer-setup-barcounter--kitchen)
- [6. Running with PM2 (Production)](#6-running-with-pm2-production)
- [7. Troubleshooting](#7-troubleshooting)
- [8. Quick Reference](#8-quick-reference)
- [9. printers.json — All Scenarios](#9-printersjson--all-scenarios)

---

## 0. Fresh Windows Setup (from scratch)

This section covers setting up the print-agent on a **brand new Windows PC** that has
nothing installed. If you already have Node.js and the repo cloned, skip to section 1.

### Step 1: Install Node.js

1. Go to **https://nodejs.org**
2. Download the **LTS** version (e.g., Node.js 22.x LTS)
3. Run the installer:
   - Click **Next** through all steps
   - ✅ Make sure "Add to PATH" is checked (it is by default)
   - ✅ Check "Automatically install necessary tools" if prompted
4. Verify installation — open **Command Prompt** (Win+R → type `cmd` → Enter):
   ```cmd
   node --version
   npm --version
   ```
   Both should print version numbers (e.g., `v22.14.0` and `10.9.2`).

### Step 2: Install Git

1. Go to **https://git-scm.com/download/win**
2. Download and run the installer (accept all defaults)
3. Verify:
   ```cmd
   git --version
   ```

### Step 3: Clone the print-agent repo

Open **Command Prompt** and run:

```cmd
cd %USERPROFILE%\Desktop
git clone https://github.com/YOUR_ORG/printing_test.git
cd printing_test
npm install
```

> Replace the git URL with your actual repository URL.

### Step 4: Create config files

**printers.json** — create this file in the `printing_test` folder:

```json
{
    "printers": {
        "pos": { "stations": [] },
        "counter": {
            "stations": ["cashier", "bar"],
            "host": "192.168.18.240",
            "width": 48
        },
        "kitchen": {
            "station": "kitchen",
            "host": "192.168.18.241",
            "width": 48
        }
    }
}
```

**ecosystem.config.cjs** — copy from the example and fill in your device key:

```cmd
copy ecosystem.config.example.cjs ecosystem.config.cjs
notepad ecosystem.config.cjs
```

Change `SNACKK_DEVICE_KEY` to your actual key (from snackk Settings → Printer Device).

### Step 5: Test that it works

Discover printers on the network:

```cmd
npm run discover
```

Test a quick direct run:

```cmd
set SNACKK_URL=https://biteo.tech
set SNACKK_DEVICE_KEY=snkp_YOUR_KEY_HERE
set PRINT_HTTP_PORT=4010
set PRINT_DISCOVERY=off
node src/index.js
```

Press `Ctrl+C` to stop after verifying it connects and prints.

### Step 6: Install PM2 and run as a service

```cmd
npm install -g pm2
npm install -g pm2-windows-startup
pm2 start ecosystem.config.cjs
pm2 save
pm2-startup install
```

> **Note**: On Windows, `pm2 startup` doesn't work natively. Use the
> `pm2-windows-startup` package instead — it registers PM2 as a Windows service
> that auto-starts on boot.

Alternatively, you can use `pm2-installer` for a more robust Windows service:

```cmd
npm install -g pm2-installer
pm2-installer install
```

### Step 7: Verify everything

```cmd
pm2 status                    :: check it's running
pm2 logs print-agent          :: check for errors
npm run discover -- --identify :: verify printers are reachable
```

Reboot the PC and verify `pm2 status` still shows `print-agent` as `online`.

### Windows vs Mac command differences

| Task                    | Mac / Linux                          | Windows (cmd)                        |
|-------------------------|--------------------------------------|--------------------------------------|
| Set env var (one-off)   | `SNACKK_URL=https://... node ...`    | `set SNACKK_URL=https://...` then `node ...` |
| Set env var (PowerShell)| —                                    | `$env:SNACKK_URL="https://..."`     |
| PM2 startup             | `pm2 startup` (then sudo command)    | `pm2-windows-startup install`        |
| File paths              | `/Users/name/Desktop/...`            | `C:\Users\name\Desktop\...`         |
| Stop process            | `Ctrl+C`                             | `Ctrl+C`                             |

---

## 1. Network & Printer Setup

### How it works

The print-agent runs on a machine (Mac, Raspberry Pi, mini PC) connected to the same
LAN as the printers. It receives tickets from the cloud (snackk) via SSE and sends
ESC/POS data to printers over TCP port 9100.

```
  Cloud (snackk)  ──SSE──►  print-agent (this Mac)  ──TCP:9100──►  printers on LAN
```

### Connecting a printer

1. Connect the thermal printer to your WiFi router (via WiFi or Ethernet cable)
2. Power it on — the router's DHCP assigns it an IP address automatically
3. Run `npm run discover` to find it (see section 2)

### Important: MAC addresses on cheap POS printers

These printers often report a **fake/generic MAC** like `28:00:00:00:00:00`. This
means:

- **MAC-based discovery is unreliable** — the ARP lookup sometimes works, sometimes
  doesn't (depends on cache timing)
- **Use fixed IP addresses (`host`) instead of `mac` in your config** — this is the
  most reliable approach
- Set a static IP directly on the printer's web interface (see section 3)

---

## 2. Discovering Printers

### Find all printers on the LAN

```bash
npm run discover
```

This scans every IP (1–254) on your subnet for port 9100. Output:

```
Found 2 printer(s):
  192.168.18.240   mac=28:00:00:00:00:00
  192.168.18.241   mac=28:00:00:00:00:01
```

### Identify which physical printer is which

```bash
npm run discover -- --identify
```

This prints a physical slip on **each** printer showing its IP + MAC, so you can
tell which printer is the kitchen one and which is the counter one.

### When discovery finds nothing

- Check that the printer is **powered on** and connected to the same WiFi/LAN
- Make sure you're on the **same subnet** (e.g., both on `192.168.18.x`)
- Try running discover again — sometimes the first scan misses due to timing

---

## 3. Setting a Static IP on the Printer

This is the **recommended** way to ensure the printer's IP never changes.

### Why it matters

By default, the router assigns IPs via DHCP. These can change after a reboot or
lease expiry. A static IP set on the printer itself is permanent.

### How to set it

1. First, find the printer's current IP:
   ```bash
   npm run discover
   ```

2. Open the printer's web interface in your browser:
   ```
   http://192.168.18.240
   ```
   (Replace with the IP from step 1)

3. You'll see the **Ethernet WebSet System** page with editable fields:
   - **IP Address**: Set your desired fixed IP (e.g., `192.168.18.240`)
   - **Subnet Mask**: `255.255.255.0`
   - **Gateway Address**: `192.168.18.1` (your router's IP)

4. Click **MODIFY** to save

5. The printer now always uses this IP, even after reboots

### Choosing IPs for multiple printers

Pick IPs that won't conflict with other devices. Use high numbers to stay out of
the router's DHCP range:

| Printer       | Suggested IP       |
|---------------|--------------------|
| Counter (bar) | `192.168.18.240`   |
| Kitchen       | `192.168.18.241`   |

> **Warning**: Never give two devices the same IP address.

---

## 4. Configuring printers.json

The file `printers.json` in the project root is the per-site configuration. It
overrides the defaults in `src/config.js`.

### Config loading order (most-specific wins)

1. Defaults in `src/config.js`
2. `printers.json` in project root (git-ignored, per-site)
3. `PRINT_*` environment variables

### Important: disabling the default `pos` printer

The defaults in `src/config.js` define a printer called `pos` that claims all three
stations (`cashier`, `kitchen`, `bar`). When you add your own printers in
`printers.json`, the merge logic **keeps the default `pos` on top**. This causes a
conflict:

```
Error: two printers claim station "cashier": pos and counter
```

**Fix**: Explicitly disable the default `pos` by setting its stations to empty:

```json
{
    "printers": {
        "pos": { "stations": [] },
        ...your printers here...
    }
}
```

### Using `host` vs `mac`

| Field  | How it works                           | Reliable? |
|--------|----------------------------------------|-----------|
| `host` | Fixed IP — connects directly           | ✅ Yes     |
| `mac`  | Needs LAN discovery to find IP by MAC  | ❌ Flaky (fake MACs) |

**Always use `host` (fixed IP)** for these POS printers. If you use `mac`:

- You must **not** set `PRINT_DISCOVERY=off` (discovery must be ON to scan for MACs)
- It may fail on cold starts due to ARP cache being empty
- The fake MAC `28:00:00:00:00:00` makes matching unreliable

### File naming

The file **must** be named `printers.json` (with an 's'). A file named `printer.json`
will be silently ignored.

---

## 5. Two-Printer Setup (Bar+Counter / Kitchen)

### printers.json

```json
{
    "printers": {
        "pos": { "stations": [] },
        "counter": {
            "stations": ["cashier", "bar"],
            "host": "192.168.18.240",
            "width": 48
        },
        "kitchen": {
            "station": "kitchen",
            "host": "192.168.18.241",
            "width": 48
        }
    }
}
```

- **`counter`** — handles `cashier` (bills) and `bar` (bar order tickets)
- **`kitchen`** — handles `kitchen` (KOT kitchen order tickets)
- **`pos`** — disabled (empty stations) to prevent conflict with defaults

### Station routing

Each ticket has a `station` field. The agent routes it to the correct printer:

| Ticket station | Prints on   | Printer IP       |
|----------------|-------------|------------------|
| `cashier`      | counter     | 192.168.18.240   |
| `bar`          | counter     | 192.168.18.240   |
| `kitchen`      | kitchen     | 192.168.18.241   |

### Rules

- Each station maps to **exactly one** printer
- One printer can serve **multiple** stations
- Two printers **cannot** claim the same station (the agent will error on startup)

### Setup steps for a new site

1. Connect both printers to WiFi
2. `npm run discover -- --identify` — find IPs + identify which is which
3. Set static IPs on each printer via `http://<ip>` (see section 3)
4. Create `printers.json` with the IPs
5. Start with PM2 (see section 6)

---

## 6. Running with PM2 (Production)

PM2 keeps the print-agent running in the background — auto-restarts on crash,
survives terminal close, and can auto-start on boot.

### ecosystem.config.cjs

```js
module.exports = {
  apps: [{
    name: 'print-agent',
    script: 'src/index.js',
    cwd: __dirname,
    env: {
      SNACKK_URL: 'https://biteo.tech',
      SNACKK_DEVICE_KEY: 'snkp_YOUR_KEY_HERE',
      PRINT_HTTP_PORT: 4010,
      PRINT_DISCOVERY: 'off',
    },
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 2000,
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }],
};
```

> **Note**: Use `PRINT_DISCOVERY: 'off'` when using `host` (fixed IP). Only remove
> it if you're using `mac`-based config (not recommended).

### First-time setup

```bash
# 1. Install PM2 globally
npm i -g pm2

# 2. Start the print-agent
pm2 start ecosystem.config.cjs

# 3. Set up auto-start on boot (run the sudo command PM2 gives you)
pm2 startup
# Copy-paste the sudo command it prints, e.g.:
# sudo env PATH=$PATH:/usr/local/bin /usr/local/lib/node_modules/pm2/bin/pm2 startup launchd -u kismatbhandari --hp /Users/kismatbhandari

# 4. Save the current process list
pm2 save
```

### Do I need to keep the terminal open?

**No.** PM2 runs as a background daemon. You can close the terminal, log out, etc.
The print-agent keeps running. You only need a terminal to check status or restart.

### Common PM2 commands

| Command                           | What it does                          |
|-----------------------------------|---------------------------------------|
| `pm2 start ecosystem.config.cjs`  | Start (or restart) the agent          |
| `pm2 status`                      | Check if it's running                 |
| `pm2 logs print-agent`            | Live tail the logs                    |
| `pm2 logs print-agent --lines 50` | Show last 50 log lines                |
| `pm2 restart print-agent`         | Restart after config change           |
| `pm2 stop print-agent`            | Stop the agent                        |
| `pm2 delete print-agent`          | Remove from PM2 entirely              |
| `pm2 save`                        | Save process list for boot recovery   |

### After changing config

If you edit `printers.json` or `ecosystem.config.cjs`:

```bash
pm2 restart print-agent
```

If you changed env vars in `ecosystem.config.cjs`:

```bash
pm2 stop print-agent
pm2 start ecosystem.config.cjs
```

(`pm2 restart` doesn't reload env vars from the ecosystem file — you need
stop + start.)

---

## 7. Troubleshooting

### "two printers claim station X"

**Cause**: The default `pos` printer (from `src/config.js`) and your custom printer
both claim the same station.

**Fix**: Add `"pos": { "stations": [] }` to your `printers.json` to disable the
default.

### "printer has no address (mac not found, no host)"

**Cause**: The printer config uses `mac` but:
- `PRINT_DISCOVERY=off` is set (discovery can't scan), OR
- Discovery ran but couldn't match the MAC (fake MAC / cold ARP cache)

**Fix**: Switch to `host` (fixed IP) instead of `mac` in `printers.json`.

### "connect timeout to X.X.X.X:9100"

**Cause**: The printer is offline, unplugged, or the IP is wrong.

**Fix**:
1. Check the printer is powered on and connected to WiFi
2. Run `npm run discover` to verify its current IP
3. If the IP changed, update `printers.json` and restart

### PM2 shows "online" but tickets show "error"

**Cause**: PM2 is running the agent, but the agent can't reach the printers.

**Fix**: Check PM2 logs for the actual error:
```bash
pm2 logs print-agent --lines 30
```

Common causes:
- Wrong IP in `printers.json`
- Printer powered off
- `PRINT_DISCOVERY=off` with `mac` config (use `host` instead)

### PM2 doesn't auto-start on boot

**Cause**: The `pm2 startup` sudo command wasn't run.

**Fix**:
```bash
pm2 startup
# Run the sudo command it prints
pm2 save
```

### Discovery finds 0 printers (but printer is on)

**Cause**: Timing/ARP cache issue, or printer is on a different subnet.

**Fix**: Run `npm run discover` again. If it still fails, verify you're on the same
WiFi network as the printer.

### File named `printer.json` is ignored

**Cause**: The config loader looks for `printers.json` (with an 's').

**Fix**: Rename the file to `printers.json`.

---

## 8. Quick Reference

### Files

| File                      | Purpose                                    |
|---------------------------|--------------------------------------------|
| `printers.json`           | Per-site printer config (IPs, stations)    |
| `ecosystem.config.cjs`    | PM2 config (env vars, restart policy)      |
| `src/config.js`           | Default config (don't edit per-site)       |
| `.queue/`                 | Durable print queue (auto-managed)         |

### Environment variables

| Variable              | Purpose                              | Example                    |
|-----------------------|--------------------------------------|----------------------------|
| `SNACKK_URL`          | Snackk backend URL                   | `https://biteo.tech`       |
| `SNACKK_DEVICE_KEY`   | Device key from snackk settings      | `snkp_xxx`                 |
| `PRINT_HTTP_PORT`     | HTTP server port                     | `4010`                     |
| `PRINT_DISCOVERY`     | LAN discovery (`off` to disable)     | `off`                      |
| `PRINT_SHOP_NAME`     | Shop name on receipts                | `NAMASTE MINI MARKET`      |

### Stations

| Station    | What prints there          |
|------------|----------------------------|
| `kitchen`  | KOT (Kitchen Order Ticket) |
| `bar`      | BOT (Bar Order Ticket)     |
| `cashier`  | Bills / receipts           |

### Typical two-printer config

```
printers.json:
  counter (192.168.18.240) → cashier + bar
  kitchen (192.168.18.241) → kitchen

ecosystem.config.cjs:
  SNACKK_URL, SNACKK_DEVICE_KEY, PRINT_HTTP_PORT, PRINT_DISCOVERY=off

Run: pm2 start ecosystem.config.cjs
```

---

## 9. printers.json — All Scenarios

Every scenario below includes `"pos": { "stations": [] }` to disable the default
printer from `src/config.js`. **This line is required** — without it you get:
`Error: two printers claim station "X"`.

---

### Scenario A: One printer for everything

All three stations (cashier, kitchen, bar) go to a single printer.

```json
{
    "printers": {
        "pos": { "stations": [] },
        "main": {
            "stations": ["cashier", "kitchen", "bar"],
            "host": "192.168.18.240",
            "width": 48
        }
    }
}
```

| Station  | Printer | IP             |
|----------|---------|----------------|
| cashier  | main    | 192.168.18.240 |
| kitchen  | main    | 192.168.18.240 |
| bar      | main    | 192.168.18.240 |

**Use case**: Small shop with one printer, or testing with a single device.

---

### Scenario B: Two printers — Counter (cashier + bar) / Kitchen

Counter printer handles bills and bar tickets. Kitchen gets its own printer.

```json
{
    "printers": {
        "pos": { "stations": [] },
        "counter": {
            "stations": ["cashier", "bar"],
            "host": "192.168.18.240",
            "width": 48
        },
        "kitchen": {
            "station": "kitchen",
            "host": "192.168.18.241",
            "width": 48
        }
    }
}
```

| Station  | Printer  | IP             |
|----------|----------|----------------|
| cashier  | counter  | 192.168.18.240 |
| bar      | counter  | 192.168.18.240 |
| kitchen  | kitchen  | 192.168.18.241 |

**Use case**: Bar is near the cashier/counter, kitchen is separate.

---

### Scenario C: Two printers — Counter (cashier) / Kitchen + Bar

Counter handles only bills. Kitchen and bar share a printer.

```json
{
    "printers": {
        "pos": { "stations": [] },
        "counter": {
            "station": "cashier",
            "host": "192.168.18.240",
            "width": 48
        },
        "kitchen": {
            "stations": ["kitchen", "bar"],
            "host": "192.168.18.241",
            "width": 48
        }
    }
}
```

| Station  | Printer  | IP             |
|----------|----------|----------------|
| cashier  | counter  | 192.168.18.240 |
| kitchen  | kitchen  | 192.168.18.241 |
| bar      | kitchen  | 192.168.18.241 |

**Use case**: Bar is near the kitchen, counter/cashier is separate.

---

### Scenario D: Three printers — one per station

Each station gets its own dedicated printer.

```json
{
    "printers": {
        "pos": { "stations": [] },
        "counter": {
            "station": "cashier",
            "host": "192.168.18.240",
            "width": 48
        },
        "kitchen": {
            "station": "kitchen",
            "host": "192.168.18.241",
            "width": 48
        },
        "bar": {
            "station": "bar",
            "host": "192.168.18.242",
            "width": 48
        }
    }
}
```

| Station  | Printer  | IP             |
|----------|----------|----------------|
| cashier  | counter  | 192.168.18.240 |
| kitchen  | kitchen  | 192.168.18.241 |
| bar      | bar      | 192.168.18.242 |

**Use case**: Large restaurant where cashier, kitchen, and bar are all in
different physical locations.

---

### Notes on all scenarios

- **`station`** (singular) = one station, **`stations`** (plural, array) = multiple
- **`width: 48`** = 80mm paper, **`width: 32`** = 58mm paper
- Replace the IPs with the actual static IPs set on your printers
  (see [section 3](#3-setting-a-static-ip-on-the-printer))
- Always use `PRINT_DISCOVERY=off` in your ecosystem when using `host` (fixed IP)
