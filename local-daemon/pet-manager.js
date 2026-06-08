const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const qiniu = require('qiniu');

const PETS_DIR = path.join(__dirname, 'public', 'pets');

// Ensure directory exists
function ensureDir(p) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

ensureDir(PETS_DIR);

// Fetch pet manifest from petdex
async function fetchManifest() {
  try {
    const res = await fetch('https://petdex.crafter.run/api/manifest');
    if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
    const data = await res.json();
    
    // Save locally
    fs.writeFileSync(path.join(PETS_DIR, 'manifest.json'), JSON.stringify(data, null, 2), 'utf8');
    return data;
  } catch (err) {
    console.error('Failed to fetch manifest from petdex:', err);
    // Fallback to local manifest if exists
    if (fs.existsSync(path.join(PETS_DIR, 'manifest.json'))) {
      return JSON.parse(fs.readFileSync(path.join(PETS_DIR, 'manifest.json'), 'utf8'));
    }
    return { pets: [] };
  }
}

// Download a file
async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(arrayBuffer));
}

// Import a pet by manifest details
async function importPetByDetails(slug, petJsonUrl, spritesheetUrl) {
  const petDir = path.join(PETS_DIR, slug);
  ensureDir(petDir);

  // Correct outdated domain in URLs
  if (petJsonUrl && petJsonUrl.includes('petdex-assets.raillyhugo.workers.dev')) {
    petJsonUrl = petJsonUrl.replaceAll('petdex-assets.raillyhugo.workers.dev', 'assets.petdex.dev');
  }
  if (spritesheetUrl && spritesheetUrl.includes('petdex-assets.raillyhugo.workers.dev')) {
    spritesheetUrl = spritesheetUrl.replaceAll('petdex-assets.raillyhugo.workers.dev', 'assets.petdex.dev');
  }

  console.log(`Importing pet "${slug}"...`);
  console.log(`Using petJsonUrl: ${petJsonUrl}`);
  console.log(`Using spritesheetUrl: ${spritesheetUrl}`);
  
  // Download pet.json and unwrap if nested
  const petJsonPath = path.join(petDir, 'pet.json');
  let res = await fetch(petJsonUrl);
  
  if (!res.ok) {
    let fallbackUrl = null;
    if (petJsonUrl.endsWith('petjson.json')) {
      fallbackUrl = petJsonUrl.replace('petjson.json', 'pet.json');
    } else if (petJsonUrl.endsWith('pet.json')) {
      fallbackUrl = petJsonUrl.replace('pet.json', 'petjson.json');
    }
    
    if (fallbackUrl) {
      console.log(`[pet-manager] ${petJsonUrl} failed with status ${res.status}. Retrying fallback URL: ${fallbackUrl}`);
      const fallbackRes = await fetch(fallbackUrl);
      if (fallbackRes.ok) {
        res = fallbackRes;
      }
    }
  }

  if (!res.ok) throw new Error(`Failed to download ${petJsonUrl}: ${res.status}`);
  let json = await res.json();
  if (json.pet) {
    json = json.pet;
  }
  fs.writeFileSync(petJsonPath, JSON.stringify(json, null, 2), 'utf8');

  // Download spritesheet (supports webp or png)
  const isPng = spritesheetUrl.endsWith('.png');
  const spritesheetExt = isPng ? 'png' : 'webp';
  const spritesheetPath = path.join(petDir, `spritesheet.${spritesheetExt}`);
  await downloadFile(spritesheetUrl, spritesheetPath);

  // Process and package frames
  const binPath = await processAndPackagePet(slug);
  return binPath;
}

// Process spritesheet and build custom pet_assets.bin
async function processAndPackagePet(slug) {
  const petDir = path.join(PETS_DIR, slug);
  const petJson = JSON.parse(fs.readFileSync(path.join(petDir, 'pet.json'), 'utf8'));
  
  // Detect spritesheet file
  let spritesheetPath = path.join(petDir, 'spritesheet.webp');
  if (!fs.existsSync(spritesheetPath)) {
    spritesheetPath = path.join(petDir, 'spritesheet.png');
  }
  if (!fs.existsSync(spritesheetPath)) {
    throw new Error(`Spritesheet not found for pet: ${slug}`);
  }

  // Get animation specifications. Default rows/frames standard for Petdex:
  // idle (row 0), run (row 1), review (row 4), failed (row 5), jump (row 6)
  const requiredStates = {
    'idle': { row: 0, frames: 6 },
    'run': { row: 1, frames: 6 },
    'review': { row: 4, frames: 6 },
    'failed': { row: 5, frames: 6 },
    'jump': { row: 6, frames: 6 }
  };

  const animConfig = petJson.animations || {};
  const S = Object.keys(requiredStates).length;
  const headerSize = 12 + S * 48; // Magic(4)+Version(4)+StateCount(4) + S*(name(32)+frames(4)+width(4)+height(4)+offsetTableOffset(4))

  // 1. Extract frames and compress to standard PNG buffers using sharp
  const statesData = [];
  for (const [stateName, defaults] of Object.entries(requiredStates)) {
    const config = animConfig[stateName] || {};
    const row = typeof config.row === 'number' ? config.row : defaults.row;
    const frames = typeof config.frames === 'number' ? config.frames : defaults.frames;
    
    console.log(`Processing state "${stateName}" (row: ${row}, frames: ${frames})...`);
    
    const width = 192;
    const height = 208;
    const pngBuffers = [];
    
    for (let c = 0; c < frames; c++) {
      try {
        const pngBuffer = await sharp(spritesheetPath)
          .extract({ left: c * width, top: row * height, width, height })
          .png() // Standard lossless PNG compression (preserves full 24-bit/32-bit colors & alpha channels)
          .toBuffer();
        pngBuffers.push(pngBuffer);
      } catch (err) {
        console.error(`Failed to crop frame row ${row}, col ${c} for state ${stateName}:`, err);
        // Fallback: empty transparent pixel PNG
        const fallbackPng = await sharp({
          create: {
            width: 1,
            height: 1,
            channels: 4,
            background: { r: 248, g: 31, b: 31, alpha: 0 }
          }
        }).png().toBuffer();
        pngBuffers.push(fallbackPng);
      }
    }

    statesData.push({
      name: stateName,
      frames,
      width,
      height,
      pngBuffers
    });
  }

  // 2. Calculate offsets
  // Frame directories start right after the main header
  let currentTableOffset = headerSize;
  for (const state of statesData) {
    state.offsetTableOffset = currentTableOffset;
    currentTableOffset += state.frames * 8; // 8 bytes per frame (Offset 4, Size 4)
  }

  // PNG data blocks start after all frame directory tables
  let currentPngPayloadOffset = currentTableOffset;
  for (const state of statesData) {
    state.frameOffsets = [];
    for (let i = 0; i < state.frames; i++) {
      const pngSize = state.pngBuffers[i].length;
      state.frameOffsets.push({
        offset: currentPngPayloadOffset,
        size: pngSize
      });
      currentPngPayloadOffset += pngSize;
    }
  }

  // 3. Construct binary buffer
  const mainHeader = Buffer.alloc(headerSize);
  mainHeader.write('PETP', 0, 4, 'ascii'); // Magic: PETP
  mainHeader.writeInt32LE(3, 4); // Version: 3
  mainHeader.writeInt32LE(S, 8); // State count

  let headerIndex = 12;
  for (const state of statesData) {
    const nameBuf = Buffer.alloc(32);
    nameBuf.write(state.name, 0, state.name.length, 'utf8');
    nameBuf.copy(mainHeader, headerIndex);
    
    mainHeader.writeInt32LE(state.frames, headerIndex + 32);
    mainHeader.writeInt32LE(state.width, headerIndex + 36);
    mainHeader.writeInt32LE(state.height, headerIndex + 40);
    mainHeader.writeInt32LE(state.offsetTableOffset, headerIndex + 44);

    headerIndex += 48;
  }

  // Create Frame Offset Tables
  const tablesBufferList = [];
  for (const state of statesData) {
    const stateTable = Buffer.alloc(state.frames * 8);
    for (let i = 0; i < state.frames; i++) {
      stateTable.writeInt32LE(state.frameOffsets[i].offset, i * 8);
      stateTable.writeInt32LE(state.frameOffsets[i].size, i * 8 + 4);
    }
    tablesBufferList.push(stateTable);
  }
  const allTablesBuffer = Buffer.concat(tablesBufferList);

  // Combine PNG payloads
  const pngBuffersList = [];
  for (const state of statesData) {
    for (const buf of state.pngBuffers) {
      pngBuffersList.push(buf);
    }
  }

  const finalFileBuffer = Buffer.concat([
    mainHeader,
    allTablesBuffer,
    ...pngBuffersList
  ]);

  const outputBinPath = path.join(petDir, 'pet_assets.bin');
  fs.writeFileSync(outputBinPath, finalFileBuffer);
  console.log(`Created binary package (PETP v3): ${outputBinPath} (Size: ${finalFileBuffer.length} bytes)`);
  return outputBinPath;
}

// Upload pet_assets.bin to tmpfile.link (China-accessible)
async function uploadToTmpFiles(slug) {
  const binPath = path.join(PETS_DIR, slug, 'pet_assets.bin');
  if (!fs.existsSync(binPath)) {
    throw new Error(`Binary file not found for pet ${slug}: ${binPath}`);
  }

  console.log(`Uploading ${slug} binary assets to tmpfile.link...`);
  const fileBuffer = fs.readFileSync(binPath);

  const form = new FormData();
  const blob = new Blob([fileBuffer], { type: 'application/octet-stream' });
  form.append('file', blob, 'pet_assets.bin');

  const res = await fetch('https://tmpfile.link/api/upload', {
    method: 'POST',
    body: form
  });

  if (!res.ok) {
    throw new Error(`tmpfile.link upload failed: ${res.status}`);
  }

  const json = await res.json();
  if (!json.downloadLink) {
    throw new Error(`tmpfile.link api error: ${JSON.stringify(json)}`);
  }

  console.log(`Uploaded pet_assets.bin successfully. Direct link: ${json.downloadLink}`);
  return json.downloadLink;
}

// Get list of imported pets
function getImportedPets() {
  const files = fs.readdirSync(PETS_DIR);
  const imported = [];
  for (const f of files) {
    const petDir = path.join(PETS_DIR, f);
    if (fs.statSync(petDir).isDirectory()) {
      const petJsonPath = path.join(petDir, 'pet.json');
      if (fs.existsSync(petJsonPath)) {
        try {
          const petJson = JSON.parse(fs.readFileSync(petJsonPath, 'utf8'));
          let ext = 'webp';
          if (fs.existsSync(path.join(petDir, 'spritesheet.png'))) {
            ext = 'png';
          }
          imported.push({
            slug: f,
            displayName: petJson.displayName,
            description: petJson.description,
            spritesheetExt: ext,
            hasBin: fs.existsSync(path.join(petDir, 'pet_assets.bin'))
          });
        } catch {}
      }
    }
  }
  return imported;
}

// Upload pet_assets.bin to Qiniu Cloud
async function uploadToQiniu(slug) {
  const accessKey = process.env.QINIU_ACCESS_KEY;
  const secretKey = process.env.QINIU_SECRET_KEY;
  const bucket = process.env.QINIU_BUCKET;
  let domain = process.env.QINIU_DOMAIN;
  const prefix = process.env.QINIU_PREFIX || 'pets/';

  if (!accessKey || !secretKey || !bucket || !domain) {
    throw new Error('Qiniu credentials missing in environment variables');
  }

  const binPath = path.join(PETS_DIR, slug, 'pet_assets.bin');
  if (!fs.existsSync(binPath)) {
    throw new Error(`Binary file not found for pet ${slug}: ${binPath}`);
  }

  const mac = new qiniu.auth.digest.Mac(accessKey, secretKey);
  const key = `${prefix}${slug}/pet_assets.bin`;

  const options = {
    scope: `${bucket}:${key}`, // Overwrite existing file with same key
  };
  const putPolicy = new qiniu.rs.PutPolicy(options);
  const uploadToken = putPolicy.uploadToken(mac);

  const config = new qiniu.conf.Config();
  const zoneName = process.env.QINIU_ZONE || 'Zone_z0';
  if (qiniu.zone[zoneName]) {
    config.zone = qiniu.zone[zoneName];
  } else {
    config.zone = qiniu.zone.Zone_z0;
  }

  const formUploader = new qiniu.form_up.FormUploader(config);
  const putExtra = new qiniu.form_up.PutExtra();

  console.log(`Uploading ${slug} binary assets to Qiniu Cloud [${key}]...`);

  return new Promise((resolve, reject) => {
    formUploader.putFile(uploadToken, key, binPath, putExtra, (respErr, respBody, respInfo) => {
      if (respErr) {
        return reject(respErr);
      }
      if (respInfo.statusCode === 200) {
        if (!domain.endsWith('/')) {
          domain += '/';
        }
        const downloadUrl = `${domain}${key}`;
        console.log(`Uploaded to Qiniu successfully. CDN link: ${downloadUrl}`);
        resolve(downloadUrl);
      } else {
        reject(new Error(`Qiniu upload failed with status ${respInfo.statusCode}: ${JSON.stringify(respBody)}`));
      }
    });
  });
}

module.exports = {
  fetchManifest,
  importPetByDetails,
  processAndPackagePet,
  uploadToTmpFiles,
  uploadToQiniu,
  getImportedPets,
  PETS_DIR
};
