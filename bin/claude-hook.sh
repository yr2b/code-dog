#!/bin/bash
# Claude Code PreToolUse Hook (reused by Gemini and Codex)
# Reads mode from local config file (<3ms, no HTTP latency) to decide:
#   non-strict → fire-and-forget background event, exit 0 immediately
#   strict      → blocking /api/approve request (waits for physical device)

INPUT=$(cat)
AGENT="${1:-claude-code}"

# Extract fields from Claude Code hook payload
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""')

# ── Fast local mode detection (<3ms, no HTTP) ───────────────────────────────
MODE="companion"
if [ -f /tmp/code_dog_config.json ]; then
    FREEFLY=$(jq -r '.freeFlyMode // false' /tmp/code_dog_config.json 2>/dev/null)
    if [ "$FREEFLY" = "true" ]; then
        MODE="freefly"
    else
        PROJ_MODE=$(jq -r --arg cwd "$CWD" '.projects | to_entries[] | select(.key as $k | $cwd | startswith($k)) | .value.mode' /tmp/code_dog_config.json 2>/dev/null | head -n 1)
        if [ -n "$PROJ_MODE" ]; then
            MODE="$PROJ_MODE"
        else
            MODE=$(jq -r --arg agent "$AGENT" '.platforms[$agent] // .mode // "companion"' /tmp/code_dog_config.json 2>/dev/null)
        fi
    fi
fi

# ── Disabled mode: transparent bypass ───────────────────────────────────────
if [ "$MODE" = "disabled" ]; then
    exit 0
fi

# ── Non-strict modes: zero latency, fire-and-forget ─────────────────────────
if [ "$MODE" != "strict" ]; then
    # Send event to daemon in background (no wait, no block)
    PAYLOAD=$(jq -n \
      --arg tool_name "$TOOL_NAME" \
      --argjson tool_input "$TOOL_INPUT" \
      --arg cwd "$CWD" \
      --arg agent "$AGENT" \
      '{tool_name: $tool_name, tool_input: $tool_input, cwd: $cwd, agent: $agent}')

    curl -s -X POST http://localhost:4000/api/hook/event \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD" > /dev/null 2>&1 &

    exit 0
fi

# ── Strict mode: blocking approval (waits for physical device confirmation) ──
CMD=$(echo "$TOOL_INPUT" | jq -r '.command // ""')

PAYLOAD=$(jq -n \
  --arg cmd "$CMD" \
  --arg cwd "$CWD" \
  --arg sid "$SESSION_ID" \
  --arg tp "$TRANSCRIPT_PATH" \
  --arg tool_name "$TOOL_NAME" \
  --argjson tool_input "$TOOL_INPUT" \
  --arg agent "$AGENT" \
  '{command: $cmd, cwd: $cwd, session_id: $sid, transcript_path: $tp, tool_name: $tool_name, tool_input: $tool_input, agent: $agent}')

RESPONSE=$(curl -s -X POST http://localhost:4000/api/approve \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

APPROVED=$(echo "$RESPONSE" | grep -o '"approved":true')

if [ -n "$APPROVED" ]; then
    exit 0
else
    echo "Access Denied: Execution blocked by physical ESP32-S3 device." >&2
    exit 2
fi
