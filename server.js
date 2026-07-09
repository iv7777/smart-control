const http = require('http');
const axios = require('axios');
const crypto = require('crypto');
const nodeSchedule = require('node-schedule');
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
const TIMERS_FILE = path.join(__dirname, 'timers.json');
const ORG_FILE = path.join(__dirname, 'orgData.json');

let cachedToken = '';
let tokenRefreshPromise = null;  // shared in-flight promise — see getAccessToken()
const activeJobs = {};

// --- ORG DATA HELPERS (shops + schedules) ---
// Shops are pure organization (labels for filtering devices in the UI) —
// they are never a control target and never constrain schedule membership.
// Schedules are the controllable unit: a named bucket of devices — from any
// shop, or none at all — with sticky target power/brightness, drift
// correction, and their own daily timers. A device belongs to at most one
// schedule at a time.
function loadOrgData() {
  if (!fs.existsSync(ORG_FILE)) return { shops: [], deviceShops: {}, schedules: [] };
  try {
    const data = fs.readFileSync(ORG_FILE, 'utf8');
    const parsed = JSON.parse(data || '{}');
    return {
      shops: parsed.shops || [],
      deviceShops: parsed.deviceShops || {},
      schedules: parsed.schedules || []
    };
  } catch (err) {
    console.error('Error reading org data:', err.message);
    return { shops: [], deviceShops: {}, schedules: [] };
  }
}

function saveOrgData(orgData) {
  try {
    fs.writeFileSync(ORG_FILE, JSON.stringify(orgData, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing org data:', err.message);
  }
}

// Removes a device from whichever schedule currently holds it (enforces the
// "one schedule per device" rule whenever membership changes elsewhere)
function removeDeviceFromAllSchedules(orgData, deviceId) {
  orgData.schedules.forEach(s => {
    s.deviceIds = s.deviceIds.filter(id => id !== deviceId);
  });
}

// --- PERSISTENCE HELPERS (timers) ---
function loadPersistedTimers() {
  if (!fs.existsSync(TIMERS_FILE)) return {};
  try {
    const data = fs.readFileSync(TIMERS_FILE, 'utf8');
    return JSON.parse(data || '{}');
  } catch (err) {
    console.error('Error reading persistent timers:', err.message);
    return {};
  }
}

function savePersistedTimers(timers) {
  try {
    fs.writeFileSync(TIMERS_FILE, JSON.stringify(timers, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing persistent timers:', err.message);
  }
}

// Cancels and removes any individual timers belonging to a device.
// Called whenever a device joins a schedule — the schedule's own timers
// take over, so the device's standalone automation is overwritten.
function deleteDeviceTimers(deviceId) {
  const currentTimers = loadPersistedTimers();
  let changed = false;
  Object.keys(currentTimers).forEach(jobKey => {
    if (currentTimers[jobKey].deviceId === deviceId) {
      if (activeJobs[jobKey]) { activeJobs[jobKey].cancel(); delete activeJobs[jobKey]; }
      delete currentTimers[jobKey];
      changed = true;
    }
  });
  if (changed) savePersistedTimers(currentTimers);
}

// Cancels and removes any timers belonging to a schedule (used when the
// schedule itself is deleted).
function deleteScheduleTimers(scheduleId) {
  const currentTimers = loadPersistedTimers();
  let changed = false;
  Object.keys(currentTimers).forEach(jobKey => {
    if (currentTimers[jobKey].scheduleId === scheduleId) {
      if (activeJobs[jobKey]) { activeJobs[jobKey].cancel(); delete activeJobs[jobKey]; }
      delete currentTimers[jobKey];
      changed = true;
    }
  });
  if (changed) savePersistedTimers(currentTimers);
}

// Fires a single timer action, whether it targets one device or a whole
// schedule. Schedule membership is resolved fresh at fire time, so a
// schedule's timer always applies to whichever devices are in it right
// now — not whoever was in it when the timer was created.
async function executeTimerAction(timer) {
  try {
    if (timer.deviceId) {
      const commands = [{ code: 'switch_led', value: timer.targetStatus }];
      if (timer.targetStatus && timer.brightness != null) {
        commands.push({ code: 'work_mode', value: 'white' });
        commands.push({ code: timer.brightCode || 'bright_value', value: timer.brightness });
      }
      await tuyaApiRequest(`/v1.0/iot-03/devices/${timer.deviceId}/commands`, 'POST', { commands });
    } else if (timer.scheduleId) {
      const orgData = loadOrgData();
      const scheduleEntry = orgData.schedules.find(s => s.scheduleId === timer.scheduleId);
      if (!scheduleEntry) {
        console.warn(`[Timer Skipped] Schedule ${timer.scheduleId} no longer exists`);
        return;
      }
      const codeMap = {};
      (timer.deviceCodes || []).forEach(dc => { codeMap[dc.deviceId] = dc.code; });
      await Promise.all(scheduleEntry.deviceIds.map(deviceId => {
        const commands = [{ code: 'switch_led', value: timer.targetStatus }];
        if (timer.targetStatus && timer.brightness != null) {
          commands.push({ code: 'work_mode', value: 'white' });
          commands.push({ code: codeMap[deviceId] || 'bright_value', value: timer.brightness });
        }
        return tuyaApiRequest(`/v1.0/iot-03/devices/${deviceId}/commands`, 'POST', { commands });
      }));
    }
  } catch (err) {
    console.error('[Timer Execution Failed]', err.message);
  }
}

// Re-register timers on startup
function initializeTimers() {
  const saved = loadPersistedTimers();
  Object.keys(saved).forEach(jobKey => {
    const timer = saved[jobKey];
    const [hour, minute] = timer.time.split(':');
    const cronPattern = `${minute} ${hour} * * *`;

    activeJobs[jobKey] = nodeSchedule.scheduleJob(cronPattern, () => {
      console.log(`[Persistent Timer Triggered] Executing action for key: ${jobKey}`);
      executeTimerAction(timer);
    });
  });
  console.log(`[Init] Loaded and armed ${Object.keys(saved).length} automation timers.`);
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
        const targetCode = code || 'bright_value';

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

  // FEATURE 2: Create a device-level timer (flat-file persisted)
  else if (req.url === '/api/light/timer' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { deviceId, time, targetStatus, brightness, brightCode } = JSON.parse(body);

        // A device in a schedule is controlled by the schedule's own timers instead
        const orgData = loadOrgData();
        const inSchedule = orgData.schedules.some(s => s.deviceIds.includes(deviceId));
        if (inSchedule) throw new Error('This device belongs to a schedule — set the timer on the schedule instead.');

        const [hour, minute] = time.split(':');

        // Each timer gets a unique UUID key — supports up to 10+ per device
        const jobKey = crypto.randomUUID();
        const timer = { deviceId, time, targetStatus, ...(brightness != null && { brightness, brightCode }) };

        const cronPattern = `${minute} ${hour} * * *`;
        activeJobs[jobKey] = nodeSchedule.scheduleJob(cronPattern, () => {
          console.log(`[Timer Triggered] Firing power: ${targetStatus} to device: ${deviceId}`);
          executeTimerAction(timer);
        });

        const currentTimers = loadPersistedTimers();
        currentTimers[jobKey] = timer;
        savePersistedTimers(currentTimers);

        console.log(`[Timer Saved] ${deviceId} configured daily at ${time}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Timer verified and saved for ${time}` }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  // FEATURE 3: Retrieve all timers (device-level and schedule-level)
  else if (req.url === '/api/timers' && req.method === 'GET') {
    const currentTimers = loadPersistedTimers();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, timers: currentTimers }));
  }

  // FEATURE 4: Delete Timer
  else if (req.url === '/api/light/timer/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { jobKey } = JSON.parse(body);
        if (activeJobs[jobKey]) {
          activeJobs[jobKey].cancel();
          delete activeJobs[jobKey];
        }
        const currentTimers = loadPersistedTimers();
        if (currentTimers[jobKey]) {
          delete currentTimers[jobKey];
          savePersistedTimers(currentTimers);
        }
        console.log(`[Timer Deleted] Canceled and removed job: ${jobKey}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Timer ${jobKey} deleted successfully` }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  // FEATURE 5: Shops (pure organization — labels only, never a control
  // target, and never a constraint on schedule membership)
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

  // Deleting a shop only clears its device assignments now. Schedules are
  // independent of shop, so no schedule or timer is ever touched here.
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
        saveOrgData(orgData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  // Assigning/changing a device's shop is purely organizational now — it has
  // no effect on the device's schedule membership.
  else if (req.url === '/api/devices/assign-shop' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { deviceId, shopId } = JSON.parse(body);
        const orgData = loadOrgData();
        if (shopId) {
          orgData.deviceShops[deviceId] = shopId;
        } else {
          delete orgData.deviceShops[deviceId];
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

  // FEATURE 9: Rename a device directly on Tuya's platform — the display
  // name is authoritative on Tuya's side, so this call affects the device
  // everywhere it's managed (including the Tuya Smart Life app), not just
  // in this dashboard. deviceId (and therefore schedule/timer/shop
  // assignments keyed on it) is untouched by a rename.
  else if (req.url === '/api/devices/rename' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { deviceId, name } = JSON.parse(body);
        if (!deviceId) throw new Error('deviceId is required');
        if (!name || !name.trim()) throw new Error('Device name is required');
        const result = await tuyaApiRequest(`/v1.0/iot-03/devices/${deviceId}`, 'PUT', { name: name.trim() });
        if (!result.success) throw new Error(result.msg || 'Tuya rejected the rename');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  else if (req.url === '/api/devices/assign-schedule' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { deviceId, scheduleId } = JSON.parse(body);
        const orgData = loadOrgData();
        removeDeviceFromAllSchedules(orgData, deviceId);
        if (scheduleId) {
          const scheduleEntry = orgData.schedules.find(s => s.scheduleId === scheduleId);
          if (!scheduleEntry) throw new Error('Schedule not found');
          scheduleEntry.deviceIds.push(deviceId);
          // Joining a schedule hands control to the schedule's own timers —
          // any individual timer this device had is overwritten
          deleteDeviceTimers(deviceId);
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

  // FEATURE 6: Schedules (device membership independent of shop; the only
  // controllable unit besides single devices)
  else if (req.url === '/api/schedules' && req.method === 'GET') {
    const orgData = loadOrgData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, schedules: orgData.schedules }));
  }

  else if (req.url === '/api/schedules' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { name, deviceIds } = JSON.parse(body);
        if (!name || !name.trim()) throw new Error('Schedule name is required');
        const orgData = loadOrgData();
        const ids = Array.isArray(deviceIds) ? deviceIds : [];
        // A device can only be in one schedule at a time — joining this one
        // silently pulls it out of whatever schedule it was in before
        ids.forEach(id => removeDeviceFromAllSchedules(orgData, id));
        const scheduleEntry = { scheduleId: crypto.randomUUID(), name: name.trim(), deviceIds: ids };
        orgData.schedules.push(scheduleEntry);
        saveOrgData(orgData);
        // Joining a schedule hands control to the schedule's own timers —
        // any individual timers these devices had are overwritten
        ids.forEach(deleteDeviceTimers);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, schedule: scheduleEntry }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  else if (req.url === '/api/schedules/update' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { scheduleId, name, deviceIds } = JSON.parse(body);
        const orgData = loadOrgData();
        const scheduleEntry = orgData.schedules.find(s => s.scheduleId === scheduleId);
        if (!scheduleEntry) throw new Error('Schedule not found');
        if (name && name.trim()) scheduleEntry.name = name.trim();
        if (Array.isArray(deviceIds)) {
          deviceIds.forEach(id => removeDeviceFromAllSchedules(orgData, id));
          scheduleEntry.deviceIds = deviceIds;
          saveOrgData(orgData);
          // Joining a schedule hands control to the schedule's own timers —
          // any individual timers these devices had are overwritten
          deviceIds.forEach(deleteDeviceTimers);
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

  else if (req.url === '/api/schedules/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { scheduleId } = JSON.parse(body);
        const orgData = loadOrgData();
        orgData.schedules = orgData.schedules.filter(s => s.scheduleId !== scheduleId);
        saveOrgData(orgData);
        deleteScheduleTimers(scheduleId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  // FEATURE 8: Schedule-level timer creation — same shape as device timers,
  // but the cron callback resolves schedule membership fresh at fire time
  // (see executeTimerAction), so it always applies to whoever's in the
  // schedule right now.
  else if (req.url === '/api/light/schedule/timer' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { scheduleId, time, targetStatus, brightness, deviceCodes } = JSON.parse(body);
        const orgData = loadOrgData();
        const scheduleEntry = orgData.schedules.find(s => s.scheduleId === scheduleId);
        if (!scheduleEntry) throw new Error('Schedule not found');

        const jobKey = crypto.randomUUID();
        const timer = { scheduleId, time, targetStatus, ...(brightness != null && { brightness, deviceCodes }) };
        const [hour, minute] = time.split(':');
        const cronPattern = `${minute} ${hour} * * *`;

        activeJobs[jobKey] = nodeSchedule.scheduleJob(cronPattern, () => {
          console.log(`[Timer Triggered] Firing power: ${targetStatus} to schedule: ${scheduleId}`);
          executeTimerAction(timer);
        });

        const currentTimers = loadPersistedTimers();
        currentTimers[jobKey] = timer;
        savePersistedTimers(currentTimers);

        console.log(`[Timer Saved] Schedule ${scheduleId} configured daily at ${time}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Timer verified and saved for ${time}` }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  }

  // FEATURE 7: Schedule control — loops the same per-device Tuya command used for single devices
  else if (req.url === '/api/light/schedule/power' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { scheduleId, status, deviceIds, isCorrection } = JSON.parse(body);
        const orgData = loadOrgData();
        const scheduleEntry = orgData.schedules.find(s => s.scheduleId === scheduleId);
        if (!scheduleEntry) throw new Error('Schedule not found');
        // Corrections (drift reconciliation) only touch the specific devices
        // that fell out of sync, not the whole schedule
        const targets = Array.isArray(deviceIds) ? deviceIds : scheduleEntry.deviceIds;
        await Promise.all(targets.map(deviceId =>
          tuyaApiRequest(`/v1.0/iot-03/devices/${deviceId}/commands`, 'POST', {
            commands: [{ code: 'switch_led', value: status }]
          })
        ));
        // A user-initiated set (not a drift correction) becomes the
        // schedule's sticky target — the ON/OFF status shown on the card
        // reflects this going forward, independent of what any individual
        // device reports
        if (!isCorrection) {
          scheduleEntry.targetPower = status;
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

  else if (req.url === '/api/light/schedule/brightness' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { scheduleId, value, deviceCodes, deviceIds, isCorrection } = JSON.parse(body);
        const orgData = loadOrgData();
        const scheduleEntry = orgData.schedules.find(s => s.scheduleId === scheduleId);
        if (!scheduleEntry) throw new Error('Schedule not found');

        // If the schedule's sticky target power is OFF, brightness is
        // meaningless right now — sending any command would risk waking the
        // devices (many LED controllers auto-power-on when they receive a
        // work_mode/brightness DP, even in the same batch as switch_led:
        // false). Just record the new target and let the existing
        // drift-correction cycle apply it silently the next time the
        // schedule is turned back on.
        if (scheduleEntry.targetPower === false) {
          if (!isCorrection) {
            scheduleEntry.targetBrightness = parseInt(value);
            saveOrgData(orgData);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, skipped: true, reason: 'Schedule is off — target saved, no devices touched' }));
          return;
        }

        // deviceCodes: [{deviceId, code}] — the frontend already knows each
        // device's correct brightness DP code (bright_value vs bright_value_v2)
        // from the status it already loaded, so the server doesn't re-fetch it.
        const codeMap = {};
        (deviceCodes || []).forEach(dc => { codeMap[dc.deviceId] = dc.code; });
        // Corrections (drift reconciliation) only touch the specific devices
        // that fell out of sync, not the whole schedule
        const targets = Array.isArray(deviceIds) ? deviceIds : scheduleEntry.deviceIds;
        await Promise.all(targets.map(deviceId => {
          const targetCode = codeMap[deviceId] || 'bright_value';
          const commands = [];

          // Enforce the schedule's target power state when sending brightness
          // commands. This prevents a device from staying ON (or turning
          // itself ON) when the schedule is supposed to be OFF.
          if (scheduleEntry.targetPower != null) {
            commands.push({ code: 'switch_led', value: scheduleEntry.targetPower });
          }

          commands.push({ code: 'work_mode', value: 'white' });
          commands.push({ code: targetCode, value: parseInt(value) });

          return tuyaApiRequest(`/v1.0/iot-03/devices/${deviceId}/commands`, 'POST', { commands });
        }));
        // A user-initiated set (not a drift correction) becomes the
        // schedule's sticky target — the slider always displays this going
        // forward, independent of what any individual device reports
        if (!isCorrection) {
          scheduleEntry.targetBrightness = parseInt(value);
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
  initializeTimers(); // Bootstrap persistent profiles
});
