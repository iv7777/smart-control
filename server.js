const http = require('http');
const axios = require('axios');
const crypto = require('crypto');
const schedule = require('node-schedule');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
// Load environment variables from .env file if it exists
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf8');
  envConfig.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      const val = valueParts.join('=').trim();
      if (key && val) {
        process.env[key.trim()] = val.replace(/^["']|["']$/g, ''); // remove optional quotes
      }
    }
  });
}

const CLIENT_ID = process.env.TUYA_CLIENT_ID;
const SECRET = process.env.TUYA_SECRET;
const UID = process.env.TUYA_UID;

if (!CLIENT_ID || !SECRET || !UID) {
  console.error('ERROR: Missing required environment variables TUYA_CLIENT_ID, TUYA_SECRET, or TUYA_UID.');
  console.error('Please configure them in your environment or place a .env file in the server directory.');
  process.exit(1);
}

const BASE_URL = 'https://openapi.tuyacn.com'; 
const STORAGE_FILE = path.join(__dirname, 'schedules.json');
const ORG_FILE = path.join(__dirname, 'orgData.json');

let cachedToken = '';
let tokenRefreshPromise = null;  // shared in-flight promise — see getAccessToken()
const activeJobs = {}; 

// --- ORG DATA HELPERS (shops + groups) ---
// Shops are pure organization (labels for filtering, never a control target).
// Groups belong to exactly one shop. A device belongs to at most one group,
// and that group must be in the same shop the device is currently assigned to.
function loadOrgData() {
  if (!fs.existsSync(ORG_FILE)) return { shops: [], deviceShops: {}, groups: [] };
  try {
    const data = fs.readFileSync(ORG_FILE, 'utf8');
    const parsed = JSON.parse(data || '{}');
    return {
      shops: parsed.shops || [],
      deviceShops: parsed.deviceShops || {},
      groups: parsed.groups || []
    };
  } catch (err) {
    console.error('Error reading org data:', err.message);
    return { shops: [], deviceShops: {}, groups: [] };
  }
}

function saveOrgData(orgData) {
  try {
    fs.writeFileSync(ORG_FILE, JSON.stringify(orgData, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing org data:', err.message);
  }
}

// Removes a device from whichever group currently holds it (enforces the
// "one group per device" rule whenever membership changes elsewhere)
function removeDeviceFromAllGroups(orgData, deviceId) {
  orgData.groups.forEach(g => {
    g.deviceIds = g.deviceIds.filter(id => id !== deviceId);
  });
}

// --- PERSISTENCE HELPERS ---
function loadPersistedSchedules() {
  if (!fs.existsSync(STORAGE_FILE)) return {};
  try {
    const data = fs.readFileSync(STORAGE_FILE, 'utf8');
    return JSON.parse(data || '{}');
  } catch (err) {
    console.error('Error reading persistent schedules:', err.message);
    return {};
  }
}

// Write updates into local flat file storage
function savePersistedSchedules(schedules) {
  try {
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(schedules, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing persistent schedules:', err.message);
  }
}

// Cancels and removes any individual schedules belonging to a device.
// Called whenever a device joins a group — the group's own schedule
// takes over, so the device's standalone automation is overwritten.
function deleteDeviceSchedules(deviceId) {
  const currentSchedules = loadPersistedSchedules();
  let changed = false;
  Object.keys(currentSchedules).forEach(jobKey => {
    if (currentSchedules[jobKey].deviceId === deviceId) {
      if (activeJobs[jobKey]) { activeJobs[jobKey].cancel(); delete activeJobs[jobKey]; }
      delete currentSchedules[jobKey];
      changed = true;
    }
  });
  if (changed) savePersistedSchedules(currentSchedules);
}

// Cancels and removes any schedules belonging to a group (used when a
// group, or the shop it lives in, is deleted).
function deleteGroupSchedules(groupId) {
  const currentSchedules = loadPersistedSchedules();
  let changed = false;
  Object.keys(currentSchedules).forEach(jobKey => {
    if (currentSchedules[jobKey].groupId === groupId) {
      if (activeJobs[jobKey]) { activeJobs[jobKey].cancel(); delete activeJobs[jobKey]; }
      delete currentSchedules[jobKey];
      changed = true;
    }
  });
  if (changed) savePersistedSchedules(currentSchedules);
}

// Fires a single scheduled action, whether it targets one device or a
// whole group. Group membership is resolved fresh at fire time, so a
// group schedule always applies to whichever devices are in the group
// right now — not whoever was in it when the schedule was created.
async function executeScheduledAction(sched) {
  try {
    if (sched.deviceId) {
      const commands = [{ code: 'switch_led', value: sched.targetStatus }];
      if (sched.targetStatus && sched.brightness != null) {
        commands.push({ code: 'work_mode', value: 'white' });
        commands.push({ code: sched.brightCode || 'bright_value', value: sched.brightness });
      }
      await tuyaApiRequest(`/v1.0/iot-03/devices/${sched.deviceId}/commands`, 'POST', { commands });
    } else if (sched.groupId) {
      const orgData = loadOrgData();
      const group = orgData.groups.find(g => g.groupId === sched.groupId);
      if (!group) {
        console.warn(`[Scheduled Group Skipped] Group ${sched.groupId} no longer exists`);
        return;
      }
      const codeMap = {};
      (sched.deviceCodes || []).forEach(dc => { codeMap[dc.deviceId] = dc.code; });
      await Promise.all(group.deviceIds.map(deviceId => {
        const commands = [{ code: 'switch_led', value: sched.targetStatus }];
        if (sched.targetStatus && sched.brightness != null) {
          commands.push({ code: 'work_mode', value: 'white' });
          commands.push({ code: codeMap[deviceId] || 'bright_value', value: sched.brightness });
        }
        return tuyaApiRequest(`/v1.0/iot-03/devices/${deviceId}/commands`, 'POST', { commands });
      }));
    }
  } catch (err) {
    console.error('[Scheduled Execution Failed]', err.message);
  }
}

// Re-register timers on startup
function initializeSchedules() {
  const saved = loadPersistedSchedules();
  Object.keys(saved).forEach(jobKey => {
    const sched = saved[jobKey];
    const [hour, minute] = sched.time.split(':');
    const cronPattern = `${minute} ${hour} * * *`;

    activeJobs[jobKey] = schedule.scheduleJob(cronPattern, () => {
      console.log(`[Persistent Timer Triggered] Executing action for key: ${jobKey}`);
      executeScheduledAction(sched);
    });
  });
  console.log(`[Init] Loaded and armed ${Object.keys(saved).length} automation schedules.`);
}

// --- HELPER: Tuya SHA256 Signature Math ---
function calculateSign(clientId, secret, timestamp, stringToSign, accessToken = '') {
  const str = clientId + accessToken + timestamp + stringToSign;
  return crypto.createHmac('sha256', secret).update(str).digest('hex').toUpperCase();
}

// --- HELPER: Fetch Token ---
async function getAccessToken() {
  // Deduplicate concurrent token-refresh calls: all callers awaiting a new
  // token share the same single in-flight request instead of each firing
  // their own to the Tuya endpoint.
  if (tokenRefreshPromise) return tokenRefreshPromise;
  tokenRefreshPromise = (async () => {
    const timestamp = Date.now().toString();
    const urlPath = '/v1.0/token?grant_type=1';
    const contentHash = crypto.createHash('sha256').update('').digest('hex');
    const stringToSign = `GET\n${contentHash}\n\n${urlPath}`;
    const sign = calculateSign(CLIENT_ID, SECRET, timestamp, stringToSign);

    const response = await axios.get(`${BASE_URL}${urlPath}`, {
      headers: { 'client_id': CLIENT_ID, 'sign': sign, 't': timestamp, 'sign_method': 'HMAC-SHA256' }
    });
    if (response.data.success) {
      cachedToken = response.data.result.access_token;
      return cachedToken;
    }
    throw new Error(response.data.msg);
  })().catch(error => {
    console.error('Token error:', error.message);
    throw error;
  }).finally(() => {
    tokenRefreshPromise = null;
  });
  return tokenRefreshPromise;
}

// --- HELPER: Send Generic API Requests ---
async function tuyaApiRequest(path, method, body = null, retried = false) {
  const token = cachedToken || await getAccessToken();
  const timestamp = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  
  const contentHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
  const stringToSign = `${method}\n${contentHash}\n\n${path}`;
  const sign = calculateSign(CLIENT_ID, SECRET, timestamp, stringToSign, token);

  const headers = {
    'client_id': CLIENT_ID,
    'access_token': token,
    'sign': sign,
    't': timestamp,
    'sign_method': 'HMAC-SHA256',
    'Content-Type': 'application/json'
  };

  try {
    const config = { method, url: `${BASE_URL}${path}`, headers };
    if (body) config.data = body;
    const response = await axios(config);
    
    // Guard against infinite retry: refresh the token only once per call.
    if (response.data.code === 1010 && !retried) { 
      await getAccessToken();
      return tuyaApiRequest(path, method, body, true);
    }
    return response.data;
  } catch (error) {
    throw error;
  }
}

// --- NATIVE HTTP SERVER ---
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // FEATURE 1: Fetch Live Device List & Statuses
  if (req.url === '/api/devices' && req.method === 'GET') {
    tuyaApiRequest(`/v1.0/users/${UID}/devices`, 'GET')
      .then(result => {
        const allDevices = result.result || [];
        
        // Exclude devices belonging to the gateway category 'wg2'
        const filteredDevices = allDevices.filter(dev => dev.category !== 'wg2');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, devices: filteredDevices }));
      })
      .catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      });
  }

  // Route: Instant Power Control
  else if (req.url === '/api/light/power' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { deviceId, status } = JSON.parse(body);
        const result = await tuyaApiRequest(`/v1.0/iot-03/devices/${deviceId}/commands`, 'POST', {
          commands: [{ code: 'switch_led', value: status }]
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: result }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  // Route: Instant Brightness Control
  else if (req.url === '/api/light/brightness' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { deviceId, value, code } = JSON.parse(body);
        // Fallback to bright_value if no specific structural code target is emitted
        const targetCode = code || 'bright_value'; 
        
        // Always include work_mode: "white" alongside the brightness command payload
        const result = await tuyaApiRequest(`/v1.0/iot-03/devices/${deviceId}/commands`, 'POST', {
          commands: [
            { code: 'work_mode', value: 'white' },
            { code: targetCode, value: parseInt(value) }
          ]
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: result }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  // FEATURE 2: Handle Dynamic Schedule Setup with Flat-File Persistence
  else if (req.url === '/api/light/schedule' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { deviceId, time, targetStatus, brightness, brightCode } = JSON.parse(body);

        // A device in a group is controlled by the group's schedule instead
        const orgData = loadOrgData();
        const inGroup = orgData.groups.some(g => g.deviceIds.includes(deviceId));
        if (inGroup) throw new Error('This device belongs to a group — schedule the group instead.');

        const [hour, minute] = time.split(':');

        // Each schedule gets a unique UUID key — supports up to 10+ per device
        const jobKey = crypto.randomUUID();
        const sched = { deviceId, time, targetStatus, ...(brightness != null && { brightness, brightCode }) };

        const cronPattern = `${minute} ${hour} * * *`;
        activeJobs[jobKey] = schedule.scheduleJob(cronPattern, () => {
          console.log(`[Timer Triggered] Firing power: ${targetStatus} to device: ${deviceId}`);
          executeScheduledAction(sched);
        });

        // Write update into local flat file storage
        const currentSchedules = loadPersistedSchedules();
        currentSchedules[jobKey] = sched;
        savePersistedSchedules(currentSchedules);

        console.log(`[Scheduled & Saved] ${deviceId} configured daily at ${time}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Timer verified and saved for ${time}` }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  // FEATURE 3: Retrieve Schedules
  else if (req.url === '/api/schedules' && req.method === 'GET') {
    const currentSchedules = loadPersistedSchedules();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, schedules: currentSchedules }));
  }

  // FEATURE 4: Delete Schedule
  else if (req.url === '/api/light/schedule/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { jobKey } = JSON.parse(body);
        if (activeJobs[jobKey]) {
          activeJobs[jobKey].cancel();
          delete activeJobs[jobKey];
        }
        const currentSchedules = loadPersistedSchedules();
        if (currentSchedules[jobKey]) {
          delete currentSchedules[jobKey];
          savePersistedSchedules(currentSchedules);
        }
        console.log(`[Schedule Deleted] Canceled and removed job: ${jobKey}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Schedule ${jobKey} deleted successfully` }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  // FEATURE 5: Shops (pure organization — labels only, never a control target)
  else if (req.url === '/api/shops' && req.method === 'GET') {
    const orgData = loadOrgData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, shops: orgData.shops, deviceShops: orgData.deviceShops }));
  }

  else if (req.url === '/api/shops' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body);
        if (!name || !name.trim()) throw new Error('Shop name is required');
        const orgData = loadOrgData();
        const shop = { shopId: crypto.randomUUID(), name: name.trim() };
        orgData.shops.push(shop);
        saveOrgData(orgData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, shop }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  else if (req.url === '/api/shops/rename' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { shopId, name } = JSON.parse(body);
        if (!name || !name.trim()) throw new Error('Shop name is required');
        const orgData = loadOrgData();
        const shop = orgData.shops.find(s => s.shopId === shopId);
        if (!shop) throw new Error('Shop not found');
        shop.name = name.trim();
        saveOrgData(orgData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  else if (req.url === '/api/shops/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { shopId } = JSON.parse(body);
        const orgData = loadOrgData();
        orgData.shops = orgData.shops.filter(s => s.shopId !== shopId);
        // Unassign devices that were in this shop
        Object.keys(orgData.deviceShops).forEach(devId => {
          if (orgData.deviceShops[devId] === shopId) delete orgData.deviceShops[devId];
        });
        // Groups belong to exactly one shop, so they can't outlive it —
        // clean up their schedules too before dropping them
        const groupIdsToRemove = orgData.groups.filter(g => g.shopId === shopId).map(g => g.groupId);
        orgData.groups = orgData.groups.filter(g => g.shopId !== shopId);
        groupIdsToRemove.forEach(deleteGroupSchedules);
        saveOrgData(orgData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  else if (req.url === '/api/devices/assign-shop' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { deviceId, shopId } = JSON.parse(body);
        const orgData = loadOrgData();
        const previousShopId = orgData.deviceShops[deviceId] || null;
        if (shopId) {
          orgData.deviceShops[deviceId] = shopId;
        } else {
          delete orgData.deviceShops[deviceId];
        }
        // Changing (or clearing) a device's shop invalidates its group
        // membership, since a group's devices must share the group's shop
        if (previousShopId !== (shopId || null)) {
          removeDeviceFromAllGroups(orgData, deviceId);
        }
        saveOrgData(orgData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  else if (req.url === '/api/devices/assign-group' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { deviceId, groupId } = JSON.parse(body);
        const orgData = loadOrgData();
        removeDeviceFromAllGroups(orgData, deviceId);
        if (groupId) {
          const group = orgData.groups.find(g => g.groupId === groupId);
          if (!group) throw new Error('Group not found');
          if (orgData.deviceShops[deviceId] !== group.shopId) {
            throw new Error("Device must belong to the group's shop first");
          }
          group.deviceIds.push(deviceId);
          // Joining a group hands control to the group's own schedule —
          // any individual schedule this device had is overwritten
          deleteDeviceSchedules(deviceId);
        }
        saveOrgData(orgData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  // FEATURE 6: Groups (belong to exactly one shop; the only controllable unit besides single devices)
  else if (req.url === '/api/groups' && req.method === 'GET') {
    const orgData = loadOrgData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, groups: orgData.groups }));
  }

  else if (req.url === '/api/groups' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { shopId, name, deviceIds } = JSON.parse(body);
        if (!shopId) throw new Error('shopId is required');
        if (!name || !name.trim()) throw new Error('Group name is required');
        const orgData = loadOrgData();
        const shop = orgData.shops.find(s => s.shopId === shopId);
        if (!shop) throw new Error('Shop not found');
        const ids = Array.isArray(deviceIds) ? deviceIds : [];
        ids.forEach(id => {
          if (orgData.deviceShops[id] !== shopId) {
            throw new Error(`Device ${id} does not belong to shop ${shop.name}`);
          }
        });
        // A device can only be in one group at a time
        ids.forEach(id => removeDeviceFromAllGroups(orgData, id));
        const group = { groupId: crypto.randomUUID(), shopId, name: name.trim(), deviceIds: ids };
        orgData.groups.push(group);
        saveOrgData(orgData);
        // Joining a group hands control to the group's own schedule —
        // any individual schedules these devices had are overwritten
        ids.forEach(deleteDeviceSchedules);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, group }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  else if (req.url === '/api/groups/update' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { groupId, name, deviceIds } = JSON.parse(body);
        const orgData = loadOrgData();
        const group = orgData.groups.find(g => g.groupId === groupId);
        if (!group) throw new Error('Group not found');
        if (name && name.trim()) group.name = name.trim();
        if (Array.isArray(deviceIds)) {
          deviceIds.forEach(id => {
            if (orgData.deviceShops[id] !== group.shopId) {
              throw new Error(`Device ${id} does not belong to this group's shop`);
            }
          });
          group.deviceIds = [];
          deviceIds.forEach(id => removeDeviceFromAllGroups(orgData, id));
          group.deviceIds = deviceIds;
          saveOrgData(orgData);
          // Joining a group hands control to the group's own schedule —
          // any individual schedules these devices had are overwritten
          deviceIds.forEach(deleteDeviceSchedules);
        } else {
          saveOrgData(orgData);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  else if (req.url === '/api/groups/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { groupId } = JSON.parse(body);
        const orgData = loadOrgData();
        orgData.groups = orgData.groups.filter(g => g.groupId !== groupId);
        saveOrgData(orgData);
        deleteGroupSchedules(groupId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  // FEATURE 8: Group scheduling — same shape as device scheduling, but the
  // cron callback resolves group membership fresh at fire time (see
  // executeScheduledAction), so it always applies to whoever's in the
  // group right now.
  else if (req.url === '/api/light/group/schedule' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { groupId, time, targetStatus, brightness, deviceCodes } = JSON.parse(body);
        const orgData = loadOrgData();
        const group = orgData.groups.find(g => g.groupId === groupId);
        if (!group) throw new Error('Group not found');

        const jobKey = crypto.randomUUID();
        const sched = { groupId, time, targetStatus, ...(brightness != null && { brightness, deviceCodes }) };
        const [hour, minute] = time.split(':');
        const cronPattern = `${minute} ${hour} * * *`;

        activeJobs[jobKey] = schedule.scheduleJob(cronPattern, () => {
          console.log(`[Timer Triggered] Firing power: ${targetStatus} to group: ${groupId}`);
          executeScheduledAction(sched);
        });

        const currentSchedules = loadPersistedSchedules();
        currentSchedules[jobKey] = sched;
        savePersistedSchedules(currentSchedules);

        console.log(`[Scheduled & Saved] Group ${groupId} configured daily at ${time}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Timer verified and saved for ${time}` }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  // FEATURE 7: Group control — loops the same per-device Tuya command used for single devices
  else if (req.url === '/api/light/group/power' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { groupId, status, deviceIds, isCorrection } = JSON.parse(body);
        const orgData = loadOrgData();
        const group = orgData.groups.find(g => g.groupId === groupId);
        if (!group) throw new Error('Group not found');
        // Corrections (drift reconciliation) only touch the specific devices
        // that fell out of sync, not the whole group
        const targets = Array.isArray(deviceIds) ? deviceIds : group.deviceIds;
        await Promise.all(targets.map(deviceId =>
          tuyaApiRequest(`/v1.0/iot-03/devices/${deviceId}/commands`, 'POST', {
            commands: [{ code: 'switch_led', value: status }]
          })
        ));
        // A user-initiated set (not a drift correction) becomes the group's
        // sticky target — the ON/OFF status shown on the card reflects this
        // going forward, independent of what any individual device reports
        if (!isCorrection) {
          group.targetPower = status;
          saveOrgData(orgData);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  else if (req.url === '/api/light/group/brightness' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { groupId, value, deviceCodes, deviceIds, isCorrection } = JSON.parse(body);
        const orgData = loadOrgData();
        const group = orgData.groups.find(g => g.groupId === groupId);
        if (!group) throw new Error('Group not found');
        // deviceCodes: [{deviceId, code}] — the frontend already knows each
        // device's correct brightness DP code (bright_value vs bright_value_v2)
        // from the status it already loaded, so the server doesn't re-fetch it.
        const codeMap = {};
        (deviceCodes || []).forEach(dc => { codeMap[dc.deviceId] = dc.code; });
        // Corrections (drift reconciliation) only touch the specific devices
        // that fell out of sync, not the whole group
        const targets = Array.isArray(deviceIds) ? deviceIds : group.deviceIds;
        await Promise.all(targets.map(deviceId => {
          const targetCode = codeMap[deviceId] || 'bright_value';
          const commands = [];
          
          // Enforce the group's target power state when sending brightness commands.
          // This prevents a device from staying ON (or automatically turning itself ON) 
          // when the group is supposed to be OFF.
          if (group.targetPower != null) {
            commands.push({ code: 'switch_led', value: group.targetPower });
          }
          
          commands.push({ code: 'work_mode', value: 'white' });
          commands.push({ code: targetCode, value: parseInt(value) });

          return tuyaApiRequest(`/v1.0/iot-03/devices/${deviceId}/commands`, 'POST', { commands });
        }));
        // A user-initiated set (not a drift correction) becomes the group's
        // sticky target — the slider always displays this going forward,
        // independent of what any individual device happens to report
        if (!isCorrection) {
          group.targetBrightness = parseInt(value);
          saveOrgData(orgData);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(3000, () => {
  console.log('Smart Automation Server active on port 3000');
  initializeSchedules(); // Bootstrap persistent profiles
});