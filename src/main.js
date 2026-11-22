'use strict';
/*
 * OhMyChiikawa — desktop pet, main process.
 *
 * Each shown pet is its own transparent, frameless, always-on-top BrowserWindow.
 * The main process provides the "physical" behaviours that only the OS layer can
 * do for every pet window:
 *   - moving the window (dragging, walking)
 *   - click-through on transparent pixels
 *   - the right-click context menu
 *   - polling the global cursor so the pet can look at you
 *
 * Everything is local. No network access is used at any point.
 */

const { app, BrowserWindow, ipcMain, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { clampWindowBounds, dragAreaForBounds, resolveDragBounds, resolveWalkPlan } = require('./window-geometry');
const { normalizePetIds } = require('./pet-prefs');

// ---------- encrypted image vault ----------
// Decrypt assets.pak once here in the main process (which has full Node access);
// the renderer pulls each image as a data: URL over IPC, so neither the
// filesystem nor the key is ever exposed to the (sandboxed) page. If the pak is
// absent (raw dev tree), ASSETS stays empty and the renderer falls back to file
// paths under src/images/.
const ASSETS = Object.create(null);
try {
  const vault = require('./asset-vault');
  const bundle = JSON.parse(vault.decrypt(fs.readFileSync(path.join(__dirname, 'assets.pak'))).toString('utf8'));
  for (const k in bundle) {
    const ext = k.split('.').pop().toLowerCase();
    const mime = ext === 'gif' ? 'image/gif' : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : 'image/png';
    ASSETS[k] = 'data:' + mime + ';base64,' + bundle[k];
  }
} catch (e) { /* no pak: dev tree uses raw files */ }
ipcMain.on('asset:get', (e, p) => { e.returnValue = ASSETS[p] || null; });

// ---------- launch options (CLI) ----------
function argValue(name, fallback) {
  const pre = '--' + name + '=';
  const hit = process.argv.find((a) => a.startsWith(pre));
  return hit ? hit.slice(pre.length) : fallback;
}
// Persisted preferences — remembers the chosen pets across launches.
const PREFS_PATH = path.join(app.getPath('userData'), 'prefs.json');
function loadPrefs() { try { return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')); } catch (e) { return {}; } }
function savePrefs() { try { fs.mkdirSync(path.dirname(PREFS_PATH), { recursive: true }); fs.writeFileSync(PREFS_PATH, JSON.stringify(prefs)); } catch (e) {} }
const prefs = loadPrefs();

let lang = (['en', 'zh', 'ja'].includes(prefs.lang)) ? prefs.lang : 'zh';   // menu & speech language (switchable, remembered)
const t = (zh, en, ja) => (lang === 'en' ? en : lang === 'ja' ? ja : zh); // pick the current language's string
// Per-language character names for the menu (the main process has no pet registry).
const PET_LABELS = {
  usagi: { zh: '乌萨奇', en: 'Usagi', ja: 'うさぎ' },
  chiikawa: { zh: '吉伊', en: 'Chiikawa', ja: 'ちいかわ' },
  hachiware: { zh: '小八', en: 'Hachiware', ja: 'ハチワレ' },
  momonga: { zh: '莫莫伽', en: 'Momonga', ja: 'モモンガ' }
};
const PET_IDS = Object.keys(PET_LABELS);
const ROLL_PETS = new Set(['usagi']);           // pets that have the hand-roll action
const PET_SPEED = { usagi: 3, chiikawa: 2, hachiware: 2, momonga: 2 }; // walk speed px/tick (16ms); default 2
const petLabel = (id) => (PET_LABELS[id] ? PET_LABELS[id][lang] : id);
const SCALES = { small: 150, medium: 200, large: 270 }; // pet display height (px)
let scaleName = argValue('scale', 'medium');
if (!SCALES[scaleName]) scaleName = 'medium';

// A `--pet=a,b` launch argument replaces the remembered selection.
const cliPets = (argValue('pet', '') || '')
  .split(',')
  .map((s) => s.trim())
  .filter((id, i, all) => PET_LABELS[id] && all.indexOf(id) === i);
const savedPetIds = () => normalizePetIds(prefs, PET_IDS, 'usagi');

// ---------- runtime state ----------
const pets = [];   // one instance per open pet window, in opening order
const settings = { follow: true, wander: true, onTop: true };
let quitting = false; // set on app quit so closing windows does not shrink the saved selection

let lookTimer = null;    // cursor poll shared by every pet window

function newInstance(id) {
  return {
    id,
    win: null,
    // dragging
    dragging: false,
    dragOffset: { x: 0, y: 0 },
    dragTimer: null,
    lastDragMoveAt: 0,
    lastDragCursor: null,
    dragSize: null,
    dragTrend: { x: 0, y: 0 },
    // eye-follow smoothing
    lookLast: { dx: 0, dy: 0 },
    // wander
    walkTimer: null,
    walkPlan: null,
    // sizing / placement
    placed: false,
    lastFitSize: null
  };
}

function instanceFor(webContents) {
  const win = BrowserWindow.fromWebContents(webContents);
  return win ? pets.find((p) => p.win === win) || null : null;
}

function persistPets() {
  prefs.pets = pets.map((p) => p.id);
  delete prefs.pet;
  savePrefs();
}

// ---------- window ----------
function createWindow(id) {
  if (!PET_LABELS[id] || pets.some((p) => p.id === id)) return null;
  const inst = newInstance(id);
  const win = new BrowserWindow({
    width: 240,
    height: 320,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    title: 'OhMyChiikawa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false // keep the pet animating while unfocused
    }
  });
  inst.win = win;
  pets.push(inst);

  win.setMenu(null);
  applyOnTop(inst);
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}

  // loadFile handles platform path differences (Windows backslashes etc.)
  win.loadFile(path.join(__dirname, 'index.html'), { query: { pet: id, scale: scaleName, lang } });

  // start click-through; el renderer gestiona el click-through con mousemove nativo
  win.setIgnoreMouseEvents(false, { forward: true });

  win.webContents.once('did-finish-load', () => {
    if (inst.win) scheduleWalk(inst);
  });

  win.on('closed', () => {
    stopDragPoll(inst);
    if (inst.walkTimer) { clearInterval(inst.walkTimer); inst.walkTimer = null; }
    clearTimeout(inst.walkPlan);
    inst.walkPlan = null;
    inst.win = null;
    const i = pets.indexOf(inst);
    if (i >= 0) pets.splice(i, 1);
    // keep the last selection on quit; closing the final pet must not wipe it
    if (!quitting && pets.length) persistPets();
  });

  return inst;
}

function addPet(id) {
  if (!PET_LABELS[id] || pets.some((p) => p.id === id)) return;
  if (createWindow(id)) persistPets();
}

function removePet(id) {
  if (pets.length <= 1) return; // the menu cannot leave zero pets
  const inst = pets.find((p) => p.id === id);
  if (inst && inst.win) inst.win.close();
}

function applyOnTop(inst) {
  if (!inst.win) return;
  inst.win.setAlwaysOnTop(settings.onTop, 'floating');
}

function workAreaForBounds(bounds) {
  return screen.getDisplayNearestPoint({
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2
  }).workArea;
}

function workAreaForDrag(bounds, point) {
  return dragAreaForBounds(screen.getAllDisplays(), bounds, point);
}

function pointDistanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function normalizeRendererPoint(point) {
  const raw = {
    x: point && Number.isFinite(point.x) ? point.x : 0,
    y: point && Number.isFinite(point.y) ? point.y : 0
  };
  return raw;
}

function currentCursorPoint(fallback, preferFallback) {
  if (preferFallback && fallback && Number.isFinite(fallback.x) && Number.isFinite(fallback.y)) {
    return normalizeRendererPoint(fallback);
  }
  try {
    const point = screen.getCursorScreenPoint();
    if (Number.isFinite(point.x) && Number.isFinite(point.y)) return point;
  } catch (e) {}
  return {
    x: fallback && Number.isFinite(fallback.x) ? fallback.x : 0,
    y: fallback && Number.isFinite(fallback.y) ? fallback.y : 0
  };
}

function moveDraggedWindow(inst, cursor, trustCursor) {
  if (!inst.win) return;
  const cur = inst.win.getBounds();
  const dragBounds = {
    x: cur.x,
    y: cur.y,
    width: inst.dragSize ? inst.dragSize.width : cur.width,
    height: inst.dragSize ? inst.dragSize.height : cur.height
  };
  const point = normalizeDragCursor(inst, cursor, dragBounds, trustCursor);
  const area = workAreaForDrag(dragBounds, point);
  const next = resolveDragBounds(dragBounds, area, point, inst.dragOffset);
  inst.dragOffset = next.offset;
  if (next.bounds.x !== cur.x || next.bounds.y !== cur.y) {
    inst.win.setPosition(next.bounds.x, next.bounds.y);
  }
}

function normalizeDragCursor(inst, cursor, bounds, trustCursor) {
  const point = { x: Math.round(cursor.x), y: Math.round(cursor.y) };
  if (!inst.lastDragCursor) {
    inst.lastDragCursor = point;
    return point;
  }
  const maxJump = Math.max(160, Math.max(bounds.width, bounds.height) * 1.2);
  const dx = point.x - inst.lastDragCursor.x;
  const dy = point.y - inst.lastDragCursor.y;
  if (!trustCursor && (Math.abs(dx) > maxJump || Math.abs(dy) > maxJump ||
      (inst.dragTrend.x > 0 && dx < -80) || (inst.dragTrend.x < 0 && dx > 80) ||
      (inst.dragTrend.y > 0 && dy < -80) || (inst.dragTrend.y < 0 && dy > 80))) {
    return inst.lastDragCursor;
  }
  if (Math.abs(dx) > 2) inst.dragTrend.x = dx > 0 ? 1 : -1;
  if (Math.abs(dy) > 2) inst.dragTrend.y = dy > 0 ? 1 : -1;
  inst.lastDragCursor = point;
  return point;
}

function clampDragOffset(offset, bounds) {
  const maxX = Math.max(0, Math.round(bounds.width) - 1);
  const maxY = Math.max(0, Math.round(bounds.height) - 1);
  return {
    x: Math.max(0, Math.min(Math.round(offset.x), maxX)),
    y: Math.max(0, Math.min(Math.round(offset.y), maxY))
  };
}

function stopDragPoll(inst) {
  if (inst.dragTimer) {
    clearInterval(inst.dragTimer);
    inst.dragTimer = null;
  }
}

function startDragPoll(inst) {
  stopDragPoll(inst);
  inst.dragTimer = setInterval(() => {
    if (!inst.dragging || !inst.win) return;
    if (Date.now() - inst.lastDragMoveAt < 80) return;
    moveDraggedWindow(inst, screen.getCursorScreenPoint(), false);
  }, 16);
}

// ---------- sizing & placement ----------
// Renderer measures the pet and asks for an exact window size (incl. motion
// headroom). We keep the pet's bottom-centre anchored so menu resizes feel
// stable, and place each new pet bottom-right in a small cascade so they do not
// stack exactly on top of each other.
function fitWindow(inst, w, h) {
  if (!inst.win) return;
  w = Math.max(60, Math.round(w));
  h = Math.max(60, Math.round(h));
  inst.lastFitSize = { width: w, height: h };
  const cur = inst.win.getBounds();
  const disp = screen.getDisplayNearestPoint({ x: cur.x + cur.width / 2, y: cur.y + cur.height / 2 });
  const area = disp.workArea;
  let x, y;
  if (!inst.placed) {
    const index = Math.max(0, pets.indexOf(inst));
    x = area.x + area.width - w - 24 - index * 36;
    y = area.y + area.height - h - 12;
    inst.placed = true;
  } else {
    // keep bottom-centre fixed
    x = Math.round(cur.x + cur.width / 2 - w / 2);
    y = Math.round(cur.y + cur.height - h);
  }
  const next = clampWindowBounds({ x, y, width: w, height: h }, area);
  inst.win.setBounds(next);
  if (!inst.win.isVisible()) inst.win.show();
}

function restoreWindowSizeIfNeeded(inst) {
  if (!inst.win || !inst.lastFitSize) return;
  const cur = inst.win.getBounds();
  if (Math.abs(cur.width - inst.lastFitSize.width) <= 2 && Math.abs(cur.height - inst.lastFitSize.height) <= 2) return;
  const x = Math.round(cur.x + cur.width / 2 - inst.lastFitSize.width / 2);
  const y = Math.round(cur.y + cur.height - inst.lastFitSize.height);
  const area = screen.getDisplayNearestPoint({
    x: cur.x + cur.width / 2,
    y: cur.y + cur.height / 2
  }).bounds;
  inst.win.setBounds(clampWindowBounds({
    x: x,
    y: y,
    width: inst.lastFitSize.width,
    height: inst.lastFitSize.height
  }, area));
}

// ---------- dragging ----------
ipcMain.on('drag:start', (e, pos) => {
  const inst = instanceFor(e.sender);
  if (!inst || !inst.win) return;
  restoreWindowSizeIfNeeded(inst);
  inst.dragging = true;
  inst.lastDragMoveAt = Date.now();
  const cursor = currentCursorPoint(pos, true);
  const b = inst.win.getBounds();
  inst.dragSize = { width: b.width, height: b.height };
  inst.lastDragCursor = { x: Math.round(cursor.x), y: Math.round(cursor.y) };
  inst.dragTrend = { x: 0, y: 0 };
  inst.dragOffset = clampDragOffset({ x: cursor.x - b.x, y: cursor.y - b.y }, b);
  stopWalk(inst);
  startDragPoll(inst);
});
ipcMain.on('drag:move', (e, pos) => {
  const inst = instanceFor(e.sender);
  if (!inst || !inst.dragging || !inst.win) return;
  inst.lastDragMoveAt = Date.now();
  moveDraggedWindow(inst, currentCursorPoint(pos, true), true);
});
ipcMain.on('drag:end', (e) => {
  const inst = instanceFor(e.sender);
  if (!inst) return;
  inst.dragging = false;
  inst.lastDragMoveAt = 0;
  inst.lastDragCursor = null;
  inst.dragSize = null;
  inst.dragTrend = { x: 0, y: 0 };
  stopDragPoll(inst);
});

// ---------- click-through ----------
ipcMain.on('hit:ignore', (e, ignore) => {
  const inst = instanceFor(e.sender);
  if (inst && inst.win) inst.win.setIgnoreMouseEvents(!!ignore, { forward: true });
});

// ---------- renderer lifecycle ----------
ipcMain.on('pet:fit', (e, size) => {
  const inst = instanceFor(e.sender);
  if (inst) fitWindow(inst, size.w, size.h);
});
ipcMain.on('pet:quit', (e) => {
  const inst = instanceFor(e.sender);
  if (inst && inst.win) inst.win.close();
  else app.quit();
});

// Switch the menu / speech language for every pet. The menu rebuilds on next
// open; the renderers update their speech lines live over IPC (no reload needed).
function setLang(l) {
  l = (['en', 'zh', 'ja'].includes(l)) ? l : 'zh';
  if (l === lang) return;
  lang = l;
  prefs.lang = lang; savePrefs();
  pets.forEach((inst) => { if (inst.win) inst.win.webContents.send('pet:lang', lang); });
}

// ---------- context menu ----------
ipcMain.on('menu:open', (e) => {
  const inst = instanceFor(e.sender);
  if (!inst || !inst.win) return;
  const lastOne = pets.length <= 1;
  const tmpl = [
    { label: petLabel(inst.id), enabled: false },
    { type: 'separator' },
    {
      label: t('角色', 'Character', 'キャラクター'),
      submenu: PET_IDS.map((id) => {
        const open = pets.some((p) => p.id === id);
        return {
          label: petLabel(id), type: 'checkbox', checked: open,
          // the only open pet cannot be unchecked: that would close the app
          enabled: !(open && lastOne),
          click: () => { if (open) removePet(id); else addPet(id); }
        };
      })
    },
    {
      label: t('语言', 'Language', '言語'),
      submenu: [
        { label: '中文', type: 'radio', checked: lang === 'zh', click: () => setLang('zh') },
        { label: 'English', type: 'radio', checked: lang === 'en', click: () => setLang('en') },
        { label: '日本語', type: 'radio', checked: lang === 'ja', click: () => setLang('ja') }
      ]
    },
    { type: 'separator' },
    {
      label: t('跟随鼠标', 'Follow cursor', 'カーソルを追う'), type: 'checkbox', checked: settings.follow,
      click: () => { settings.follow = !settings.follow; if (settings.follow) startLook(); else stopLook(); }
    },
    {
      label: t('四处走动', 'Wander', 'うろうろ歩く'), type: 'checkbox', checked: settings.wander,
      click: () => {
        settings.wander = !settings.wander;
        if (settings.wander) pets.forEach(scheduleWalk); else pets.forEach(stopWalk);
      }
    },
    {
      label: t('总在最前', 'Always on top', '常に最前面'), type: 'checkbox', checked: settings.onTop,
      click: () => { settings.onTop = !settings.onTop; pets.forEach(applyOnTop); }
    },
    { type: 'separator' },
    {
      label: t('大小', 'Size', 'サイズ'),
      submenu: ['small', 'medium', 'large'].map((s) => ({
        label: { small: t('小', 'Small', '小'), medium: t('中', 'Medium', '中'), large: t('大', 'Large', '大') }[s],
        type: 'radio', checked: scaleName === s,
        click: () => {
          scaleName = s;
          pets.forEach((p) => { if (p.win) p.win.webContents.send('scale:set', SCALES[s]); });
        }
      }))
    },
    { label: t('跳一下', 'Hop', 'ジャンプ'), click: () => inst.win && inst.win.webContents.send('pet:react', 'hop') },
    ...(ROLL_PETS.has(inst.id)
      ? [{ label: t('转手', 'Roll hands', '手をぐるぐる'), click: () => inst.win && inst.win.webContents.send('pet:react', 'roll') }]
      : []),
    { type: 'separator' },
    // closes this pet; the app quits when the last window closes
    { label: t('退出', 'Quit', '終了') + ' ' + petLabel(inst.id), click: () => inst.win && inst.win.close() }
  ];
  Menu.buildFromTemplate(tmpl).popup({ window: inst.win });
});

// ---------- cursor poll: drives click-through hit-testing AND eye-follow ----------
// Click-through is hit-tested here, from the global cursor against live window
// bounds, rather than relying solely on the renderer's mousemove. On Windows the
// forwarded move events under setIgnoreMouseEvents({forward:true}) stall after
// focus changes / occlusion, and the pet can also wander UNDER a stationary
// cursor (the window moves but no mousemove fires) — both leave the renderer's
// toggle stuck, so the pet stops being draggable / right-clickable and clicks
// fall through to the desktop. Polling the OS cursor fixes both, because IPC is
// unaffected by the ignore state. One poll serves every pet window; a window
// being dragged is skipped.
function startLook() {
  stopLook();
  lookTimer = setInterval(() => {
    if (!pets.length) return;
    let c;
    try { c = screen.getCursorScreenPoint(); } catch (e) { return; }
    for (const inst of pets) {
      if (!inst.win || inst.dragging) continue;
      const b = inst.win.getBounds();
      inst.win.webContents.send('pet:cursor', { x: c.x - b.x, y: c.y - b.y, winX: b.x, winY: b.y, curX: c.x, curY: c.y });
      if (!settings.follow) continue;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height * 0.42; // around the face
      const clamp = (v) => Math.max(-1, Math.min(1, v));
      const dx = clamp((c.x - cx) / 360);
      const dy = clamp((c.y - cy) / 360);
      if (Math.abs(dx - inst.lookLast.dx) > 0.03 || Math.abs(dy - inst.lookLast.dy) > 0.03) {
        inst.lookLast = { dx, dy };
        inst.win.webContents.send('pet:look', { dx, dy });
      }
    }
  }, 80);
}
function stopLook() { if (lookTimer) { clearInterval(lookTimer); lookTimer = null; } }

// ---------- wander / edge-walk ----------
function scheduleWalk(inst) {
  clearTimeout(inst.walkPlan);
  inst.walkPlan = null;
  if (!settings.wander || !inst.win) return;
  const delay = 6000 + Math.random() * 9000;
  inst.walkPlan = setTimeout(() => startWalk(inst), delay);
}
function startWalk(inst) {
  if (!inst.win || inst.dragging || !settings.wander) { scheduleWalk(inst); return; }
  restoreWindowSizeIfNeeded(inst);
  let b = inst.win.getBounds();
  const disp = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  let area = disp && disp.bounds ? disp.bounds : null;
  // En algunos entornos Linux/Wayland los bounds del display pueden venir vacíos.
  // Fallback al display primario para que el wander no se quede bloqueado.
  if (!area || area.width <= 0 || area.height <= 0) {
    const primary = screen.getPrimaryDisplay();
    area = (primary && primary.bounds && primary.bounds.width > 0 && primary.bounds.height > 0) ? primary.bounds : null;
  }
  if (!area) { scheduleWalk(inst); return; }
  const dir = Math.random() < 0.5 ? -1 : 1;
  const distance = 80 + Math.random() * 220;
  const speed = PET_SPEED[inst.id] || 2; // usagi runs faster (it has a real run cycle)
  const plan = resolveWalkPlan(b, area, dir, distance, speed);
  if (!plan) { stopWalk(inst); return; }
  if (plan.bounds.x !== b.x) {
    inst.win.setPosition(plan.bounds.x, b.y);
    b = Object.assign({}, b, { x: plan.bounds.x });
  }
  const targetX = plan.targetX;
  inst.win.webContents.send('pet:walk', { dir: plan.dir });
  clearInterval(inst.walkTimer);
  inst.walkTimer = setInterval(() => {
    if (!inst.win || inst.dragging) { stopWalk(inst); return; }
    const cur = inst.win.getBounds();
    const remaining = targetX - cur.x;
    if (Math.abs(remaining) <= speed) {
      inst.win.setPosition(targetX, cur.y);
      stopWalk(inst);
      return;
    }
    const next = clampWindowBounds({
      x: Math.round(cur.x + Math.sign(remaining) * speed),
      y: b.y,
      width: cur.width,
      height: cur.height
    }, area);
    if (next.x === cur.x) { stopWalk(inst); return; }
    inst.win.setPosition(next.x, cur.y);
  }, 16);
}
function stopWalk(inst) {
  if (inst.walkTimer) { clearInterval(inst.walkTimer); inst.walkTimer = null; }
  if (inst.win) inst.win.webContents.send('pet:walk-stop');
  scheduleWalk(inst);
}

// ---------- app lifecycle ----------
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());
app.whenReady().then(() => {
  const initial = cliPets.length ? cliPets : savedPetIds();
  initial.forEach(createWindow);
  startLook(); // always polls: drives click-through; eye-follow gated by settings.follow
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) savedPetIds().forEach(createWindow);
  });
});
