# 宠物自愈同步机制实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现硬件长时间关机重连后，自动、自愈地重新从后端加载当前宠物，并实现电量上报。

**Architecture:** 硬件将心跳字符串升级为带有状态的 JSON 格式，在重连成功和运行中上报给后端；后端接收到状态后如果发现硬件无宠物或宠物不匹配，自动调用级联分级上传机制生成最新链接，并下发同步通知。

**Tech Stack:** C++ (Arduino / ESP32-S3), Node.js (Express, MQTT)

---

### Task 1: 固件端心跳 JSON 化重构

**Files:**
- Modify: `src/main.cpp:1610-1810`

- [ ] **Step 1: 在 setup 前定义并实现 `sendHeartbeat()` 函数**

在 `src/main.cpp` 的 `connectWiFi()` 函数之前（大约第 1610 行），插入 `sendHeartbeat()` 函数定义：

```cpp
void sendHeartbeat() {
  if (!mqttClient.connected()) return;
  
  JsonDocument doc;
  doc["pet_loaded"] = petLoaded;
  doc["active_slug"] = activePetSlug;
  doc["battery"] = batteryPct;
  doc["charging"] = isCharging;
  
  String payload;
  serializeJson(doc, payload);
  
  String topic = "ai/heartbeat/" + String(client_id);
  mqttClient.publish(topic.c_str(), payload.c_str());
  Serial.printf("Sent heartbeat payload: %s\n", payload.c_str());
}
```

- [ ] **Step 2: 在 MQTT 重连成功订阅完成后立即触发一次状态心跳**

修改 `src/main.cpp` 中的 `reconnectMQTT()` 函数，在 MQTT 订阅完所有 topic 之后（大约第 1685 行），添加立即发送心跳逻辑：

```cpp
        mqttClient.subscribe(requestTopic.c_str());
        mqttClient.subscribe(queueTopic.c_str());
        mqttClient.subscribe(notifyTopic.c_str());
        mqttClient.subscribe(petChangedTopic.c_str());
        mqttClient.subscribe(petStateTopic.c_str());
        
        // 连上后立即发送状态，促使后端同步
        sendHeartbeat();
        
        updateUI();
```

- [ ] **Step 3: 将 `loop()` 中的老心跳替换为 `sendHeartbeat()`**

修改 `src/main.cpp` 的 `loop()` 函数，将原本的 `"ping"` 字符串定时发送（大约第 1793 行）修改为：

```cpp
  // Send heartbeat every 5 seconds
  static unsigned long lastHeartbeatTime = 0;
  if (millis() - lastHeartbeatTime > 5000) {
    lastHeartbeatTime = millis();
    sendHeartbeat();
  }
```

- [ ] **Step 4: 编译固件以确保没有语法错误**

Run: `.venv/bin/pio run`
Expected: 编译成功 (SUCCESS)

- [ ] **Step 5: 提交固件端修改**

```bash
git add src/main.cpp
git commit -m "feat(firmware): 升级心跳为 JSON 格式上报状态，重连立即发送心跳"
```

---

### Task 2: 后端端抽取公共同步函数 `syncActivePetToDevice`

**Files:**
- Modify: `local-daemon/server.js:990-1065`

- [ ] **Step 1: 在 server.js 中定义 `syncActivePetToDevice` 异步函数**

在 `app.post('/api/pets/active'` 接口的前面（大约第 990 行），插入公共宠物打包与同步广播函数：

```javascript
async function syncActivePetToDevice(slug) {
  if (!slug) throw new Error('Missing pet slug');
  
  // 1. 生成二进制包
  await petManager.processAndPackagePet(slug);
  
  // 2. 级联分级上传获取链接 (七牛 CDN -> tmpfile.link -> 本地 tunnel)
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
  
  // 3. 读取显示名称
  const petJsonPath = path.join(petManager.PETS_DIR, slug, 'pet.json');
  const petJson = JSON.parse(fs.readFileSync(petJsonPath, 'utf8'));

  // 4. 广播推送给设备
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
```

- [ ] **Step 2: 重构 `/api/pets/active` 路由逻辑**

将原有的 `/api/pets/active` 逻辑（大约第 997 行到 1059 行）替换为对 `syncActivePetToDevice` 的调用：

```javascript
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
```

- [ ] **Step 3: 提交后端抽取公共方法修改**

```bash
git add local-daemon/server.js
git commit -m "refactor(backend): 抽取公共宠物打包上传并向设备同步的函数"
```

---

### Task 3: 后端端心跳自愈与电量上报逻辑重构

**Files:**
- Modify: `local-daemon/server.js:250-265`

- [ ] **Step 1: 修改心跳接收回调中的逻辑**

在 `local-daemon/server.js` 中找到 MQTT 处理 `ai/heartbeat/${currentId}` 的位置（大约第 254 行），修改为：

```javascript
    if (topicStr === `ai/heartbeat/${currentId}`) {
      lastDeviceHeartbeat = Date.now();
      
      try {
        const payload = JSON.parse(message.toString());
        
        // 缓存电量及充电信息到 config 中（便于后续扩展展示）
        if (typeof payload.battery === 'number') {
          config.deviceBattery = payload.battery;
          config.deviceCharging = !!payload.charging;
        }

        // 自愈同步判断：设备未加载宠物，或者设备上报的宠物与后端配置的不匹配
        const deviceNeedsPet = !payload.pet_loaded || payload.active_slug !== config.activePet;
        if (deviceNeedsPet) {
          console.log(`[Sync System] Device reports pet not loaded or slug mismatch (device: "${payload.active_slug || ''}", config: "${config.activePet}"). Triggering automatic sync...`);
          syncActivePetToDevice(config.activePet).catch(err => {
            console.error('[Sync System] Auto sync active pet to device failed:', err);
          });
        }
      } catch (e) {
        // 兼容发送旧版 "ping" 的设备
        console.log(`[Sync System] Legacy heartbeat received from ${currentId}: "${message.toString()}"`);
      }
      return;
    }
```

- [ ] **Step 2: 运行后端测试是否存在语法错误**

Run: `node --check local-daemon/server.js`
Expected: 无输出（表示没有语法错误）

- [ ] **Step 3: 提交心跳自愈与电量上报逻辑**

```bash
git add local-daemon/server.js
git commit -m "feat(backend): 重构心跳包监听，实现设备缺少宠物时的自愈同步以及电量接收"
```

---

### Task 4: 完整验证测试

- [ ] **Step 1: 执行整体测试**
  1. 编译并烧录固件：`.venv/bin/pio run -t upload`。
  2. 运行后端服务并开启调试，观察心跳日志是否打印接收到电量和自愈请求。
  3. 模拟长时间关机重连：设备开机或断电重连后，查看是否在收到第一条 JSON 心跳后立即触发了宠物打包、CDN上传并下发 `ai/pet_changed` 同步命令。
  4. 确认设备是否成功自动加载出宠物。
