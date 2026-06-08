require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');

const hooksManager = require('./hooks-manager');
const petManager = require('./pet-manager');
const multer = require('multer');
const uploadDir = path.join(__dirname, 'temp-uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const uploader = multer({ dest: uploadDir });

const app = express();
const PORT = 4000;
const ASSET_PORT = 4001;
const MQTT_BROKER = 'mqtt://broker-cn.emqx.io'; // China-accessible broker

let publicTunnelUrl = '';

// Minimal static server for pet assets only (exposed via tunnel)
const assetApp = express();
assetApp.use('/pets', express.static(path.join(__dirname, 'public', 'pets')));
const assetServer = http.createServer(assetApp);
assetServer.listen(ASSET_PORT, () => {
  console.log(`Asset server listening on port ${ASSET_PORT} (pets directory only)`);
});

function startTunnel() {
  console.log('Starting localhost.run SSH tunnel for cross-network ESP32 access...');
  const ssh = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-R', `80:localhost:${ASSET_PORT}`,
    'nokey@localhost.run'
  ]);

  ssh.stdout.on('data', (data) => {
    const output = data.toString();
    console.log(`[Tunnel STDOUT]: ${output.trim()}`);
    const match = output.match(/([a-zA-Z0-9-]+\.lhr\.life)/);
    if (match) {
      publicTunnelUrl = `http://${match[1]}`;
      console.log(`==================================================`);
      console.log(`PUBLIC TUNNEL URL DETECTED: ${publicTunnelUrl}`);
      console.log(`==================================================`);
    }
  });

  ssh.stderr.on('data', (data) => {
    const output = data.toString();
    console.log(`[Tunnel STDERR]: ${output.trim()}`);
  });

  ssh.on('close', (code) => {
    console.log(`Tunnel process exited with code ${code}. Restarting in 5 seconds...`);
    publicTunnelUrl = '';
    setTimeout(startTunnel, 5000);
  });
}

startTunnel();

function isQiniuConfigured() {
  const ak = process.env.QINIU_ACCESS_KEY;
  const sk = process.env.QINIU_SECRET_KEY;
  const bucket = process.env.QINIU_BUCKET;
  const domain = process.env.QINIU_DOMAIN;
  if (!ak || !sk || !bucket || !domain) return false;
  if (ak.includes('your_access_key') || sk.includes('your_secret_key') || bucket.includes('your_bucket_name') || domain.includes('your_cdn_domain')) {
    return false;
  }
  return true;
}

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuration Management
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = {
  freeFlyMode: false,
  activePet: 'boba',
  logRetentionLimit: 1000,
  clientId: '',
  global: {
    mode: 'companion'
  },
  platforms: {
    'claude-code': 'companion',
    'antigravity': 'companion'
  },
  projects: {}
};

function loadConfig() {
  let changed = false;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.error('Failed to parse config.json, using defaults:', err);
    }
  } else {
    changed = true;
  }
  
  if (!config.clientId) {
    config.clientId = 'client_' + Math.random().toString(36).substring(2, 10);
    changed = true;
  }
  
  if (changed) {
    saveConfig();
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
  // Export a lightweight copy for fast local mode-check by shell hooks (<3ms, no HTTP)
  try {
    const sharedConfig = {
      mode: config.global ? config.global.mode : 'companion',
      freeFlyMode: config.freeFlyMode || false,
      platforms: config.platforms || {},
      projects: config.projects || {}
    };
    fs.writeFileSync('/tmp/code_dog_config.json', JSON.stringify(sharedConfig), 'utf8');
  } catch (e) {
    // Non-fatal: hooks will fall back to companion mode
  }
}

loadConfig();
// Ensure /tmp config is exported on startup even if loadConfig skipped saveConfig
saveConfig();

// Sync Hook Installations based on config
function syncHookInstallations() {
  console.log('Syncing hook installation states...');
  
  // Clean up/install global platforms
  const platforms = ['claude-code', 'antigravity', 'gemini', 'codex', 'opencode'];
  for (const agentId of platforms) {
    const status = hooksManager.getAgentStatus(agentId);
    if (!status.detected) continue;

    const targetMode = config.platforms[agentId] || config.global.mode;
    
    if (targetMode === 'disabled') {
      if (status.installed) {
        console.log(`Config says disabled. Uninstalling hook for ${agentId}...`);
        try { hooksManager.uninstallAgentHook(agentId); } catch (e) { console.error(e); }
      }
    } else {
      // Force rewrite/update to ensure latest script content and parameters
      console.log(`Config says enabled (${targetMode}). Syncing/updating hook for ${agentId}...`);
      try { hooksManager.installAgentHook(agentId); } catch (e) { console.error(e); }
    }
  }
}

// Initial sync
syncHookInstallations();

let pendingRequests = [];
let requestHistory = [];
let mqttClient = null;

const HISTORY_PATH = path.join(__dirname, 'audit_history.json');

function loadHistory() {
  if (fs.existsSync(HISTORY_PATH)) {
    try {
      requestHistory = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    } catch (err) {
      console.error('Failed to parse audit_history.json:', err);
    }
  }
}

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(requestHistory, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error('Failed to write audit history to file:', err);
  }
}

function addHistoryEntry(entry) {
  requestHistory.push(entry);
  const limit = config.logRetentionLimit || 1000;
  if (requestHistory.length > limit) {
    requestHistory = requestHistory.slice(-limit);
  }
  saveHistory();
}

// Load history on startup
loadHistory();

let currentSubscribedClientId = null;
let lastDeviceHeartbeat = 0;

function updateMQTTSubscriptions() {
  if (!mqttClient || !mqttClient.connected) return;
  const newId = config.clientId || 'client_zyx_s3';
  if (currentSubscribedClientId === newId) return;

  // Unsubscribe old
  if (currentSubscribedClientId) {
    mqttClient.unsubscribe(`ai/response/${currentSubscribedClientId}`);
    mqttClient.unsubscribe(`ai/notify/${currentSubscribedClientId}`);
    mqttClient.unsubscribe(`ai/heartbeat/${currentSubscribedClientId}`);
  }

  // Subscribe new
  mqttClient.subscribe(`ai/response/${newId}`, (err) => {
    if (err) console.error('Subscription error response:', err);
  });
  mqttClient.subscribe(`ai/notify/${newId}`, (err) => {
    if (err) console.error('Subscription error notify:', err);
  });
  mqttClient.subscribe(`ai/heartbeat/${newId}`, (err) => {
    if (err) console.error('Subscription error heartbeat:', err);
  });
  
  currentSubscribedClientId = newId;
  console.log(`MQTT subscribed to topics for client: ${newId}`);
  broadcastStatus();
  broadcastQueueToDevice();
}

// Connect to MQTT Broker
function connectMQTT() {
  mqttClient = mqtt.connect(MQTT_BROKER);

  mqttClient.on('connect', () => {
    console.log(`Connected to MQTT Broker: ${MQTT_BROKER}`);
    updateMQTTSubscriptions();
  });

  mqttClient.on('message', (topic, message) => {
    const topicStr = topic.toString();
    const currentId = config.clientId || 'client_zyx_s3';
    
    // Map to keep track of last sync trigger time per client to prevent sync storms
    if (!global.lastSyncTriggerTime) {
      global.lastSyncTriggerTime = {};
    }

    if (topicStr === `ai/heartbeat/${currentId}`) {
      lastDeviceHeartbeat = Date.now();
      
      try {
        const payload = JSON.parse(message.toString());
        
        // Cache battery and charging info in config with change detection
        let configChanged = false;
        if (typeof payload.battery === 'number' && payload.battery !== config.deviceBattery) {
          config.deviceBattery = payload.battery;
          configChanged = true;
        }

        const chargingState = !!payload.charging;
        if (payload.charging !== undefined && chargingState !== config.deviceCharging) {
          config.deviceCharging = chargingState;
          configChanged = true;
        }

        if (configChanged) {
          saveConfig();
        }

        // Self-healing check with 30s cooldown: trigger sync if device reports pet not loaded or slug mismatch
        const deviceNeedsPet = !payload.pet_loaded || payload.active_slug !== config.activePet;
        const now = Date.now();
        const lastTrigger = global.lastSyncTriggerTime[currentId] || 0;
        const isCooldownOver = (now - lastTrigger) > 30000; // 30s cooldown

        if (deviceNeedsPet && isCooldownOver) {
          global.lastSyncTriggerTime[currentId] = now;
          console.log(`[Sync System] Device reports pet not loaded or slug mismatch (device: "${payload.active_slug || ''}", config: "${config.activePet}"). Cooldown ok, triggering automatic sync...`);
          syncActivePetToDevice(config.activePet).catch(err => {
            console.error('[Sync System] Auto sync active pet to device failed:', err);
          });
        }
      } catch (e) {
        // Fallback for legacy text-based "ping" heartbeats
        console.log(`[Sync System] Legacy heartbeat received from ${currentId}: "${message.toString()}"`);
      }
      return;
    }

    try {
      const payload = JSON.parse(message.toString());
      console.log(`MQTT received on ${topic}:`, payload);

      if (topicStr === `ai/response/${currentId}`) {
        handleApprovalAction(payload.id, payload.approved ? 'approve' : 'reject', 'physical_device');
      }
    } catch (e) {
      console.error('Failed to parse MQTT message:', e);
    }
  });

  mqttClient.on('error', (err) => {
    console.error('MQTT error:', err);
  });
}

connectMQTT();

// Helper to broadcast current queue status to ESP32 S3
function broadcastQueueToDevice() {
  if (!mqttClient || !mqttClient.connected) return;

  const payload = {
    total: pendingRequests.length,
    requests: pendingRequests.map(r => ({
      id: r.id,
      command: r.command,
      task_title: r.task_title,
      thinking: r.thinking,
      mode: r.mode,
      agent: r.agent,
      cwd: r.cwd
    }))
  };

  const cid = config.clientId || 'client_zyx_s3';
  mqttClient.publish(`ai/queue/${cid}`, JSON.stringify(payload), { retain: true });
}

// Broadcast general status changes
function broadcastStatus() {
  if (!mqttClient || !mqttClient.connected) return;
  
  const payload = {
    freeFlyMode: config.freeFlyMode,
    activePet: config.activePet
  };
  
  const cid = config.clientId || 'client_zyx_s3';
  mqttClient.publish(`ai/status/${cid}`, JSON.stringify(payload), { retain: true });
}

// Helper to resolve the mode for a given command
function resolveMode(cwd, agentId) {
  // 1. Free Fly Mode has highest priority
  if (config.freeFlyMode) {
    return 'freefly';
  }

  // Normalize agentId
  let normalizedAgent = agentId;
  if (agentId === 'claude') normalizedAgent = 'claude-code';

  // 2. Check project overrides
  if (cwd) {
    const matchedProject = Object.keys(config.projects).find(projectPath => {
      // Direct match or prefix
      return cwd.startsWith(projectPath);
    });

    if (matchedProject) {
      const projectConfig = config.projects[matchedProject];
      if (projectConfig.platforms && projectConfig.platforms[normalizedAgent]) {
        return projectConfig.platforms[normalizedAgent];
      }
      return projectConfig.mode || 'strict';
    }
  }

  // 3. Check platform overrides
  if (config.platforms && config.platforms[normalizedAgent]) {
    return config.platforms[normalizedAgent];
  }

  // 4. Fallback to global
  return config.global.mode || 'companion';
}

// Helper to parse tool name and generate user-friendly description
function formatToolDescription(toolName, toolInput, command) {
  if (!toolName) {
    if (command) {
      // Truncate raw command for description
      const baseCmd = command.split(' ')[0] || '';
      return `运行命令: ${baseCmd}`;
    }
    return '执行 AI 动作';
  }

  const lower = toolName.toLowerCase();
  
  // Parse target path or filename
  const getFileBasename = (p) => {
    if (!p) return '';
    const parts = p.split(/[\/\\]/);
    return parts[parts.length - 1];
  };

  const targetPath = toolInput.file_path || toolInput.filePath || toolInput.path || '';
  const filename = getFileBasename(targetPath);

  switch (lower) {
    case 'read':
    case 'viewfile':
    case 'view_file':
      return filename ? `查看文件: ${filename}` : '读取文件';
      
    case 'edit':
    case 'write':
    case 'editfile':
    case 'write_to_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
      return filename ? `编辑修改: ${filename}` : '写入修改文件';
      
    case 'bash':
    case 'run_command':
    case 'execute_command': {
      const cmdStr = toolInput.command || command || '';
      const firstWord = cmdStr.trim().split(/\s+/)[0] || 'shell';
      return `执行命令: ${firstWord}`;
    }
    
    case 'grep':
    case 'grep_search': {
      const query = toolInput.query || toolInput.pattern || '';
      return query ? `搜索代码: "${query}"` : '搜索代码库';
    }
    
    case 'glob':
    case 'list_dir':
    case 'list_directory':
      return '列出目录结构';
      
    case 'search_web':
    case 'web_search':
    case 'read_url':
      return '进行网页搜索/查看';
      
    default:
      return `执行工具: ${toolName}`;
  }
}

// Parse Claude Code transcript file (JSONL format)
async function parseTranscript(transcriptPath) {
  let taskTitle = '未命名任务';
  let latestThinking = '';

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { taskTitle, latestThinking };
  }

  try {
    const fileStream = fs.createReadStream(transcriptPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let firstUserMessage = null;
    let lastAssistantMessage = null;

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        // Handle nesting under obj.message (new Claude Code schema)
        const msg = obj.message || obj;
        const role = msg.role || obj.type || '';
        
        if (role === 'user' && !firstUserMessage) {
          firstUserMessage = msg.content;
        }
        if (role === 'assistant') {
          lastAssistantMessage = msg.content;
        }
      } catch (e) {
        // Skip unparsable lines
      }
    }

    if (firstUserMessage) {
      if (Array.isArray(firstUserMessage)) {
        taskTitle = firstUserMessage.map(c => c.text || c.thinking || '').join(' ').trim();
      } else {
        taskTitle = String(firstUserMessage).trim();
      }
    }

    if (lastAssistantMessage) {
      if (Array.isArray(lastAssistantMessage)) {
        // Extract thinking text from content blocks if present
        const thinkingBlock = lastAssistantMessage.find(c => c.type === 'thinking');
        const textBlock = lastAssistantMessage.find(c => c.type === 'text');
        
        if (thinkingBlock && thinkingBlock.thinking) {
          latestThinking = thinkingBlock.thinking;
        } else if (textBlock && textBlock.text) {
          latestThinking = textBlock.text;
        } else {
          latestThinking = lastAssistantMessage.map(c => c.text || c.thinking || '').join(' ').trim();
        }
      } else {
        const assistantText = String(lastAssistantMessage);
        // Fallback for flat string thinking block extraction
        const match = assistantText.match(/<thinking>([\s\S]*?)<\/thinking>/);
        if (match && match[1]) {
          latestThinking = match[1].trim();
        } else {
          latestThinking = assistantText.trim();
        }
      }
    }
  } catch (err) {
    console.error('Error parsing transcript:', err);
  }

  if (taskTitle.length > 80) taskTitle = taskTitle.substring(0, 77) + '...';
  if (latestThinking.length > 200) latestThinking = latestThinking.substring(0, 197) + '...';

  return { taskTitle, latestThinking };
}

// Handle decision (from device or Web Dashboard)
function handleApprovalAction(id, action, source) {
  const index = pendingRequests.findIndex(r => r.id === id);
  if (index === -1) return false;

  const req = pendingRequests[index];
  const approved = action === 'approve';

  // Respond to suspended HTTP request
  try {
    req.res.json({ approved });
  } catch (err) {
    console.error('Error sending HTTP response:', err);
  }

  // Remove from pending list
  pendingRequests.splice(index, 1);

  // Save to history (persistent, enforces retention limit)
  addHistoryEntry({
    id: req.id,
    command: req.command,
    cwd: req.cwd,
    agent: req.agent,
    task_title: req.task_title,
    thinking: req.thinking,
    mode: req.mode,
    status: approved ? 'Approved' : 'Rejected',
    source: source,
    timestamp: new Date().toLocaleTimeString()
  });

  // Notify device and dash
  broadcastQueueToDevice();
  
  // Publish state change to MQTT to reset screen to idle or show success/failure
  if (mqttClient && mqttClient.connected) {
    const animState = approved ? 'jump' : 'failed';
    const cid = config.clientId || 'client_zyx_s3';
    mqttClient.publish(`ai/pet_state/${cid}`, JSON.stringify({ state: animState, duration: 2000 }));
  }
  
  return true;
}

// Hook endpoint
app.post('/api/approve', async (req, res) => {
  // Support both Claude Code raw hook payload and our legacy payload
  const rawCommand = req.body.command || (req.body.tool_input && req.body.tool_input.command) || '';
  const toolName = req.body.tool_name || req.body.toolName || '';
  const toolInput = req.body.tool_input || req.body.toolInput || {};
  const cwd = req.body.cwd || req.body.working_directory || '';
  const session_id = req.body.session_id || '';
  const transcript_path = req.body.transcript_path || '';
  const agent = req.body.agent || 'claude-code';

  // Resolve the Mode
  const mode = resolveMode(cwd, agent);
  console.log(`Resolved execution mode [${mode}] for ${agent} in ${cwd}`);

  // Handle Mode Actions
  if (mode === 'disabled') {
    res.json({ approved: true });
    return;
  }

  if (mode === 'freefly' || mode === 'monitor' || mode === 'companion') {
    // Immediate Auto-Approval
    res.json({ approved: true });

    // Parse details asynchronously to update dashboard history and ESP32 pet animations
    parseTranscript(transcript_path).then(({ taskTitle, latestThinking }) => {
      const description = formatToolDescription(toolName, toolInput, rawCommand);
      
      // Update history (persistent, enforces retention limit)
      addHistoryEntry({
        id: 'auto_' + Date.now(),
        command: rawCommand || description,
        cwd,
        agent,
        task_title: taskTitle,
        thinking: latestThinking,
        mode,
        status: 'Auto-Approved',
        source: 'system',
        timestamp: new Date().toLocaleTimeString()
      });

      // Trigger companion status updates on ESP32 screen
      if (mqttClient && mqttClient.connected) {
        // Send state animation
        let espState = 'run';
        if (mode === 'companion') {
          // Map tool to state
          const lowerTool = toolName.toLowerCase();
          if (lowerTool === 'read' || lowerTool === 'grep' || lowerTool === 'glob') {
            espState = 'review';
          }
        }
        
        const cid = config.clientId || 'client_zyx_s3';
        mqttClient.publish(`ai/pet_state/${cid}`, JSON.stringify({ 
          state: espState, 
          duration: 3000,
          text: description,
          thinking: latestThinking,
          agent: agent
        }));
      }
    });

    return;
  }

  // Strict Guard (Interception Blocking Flow)
  const id = 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  console.log(`[Strict Guard] Suspending command approval request: ${rawCommand || toolName}`);

  // Parse details
  const { taskTitle, latestThinking } = await parseTranscript(transcript_path);
  const friendlyDescription = formatToolDescription(toolName, toolInput, rawCommand);

  const requestObj = {
    id,
    command: rawCommand || friendlyDescription,
    cwd,
    session_id,
    transcript_path,
    task_title: taskTitle,
    thinking: latestThinking,
    agent,
    mode: 'strict',
    res, // Store the HTTP response object to hold it open
    timestamp: new Date().toLocaleTimeString()
  };

  pendingRequests.push(requestObj);

  // Broadcast to MQTT (triggers automatic pop up on ESP32 screen!)
  if (mqttClient && mqttClient.connected) {
    const payload = {
      id,
      command: rawCommand || friendlyDescription,
      task_title: taskTitle,
      thinking: latestThinking,
      agent,
      cwd
    };
    const cid = config.clientId || 'client_zyx_s3';
    mqttClient.publish(`ai/request/${cid}`, JSON.stringify(payload));
  }

  broadcastQueueToDevice();

  // Set timeout (60 seconds)
  setTimeout(() => {
    const stillPending = pendingRequests.find(r => r.id === id);
    if (stillPending) {
      console.log(`Request ${id} timed out.`);
      handleApprovalAction(id, 'reject', 'timeout');
    }
  }, 60000);
});

// Notify endpoint
app.post('/api/notify', (req, res) => {
  const { title, message, status } = req.body;

  if (mqttClient && mqttClient.connected) {
    const payload = {
      title: title || 'Notification',
      message: message || '',
      status: status || 'info',
      timestamp: new Date().toLocaleTimeString()
    };
    const cid = config.clientId || 'client_zyx_s3';
    mqttClient.publish(`ai/notify/${cid}`, JSON.stringify(payload));
    res.json({ success: true });
  } else {
    res.status(503).json({ error: 'MQTT client not connected' });
  }
});

// Config Endpoints
app.get('/api/config', (req, res) => {
  res.json(config);
});

app.post('/api/config', (req, res) => {
  config = { ...config, ...req.body };
  saveConfig();
  updateMQTTSubscriptions();
  syncHookInstallations();
  broadcastStatus();
  res.json({ success: true, config });
});

// Toggle Free Fly Mode
app.post('/api/config/freefly', (req, res) => {
  if (typeof req.body.freeFlyMode === 'boolean') {
    config.freeFlyMode = req.body.freeFlyMode;
    saveConfig();
    broadcastStatus();
    console.log(`Free Fly Mode toggled: ${config.freeFlyMode ? 'ON' : 'OFF'}`);
    
    // Reset any active pending requests if Free Fly Mode is enabled
    if (config.freeFlyMode && pendingRequests.length > 0) {
      console.log(`Free Fly Mode enabled. Auto-approving all ${pendingRequests.length} pending requests.`);
      const requestsToApprove = [...pendingRequests];
      for (const req of requestsToApprove) {
        handleApprovalAction(req.id, 'approve', 'freefly_override');
      }
    }
    
    res.json({ success: true, freeFlyMode: config.freeFlyMode });
  } else {
    res.status(400).json({ error: 'Invalid freeFlyMode flag' });
  }
});

// Hook Status and Management
app.get('/api/hooks/status', (req, res) => {
  const platforms = ['claude-code', 'antigravity', 'gemini', 'codex', 'opencode'];
  const statuses = platforms.map(id => {
    const status = hooksManager.getAgentStatus(id);
    const resolvedMode = config.platforms[id] || config.global.mode;
    return {
      id,
      name: status.name,
      detected: status.detected,
      installed: status.installed,
      configPath: status.configPath,
      mode: resolvedMode
    };
  });
  res.json({ statuses });
});

app.post('/api/hooks/toggle', (req, res) => {
  const { agentId, mode } = req.body;
  if (!agentId || !mode) return res.status(400).json({ error: 'Missing agentId or mode' });

  console.log(`Setting platform ${agentId} mode to: ${mode}`);
  config.platforms[agentId] = mode;
  saveConfig();
  syncHookInstallations();
  res.json({ success: true, config });
});

// Projects Config
app.post('/api/config/projects', (req, res) => {
  const { projectPath, mode, platforms } = req.body;
  if (!projectPath) return res.status(400).json({ error: 'Missing projectPath' });
  
  if (mode === 'delete') {
    delete config.projects[projectPath];
  } else {
    config.projects[projectPath] = {
      mode: mode || 'strict',
      platforms: platforms || {}
    };
  }
  
  saveConfig();
  res.json({ success: true, config });
});

// Pet Endpoints
app.get('/api/pets/store', async (req, res) => {
  const manifest = await petManager.fetchManifest();
  res.json(manifest);
});

app.get('/api/pets/imported', (req, res) => {
  const imported = petManager.getImportedPets();
  res.json({ pets: imported });
});

// Helper to clean and resolve pet.json URLs from direct links or page links
async function resolvePetJsonUrl(inputUrl) {
  // 1. Clean typos like "https;?/", "http;?/", "https:?//", "https;?/", etc.
  let cleaned = inputUrl.trim();
  cleaned = cleaned.replace(/^(https?)[;:?/\s]+/i, '$1://');
  
  // Make sure it has protocol
  if (!cleaned.startsWith('http://') && !cleaned.startsWith('https://')) {
    cleaned = 'https://' + cleaned;
  }

  // If it already ends in .json, it is the direct link
  if (cleaned.toLowerCase().endsWith('.json') || cleaned.toLowerCase().endsWith('.jsonl')) {
    return { petJsonUrl: cleaned };
  }

  // 2. Try to extract slug from URL
  let slug = null;
  // Match "/pets/slug", "/pet/slug", "?pets/slug", "?pet/slug", "&pets/slug", "/pets/#/slug", etc.
  let match = cleaned.match(/[/?&]pets?\/#?\/([a-zA-Z0-9_-]+)/i);
  if (match) {
    slug = match[1];
  } else {
    // Match query parameter "pet=slug" or "pets=slug"
    match = cleaned.match(/[?&]pets?=([a-zA-Z0-9_-]+)/i);
    if (match) {
      slug = match[1];
    }
  }

  console.log(`[URL Resolver] Cleaned URL: ${cleaned}, extracted slug: ${slug}`);

  // 3. Search in local manifest if slug is found
  if (slug) {
    try {
      const manifest = await petManager.fetchManifest();
      const storePets = manifest.pets || [];
      const found = storePets.find(p => p.slug === slug || p.id === slug);
      if (found && found.petJsonUrl) {
        console.log(`[URL Resolver] Found slug "${slug}" in manifest. pet.json: ${found.petJsonUrl}`);
        return { petJsonUrl: found.petJsonUrl, spritesheetUrl: found.spritesheetUrl };
      }
    } catch (e) {
      console.error('[URL Resolver] Failed to query manifest:', e);
    }
  }

  // 4. Fetch the webpage HTML and scan for JSON urls
  try {
    console.log(`[URL Resolver] Fetching page HTML to scan for pet.json: ${cleaned}`);
    const pageRes = await fetch(cleaned);
    if (pageRes.ok) {
      const html = await pageRes.text();
      // Search for any pet.json or petjson.json URL
      let jsonMatch = html.match(/https?:\/\/[^\s"'`<>]+?\/(?:pet\.json|petjson\.json|metadata\.json)/i);
      if (!jsonMatch && slug) {
        // Look for any .json containing slug
        jsonMatch = html.match(new RegExp('https?:\\/\\/[^\\s"\'`<>]+?\\/' + slug + '[^\\s"\'`<>]*?\\.json', 'i'));
      }
      if (!jsonMatch) {
        // Look for relative links to json files
        const relMatch = html.match(/["']([^"'\s<>]+?\.(?:json))["']/i);
        if (relMatch) {
          jsonMatch = [new URL(relMatch[1], cleaned).href];
        }
      }
      if (jsonMatch && jsonMatch[0]) {
        console.log(`[URL Resolver] Scraped JSON URL from HTML: ${jsonMatch[0]}`);
        return { petJsonUrl: jsonMatch[0] };
      }
    }
  } catch (err) {
    console.error(`[URL Resolver] Failed to fetch page HTML for scanning:`, err);
  }

  // 5. Test fallback standard URL patterns
  if (slug) {
    const parsed = new URL(cleaned);
    const origin = parsed.origin;
    const fallbacks = [
      `${origin}/api/pets/${slug}`,
      `${origin}/api/pet/${slug}`,
      `${origin}/pets/${slug}/pet.json`,
      `${origin}/pets/${slug}/petjson.json`,
      `${origin}/${slug}/pet.json`,
      cleaned.endsWith('/') ? `${cleaned}pet.json` : `${cleaned}/pet.json`,
      cleaned.endsWith('/') ? `${cleaned}petjson.json` : `${cleaned}/petjson.json`
    ];

    console.log(`[URL Resolver] Testing standard fallback JSON paths:`, fallbacks);
    for (const url of fallbacks) {
      try {
        const testRes = await fetch(url);
        if (testRes.ok) {
          console.log(`[URL Resolver] Fallback path exists! Resolving to: ${url}`);
          return { petJsonUrl: url };
        }
      } catch {}
    }
  }

  throw new Error(`无法从链接解析出 pet.json。请确保链接包含正确的宠物信息。`);
}

app.post('/api/pets/import-url', async (req, res) => {
  const { petJsonUrl } = req.body;
  if (!petJsonUrl) {
    return res.status(400).json({ error: 'Missing petJsonUrl' });
  }

  try {
    // Resolve page links to actual pet.json URL
    const resolvedResult = await resolvePetJsonUrl(petJsonUrl);
    const resolvedJsonUrl = resolvedResult.petJsonUrl;
    console.log(`Resolved petJsonUrl: ${resolvedJsonUrl}`);

    console.log(`Fetching pet.json from ${resolvedJsonUrl}...`);
    const petRes = await fetch(resolvedJsonUrl);
    if (!petRes.ok) throw new Error(`HTTP error: ${petRes.status}`);
    let petJson = await petRes.json();
    if (petJson.pet) {
      petJson = petJson.pet;
    }

    const slug = petJson.id;
    if (!slug) throw new Error('pet.json missing required "id" field');

    // Use spritesheet URL from manifest or API if we matched one, otherwise build relative to pet.json
    let spritesheetUrl = resolvedResult.spritesheetUrl || petJson.spritesheetUrl;
    if (!spritesheetUrl) {
      const spritesheetPath = petJson.spritesheetPath || 'spritesheet.webp';
      spritesheetUrl = new URL(spritesheetPath, resolvedJsonUrl).href;
    }

    console.log(`Parsed pet slug: ${slug}, Spritesheet URL: ${spritesheetUrl}`);
    const binPath = await petManager.importPetByDetails(slug, resolvedJsonUrl, spritesheetUrl);
    res.json({ success: true, slug, binPath });
  } catch (err) {
    console.error(`URL Import failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pets/upload', uploader.fields([
  { name: 'petJson', maxCount: 1 },
  { name: 'spritesheet', maxCount: 1 }
]), async (req, res) => {
  try {
    const petJsonFile = req.files && req.files.petJson ? req.files.petJson[0] : null;
    const spritesheetFile = req.files && req.files.spritesheet ? req.files.spritesheet[0] : null;

    if (!petJsonFile || !spritesheetFile) {
      return res.status(400).json({ error: 'Both petJson and spritesheet files are required' });
    }

    const petJsonContent = fs.readFileSync(petJsonFile.path, 'utf8');
    const petJson = JSON.parse(petJsonContent);
    const slug = petJson.id;

    if (!slug) {
      throw new Error('pet.json missing required "id" field');
    }

    const targetDir = path.join(petManager.PETS_DIR, slug);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    fs.writeFileSync(path.join(targetDir, 'pet.json'), JSON.stringify(petJson, null, 2), 'utf8');

    const isPng = spritesheetFile.originalname.endsWith('.png');
    const ext = isPng ? 'png' : 'webp';
    const destPath = path.join(targetDir, `spritesheet.${ext}`);
    fs.renameSync(spritesheetFile.path, destPath);

    if (fs.existsSync(petJsonFile.path)) {
      fs.unlinkSync(petJsonFile.path);
    }

    console.log(`Importing files locally for slug "${slug}"...`);
    const binPath = await petManager.processAndPackagePet(slug);

    res.json({ success: true, slug, binPath });
  } catch (err) {
    console.error(`File upload import failed:`, err);
    if (req.files) {
      for (const fieldname in req.files) {
        req.files[fieldname].forEach(file => {
          if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        });
      }
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pets/import', async (req, res) => {
  const { slug, petJsonUrl, spritesheetUrl } = req.body;
  if (!slug || !petJsonUrl || !spritesheetUrl) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const binPath = await petManager.importPetByDetails(slug, petJsonUrl, spritesheetUrl);
    res.json({ success: true, slug, binPath });
  } catch (err) {
    console.error(`Failed to import pet ${slug}:`, err);
    res.status(500).json({ error: err.message });
  }
});

function getLocalIPAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Helper to package pet and broadcast download URL to ESP32 S3 over MQTT
async function syncActivePetToDevice(slug) {
  if (!slug) throw new Error('Missing pet slug');

  // Generate binary package if not present
  await petManager.processAndPackagePet(slug);
  
  // Upload to Qiniu Cloud if configured, fallback to tmpfile.link, fallback to local tunnel
  let downloadUrl = '';
  let usedCdn = false;

  if (isQiniuConfigured()) {
    try {
      console.log(`Uploading pet binary to Qiniu Cloud CDN...`);
      downloadUrl = await petManager.uploadToQiniu(slug);
      usedCdn = true;
      console.log(`Download URL (Qiniu CDN): ${downloadUrl}`);
    } catch (qiniuErr) {
      console.error(`Qiniu upload failed: ${qiniuErr.message}, falling back to tmpfile.link...`);
    }
  }

  if (!usedCdn) {
    try {
      console.log(`Uploading pet binary to tmpfile.link...`);
      downloadUrl = await petManager.uploadToTmpFiles(slug);
      console.log(`Download URL (tmpfile.link): ${downloadUrl}`);
    } catch (uploadErr) {
      console.error(`tmpfile.link upload failed: ${uploadErr.message}`);
      if (publicTunnelUrl) {
        downloadUrl = `${publicTunnelUrl}/pets/${slug}/pet_assets.bin`;
        console.log(`Falling back to tunnel URL: ${downloadUrl}`);
      } else {
        throw new Error('No download URL available: tmpfile.link failed and tunnel not ready');
      }
    }
  }
  
  // Read display name
  const petJsonPath = path.join(petManager.PETS_DIR, slug, 'pet.json');
  const petJson = JSON.parse(fs.readFileSync(petJsonPath, 'utf8'));

  // Broadcast to ESP32-S3 over MQTT
  if (mqttClient && mqttClient.connected) {
    const cid = config.clientId || 'client_zyx_s3';
    mqttClient.publish(`ai/pet_changed/${cid}`, JSON.stringify({
      slug,
      url: downloadUrl,
      displayName: petJson.displayName
    }), { retain: true });
  }

  return { slug, downloadUrl, displayName: petJson.displayName };
}

// Select active pet and publish binary file link via MQTT
app.post('/api/pets/active', async (req, res) => {
  const { slug } = req.body;
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  try {
    const result = await syncActivePetToDevice(slug);
    config.activePet = result.slug;
    saveConfig();
    broadcastStatus();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(`Failed to activate pet ${slug}:`, err);
    res.status(500).json({ error: err.message });
  }
});

// Delete Local Pet Endpoint
app.delete('/api/pets/:slug', (req, res) => {
  const { slug } = req.params;
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  // Prevent path traversal
  const targetDir = path.resolve(petManager.PETS_DIR, slug);
  if (!targetDir.startsWith(petManager.PETS_DIR) || targetDir === petManager.PETS_DIR) {
    return res.status(400).json({ error: 'Invalid pet ID' });
  }

  // Prevent deleting active pet
  if (slug === config.activePet) {
    return res.status(400).json({ error: '无法删除当前活跃中的宠物。请先切换至其他活跃宠物再进行删除！' });
  }

  try {
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      console.log(`Deleted local pet directory: ${targetDir}`);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: '宠物未找到' });
    }
  } catch (err) {
    console.error(`Failed to delete pet ${slug}:`, err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/active-pet/metadata', (req, res) => {
  const petJsonPath = path.join(petManager.PETS_DIR, config.activePet, 'pet.json');
  if (fs.existsSync(petJsonPath)) {
    try {
      const petJson = JSON.parse(fs.readFileSync(petJsonPath, 'utf8'));
      petJson.id = config.activePet; // Force ID to match folder name for UI tracking
      return res.json(petJson);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to read pet metadata' });
    }
  }
  res.status(404).json({ error: 'Active pet metadata not found' });
});

// Dashboard Action Endpoint
app.post('/api/action', (req, res) => {
  const { id, action } = req.body;
  const success = handleApprovalAction(id, action, 'web_dashboard');
  res.json({ success });
});

// Update log retention limit
app.post('/api/config/retention', (req, res) => {
  const { limit } = req.body;
  if (!Number.isInteger(limit) || limit < 10) {
    return res.status(400).json({ error: 'Limit must be an integer >= 10' });
  }
  config.logRetentionLimit = limit;
  saveConfig();
  // Trim existing history to new limit immediately
  if (requestHistory.length > limit) {
    requestHistory = requestHistory.slice(-limit);
    saveHistory();
  }
  res.json({ success: true, logRetentionLimit: config.logRetentionLimit });
});

// Safe Shutdown: uninstall all hooks then exit
app.post('/api/shutdown', async (req, res) => {
  console.log('Safe shutdown initiated: removing all hooks...');
  
  const platforms = ['claude-code', 'antigravity', 'gemini', 'codex', 'opencode'];
  const results = [];
  for (const agentId of platforms) {
    const status = hooksManager.getAgentStatus(agentId);
    if (status.installed) {
      try {
        hooksManager.uninstallAgentHook(agentId);
        results.push({ agentId, success: true });
        console.log(`  ✓ Uninstalled hook for ${agentId}`);
      } catch (err) {
        results.push({ agentId, success: false, error: err.message });
        console.error(`  ✗ Failed to uninstall hook for ${agentId}:`, err.message);
      }
    } else {
      results.push({ agentId, success: true, skipped: true });
    }
  }
  
  // Persist final history before exit
  saveHistory();
  
  res.json({ success: true, message: '所有 Hook 已清理，守护进程即将关闭。', results });
  
  // Gracefully exit after sending response
  setTimeout(() => {
    console.log('Daemon exiting cleanly.');
    process.exit(0);
  }, 500);
});

// Status Endpoint
app.get('/api/status', (req, res) => {
  const cdnEnabled = isQiniuConfigured();
  res.json({
    mqtt: mqttClient ? mqttClient.connected : false,
    deviceOnline: lastDeviceHeartbeat > 0 && (Date.now() - lastDeviceHeartbeat < 15000),
    client_id: config.clientId || 'client_zyx_s3',
    broker: MQTT_BROKER,
    cdnEnabled,
    config,
    pending: pendingRequests.map(r => ({
      id: r.id,
      command: r.command,
      cwd: r.cwd,
      agent: r.agent,
      task_title: r.task_title,
      thinking: r.thinking,
      timestamp: r.timestamp
    })),
    history: requestHistory
  });
});

// Non-blocking hook event endpoint (called asynchronously by non-strict hooks)
// Immediately returns 200, then publishes pet animation state via MQTT in background
app.post('/api/hook/event', (req, res) => {
  const toolName = req.body.tool_name || '';
  const toolInput = req.body.tool_input || {};
  const command = req.body.command || '';
  const cwd = req.body.cwd || '';
  const agent = req.body.agent || 'unknown';

  // Respond immediately — caller already exited and doesn't wait
  res.json({ received: true });

  // Map tool name to pet animation state
  const READ_TOOLS = new Set([
    'read', 'view_file', 'viewfile', 'grep', 'grep_search', 'glob',
    'list_dir', 'list_directory', 'search_web', 'web_search', 'read_url', 'read_url_content'
  ]);
  const lowerTool = toolName.toLowerCase();
  const petState = READ_TOOLS.has(lowerTool) ? 'review' : 'run';

  console.log(`[hook/event] agent=${agent} tool=${toolName || '(none)'} → pet:${petState}`);

  // Resolve the Mode
  const mode = resolveMode(cwd, agent);

  // If mode is disabled, do not log or broadcast pet animation
  if (mode === 'disabled') {
    return;
  }

  // Update history (persistent, enforces retention limit)
  const description = formatToolDescription(toolName, toolInput, command);
  addHistoryEntry({
    id: req.body.id || 'auto_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    command: command || description,
    cwd,
    agent,
    task_title: '自动审计任务',
    thinking: '',
    mode,
    status: 'Auto-Approved',
    source: 'system',
    timestamp: new Date().toLocaleTimeString()
  });

  // Async MQTT publish (non-blocking)
  if (mqttClient && mqttClient.connected) {
    const cid = config.clientId || 'client_zyx_s3';
    mqttClient.publish(`ai/pet_state/${cid}`, JSON.stringify({ 
      state: petState, 
      duration: 5000,
      text: description,
      agent: agent
    }));
  }
});

// Command result endpoint (called after command finishes in non-strict mode)
// Publishes jump (exit 0) or failed (exit != 0) for 3 seconds, then returns to idle
app.post('/api/result', (req, res) => {
  const id = req.body.id;
  const exitCode = parseInt(req.body.exit_code, 10);
  const agent = req.body.agent || 'unknown';
  const command = req.body.command || '';

  res.json({ received: true });

  const animState = exitCode === 0 ? 'jump' : 'failed';
  console.log(`[result] id=${id || '(none)'} agent=${agent} exit=${exitCode} → pet:${animState}`);

  if (id) {
    const entry = requestHistory.find(h => h.id === id);
    if (entry) {
      entry.exitCode = exitCode;
      saveHistory();
    }
  }

  if (mqttClient && mqttClient.connected) {
    const cid = config.clientId || 'client_zyx_s3';
    mqttClient.publish(`ai/pet_state/${cid}`, JSON.stringify({ state: animState, duration: 3000, agent: agent }));

    // Return to idle after 3 seconds
    setTimeout(() => {
      if (mqttClient && mqttClient.connected) {
        mqttClient.publish(`ai/pet_state/${cid}`, JSON.stringify({ state: 'idle' }));
      }
    }, 3000);
  }
});

app.listen(PORT, () => {
  console.log(`Local daemon listening on http://localhost:${PORT}`);
});

