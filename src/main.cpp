#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Arduino_GFX_Library.h>
#include <Wire.h>
#include "TouchDrvCSTXXX.hpp"
#include <vector>
#include <HTTPClient.h>
#include <PNGdec.h>
#include <Preferences.h>

// Board Display Definitions (Waveshare ESP32-S3 Touch LCD 1.54)
#define GFX_BL 46
Arduino_DataBus *bus = new Arduino_ESP32SPI(45 /* DC */, 21 /* CS */, 38 /* SCK */, 39 /* MOSI */, -1 /* MISO */);
Arduino_GFX *gfx = new Arduino_ST7789(bus, 40 /* RST */, 0 /* rotation */, true, 240, 240);

// Touch Definitions
#define SENSOR_SDA 42
#define SENSOR_SCL 41
#define SENSOR_IRQ 48
#define SENSOR_RST 47
TouchDrvCSTXXX touch;
volatile bool isPressed = false;
bool hasTouch = false;

// Button pin mapping
#define PIN_BOOT     0
#define PIN_PLUS     4
#define PIN_PWR      5

// Battery and Power Latch pin mapping
#define PIN_BAT_ADC  1
#define PIN_BAT_PWR  2
#define PIN_CHG      3

// Global battery status
int batteryPct = 100;
bool isCharging = false;
unsigned long lastBatteryUpdateTime = 0;

// Screen Brightness variables
int screenBrightness = 80;
Preferences prefs;

// Button state variables
unsigned long bootPressStart = 0;
unsigned long plusPressStart = 0;
unsigned long pwrPressStart = 0;
bool bootWasPressed = false;
bool plusWasPressed = false;
bool pwrWasPressed = false;

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

WiFiClient espClient;
PubSubClient mqttClient(espClient);

// Request Struct
struct ApprovalRequest {
  String id;
  String command;
  String task_title;
  String thinking;
  String agent;
  String cwd;
};

std::vector<ApprovalRequest> requests;
int currentRequestIndex = 0;

// Notification Struct
struct SysNotification {
  String title;
  String message;
  String status;
  unsigned long timestamp;
  bool active;
};
SysNotification activeNotification = {"", "", "", 0, false};

// Colors (RGB565)
#define COLOR_DARK_BG    0x10A2  // #101114 (Slate black)
#define COLOR_CARD_BG    0x18E5  // #18191c
#define COLOR_TEXT_MAIN  0xFFFF  // White
#define COLOR_TEXT_MUTED 0x9CF3  // Grey
#define COLOR_GREEN      0x138A  // Emerald Green
#define COLOR_RED        0xE208  // Coral Red
#define COLOR_CYAN       0x3E5F  // Sky Blue
#define COLOR_PURPLE     0xA29F  // Purple

// State Enumeration
enum ScreenState {
  STATE_COMPANION,    // Displays pet animation with thinking bubble
  STATE_APPROVAL,     // Blocking approval screen
  STATE_STATUS,       // System diagnostics screen
  STATE_NOTIFICATION  // Global notify card
};
ScreenState currentState = STATE_COMPANION;

// Pet Binary Asset Caching variables (SPIRAM allocation)
uint8_t* petBinBuffer = nullptr;
int petBinSize = 0;
uint16_t* petDoubleBuffer = nullptr;


struct FrameEntry {
  int32_t offset;
  int32_t size;
};

struct StateAnimation {
  char name[33];
  int32_t frames;
  int32_t width;
  int32_t height;
  int32_t offsetTableOffset;
  std::vector<FrameEntry> frameOffsets;
};

std::vector<StateAnimation> animations;
bool petLoaded = false;
String activePetSlug = "";
String activePetName = "";

// Mascot Animation Playback variables
String companionState = "idle";
unsigned long companionStateExpiry = 0;
String bubbleText = "";
unsigned long bubbleTextExpiry = 0;
String companionAgent = "";
int currentFrameIndex = 0;
unsigned long lastFrameTime = 0;

// Rendering state tracking (module-level, reset on pet change)
bool placeholderDrawn = false;
bool lastPetLoadedState = false;

// Static frame transparency check variable
static bool frameHasContent = false;

// 32x32 Monochrome bitmaps for AI platforms
const uint8_t PROGMEM logo_claude[] = {
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x07, 0xe0, 0x00,
  0x00, 0x3f, 0xfc, 0x00,
  0x00, 0xff, 0xff, 0x00,
  0x01, 0xf8, 0x1f, 0x80,
  0x03, 0xc0, 0x03, 0xc0,
  0x07, 0x03, 0xc0, 0xe0,
  0x0e, 0x0f, 0xf0, 0x70,
  0x1c, 0x3f, 0xfc, 0x38,
  0x18, 0x7c, 0x3e, 0x18,
  0x30, 0xf0, 0x0f, 0x0c,
  0x31, 0xe0, 0x07, 0x8c,
  0x33, 0xc0, 0x03, 0xcc,
  0x67, 0x80, 0x01, 0xe6,
  0x67, 0x00, 0x00, 0xe6,
  0x6e, 0x00, 0x00, 0x76,
  0x6e, 0x00, 0x00, 0x76,
  0x67, 0x00, 0x00, 0xe6,
  0x67, 0x80, 0x01, 0xe6,
  0x33, 0xc0, 0x03, 0xcc,
  0x31, 0xe0, 0x07, 0x8c,
  0x30, 0xf0, 0x0f, 0x0c,
  0x18, 0x7c, 0x3e, 0x18,
  0x1c, 0x3f, 0xfc, 0x38,
  0x0e, 0x0f, 0xf0, 0x70,
  0x07, 0x03, 0xc0, 0xe0,
  0x03, 0xc0, 0x03, 0xc0,
  0x01, 0xf8, 0x1f, 0x80,
  0x00, 0xff, 0xff, 0x00,
  0x00, 0x3f, 0xfc, 0x00,
  0x00, 0x07, 0xe0, 0x00,
  0x00, 0x00, 0x00, 0x00
};

const uint8_t PROGMEM logo_gemini[] = {
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x01, 0x80, 0x00,
  0x00, 0x01, 0x80, 0x00,
  0x00, 0x01, 0x80, 0x00,
  0x00, 0x01, 0x80, 0x00,
  0x00, 0x01, 0x80, 0x00,
  0x00, 0x03, 0xc0, 0x00,
  0x00, 0x03, 0xc0, 0x00,
  0x00, 0x03, 0xc0, 0x00,
  0x00, 0x07, 0xe0, 0x00,
  0x00, 0x0f, 0xf0, 0x00,
  0x00, 0x1f, 0xf8, 0x00,
  0x00, 0x7f, 0xfe, 0x00,
  0x01, 0xff, 0xff, 0x80,
  0x0f, 0xff, 0xff, 0xf0,
  0x3f, 0xff, 0xff, 0xfc,
  0x3f, 0xff, 0xff, 0xfc,
  0x0f, 0xff, 0xff, 0xf0,
  0x01, 0xff, 0xff, 0x80,
  0x00, 0x7f, 0xfe, 0x00,
  0x00, 0x1f, 0xf8, 0x00,
  0x00, 0x0f, 0xf0, 0x00,
  0x00, 0x07, 0xe0, 0x00,
  0x00, 0x03, 0xc0, 0x00,
  0x00, 0x03, 0xc0, 0x00,
  0x00, 0x03, 0xc0, 0x00,
  0x00, 0x01, 0x80, 0x00,
  0x00, 0x01, 0x80, 0x00,
  0x00, 0x01, 0x80, 0x00,
  0x00, 0x01, 0x80, 0x00,
  0x00, 0x01, 0x80, 0x00,
  0x00, 0x00, 0x00, 0x00
};

const uint8_t PROGMEM logo_antigravity[] = {
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x01, 0x80, 0x00,
  0x00, 0x03, 0xc0, 0x00,
  0x00, 0x07, 0xe0, 0x00,
  0x00, 0x0f, 0xf0, 0x00,
  0x00, 0x1f, 0xf8, 0x00,
  0x00, 0x3d, 0xbc, 0x00,
  0x00, 0x79, 0x9e, 0x00,
  0x00, 0xf1, 0x8f, 0x00,
  0x01, 0xe1, 0x87, 0x80,
  0x03, 0xc1, 0x83, 0xc0,
  0x07, 0x81, 0x81, 0xe0,
  0x0f, 0x01, 0x80, 0xf0,
  0x1e, 0x01, 0x80, 0x78,
  0x3c, 0x01, 0x80, 0x3c,
  0x78, 0x01, 0x80, 0x1e,
  0x00, 0x01, 0x80, 0x00,
  0x00, 0x01, 0x80, 0x00,
  0x00, 0x01, 0x80, 0x00,
  0x00, 0x01, 0x80, 0x00,
  0x00, 0x01, 0x80, 0x00,
  0x03, 0xff, 0xff, 0xc0,
  0x0f, 0xff, 0xff, 0xf0,
  0x1f, 0x00, 0x00, 0xf8,
  0x3c, 0x00, 0x00, 0x3c,
  0x38, 0x00, 0x00, 0x1c,
  0x1c, 0x00, 0x00, 0x38,
  0x0f, 0x00, 0x00, 0xf0,
  0x03, 0xff, 0xff, 0xc0,
  0x00, 0x7f, 0xfe, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00
};

const uint8_t PROGMEM logo_codex[] = {
  0x00, 0x00, 0x00, 0x00,
  0x7f, 0xff, 0xff, 0xfe,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x43, 0xc0, 0x00, 0x02,
  0x41, 0xe0, 0x00, 0x02,
  0x40, 0xf0, 0x00, 0x02,
  0x40, 0x78, 0x00, 0x02,
  0x40, 0x3c, 0x00, 0x02,
  0x40, 0x78, 0x00, 0x02,
  0x40, 0xf0, 0x00, 0x02,
  0x41, 0xe0, 0x00, 0x02,
  0x43, 0xc0, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x7f, 0xff, 0xff, 0xfe,
  0x00, 0x00, 0x00, 0x00
};

const uint8_t PROGMEM logo_opencode[] = {
  0x00, 0x00, 0x00, 0x00,
  0x7f, 0xff, 0xff, 0xfe,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0xf0, 0x0f, 0x02,
  0x41, 0xe0, 0x07, 0x82,
  0x43, 0xc0, 0x03, 0xc2,
  0x47, 0x80, 0x01, 0xe2,
  0x4f, 0x00, 0x00, 0xf2,
  0x4f, 0x00, 0x00, 0xf2,
  0x47, 0x80, 0x01, 0xe2,
  0x43, 0xc0, 0x03, 0xc2,
  0x41, 0xe0, 0x07, 0x82,
  0x40, 0xf0, 0x0f, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x40, 0x00, 0x00, 0x02,
  0x7f, 0xff, 0xff, 0xfe,
  0x00, 0x00, 0x00, 0x00
};

// Overlay dirty tracking
String lastBubbleText = "";
int lastPendingCount = -1;
bool overlaysNeedRedraw = true;


// Touch gesture tracking
bool touchActive = false;
unsigned long touchStartTime = 0;
unsigned long lastTouchTime = 0;
bool longPressTriggered = false;
int startTouchX = 0;
int startTouchY = 0;

// Parse the downloaded custom pet binary package
void parsePetBinary() {
  animations.clear();
  petLoaded = false;

  if (petBinBuffer == nullptr || petBinSize < 12) {
    return;
  }
  
  // Verify magic PETP
  if (petBinBuffer[0] != 'P' || petBinBuffer[1] != 'E' || petBinBuffer[2] != 'T' || petBinBuffer[3] != 'P') {
    Serial.println("Invalid magic in binary package (expected PETP)");
    return;
  }
  
  int32_t version = *((int32_t*)(petBinBuffer + 4));
  int32_t stateCount = *((int32_t*)(petBinBuffer + 8));

  if (version < 3) {
    Serial.println("Obsolete binary format. PNGdec packaging (v3) required.");
    return;
  }
  
  Serial.printf("Parsing pet bin: version=%d, states=%d\n", version, stateCount);
  
  animations.clear();
  int headerIndex = 12;
  
  for (int i = 0; i < stateCount; i++) {
    if (headerIndex + 48 > petBinSize) break;
    
    StateAnimation anim;
    memcpy(anim.name, petBinBuffer + headerIndex, 32);
    anim.name[32] = '\0'; // 显式置为 \0 保证 strcmp 不会越界
    anim.frames = *((int32_t*)(petBinBuffer + headerIndex + 32));
    anim.width = *((int32_t*)(petBinBuffer + headerIndex + 36));
    anim.height = *((int32_t*)(petBinBuffer + headerIndex + 40));
    anim.offsetTableOffset = *((int32_t*)(petBinBuffer + headerIndex + 44));
    
    // Parse Frame Offset Table for this state
    int tableIndex = anim.offsetTableOffset;
    for (int f = 0; f < anim.frames; f++) {
      if (tableIndex + 8 > petBinSize) break;
      FrameEntry entry;
      entry.offset = *((int32_t*)(petBinBuffer + tableIndex));
      entry.size = *((int32_t*)(petBinBuffer + tableIndex + 4));
      anim.frameOffsets.push_back(entry);
      tableIndex += 8;
    }
    
    Serial.printf("Parsed state: %s, frames=%d, size=%dx%d, tableOffset=%d\n", anim.name, anim.frames, anim.width, anim.height, anim.offsetTableOffset);
    
    animations.push_back(anim);
    headerIndex += 48;
  }
  
  petLoaded = true;
}

// Download pet binary package from public direct link into PSRAM
bool downloadActivePet(String url) {
  if (WiFi.status() != WL_CONNECTED) return false;
  
  Serial.printf("Downloading active pet from: %s\n", url.c_str());
  
  // Display download indicator
  gfx->fillScreen(COLOR_DARK_BG);
#ifdef U8G2_FONT_SUPPORT
  gfx->setFont(u8g2_font_unifont_t_chinese4);
#endif
  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_CYAN);
  gfx->setCursor(10, 30);
  gfx->print("同步宠物资源...");
  gfx->setTextColor(COLOR_TEXT_MAIN);
  gfx->setCursor(10, 60);
  gfx->print(activePetName.length() > 0 ? activePetName : "宠物猫咪");

  // Draw card container and static progress bar outline once
  gfx->fillRoundRect(10, 80, 220, 140, 8, COLOR_CARD_BG);
  gfx->drawRoundRect(20, 120, 200, 20, 4, COLOR_TEXT_MUTED);
  
  HTTPClient http;
  http.setTimeout(30000); // 30 seconds connection/read timeout
  WiFiClientSecure secureClient;
  bool beginSuccess = false;
  
  if (url.startsWith("https://")) {
    secureClient.setInsecure(); // Skip certificate verification for public download
    beginSuccess = http.begin(secureClient, url);
  } else {
    beginSuccess = http.begin(url);
  }
  
  if (!beginSuccess) {
    Serial.println("HTTPClient begin failed");
    return false;
  }
  
  int httpCode = http.GET();
  
  if (httpCode != HTTP_CODE_OK) {
    Serial.printf("HTTP GET failed, error: %d\n", httpCode);
    http.end();
    return false;
  }
  
  int len = http.getSize();
  if (len <= 0) {
    Serial.println("Content-length is missing or invalid");
    http.end();
    return false;
  }
  
  Serial.printf("File size: %d bytes\n", len);
  
  uint8_t* tempBuffer = (uint8_t*)heap_caps_malloc(len, MALLOC_CAP_SPIRAM);
  if (tempBuffer == nullptr) {
    Serial.println("SPIRAM allocation failed! Trying internal heap...");
    if (heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL) > len) {
      tempBuffer = (uint8_t*)heap_caps_malloc(len, MALLOC_CAP_INTERNAL);
    }
  }
  
  if (tempBuffer == nullptr) {
    Serial.println("Failed to allocate memory for pet assets (both SPIRAM and Internal Heap)!");
    http.end();
    return false;
  }
  
  WiFiClient* stream = http.getStreamPtr();
  int readBytes = 0;
  unsigned long start = millis();
  
  while (http.connected() && readBytes < len) {
    int available = stream->available();
    if (available > 0) {
      int toRead = std::min(available, 16384); // read in larger chunks
      int read = stream->readBytes(tempBuffer + readBytes, toRead);
      readBytes += read;
      
      // Draw progress bar
      int progress = (readBytes * 100) / len;
      if (progress > 0) {
        gfx->fillRoundRect(22, 122, (progress * 196) / 100, 16, 2, COLOR_CYAN);
      }
      // Clear the text area inside card to prevent digit overlapping/scrambling
      gfx->fillRect(80, 160, 80, 24, COLOR_CARD_BG);
      gfx->setCursor(95, 180);
      gfx->setTextColor(COLOR_GREEN);
      gfx->printf("%d%%", progress);
    }
    
    // Timeout check (300 seconds / 5 minutes)
    if (millis() - start > 300000) {
      Serial.println("Download timeout!");
      free(tempBuffer);
      http.end();
      return false;
    }
    mqttClient.loop(); // Keep MQTT alive during download
    if (available == 0) {
      delay(1); // Only delay when no network data is waiting
    }
  }
  
  http.end();
  
  if (readBytes == len) {
    Serial.println("Download complete.");
    
    // Free old buffer
    if (petBinBuffer != nullptr) {
      free(petBinBuffer);
    }
    
    petBinBuffer = tempBuffer;
    petBinSize = len;
    
    parsePetBinary();
    // Reset rendering state to force clean redraw with new pet
    placeholderDrawn = false;
    lastPetLoadedState = false;
    overlaysNeedRedraw = true;
    return true;
  } else {
    Serial.printf("Read error: expected %d, read %d\n", len, readBytes);
    free(tempBuffer);
    return false;
  }
}

// Draw helpers
void updateBatteryStatus() {
  // Read charging status: GPIO 3 is low when charging
  isCharging = (digitalRead(PIN_CHG) == LOW);

  // Read voltage using analogReadMilliVolts
  uint32_t pin_mv = analogReadMilliVolts(PIN_BAT_ADC);
  float voltage = (pin_mv / 1000.0f) * 3.0f; // Resistor divider ratio is 3.0

  // Apply running average to smooth out fluctuations
  static float smoothedVoltage = -1.0f;
  if (smoothedVoltage < 0.0f) {
    smoothedVoltage = voltage;
  } else {
    smoothedVoltage = smoothedVoltage * 0.9f + voltage * 0.1f;
  }

  // Calculate percentage: Map 3.5V..4.15V to 0%..100%
  float pct = (smoothedVoltage - 3.50f) / (4.15f - 3.50f) * 100.0f;
  if (pct > 100.0f) pct = 100.0f;
  if (pct < 0.0f) pct = 0.0f;
  batteryPct = (int)pct;

  Serial.printf("Battery: pin_mv=%d, voltage=%.2fV (smooth=%.2fV), pct=%d%%, charging=%s\n",
                pin_mv, voltage, smoothedVoltage, batteryPct, isCharging ? "YES" : "NO");
}

void setBrightness(int percent) {
  if (percent < 10) percent = 10;
  if (percent > 100) percent = 100;
  
  // 映射 10%-100% 亮度至 15-255 的 PWM 占空比
  int duty = map(percent, 10, 100, 15, 255);
  ledcWrite(0, duty);
  Serial.printf("Backlight set to %d%% (duty %d)\n", percent, duty);
}

void initBrightness() {
  // LEDC 通道 0, 频率 5000Hz, 分辨率 8 位
  ledcSetup(0, 5000, 8);
  ledcAttachPin(GFX_BL, 0);
  
  prefs.begin("system", false);
  screenBrightness = prefs.getInt("brightness", 80);
  prefs.end();
  
  setBrightness(screenBrightness);
}

void saveBrightness(int percent) {
  prefs.begin("system", false);
  prefs.putInt("brightness", percent);
  prefs.end();
}

void drawGlobalBattery(int x, int y) {
  gfx->setTextSize(1);
  
  uint16_t color = COLOR_TEXT_MUTED;
  String text = "";
  
  if (isCharging) {
    color = COLOR_GREEN;
    text = "CHG " + String(batteryPct) + "%";
  } else {
    if (batteryPct <= 20) {
      color = COLOR_RED;
    } else {
      color = COLOR_TEXT_MUTED;
    }
    text = "BAT " + String(batteryPct) + "%";
  }
  
  gfx->setTextColor(color);
  gfx->setCursor(x, y);
  gfx->print(text);
}

void drawHeader(const char* title, uint16_t titleColor) {
  gfx->fillScreen(COLOR_DARK_BG);
  
#ifdef U8G2_FONT_SUPPORT
  gfx->setFont(u8g2_font_chill7_h_cjk);
#endif
  
  // First row: Status indicators (WIFI, MQTT, BATTERY) at y=5, size 1
  gfx->setTextSize(1);
  
  // WiFi status
  gfx->setCursor(10, 5);
  if (WiFi.status() == WL_CONNECTED) {
    gfx->setTextColor(COLOR_GREEN);
    gfx->print("WIFI");
  } else {
    gfx->setTextColor(COLOR_RED);
    gfx->print("WIFI");
  }
  
  // MQTT status
  gfx->setCursor(45, 5);
  if (mqttClient.connected()) {
    gfx->setTextColor(COLOR_GREEN);
    gfx->print("MQTT");
  } else {
    gfx->setTextColor(COLOR_RED);
    gfx->print("MQTT");
  }

  // Draw battery status globally in top right corner (x=180, y=5)
  drawGlobalBattery(180, 5);

  // Second row: Screen Title at y=18, size 1 (16px font is already large)
#ifdef U8G2_FONT_SUPPORT
  gfx->setFont(u8g2_font_unifont_t_chinese4);
#endif
  gfx->setTextSize(1);
  gfx->setTextColor(titleColor);
  gfx->setCursor(10, 18);
  gfx->print(title);
  
  gfx->drawFastHLine(0, 38, 240, COLOR_CARD_BG);
}

// Prints UTF-8 string with pixel-based auto-wrapping and line indent
void drawWrappedText(const String &str, int startX, int startY, int maxW, int lineHeight, bool isLargeFont = false) {
#ifdef U8G2_FONT_SUPPORT
  int curX = startX;
  int curY = startY;
  int i = 0;
  int len = str.length();
  
  while (i < len) {
    int charLen = 1;
    uint8_t c = str[i];
    if ((c & 0x80) == 0) charLen = 1;
    else if ((c & 0xE0) == 0xC0) charLen = 2;
    else if ((c & 0xF0) == 0xE0) charLen = 3;
    else if ((c & 0xF8) == 0xF0) charLen = 4;
    
    if (i + charLen > len) {
      charLen = len - i;
    }
    
    String ch = str.substring(i, i + charLen);
    i += charLen;
    
    if (ch == "\n") {
      curX = startX;
      curY += lineHeight;
      continue;
    }
    
    // Dynamic width calculation based on font size
    int chWidth = 5;
    if (isLargeFont) {
      chWidth = (charLen >= 3) ? 16 : 8;
    } else {
      chWidth = (charLen >= 3) ? 8 : 5;
    }
    
    if (curX + chWidth > startX + maxW) {
      curX = startX;
      curY += lineHeight;
    }
    
    gfx->setCursor(curX, curY);
    gfx->print(ch);
    curX += chWidth;
  }
#else
  // Fallback: draw using old logic (if U8G2 not available, ASCII font)
  int charsPerLine = maxW / 6;
  int lineCount = 0;
  for (unsigned int i = 0; i < str.length(); i += charsPerLine) {
    gfx->setCursor(startX, startY + lineCount * lineHeight);
    gfx->print(str.substring(i, std::min(i + charsPerLine, str.length())));
    lineCount++;
  }
#endif
}

void drawStatusScreen() {
  drawHeader("DIAGNOSTICS", COLOR_CYAN);
  
#ifdef U8G2_FONT_SUPPORT
  gfx->setFont(u8g2_font_chill7_h_cjk);
#endif
  
  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_TEXT_MUTED);
  gfx->setCursor(10, 48); // Adjusted Y from 45 to 48
  gfx->print("Client ID: ");
  gfx->setTextColor(COLOR_TEXT_MAIN);
  gfx->println(client_id);
  
  gfx->setTextColor(COLOR_TEXT_MUTED);
  gfx->setCursor(10, 63); // Adjusted Y from 60 to 63
  gfx->print("IP: ");
  gfx->setTextColor(COLOR_TEXT_MAIN);
  gfx->println(WiFi.localIP().toString());

  gfx->setTextColor(COLOR_TEXT_MUTED);
  gfx->setCursor(10, 78); // Adjusted Y from 75 to 78
  gfx->print("Mascot: ");
  gfx->setTextColor(COLOR_GREEN);
  gfx->println(petLoaded ? activePetName : "Not Loaded");

  // Status Indicator Panel
  gfx->fillRoundRect(10, 100, 220, 120, 8, COLOR_CARD_BG);
  
  gfx->setTextSize(2);
  gfx->setTextColor(COLOR_GREEN);
  gfx->setCursor(20, 115);
  gfx->print("TETHERED MODE");
  
  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_TEXT_MUTED);
  gfx->setCursor(20, 150);
  gfx->println("All configurations synced.");
  gfx->setCursor(20, 165);
  gfx->println("Tap screen to return.");

  // === 绘制亮度控制面板 ===
  gfx->setCursor(20, 190);
  gfx->print("亮度: ");
  gfx->setTextColor(COLOR_CYAN);
  gfx->printf("%d%%", screenBrightness);

  // 绘制进度条背景
  int barX = 65;
  int barY = 184;
  int barW = 110;
  int barH = 8;
  gfx->fillRoundRect(barX, barY, barW, barH, 4, COLOR_DARK_BG);
  
  // 绘制进度条高亮填充
  int activeW = map(screenBrightness, 10, 100, 0, barW);
  if (activeW > 0) {
    gfx->fillRoundRect(barX, barY, activeW, barH, 4, COLOR_CYAN);
  }

  // 右侧实体按键提示
  gfx->setTextColor(COLOR_TEXT_MUTED);
  gfx->setCursor(185, 190);
  gfx->print("[-/+]");
}

void drawApprovalScreen() {
  if (requests.empty()) {
    currentState = STATE_COMPANION;
    return;
  }
  
  ApprovalRequest req = requests[currentRequestIndex];
  
  drawHeader("CONFIRM ACTION", COLOR_RED);
  
  // Multi-task Indicator & Switcher buttons (inside header row 2)
  if (requests.size() > 1) {
#ifdef U8G2_FONT_SUPPORT
    gfx->setFont(u8g2_font_unifont_t_chinese4);
#endif
    gfx->setTextSize(1);
    gfx->setTextColor(COLOR_TEXT_MUTED);
    gfx->setCursor(160, 26);
    gfx->print("<");

#ifdef U8G2_FONT_SUPPORT
    gfx->setFont(u8g2_font_chill7_h_cjk);
#endif
    gfx->setCursor(180, 23);
    gfx->printf("%d/%d", currentRequestIndex + 1, requests.size());

#ifdef U8G2_FONT_SUPPORT
    gfx->setFont(u8g2_font_unifont_t_chinese4);
#endif
    gfx->setCursor(215, 26);
    gfx->print(">");
  }

  // Draw Platform Logo and Agent Name
  String agent = req.agent;
  agent.trim();
  agent.toLowerCase();
  
  int logoX = 10;
  int logoY = 40;
  
  if (agent.indexOf("claude") >= 0) {
    gfx->drawBitmap(logoX, logoY, logo_claude, 32, 32, COLOR_CYAN, COLOR_DARK_BG);
  } else if (agent.indexOf("gemini") >= 0) {
    gfx->drawBitmap(logoX, logoY, logo_gemini, 32, 32, COLOR_CYAN, COLOR_DARK_BG);
  } else if (agent.indexOf("antigravity") >= 0) {
    gfx->drawBitmap(logoX, logoY, logo_antigravity, 32, 32, COLOR_CYAN, COLOR_DARK_BG);
  } else if (agent.indexOf("codex") >= 0 || agent.indexOf("copilot") >= 0) {
    gfx->drawBitmap(logoX, logoY, logo_codex, 32, 32, COLOR_CYAN, COLOR_DARK_BG);
  } else if (agent.indexOf("opencode") >= 0) {
    gfx->drawBitmap(logoX, logoY, logo_opencode, 32, 32, COLOR_CYAN, COLOR_DARK_BG);
  } else {
    gfx->drawBitmap(logoX, logoY, logo_codex, 32, 32, COLOR_CYAN, COLOR_DARK_BG);
  }
  
#ifdef U8G2_FONT_SUPPORT
  gfx->setFont(u8g2_font_unifont_t_chinese4);
#endif
  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_CYAN);
  gfx->setCursor(48, 58); // Stacked top line baseline Y=58 next to 32x32 logo (Y=40..72)
  String agentUpper = req.agent;
  agentUpper.toUpperCase();
  gfx->print(agentUpper);
  
#ifdef U8G2_FONT_SUPPORT
  gfx->setFont(u8g2_font_chill7_h_cjk);
#endif
  gfx->setTextColor(COLOR_TEXT_MUTED);
  String cwdText = req.cwd;
  if (cwdText.length() > 25) {
    cwdText = "..." + cwdText.substring(cwdText.length() - 22);
  }
  gfx->setCursor(48, 71); // Stacked bottom line baseline Y=71
  gfx->print(cwdText);
  
  // Command Box (shifted down to Y=78, height=52)
  gfx->fillRoundRect(10, 78, 220, 52, 6, COLOR_CARD_BG);
  gfx->setTextColor(COLOR_GREEN);
  
#ifdef U8G2_FONT_SUPPORT
  gfx->setFont(u8g2_font_unifont_t_chinese4);
#endif
  
  String cmd = req.command;
  if (cmd.length() > 60) {
    cmd = cmd.substring(0, 57) + "...";
  }
  drawWrappedText(cmd, 18, 96, 200, 18, true);
  
  // Thinking / Goal Box (shifted down to Y=136, height=50)
  gfx->fillRoundRect(10, 136, 220, 50, 6, COLOR_CARD_BG);
  gfx->setTextColor(COLOR_TEXT_MUTED);
  
#ifdef U8G2_FONT_SUPPORT
  gfx->setFont(u8g2_font_chill7_h_cjk);
#endif
  gfx->setCursor(15, 144);
  gfx->print("Goal: ");
  
#ifdef U8G2_FONT_SUPPORT
  gfx->setFont(u8g2_font_unifont_t_chinese4);
#endif
  gfx->setTextColor(COLOR_TEXT_MAIN);
  
  String title = req.task_title;
  if (title.length() > 45) title = title.substring(0, 42) + "...";
  drawWrappedText(title, 55, 154, 165, 18, true);
  
  // Large Action Buttons at the bottom (vertical centered text)
#ifdef U8G2_FONT_SUPPORT
  gfx->setFont(u8g2_font_chill7_h_cjk);
#endif
  gfx->fillRoundRect(10, 192, 105, 38, 8, COLOR_RED);
  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_TEXT_MAIN);
  gfx->setCursor(44, 214);
  gfx->print("REJECT");
  
  gfx->fillRoundRect(125, 192, 105, 38, 8, COLOR_GREEN);
  gfx->setTextColor(COLOR_TEXT_MAIN);
  gfx->setCursor(156, 214);
  gfx->print("APPROVE");
}

void drawNotificationScreen() {
  uint16_t statusColor = COLOR_CYAN;
  if (activeNotification.status == "success") statusColor = COLOR_GREEN;
  else if (activeNotification.status == "error") statusColor = COLOR_RED;
  
  drawHeader("SYSTEM NOTICE", statusColor);
  
  gfx->fillRoundRect(10, 50, 220, 180, 8, COLOR_CARD_BG);
  
#ifdef U8G2_FONT_SUPPORT
  gfx->setFont(u8g2_font_unifont_t_chinese4);
#endif
  gfx->setTextSize(1);
  gfx->setTextColor(statusColor);
  gfx->setCursor(20, 72);
  gfx->print(activeNotification.title);
  
  gfx->setTextColor(COLOR_TEXT_MAIN);
  String msg = activeNotification.message;
  if (msg.length() > 120) msg = msg.substring(0, 117) + "...";
  
  drawWrappedText(msg, 20, 105, 200, 20, true);
}

static PNG png;
int allowedPngDrawHeight = 208;
int pngOffsetX = 24;
int pngOffsetY = 16;

// PNGdec callback to write decoded line to double buffer or screen
int pngDraw(PNGDRAW *pDraw) {
  if (pDraw->y >= allowedPngDrawHeight) {
    return 0; // stop decoding early if clipped
  }
  
  uint16_t lineBuffer[240];
  
  // Extract RGB888 representation of COLOR_DARK_BG in 0x00BBGGRR format
  uint8_t r = ((COLOR_DARK_BG >> 11) & 0x1F) << 3;
  uint8_t g = ((COLOR_DARK_BG >> 5) & 0x3F) << 2;
  uint8_t b = (COLOR_DARK_BG & 0x1F) << 3;
  uint32_t bg00BBGGRR = (b << 16) | (g << 8) | r;
  
  png.getLineAsRGB565(pDraw, lineBuffer, PNG_RGB565_LITTLE_ENDIAN, bg00BBGGRR);
  
  int y = pDraw->y;
  int w = pDraw->iWidth;
  
  // Transparency Check (check if the frame has any visible content)
  if (!frameHasContent) {
    if (pDraw->iPixelType == PNG_PIXEL_TRUECOLOR_ALPHA) {
      uint8_t* s = pDraw->pPixels;
      for (int x = 0; x < w; x++) {
        if (s[3] > 10) { // Alpha channel > 10
          frameHasContent = true;
          break;
        }
        s += 4;
      }
    } else if (pDraw->iPixelType == PNG_PIXEL_GRAY_ALPHA) {
      uint8_t* s = pDraw->pPixels;
      for (int x = 0; x < w; x++) {
        if (s[1] > 10) { // Alpha channel > 10
          frameHasContent = true;
          break;
        }
        s += 2;
      }
    } else {
      frameHasContent = true;
    }
  }
  
  if (petDoubleBuffer != nullptr) {
    uint16_t* destLine = petDoubleBuffer + y * w;
    // Copy the entire line (already blended with COLOR_DARK_BG) directly
    memcpy(destLine, lineBuffer, w * sizeof(uint16_t));
  } else {
    // Fallback if double buffer allocation failed: draw directly to screen
    int screenY = pngOffsetY + y;
    for (int x = 0; x < w; x++) {
      gfx->drawPixel(pngOffsetX + x, screenY, lineBuffer[x]);
    }
  }
  return 1; // continue decoding
}

// Render active pet animation frame (Centered 192x208)
void drawPetFrame(String stateName, int frameIndex) {

  if (!petLoaded || animations.empty()) {
    lastPetLoadedState = false;
    if (placeholderDrawn) return;
    placeholderDrawn = true;

    // Render local simple graphics placeholder if pet assets are missing
    gfx->fillScreen(COLOR_DARK_BG);
    gfx->drawRoundRect(20, 20, 200, 200, 8, COLOR_CARD_BG);
    
    gfx->setTextSize(2);
    gfx->setTextColor(COLOR_CYAN);
    gfx->setCursor(45, 80);
    gfx->print("MASCOT IDLE");
    
    gfx->setTextSize(1);
    gfx->setTextColor(COLOR_TEXT_MUTED);
    gfx->setCursor(45, 120);
    gfx->print("Ready for AI Sync");
    gfx->setCursor(45, 140);
    gfx->print("Waiting for active pet...");
    
    // Draw status bar at bottom
    gfx->fillRect(0, 220, 240, 20, COLOR_CARD_BG);
    gfx->setCursor(10, 226);
    gfx->setTextColor(COLOR_TEXT_MUTED);
    gfx->print("WiFi Connected: ");
    if (WiFi.status() == WL_CONNECTED) {
      gfx->setTextColor(COLOR_GREEN);
      gfx->print("ONLINE");
    } else {
      gfx->setTextColor(COLOR_RED);
      gfx->print("OFFLINE");
    }
    return;
  }

  placeholderDrawn = false;
  if (!lastPetLoadedState) {
    lastPetLoadedState = true;
    gfx->fillScreen(COLOR_DARK_BG); // Clear the placeholder once when pet loads
  }
  
  // Find state animation
  StateAnimation* anim = nullptr;
  for (auto& a : animations) {
    if (String(a.name) == stateName) {
      anim = &a;
      break;
    }
  }
  
  // Fallback to first animation if state not found
  if (anim == nullptr) {
    anim = &animations[0];
  }
  
  if (anim->frames <= 0) return;
  
  int idx = frameIndex % anim->frames;
  if (idx >= (int)anim->frameOffsets.size()) {
    idx = 0;
  }
  
  // Compute centering coordinates
  int x = (240 - anim->width) / 2;
  int y = (240 - anim->height) / 2;
  
  // Handle speech bubble clipping to prevent overlapping eraser glitches
  int drawHeight = anim->height;
  bool bubbleActive = (bubbleText.length() > 0 && millis() < bubbleTextExpiry);
  if (bubbleActive && currentState == STATE_COMPANION) {
    if (y + anim->height > 182) {
      drawHeight = 182 - y;
    }
  }

  if (drawHeight <= 0) return;

  // Set global variables for the PNGDraw callback
  allowedPngDrawHeight = drawHeight;
  pngOffsetX = x;
  pngOffsetY = y;
  frameHasContent = false; // Reset before decoding this frame

  if (idx < (int)anim->frameOffsets.size()) {
    int32_t offset = anim->frameOffsets[idx].offset;
    int32_t size = anim->frameOffsets[idx].size;
    
    if (offset + size <= petBinSize) {
      uint8_t* pngData = petBinBuffer + offset;
      
      // Decode PNG directly from RAM
      int16_t rc = png.openRAM(pngData, size, pngDraw);
      if (rc == PNG_SUCCESS) {
        png.decode(NULL, 0);
        png.close();
        
        if (!frameHasContent && idx > 0) {
          // Detected blank frame. Truncate animation to the valid frames before it.
          anim->frames = idx;
          Serial.printf("Detected blank frame at idx %d. Truncated state %s to %d frames.\n", idx, stateName.c_str(), idx);
        } else {
          // If we decoded into the double buffer, push it to the screen in a single operation
          if (petDoubleBuffer != nullptr) {
            gfx->draw16bitRGBBitmap(x, y, petDoubleBuffer, anim->width, drawHeight);
          }
        }
      } else {
        Serial.printf("PNG Decode failed for state %s frame %d (rc=%d)\n", stateName.c_str(), idx, rc);
      }
    }
  }
}

// Render Companion view (fullscreen animating pet + speech bubble overlay)
void drawCompanionScreen() {
  bool bubbleActive = (bubbleText.length() > 0 && millis() < bubbleTextExpiry);

  if (!bubbleActive && lastBubbleText.length() > 0) {
    // Bubble just expired — clear the entire bubble area
    gfx->fillRect(10, 182, 220, 58, COLOR_DARK_BG);
    lastBubbleText = "";
  }

  // 1. Draw animating pet
  drawPetFrame(companionState, currentFrameIndex);

  // 2. Pending badge — Moved to y=2..15 to completely avoid pet area (which starts at y=16)
  int pendingCount = requests.size();
  if (pendingCount != lastPendingCount || overlaysNeedRedraw) {
    gfx->fillRect(5, 2, 60, 13,
        pendingCount > 0 ? COLOR_CARD_BG : COLOR_DARK_BG);
    if (pendingCount > 0) {
#ifdef U8G2_FONT_SUPPORT
      gfx->setFont(u8g2_font_chill7_h_cjk);
#endif
      gfx->setTextSize(1);
      gfx->setTextColor(COLOR_RED);
      gfx->setCursor(10, 5);
      gfx->printf("PEND: %d", pendingCount);
    }
    lastPendingCount = pendingCount;
  }

  // 3. Global battery badge - top right corner, only redraw if changed or overlaysNeedRedraw is true
  static int lastDrawnBatteryPct = -1;
  static bool lastDrawnIsCharging = false;
  if (batteryPct != lastDrawnBatteryPct || isCharging != lastDrawnIsCharging || overlaysNeedRedraw) {
    gfx->fillRect(175, 2, 60, 13, COLOR_DARK_BG);
#ifdef U8G2_FONT_SUPPORT
    gfx->setFont(u8g2_font_chill7_h_cjk);
#endif
    drawGlobalBattery(180, 5);
    lastDrawnBatteryPct = batteryPct;
    lastDrawnIsCharging = isCharging;
  }

  // 4. Speech bubble overlay — pet is clipped, only redraw if text changes or overlaysNeedRedraw is true
  if (bubbleActive) {
    if (bubbleText != lastBubbleText || overlaysNeedRedraw) {
      gfx->fillRoundRect(10, 182, 220, 52, 6, COLOR_CARD_BG);
      gfx->drawRoundRect(10, 182, 220, 52, 6, COLOR_CYAN);
      gfx->setTextSize(1);
      gfx->setTextColor(COLOR_TEXT_MAIN);

#ifdef U8G2_FONT_SUPPORT
      gfx->setFont(u8g2_font_unifont_t_chinese4);
#endif

      int startX = 20;
      int maxW = 200;
      
      String agent = companionAgent;
      agent.trim();
      agent.toLowerCase();
      
      if (agent.length() > 0) {
        int logoX = 16;
        int logoY = 192; // 垂直居中于气泡内: 182 + (52 - 32) / 2
        bool drewLogo = true;
        
        if (agent.indexOf("claude") >= 0) {
          gfx->drawBitmap(logoX, logoY, logo_claude, 32, 32, COLOR_CYAN, COLOR_CARD_BG);
        } else if (agent.indexOf("gemini") >= 0) {
          gfx->drawBitmap(logoX, logoY, logo_gemini, 32, 32, COLOR_CYAN, COLOR_CARD_BG);
        } else if (agent.indexOf("antigravity") >= 0) {
          gfx->drawBitmap(logoX, logoY, logo_antigravity, 32, 32, COLOR_CYAN, COLOR_CARD_BG);
        } else if (agent.indexOf("codex") >= 0 || agent.indexOf("copilot") >= 0) {
          gfx->drawBitmap(logoX, logoY, logo_codex, 32, 32, COLOR_CYAN, COLOR_CARD_BG);
        } else if (agent.indexOf("opencode") >= 0) {
          gfx->drawBitmap(logoX, logoY, logo_opencode, 32, 32, COLOR_CYAN, COLOR_CARD_BG);
        } else {
          drewLogo = false;
        }
        
        if (drewLogo) {
          startX = 54;
          maxW = 156;
        }
      }

      String msg = bubbleText;
      if (msg.length() > 44) msg = msg.substring(0, 41) + "...";
      drawWrappedText(msg, startX, 198, maxW, 18, true);
      lastBubbleText = bubbleText;
    }
  }

  overlaysNeedRedraw = false;
}

void updateUI() {
  static ScreenState previousState = STATE_COMPANION;

  if (requests.size() > 0 && currentState == STATE_APPROVAL) {
    currentState = STATE_APPROVAL;
    if (previousState != STATE_APPROVAL) {
      gfx->fillScreen(COLOR_DARK_BG);
    }
    drawApprovalScreen();
  } else if (activeNotification.active) {
    currentState = STATE_NOTIFICATION;
    drawNotificationScreen();
  } else if (currentState == STATE_STATUS) {
    drawStatusScreen();
  } else {
    currentState = STATE_COMPANION;
    if (previousState != STATE_COMPANION) {
      gfx->fillScreen(COLOR_DARK_BG);
      overlaysNeedRedraw = true;
      currentFrameIndex = 0;
      lastFrameTime = millis();
    }
  }
  previousState = currentState;
}

// MQTT Message callback
void callback(char* topic, byte* payload, unsigned int length) {
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, payload, length);
  if (error) {
    Serial.print("JSON Deserialization failed: ");
    Serial.println(error.c_str());
    return;
  }
  
  String topicStr = String(topic);
  Serial.print("Received MQTT message on topic: ");
  Serial.println(topicStr);

  if (topicStr.endsWith("/request/" + String(client_id))) {
    ApprovalRequest req;
    req.id = doc["id"] | "";
    req.command = doc["command"] | "";
    req.task_title = doc["task_title"] | "";
    req.thinking = doc["thinking"] | "";
    req.agent = doc["agent"] | "claude";
    req.cwd = doc["cwd"] | "";
    
    bool duplicate = false;
    for (const auto& r : requests) {
      if (r.id == req.id) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) {
      requests.push_back(req);

      // Auto-popup to Approval only when no notification is active
      if (!activeNotification.active) {
        currentState = STATE_APPROVAL;
        currentRequestIndex = requests.size() - 1;
      }
    }
    updateUI();
  } 
  else if (topicStr.endsWith("/queue/" + String(client_id))) {
    requests.clear();
    JsonArray arr = doc["requests"].as<JsonArray>();
    for (JsonObject obj : arr) {
      ApprovalRequest req;
      req.id = obj["id"] | "";
      req.command = obj["command"] | "";
      req.task_title = obj["task_title"] | "";
      req.thinking = obj["thinking"] | "";
      req.agent = obj["agent"] | "claude";
      req.cwd = obj["cwd"] | "";
      requests.push_back(req);
    }
    
    if (requests.empty()) {
      // Auto-return: Automatically switch back to Companion view when queue clears
      currentState = STATE_COMPANION;
      currentRequestIndex = 0;
    } else {
      // If we have requests and are in companion view, auto pop-up!
      if (currentState == STATE_COMPANION) {
        currentState = STATE_APPROVAL;
        currentRequestIndex = 0;
      } else if (currentRequestIndex >= (int)requests.size()) {
        currentRequestIndex = requests.size() - 1;
      }
    }
    updateUI();
  } 
  else if (topicStr.endsWith("/notify/" + String(client_id))) {
    activeNotification.title = doc["title"] | "Notice";
    activeNotification.message = doc["message"] | "";
    activeNotification.status = doc["status"] | "info";
    activeNotification.timestamp = millis();
    activeNotification.active = true;
    updateUI();
  }
  else if (topicStr.endsWith("/pet_changed/" + String(client_id))) {
    String slug = doc["slug"] | "";
    String url = doc["url"] | "";
    String displayName = doc["displayName"] | "";
    
    if (slug.length() > 0 && url.length() > 0) {
      static String lastDownloadUrl = "";
      if (slug == activePetSlug && (petLoaded || url == lastDownloadUrl)) {
        Serial.println("Pet is already loaded or downloading from same URL. Skipping download.");
        return;
      }
      lastDownloadUrl = url;
      
      activePetSlug = slug;
      activePetName = displayName;
      // Download assets and load pet
      downloadActivePet(url);
      
      // Reset state, clear screen to remove download indicator residue, and redraw
      currentState = STATE_COMPANION;
      gfx->fillScreen(COLOR_DARK_BG);
      overlaysNeedRedraw = true;
      currentFrameIndex = 0;
      lastFrameTime = millis();
      updateUI();
    }
  }
  else if (topicStr.endsWith("/pet_state/" + String(client_id))) {
    // Receive non-blocking companion state changes (for companion mode)
    companionState = doc["state"].as<String>();
    int duration = doc["duration"] | 0;
    if (duration > 0) {
      companionStateExpiry = millis() + duration;
    } else {
      companionStateExpiry = 0;
    }
    
    String text = doc["text"] | "";
    if (text.length() > 0) {
      bubbleText = text;
      bubbleTextExpiry = millis() + 4000; // Bubble lasts 4s
    }

    companionAgent = doc["agent"] | "";
  }
}

// Send Approval Response
void sendResponse(String id, bool approved) {
  if (!mqttClient.connected()) return;
  
  JsonDocument doc;
  doc["id"] = id;
  doc["approved"] = approved;
  
  char buffer[128];
  serializeJson(doc, buffer);
  
  String topic = "ai/response/" + String(client_id);
  mqttClient.publish(topic.c_str(), buffer);
  Serial.printf("Published response: %s\n", buffer);
}

void playRandomAction() {
  if (animations.empty()) return;
  
  // 1. 计算符合条件的状态总数（排除 failed 和 idle）
  int eligibleCount = 0;
  for (const auto& anim : animations) {
    if (strcmp(anim.name, "failed") != 0 && strcmp(anim.name, "idle") != 0) {
      eligibleCount++;
    }
  }
  
  const char* chosenState = "idle";
  int targetIdx = 0;
  if (eligibleCount > 0) {
    targetIdx = random(0, eligibleCount);
    // 2. 找到对应随机索引的状态
    int currentIdx = 0;
    for (const auto& anim : animations) {
      if (strcmp(anim.name, "failed") != 0 && strcmp(anim.name, "idle") != 0) {
        if (currentIdx == targetIdx) {
          chosenState = anim.name;
          break;
        }
        currentIdx++;
      }
    }
  }
  
  // 如果选中的状态与当前状态相同，且符合条件的状态数大于 1，则确保切换到下一个状态
  if (eligibleCount > 1 && companionState == chosenState) {
    targetIdx = (targetIdx + 1) % eligibleCount;
    int currentIdx = 0;
    for (const auto& anim : animations) {
      if (strcmp(anim.name, "failed") != 0 && strcmp(anim.name, "idle") != 0) {
        if (currentIdx == targetIdx) {
          chosenState = anim.name;
          break;
        }
        currentIdx++;
      }
    }
  }

  companionState = chosenState;
  companionStateExpiry = millis() + 3000; // 播放 3 秒
  currentFrameIndex = 0;
  lastFrameTime = millis();
  
  Serial.printf("Triggered random action: %s for 3000ms\n", companionState.c_str());
}
void handleShortPress(int tx, int ty);

void handleShortPress(int tx, int ty) {
  if (currentState == STATE_COMPANION) {
    playRandomAction();
  }
  else if (currentState == STATE_STATUS) {
    currentState = STATE_COMPANION;
    updateUI();
  }
  else if (currentState == STATE_APPROVAL) {
    if (requests.empty() || currentRequestIndex >= (int)requests.size()) {
      currentState = STATE_COMPANION;
      currentRequestIndex = 0;
      updateUI();
      return;
    }
    if (ty < 40) {
      // 头部栏多任务切换
      if (requests.size() > 1 && tx >= 155 && tx <= 180 && ty >= 12 && ty <= 34) {
        currentRequestIndex--;
        if (currentRequestIndex < 0) currentRequestIndex = requests.size() - 1;
        updateUI();
        return;
      }
      else if (requests.size() > 1 && tx >= 210 && tx <= 235 && ty >= 12 && ty <= 34) {
        currentRequestIndex++;
        if (currentRequestIndex >= (int)requests.size()) currentRequestIndex = 0;
        updateUI();
        return;
      }
      
      currentState = STATE_COMPANION;
      updateUI();
      return;
    }

    // Reject 按钮: x: 10-115, y: 192-230
    else if (tx >= 10 && tx <= 115 && ty >= 192 && ty <= 230) {
      Serial.println("Rejected button clicked!");
      sendResponse(requests[currentRequestIndex].id, false);
      requests.erase(requests.begin() + currentRequestIndex);
      if (requests.empty()) {
        currentState = STATE_COMPANION;
        currentRequestIndex = 0;
      } else {
        if (currentRequestIndex >= (int)requests.size()) {
          currentRequestIndex = requests.size() - 1;
        }
      }
      updateUI();
    }
    // Approve 按钮: x: 125-230, y: 192-230
    else if (tx >= 125 && tx <= 230 && ty >= 192 && ty <= 230) {
      Serial.println("Approved button clicked!");
      sendResponse(requests[currentRequestIndex].id, true);
      requests.erase(requests.begin() + currentRequestIndex);
      if (requests.empty()) {
        currentState = STATE_COMPANION;
        currentRequestIndex = 0;
      } else {
        if (currentRequestIndex >= (int)requests.size()) {
          currentRequestIndex = requests.size() - 1;
        }
      }
      updateUI();
    }
  }
}

// Touch Input Handler
void checkTouch() {
  if (!hasTouch) return;

  unsigned long now = millis();
  bool pinTouched = (digitalRead(SENSOR_IRQ) == LOW);
  
  int16_t x[5], y[5];
  bool gotPoint = false;
  int tx = 0, ty = 0;

  if (isPressed || pinTouched) {
    isPressed = false;
    uint8_t touched = touch.getPoint(x, y, touch.getSupportTouchPoint());
    if (touched > 0) {
      gotPoint = true;
      tx = x[0];
      ty = y[0];
    }
  }

  if (gotPoint) {
    if (!touchActive) {
      touchActive = true;
      touchStartTime = now;
      longPressTriggered = false;
      startTouchX = tx;
      startTouchY = ty;
      Serial.printf("Touch started: X=%d, Y=%d\n", tx, ty);
    }
    lastTouchTime = now;

    // 长按 3 秒判定（仅在宠物主界面下触发长按）
    if (currentState == STATE_COMPANION && !longPressTriggered) {
      if (now - touchStartTime >= 3000) {
        longPressTriggered = true;
        Serial.println("Long press triggered in Companion mode (3 seconds)!");
        if (requests.size() > 0) {
          currentState = STATE_APPROVAL;
          currentRequestIndex = 0;
        } else {
          currentState = STATE_STATUS;
        }
        updateUI();
      }
    }
  } else {
    // 触摸断开判定，设置 150ms 采样时间窗过滤短暂的 I2C 响应间歇
    if (touchActive && (now - lastTouchTime > 150)) {
      touchActive = false;
      unsigned long duration = now - touchStartTime;
      Serial.printf("Touch released. Duration: %lu ms, longPressTriggered=%s\n", duration, longPressTriggered ? "YES" : "NO");
      
      if (!longPressTriggered) {
        handleShortPress(startTouchX, startTouchY);
      }
    }
  }
}

// Physical Button polling and debouncing
void checkButtons() {
  unsigned long now = millis();

  // --- BOOT Button (GPIO 0) ---
  bool bootPressed = (digitalRead(PIN_BOOT) == LOW);
  if (bootPressed && !bootWasPressed) {
    bootPressStart = now;
    bootWasPressed = true;
  } else if (!bootPressed && bootWasPressed) {
    unsigned long duration = now - bootPressStart;
    if (duration > 50 && duration < 1000) { // Short press
      // In Approval mode, BOOT button acts as Reject
      if (currentState == STATE_APPROVAL && !requests.empty()) {
        Serial.println("BOOT Button: Rejecting Request");
        sendResponse(requests[currentRequestIndex].id, false);
        requests.erase(requests.begin() + currentRequestIndex);
        if (requests.empty()) {
          currentState = STATE_COMPANION;
          currentRequestIndex = 0;
        } else {
          if (currentRequestIndex >= (int)requests.size()) {
            currentRequestIndex = requests.size() - 1;
          }
        }
        updateUI();
      } else if (currentState == STATE_STATUS) {
        // 状态页短按 BOOT 键为“减小亮度”
        screenBrightness -= 10;
        if (screenBrightness < 10) screenBrightness = 10;
        setBrightness(screenBrightness);
        saveBrightness(screenBrightness);
        updateUI();
      }
    }
    bootWasPressed = false;
  }

  // --- PLUS Button (GPIO 4) ---
  bool plusPressed = (digitalRead(PIN_PLUS) == LOW);
  if (plusPressed && !plusWasPressed) {
    plusPressStart = now;
    plusWasPressed = true;
  } else if (!plusPressed && plusWasPressed) {
    unsigned long duration = now - plusPressStart;
    if (duration > 50 && duration < 1000) { // Short press
      // In Approval mode, PLUS button acts as Approve
      if (currentState == STATE_APPROVAL && !requests.empty()) {
        Serial.println("PLUS Button: Approving Request");
        sendResponse(requests[currentRequestIndex].id, true);
        requests.erase(requests.begin() + currentRequestIndex);
        if (requests.empty()) {
          currentState = STATE_COMPANION;
          currentRequestIndex = 0;
        } else {
          if (currentRequestIndex >= (int)requests.size()) {
            currentRequestIndex = requests.size() - 1;
          }
        }
        updateUI();
      } else if (currentState == STATE_STATUS) {
        // 状态页短按 PLUS 键为“增加亮度”
        screenBrightness += 10;
        if (screenBrightness > 100) screenBrightness = 100;
        setBrightness(screenBrightness);
        saveBrightness(screenBrightness);
        updateUI();
      } else {
        // Toggle view between Companion and Diagnostics (only trigger from other states)
        Serial.println("PLUS Button: Toggling View Mode");
        if (currentState == STATE_COMPANION) {
          currentState = STATE_STATUS;
        }
        updateUI();
      }
    }
    plusWasPressed = false;
  }

  // --- PWR Button (GPIO 5) ---
  bool pwrPressed = (digitalRead(PIN_PWR) == LOW);
  if (pwrPressed) {
    if (!pwrWasPressed) {
      pwrPressStart = now;
      pwrWasPressed = true;
    } else {
      // Long press detection for shutdown (2 seconds)
      unsigned long duration = now - pwrPressStart;
      if (duration >= 2000) {
        Serial.println("PWR Button: Shutdown triggered");
        // Turn off screen backlight immediately
        ledcWrite(0, 0);
        pinMode(GFX_BL, OUTPUT);
        digitalWrite(GFX_BL, LOW);
        gfx->displayOff();

        delay(500); // Give user a moment to release
        
        // Disable power latch pin (pull LOW) to cut off battery circuit
        digitalWrite(PIN_BAT_PWR, LOW);
        pinMode(PIN_BAT_PWR, OUTPUT);
        digitalWrite(PIN_BAT_PWR, LOW);
        
        // Spin forever while power shuts down
        while (true) {
          delay(100);
        }
      }
    }
  } else if (!pwrPressed && pwrWasPressed) {
    unsigned long duration = now - pwrPressStart;
    if (duration > 50 && duration < 2000) { // Short press
      // Toggle view between Companion and Diagnostics
      Serial.println("PWR Button: Toggling View Mode");
      if (currentState == STATE_COMPANION) {
        currentState = STATE_STATUS;
      } else if (currentState == STATE_STATUS) {
        currentState = STATE_COMPANION;
      }
      updateUI();
    }
    pwrWasPressed = false;
  }
}

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

// Connect to WiFi
void connectWiFi() {
  gfx->fillScreen(COLOR_DARK_BG);
  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_TEXT_MAIN);
  gfx->setCursor(10, 40);
  gfx->println("Connecting to WiFi...");
  gfx->print("SSID: ");
  gfx->println(ssid);

  WiFi.begin(ssid, password);
  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 20) {
    delay(500);
    gfx->print(".");
    Serial.print(".");
    retry++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    gfx->println("\nConnected!");
    gfx->print("IP: ");
    gfx->println(WiFi.localIP().toString());
    delay(1000);
  } else {
    gfx->println("\nConnection failed! Running Offline.");
    delay(2000);
  }
}

// Check WiFi and reconnect in background if disconnected (non-blocking)
void checkWiFiConnection() {
  static unsigned long lastWiFiCheckTime = 0;
  unsigned long now = millis();
  
  if (now - lastWiFiCheckTime > 10000) { // Check every 10 seconds
    lastWiFiCheckTime = now;
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("WiFi disconnected! Attempting reconnect in background...");
      WiFi.disconnect();
      WiFi.begin(ssid, password);
    }
  }
}

// Connect to MQTT Broker (non-blocking)
void reconnectMQTT() {
  if (WiFi.status() != WL_CONNECTED) return;
  
  static unsigned long lastReconnectAttempt = 0;
  if (!mqttClient.connected()) {
    unsigned long now = millis();
    if (now - lastReconnectAttempt > 5000) { // Try every 5 seconds
      lastReconnectAttempt = now;
      Serial.print("Attempting MQTT connection (non-blocking)...");
      String clientId = "ESP32S3Client-" + String(random(0xffff), HEX);
      
      if (mqttClient.connect(clientId.c_str())) {
        Serial.println("connected");
        
        String requestTopic = "ai/request/" + String(client_id);
        String queueTopic = "ai/queue/" + String(client_id);
        String notifyTopic = "ai/notify/" + String(client_id);
        String petChangedTopic = "ai/pet_changed/" + String(client_id);
        String petStateTopic = "ai/pet_state/" + String(client_id);
        
        mqttClient.subscribe(requestTopic.c_str());
        mqttClient.subscribe(queueTopic.c_str());
        mqttClient.subscribe(notifyTopic.c_str());
        mqttClient.subscribe(petChangedTopic.c_str());
        mqttClient.subscribe(petStateTopic.c_str());
        
        sendHeartbeat();
        
        updateUI();
      } else {
        Serial.print("failed, rc=");
        Serial.print(mqttClient.state());
        Serial.println(" try again in 5 seconds");
      }
    }
  }
}

void IRAM_ATTR touch_isr() {
  isPressed = true;
}

void setup() {
  Serial.begin(115200);

  // Latch battery power immediately (GPIO 2 HIGH)
  pinMode(PIN_BAT_PWR, OUTPUT);
  digitalWrite(PIN_BAT_PWR, HIGH);

  // Initialize button pins
  pinMode(PIN_BOOT, INPUT_PULLUP);
  pinMode(PIN_PLUS, INPUT_PULLUP);
  pinMode(PIN_PWR, INPUT_PULLUP);

  // Initialize charging detection pin
  pinMode(PIN_CHG, INPUT_PULLUP);

  // Measure battery level once at startup
  updateBatteryStatus();
  
  // Init Display
  if (!gfx->begin()) {
    Serial.println("gfx->begin() failed!");
  }
  initBrightness();
  gfx->fillScreen(COLOR_DARK_BG);

#ifdef U8G2_FONT_SUPPORT
  gfx->setFont(u8g2_font_unifont_t_chinese4);
  gfx->setUTF8Print(true);
#endif

  // Allocate pet double buffer in SPIRAM, fallback to internal RAM
  petDoubleBuffer = (uint16_t*)heap_caps_malloc(192 * 208 * 2, MALLOC_CAP_SPIRAM);
  if (petDoubleBuffer == nullptr) {
    Serial.println("SPIRAM double buffer allocation failed! Trying internal heap...");
    petDoubleBuffer = (uint16_t*)heap_caps_malloc(192 * 208 * 2, MALLOC_CAP_INTERNAL);
  }
  if (petDoubleBuffer == nullptr) {
    Serial.println("Warning: Double buffer allocation failed entirely! Flicker reduction will be disabled.");
  }

  // Init Touch sensor
  touch.setPins(SENSOR_RST, SENSOR_IRQ);
  Wire.begin(SENSOR_SDA, SENSOR_SCL);
  hasTouch = touch.begin(Wire, CST816_SLAVE_ADDRESS, SENSOR_SDA, SENSOR_SCL);
  if (hasTouch) {
    Serial.println("Touch Panel CST816 initialized.");
    attachInterrupt(SENSOR_IRQ, touch_isr, FALLING);
  } else {
    Serial.println("Touch Panel CST816 initialization failed!");
  }

  // Network and MQTT Setup
  connectWiFi();
  mqttClient.setServer(mqtt_server, mqtt_port);
  mqttClient.setCallback(callback);
  mqttClient.setKeepAlive(120); // Long keepalive to survive pet binary downloads
  
  updateUI();
}

void loop() {
  // Check WiFi connectivity in background
  checkWiFiConnection();

  // Check MQTT connection
  if (!mqttClient.connected()) {
    reconnectMQTT();
  }
  mqttClient.loop();
  
  // Check and process physical buttons
  checkButtons();

  // Update battery level every 10 seconds (non-blocking)
  if (millis() - lastBatteryUpdateTime > 10000) {
    lastBatteryUpdateTime = millis();
    int prevBatteryPct = batteryPct;
    bool prevIsCharging = isCharging;
    
    updateBatteryStatus();
    
    // If battery status changed and we are on a screen with a header, redraw it
    if (batteryPct != prevBatteryPct || isCharging != prevIsCharging) {
      if (currentState == STATE_STATUS || currentState == STATE_APPROVAL || currentState == STATE_NOTIFICATION) {
        updateUI();
      } else if (currentState == STATE_COMPANION) {
        overlaysNeedRedraw = true;
      }
    }
  }

  // Send heartbeat every 5 seconds
  static unsigned long lastHeartbeatTime = 0;
  if (millis() - lastHeartbeatTime > 5000) {
    lastHeartbeatTime = millis();
    sendHeartbeat();
  }
  
  // Check touch coordinates
  checkTouch();
  
  // Handle temporary companion state expiry
  if (companionStateExpiry > 0 && (int32_t)(millis() - companionStateExpiry) >= 0) {
    companionState = "idle";
    companionStateExpiry = 0;
  }
  
  // Animation frame update for companion mascot rendering (approx 6-8 fps -> ~150ms per frame)
  if (currentState == STATE_COMPANION) {
    unsigned long now = millis();
    if (now - lastFrameTime > 150) {
      currentFrameIndex++;
      lastFrameTime = now;
      drawCompanionScreen();
    }
  }
  
  // Clear expired notifications (active for 4 seconds)
  if (activeNotification.active && (millis() - activeNotification.timestamp > 4000)) {
    activeNotification.active = false;
    // After notification expires, auto-switch to approval if requests are pending
    if (requests.size() > 0) {
      currentState = STATE_APPROVAL;
      currentRequestIndex = 0;
    }
    updateUI();
  }
  
  delay(10);
}

