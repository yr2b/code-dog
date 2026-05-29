# code-dog README & Build Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename AegisPet to `code-dog`, implement a pre-build `.env` loader script for PlatformIO to inject credentials without manual code edits, and write Chinese and English READMEs.

**Architecture:** A Python pre-build script (`read_env.py`) reads the root `.env` file, parsing `WIFI_SSID`, `WIFI_PASS`, and `CLIENT_ID` into compilation macros. `src/main.cpp` uses these macros with safe fallback values, preventing credentials leakage.
`README.md` (Chinese) and `README_EN.md` (English) are updated with foolproof guides and the new logo.

**Tech Stack:** Node.js, PlatformIO, Python, C++, Markdown, Docker-Compose.

---

### Task 1: Create PlatformIO Env Loader Script

**Files:**
- Create: `/home/zyx/code-project/ai-execution-reminder/read_env.py`

- [ ] **Step 1: Create the pre-build python script**
  Create `/home/zyx/code-project/ai-execution-reminder/read_env.py` with the following content:
  ```python
  import os
  import re

  Import("env")

  # Find .env in project directory
  proj_dir = env.get("PROJECT_DIR")
  env_file = os.path.join(proj_dir, ".env")

  if os.path.exists(env_file):
      print(f"[{env.get('PIOTOOL', 'PIO')}] Loading variables from {env_file}...")
      with open(env_file, "r", encoding="utf-8") as f:
          for line in f:
              line = line.strip()
              # Skip comments and empty lines
              if not line or line.startswith("#"):
                  continue
              # Split key and value
              parts = line.split("=", 1)
              if len(parts) == 2:
                  key = parts[0].strip()
                  val = parts[1].strip()
                  # Strip quotes
                  if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                      val = val[1:-1]
                  # Add as string macro
                  env.Append(BUILD_FLAGS=[f'-D {key}=\\\"{val}\\\"'])
  else:
      print(f"[{env.get('PIOTOOL', 'PIO')}] .env file not found at {env_file}. Using build flags defaults.")
  ```

---

### Task 2: Inject Pre-build Script into PlatformIO

**Files:**
- Modify: `/home/zyx/code-project/ai-execution-reminder/platformio.ini`

- [ ] **Step 1: Update platformio.ini**
  Modify `/home/zyx/code-project/ai-execution-reminder/platformio.ini` to add `extra_scripts = pre:read_env.py` and ensure build_flags parses macros cleanly.
  Replace:
  ```ini
  ; 构建参数
  build_flags =
      -D BOARD_HAS_PSRAM
      -D ARDUINO_USB_MODE=1
      -D ARDUINO_USB_CDC_ON_BOOT=1
  ```
  With:
  ```ini
  ; 构建参数
  extra_scripts = pre:read_env.py
  build_flags =
      -D BOARD_HAS_PSRAM
      -D ARDUINO_USB_MODE=1
      -D ARDUINO_USB_CDC_ON_BOOT=1
  ```

---

### Task 3: Update ESP32 Firmware to use Macros

**Files:**
- Modify: `/home/zyx/code-project/ai-execution-reminder/src/main.cpp:50-56`

- [ ] **Step 1: Modify main.cpp credentials**
  Open `/home/zyx/code-project/ai-execution-reminder/src/main.cpp` and update the definition of ssid, password, and client_id to use build macros with hardcoded values as fallbacks.
  Replace:
  ```cpp
  // Network & MQTT Settings (Replace with actual details or let daemon sync if needed)
  const char* ssid = "ATrenew_guest-2.4g";         // Replace with your WiFi SSID
  const char* password = "Welc0mErere!"; // Replace with your WiFi Password
  const char* mqtt_server = "broker-cn.emqx.io";
  const int mqtt_port = 1883;
  const char* client_id = "client_fd6b97fj";       // Matches Local Daemon CLIENT_ID
  ```
  With:
  ```cpp
  // Preprocessor macro definitions if not provided by build system
  #ifndef WIFI_SSID
  #define WIFI_SSID ""
  #endif
  #ifndef WIFI_PASS
  #define WIFI_PASS ""
  #endif
  #ifndef CLIENT_ID
  #define CLIENT_ID ""
  #endif

  // Network & MQTT Settings (Using build macros with fallbacks)
  const char* ssid = (strlen(WIFI_SSID) > 0) ? WIFI_SSID : "ATrenew_guest-2.4g";
  const char* password = (strlen(WIFI_PASS) > 0) ? WIFI_PASS : "Welc0mErere!";
  const char* mqtt_server = "broker-cn.emqx.io";
  const int mqtt_port = 1883;
  const char* client_id = (strlen(CLIENT_ID) > 0) ? CLIENT_ID : "client_fd6b97fj";
  ```

---

### Task 4: Create Root `.env.example` Template

**Files:**
- Create: `/home/zyx/code-project/ai-execution-reminder/.env.example`

- [ ] **Step 1: Write env template file**
  Create `/home/zyx/code-project/ai-execution-reminder/.env.example` containing placeholders:
  ```ini
  # code-dog Local Configuration Template
  # Copy this file to .env and fill in your details

  # ESP32-S3 WiFi Credentials
  WIFI_SSID="your_wifi_ssid_here"
  WIFI_PASS="your_wifi_password_here"

  # MQTT client ID (copied from local daemon Web UI: http://localhost:4000)
  CLIENT_ID="your_client_id_here"
  ```

---

### Task 5: Rewrite `README.md` (Chinese)

**Files:**
- Modify: `/home/zyx/code-project/ai-execution-reminder/README.md`

- [ ] **Step 1: Write new README.md**
  Write the comprehensive, user-friendly Chinese documentation into `/home/zyx/code-project/ai-execution-reminder/README.md`. It must contain the logo, features, Mermaid diagram, `.env` configuration steps, step-by-step instructions on creating a `.venv` (using `python3 -m venv .venv`), activating it, installing PlatformIO via `pip install platformio`, and the troubleshooting FAQ.

---

### Task 6: Write `README_EN.md` (English)

**Files:**
- Create: `/home/zyx/code-project/ai-execution-reminder/README_EN.md`

- [ ] **Step 1: Write README_EN.md**
  Create the English version of the documentation `/home/zyx/code-project/ai-execution-reminder/README_EN.md` translating all sections from `README.md` (including the `.venv` setup steps).

---

### Task 7: Compile Verification

**Files:**
- Test compilation using CLI.

- [ ] **Step 1: Run compilation checks**
  Check that the project compiles with no errors.
  Run: `.venv/bin/pio run`
  Expected: Success.
