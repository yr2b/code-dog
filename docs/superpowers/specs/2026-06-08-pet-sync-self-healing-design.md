# 2026-06-08 宠物同步与自愈机制设计规范

## 背景与问题描述

在项目使用过程中，存在以下问题：
1. **长时间关机后重新上电，无法自动加载宠物**：由于设备的宠物二进制数据（例如图像帧及动作配置）存放在设备的 PSRAM 内存中，关机断电会导致内存清空。
2. **下载链接失效**：固件重新上电并连接上 MQTT 后，虽然会收到来自 MQTT 的 `ai/pet_changed` 历史 Retain 消息，但该消息中的宠物下载链接（例如由 `tmpfile.link` 产生的临时链接，或由 `localhost.run` 隧道重启前生成的链接）可能已经过期，导致设备下载失败并卡在未加载状态。
3. **缺乏主动同步机制**：设备只是单向接收 Topic，没有主动上报自己当前缺失宠物资源的状态，后端无法感知设备上线并重新同步有效的下载链接。

## 解决方案

本项目采用**基于 JSON 心跳包的自愈式状态同步方案**。

### 1. 固件端改动 (`src/main.cpp`)

* **心跳格式升级**：
  将原本的 `"ping"` 字符串心跳更改为 JSON 格式。心跳中应携带设备的实时状态：
  - `pet_loaded`: 当前是否已成功加载宠物资产 (`bool`)
  - `active_slug`: 当前正在运行的宠物标识符 (`String`)
  - `battery`: 电池电量百分比 (`int`)
  - `charging`: 当前是否在充电 (`bool`)

* **连接成功立即上报**：
  当 MQTT 连接并订阅成功后，**立即**主动发送一次上述 JSON 状态心跳，使得后端能第一时间感应到设备刚开机上线。

* **心跳周期上报**：
  在 `loop()` 循环中，每 5 秒发送一次最新的 JSON 状态心跳。

### 2. 后端端改动 (`local-daemon/server.js`)

* **抽取公共同步函数 `syncActivePetToDevice(slug)`**：
  封装宠物的打包与分级级联上传逻辑（优先七牛云 CDN -> 其次 `tmpfile.link` -> 最后本地隧道 `publicTunnelUrl`），生成有效链接，并广播推送给设备：
  ```javascript
  async function syncActivePetToDevice(slug) { ... }
  ```
* **激活 API `/api/pets/active` 重构**：
  调用抽取的 `syncActivePetToDevice` 函数，更新全局配置并同步给设备。

* **心跳接收逻辑自愈改造**：
  在接收到 `ai/heartbeat/${client_id}` 主题的心跳包时，解析 JSON 内容：
  - 更新电池电量和充电信息（可用于后端状态监控）。
  - 判断自愈条件：如果设备 `pet_loaded === false`，或者设备上报的 `active_slug` 与后端配置的 `config.activePet` 不匹配，则自动重新打包并级联上传宠物，生成最新的有效链接推送给设备。
  - 兼容发送旧版 `"ping"` 纯文本心跳包的设备，避免解析失败导致崩溃。

---

## 模块设计细节

### 固件端 (`src/main.cpp`)

#### 头文件引入
确保已引入 ArduinoJson：
```cpp
#include <ArduinoJson.h>
```

#### 心跳上报实现
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

#### 连接及定时触发
```cpp
// reconnectMQTT 中
if (mqttClient.connect(clientId.c_str())) {
  // ... 订阅 topics ...
  sendHeartbeat(); // 连上立即上报
}

// loop 中
static unsigned long lastHeartbeatTime = 0;
if (millis() - lastHeartbeatTime > 5000) {
  lastHeartbeatTime = millis();
  sendHeartbeat();
}
```

---

### 后端端 (`local-daemon/server.js`)

#### 公共同步函数 `syncActivePetToDevice(slug)`
```javascript
async function syncActivePetToDevice(slug) {
  if (!slug) throw new Error('Missing pet slug');
  
  await petManager.processAndPackagePet(slug);
  
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
  
  const petJsonPath = path.join(petManager.PETS_DIR, slug, 'pet.json');
  const petJson = JSON.parse(fs.readFileSync(petJsonPath, 'utf8'));

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

#### 心跳处理器自愈逻辑
```javascript
    if (topicStr === `ai/heartbeat/${currentId}`) {
      lastDeviceHeartbeat = Date.now();
      
      try {
        const payload = JSON.parse(message.toString());
        
        if (typeof payload.battery === 'number') {
          config.deviceBattery = payload.battery;
          config.deviceCharging = !!payload.charging;
        }

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

---

## 验证与测试方案

1. **固件编译校验**：
   运行 `pio run` 确保固件修改无语法错误并成功生成编译产物。
2. **连接稳定性与心跳上报校验**：
   运行本地后端服务，观察设备连上 MQTT 后的心跳上报情况，并在控制台检查是否输出 JSON 格式 payload。
3. **长时间关机模拟测试（自愈测试）**：
   - 彻底关闭设备电源（或拉低锁存引脚关机），在后端切换当前活跃宠物。
   - 等待一段时间后，设备重新上电。
   - 观察控制台日志：后端接收到设备 `pet_loaded === false` 的心跳，并自动重新触发七牛云或本地隧道上传，最后下发新宠物链接给设备。
   - 验证设备是否能自动下载并成功显示宠物。
