const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const HOME = os.homedir();
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Helper to check if path exists
function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

// Ensure directory exists
function ensureDir(p) {
  if (!exists(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

// Safely parse JSON
function readJson(p) {
  if (!exists(p)) return {};
  try {
    const content = fs.readFileSync(p, 'utf8');
    return JSON.parse(content || '{}');
  } catch {
    return {};
  }
}

// Safely write JSON
function writeJson(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// Create backup file
function backupFile(p) {
  if (!exists(p)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${p}.${stamp}.bak`;
  try {
    fs.copyFileSync(p, backup);
    console.log(`Created backup: ${backup}`);
  } catch (err) {
    console.error(`Failed to create backup for ${p}:`, err);
  }
}

// Agent configs
const AGENT_SPECS = {
  'claude-code': {
    name: 'Claude Code',
    globalConfigPath: () => path.join(HOME, '.claude', 'settings.json'),
    projectConfigPath: (dir) => path.join(dir, '.claude', 'settings.json'),
    detectPath: () => path.join(HOME, '.claude'),
    install: (configPath) => {
      const config = readJson(configPath);
      config.hooks = config.hooks || {};
      config.hooks.PreToolUse = config.hooks.PreToolUse || [];
      
      // Clean existing hooks of our type
      config.hooks.PreToolUse = config.hooks.PreToolUse.filter(item => !isOurHookEntry(item));
      
      // Add our hook
      config.hooks.PreToolUse.push({
        hooks: [
          {
            type: 'command',
            command: path.join(PROJECT_ROOT, 'bin', 'claude-hook.sh') + ' claude-code',
            timeout: 60,
            statusMessage: 'Waiting for physical confirmation on ESP32-S3...'
          }
        ]
      });
      
      writeJson(configPath, config);
    },
    uninstall: (configPath) => {
      if (!exists(configPath)) return;
      const config = readJson(configPath);
      if (!config.hooks || !config.hooks.PreToolUse) return;
      
      config.hooks.PreToolUse = config.hooks.PreToolUse.filter(item => !isOurHookEntry(item));
      
      if (config.hooks.PreToolUse.length === 0) {
        delete config.hooks.PreToolUse;
      }
      if (Object.keys(config.hooks).length === 0) {
        delete config.hooks;
      }
      
      writeJson(configPath, config);
    },
    isInstalled: (configPath) => {
      if (!exists(configPath)) return false;
      const config = readJson(configPath);
      return !!(config.hooks && config.hooks.PreToolUse && config.hooks.PreToolUse.some(isOurHookEntry));
    }
  },

  'antigravity': {
    name: 'Antigravity',
    globalConfigPath: () => path.join(HOME, '.config', 'Antigravity', 'bin', 'bash'),
    projectConfigPath: (dir) => path.join(dir, '.config', 'Antigravity', 'bin', 'bash'), // fallback to global
    detectPath: () => path.join(HOME, '.gemini', 'antigravity'),
    install: (configPath) => {
      backupFile(configPath);
      ensureDir(path.dirname(configPath));
      
      const bashContent = `#!/bin/bash
# Real bash absolute path
REAL_BASH="/bin/bash"

# Detect if it's run by Antigravity Agent and contains a command to execute
if [ -n "$ANTIGRAVITY_AGENT" ] && [ "$1" = "-c" ]; then
    CMD="$2"
    
    # Whitelist diagnostic and safe read-only commands to prevent deadlocks
    if [[ "$CMD" == *"env"* ]] || [[ "$CMD" == *"ps "* ]] || [[ "$CMD" == *"ls "* ]] || [[ "$CMD" == *"cat "* ]] || [[ "$CMD" == *"which "* ]] || [[ "$CMD" == *"mkdir "* ]] || [[ "$CMD" == *"node local-daemon/server.js"* ]] || [[ "$CMD" == *"curl "* ]]; then
        exec "$REAL_BASH" "$@"
    fi

    # Read mode from local config file (fast local check, <3ms, no HTTP latency)
    MODE="companion"
    if [ -f /tmp/code_dog_config.json ]; then
        FREEFLY=$(jq -r '.freeFlyMode // false' /tmp/code_dog_config.json 2>/dev/null)
        if [ "$FREEFLY" = "true" ]; then
            MODE="freefly"
        else
            PROJ_MODE=\$(jq -r --arg cwd "\$PWD" '.projects | to_entries[] | select(.key as \$k | \$cwd | startswith(\$k)) | .value.mode' /tmp/code_dog_config.json 2>/dev/null | head -n 1)
            if [ -n "\$PROJ_MODE" ]; then
                MODE="\$PROJ_MODE"
            else
                MODE=\$(jq -r '.platforms["antigravity"] // .mode // "companion"' /tmp/code_dog_config.json 2>/dev/null)
            fi
        fi
    fi

    if [ "\$MODE" = "disabled" ]; then
        exec "\$REAL_BASH" "\$@"
    fi

    if [ "\$MODE" != "strict" ]; then
        REQ_ID="auto_\$(date +%s)_\$RANDOM"

        # Non-strict: send event in background, execute command immediately (zero latency)
        PAYLOAD=\$(jq -n --arg id "\$REQ_ID" --arg cmd "\$CMD" --arg cwd "\$(pwd)" '{id: \$id, command: \$cmd, cwd: \$cwd, agent: "antigravity"}')
        curl -s -X POST http://localhost:4000/api/hook/event \\
          -H "Content-Type: application/json" \\
          -d "\$PAYLOAD" > /dev/null 2>&1 &

        # Execute command and capture exit code
        EXIT_CODE=0
        "\$REAL_BASH" "\$@" || EXIT_CODE=\$?

        # Report result (triggers jump/failed animation on pet)
        curl -s -m 1 -X POST http://localhost:4000/api/result \\
          -H "Content-Type: application/json" \\
          -d "{\\"id\\":\\"\$REQ_ID\\",\\"exit_code\\":\$EXIT_CODE,\\"command\\":\$(echo "\$CMD" | jq -R .),\\"agent\\":\\"antigravity\\"}" > /dev/null 2>&1

        exit \$EXIT_CODE
    else
        # Strict mode: blocking approval request (waits for physical device confirmation)
        RESPONSE=$(curl -s -X POST http://localhost:4000/api/approve \\
          -H "Content-Type: application/json" \\
          -d "{\\"command\\":$(echo "$CMD" | jq -R .), \\"cwd\\":$(pwd | jq -R .), \\"agent\\":\\"antigravity\\"}")

        APPROVED=$(echo "$RESPONSE" | grep -o '"approved":true')

        if [ -n "$APPROVED" ]; then
            exec "$REAL_BASH" "$@"
        else
            echo "Access Denied: Command execution rejected by physical ESP32-S3 device." >&2
            exit 130
        fi
    fi
else
    # Transparent delegation for other users / sessions
    exec "$REAL_BASH" "$@"
fi
`;
      fs.writeFileSync(configPath, bashContent, { encoding: 'utf8', mode: 0o755 });
    },

    uninstall: (configPath) => {
      if (exists(configPath)) {
        try {
          fs.unlinkSync(configPath);
        } catch (err) {
          console.error(`Failed to delete Antigravity wrapper bash:`, err);
        }
      }
    },
    isInstalled: (configPath) => {
      return exists(configPath);
    }
  },

  'gemini': {
    name: 'Gemini CLI',
    globalConfigPath: () => path.join(HOME, '.gemini', 'settings.json'),
    projectConfigPath: (dir) => path.join(dir, '.gemini', 'settings.json'),
    detectPath: () => path.join(HOME, '.gemini'),
    install: (configPath) => {
      const config = readJson(configPath);
      config.hooks = config.hooks || {};
      config.hooks.BeforeTool = config.hooks.BeforeTool || [];
      
      config.hooks.BeforeTool = config.hooks.BeforeTool.filter(item => !isOurHookEntry(item));
      config.hooks.BeforeTool.push({
        hooks: [
          {
            type: 'command',
            command: path.join(PROJECT_ROOT, 'bin', 'claude-hook.sh') + ' gemini' // reusing the hook logic
          }
        ]
      });
      
      writeJson(configPath, config);
    },
    uninstall: (configPath) => {
      if (!exists(configPath)) return;
      const config = readJson(configPath);
      if (!config.hooks || !config.hooks.BeforeTool) return;
      
      config.hooks.BeforeTool = config.hooks.BeforeTool.filter(item => !isOurHookEntry(item));
      
      if (config.hooks.BeforeTool.length === 0) {
        delete config.hooks.BeforeTool;
      }
      if (Object.keys(config.hooks).length === 0) {
        delete config.hooks;
      }
      
      writeJson(configPath, config);
    },
    isInstalled: (configPath) => {
      if (!exists(configPath)) return false;
      const config = readJson(configPath);
      return !!(config.hooks && config.hooks.BeforeTool && config.hooks.BeforeTool.some(isOurHookEntry));
    }
  },

  'codex': {
    name: 'Codex CLI',
    globalConfigPath: () => path.join(HOME, '.codex', 'hooks.json'),
    projectConfigPath: (dir) => path.join(dir, '.codex', 'hooks.json'),
    detectPath: () => path.join(HOME, '.codex'),
    install: (configPath) => {
      const config = readJson(configPath);
      config.hooks = config.hooks || {};
      config.hooks.PreToolUse = config.hooks.PreToolUse || [];
      
      config.hooks.PreToolUse = config.hooks.PreToolUse.filter(item => !isOurHookEntry(item));
      config.hooks.PreToolUse.push({
        hooks: [
          {
            type: 'command',
            command: path.join(PROJECT_ROOT, 'bin', 'claude-hook.sh') + ' codex'
          }
        ]
      });
      
      writeJson(configPath, config);
    },
    uninstall: (configPath) => {
      if (!exists(configPath)) return;
      const config = readJson(configPath);
      if (!config.hooks || !config.hooks.PreToolUse) return;
      
      config.hooks.PreToolUse = config.hooks.PreToolUse.filter(item => !isOurHookEntry(item));
      
      if (config.hooks.PreToolUse.length === 0) {
        delete config.hooks.PreToolUse;
      }
      if (Object.keys(config.hooks).length === 0) {
        delete config.hooks;
      }
      
      writeJson(configPath, config);
    },
    isInstalled: (configPath) => {
      if (!exists(configPath)) return false;
      const config = readJson(configPath);
      return !!(config.hooks && config.hooks.PreToolUse && config.hooks.PreToolUse.some(isOurHookEntry));
    }
  },

  'opencode': {
    name: 'OpenCode',
    globalConfigPath: () => path.join(HOME, '.config', 'opencode', 'plugins', 'ai-reminder-hook.js'),
    projectConfigPath: (dir) => path.join(dir, '.config', 'opencode', 'plugins', 'ai-reminder-hook.js'),
    detectPath: () => path.join(HOME, '.config', 'opencode'),
    install: (configPath) => {
      ensureDir(path.dirname(configPath));
      const pluginContent = `// AI Reminder Hook Plugin for OpenCode
const http = require('http');

module.exports = {
  name: 'ai-reminder-hook',
  onToolBefore: async (event) => {
    return new Promise((resolve) => {
      const data = JSON.stringify({
        command: event.command || '',
        tool_name: event.toolName || 'tool',
        tool_input: event.toolInput || {},
        cwd: process.cwd(),
        agent: 'opencode'
      });
      
      const req = http.request({
        hostname: 'localhost',
        port: 4000,
        path: '/api/approve',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length
        },
        timeout: 60000
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(!!parsed.approved);
          } catch {
            resolve(true); // fallback to approve
          }
        });
      });
      
      req.on('error', () => resolve(true));
      req.write(data);
      req.end();
    });
  }
};
`;
      fs.writeFileSync(configPath, pluginContent, 'utf8');
    },
    uninstall: (configPath) => {
      if (exists(configPath)) {
        try {
          fs.unlinkSync(configPath);
        } catch (err) {
          console.error(`Failed to delete OpenCode hook plugin:`, err);
        }
      }
    },
    isInstalled: (configPath) => {
      return exists(configPath);
    }
  }
};

// Check if a hook entry belongs to us
function isOurHookEntry(entry) {
  if (!entry || !entry.hooks || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(isOurHookCommand);
}

// Check if a command is ours
function isOurHookCommand(subHook) {
  if (!subHook || typeof subHook !== 'object') return false;
  const cmd = subHook.command || '';
  return cmd.includes('ai-execution-reminder') && cmd.includes('claude-hook.sh');
}

// PUBLIC API

function getAgentStatus(agentId, projectPath = null) {
  const spec = AGENT_SPECS[agentId];
  if (!spec) return { detected: false, installed: false };
  
  const detected = exists(spec.detectPath());
  const configPath = projectPath ? spec.projectConfigPath(projectPath) : spec.globalConfigPath();
  const installed = spec.isInstalled(configPath);
  
  return {
    detected,
    installed,
    name: spec.name,
    configPath
  };
}

function installAgentHook(agentId, projectPath = null) {
  const spec = AGENT_SPECS[agentId];
  if (!spec) throw new Error(`Unknown agent: ${agentId}`);
  
  const configPath = projectPath ? spec.projectConfigPath(projectPath) : spec.globalConfigPath();
  backupFile(configPath);
  spec.install(configPath);
  console.log(`Successfully installed hook for ${spec.name} at ${configPath}`);
}

function uninstallAgentHook(agentId, projectPath = null) {
  const spec = AGENT_SPECS[agentId];
  if (!spec) throw new Error(`Unknown agent: ${agentId}`);
  
  const configPath = projectPath ? spec.projectConfigPath(projectPath) : spec.globalConfigPath();
  backupFile(configPath);
  spec.uninstall(configPath);
  console.log(`Successfully uninstalled hook for ${spec.name} at ${configPath}`);
}

module.exports = {
  AGENT_SPECS,
  getAgentStatus,
  installAgentHook,
  uninstallAgentHook
};
