const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 1000 / 60;
const GRAVITY = 900;
const PLAYER_RADIUS = 28;
const PROJECTILE_RADIUS = 8;
const PROJECTILE_LIFETIME_MS = 6000;
const ARENA_WIDTH = 1000;
const ARENA_HEIGHT = 560;
const HIT_COOLDOWN_MS = 900;
const FIRE_COOLDOWN_MS = 1500;
const START_HP = 5;

const rooms = new Map();

function makeRoom(id) {
  return {
    id,
    players: {},
    projectiles: [],
    lastHitAt: 0,
    started: false,
    winner: null,
  };
}

function playerStartState(slot) {
  const left = slot === 0;
  return {
    slot,
    hp: START_HP,
    cooldownUntil: 0,
    x: left ? 120 : ARENA_WIDTH - 120,
    y: ARENA_HEIGHT - 80,
    color: left ? '#4c9dff' : '#ff5b8a',
    facing: left ? 1 : -1,
    lastSeenAt: Date.now(),
  };
}

function findOrCreateRoom() {
  for (const room of rooms.values()) {
    if (Object.keys(room.players).length < 2 && !room.winner) return room;
  }
  const id = `room-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const room = makeRoom(id);
  rooms.set(id, room);
  return room;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function getRoomView(room) {
  return {
    arena: { width: ARENA_WIDTH, height: ARENA_HEIGHT },
    started: room.started,
    winner: room.winner,
    players: room.players,
    projectiles: room.projectiles,
  };
}

function resetRoom(room) {
  room.projectiles = [];
  room.lastHitAt = 0;
  room.winner = null;
  Object.keys(room.players).forEach((id) => {
    const slot = room.players[id].slot;
    room.players[id] = { id, ...playerStartState(slot) };
  });
}

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 1e6) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  let reqPath = req.url === '/' ? '/index.html' : req.url;
  reqPath = reqPath.split('?')[0];
  const safePath = path.normalize(reqPath).replace(/^\.\.(\/|\\|$)/, '');
  const filePath = path.join(__dirname, 'public', safePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/join') {
      const room = findOrCreateRoom();
      const playerId = crypto.randomUUID();
      const slot = Object.keys(room.players).length;
      room.players[playerId] = { id: playerId, ...playerStartState(slot) };
      room.started = Object.keys(room.players).length === 2;
      sendJSON(res, 200, { roomId: room.id, playerId, slot });
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/state')) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const roomId = url.searchParams.get('roomId');
      const playerId = url.searchParams.get('playerId');
      const room = rooms.get(roomId);
      if (!room || !room.players[playerId]) {
        sendJSON(res, 404, { error: 'room or player not found' });
        return;
      }
      room.players[playerId].lastSeenAt = Date.now();
      sendJSON(res, 200, getRoomView(room));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/fire') {
      const body = await parseBody(req);
      const { roomId, playerId, power, angle } = body;
      const room = rooms.get(roomId);
      const player = room?.players[playerId];
      if (!room || !player || room.winner) {
        sendJSON(res, 400, { ok: false });
        return;
      }

      const now = Date.now();
      if (player.cooldownUntil > now) {
        sendJSON(res, 200, { ok: false, cooldownUntil: player.cooldownUntil });
        return;
      }

      const clampedPower = clamp(Number(power) || 0, 150, 900);
      const clampedAngle = clamp(Number(angle) || 0, -Math.PI + 0.15, -0.15);
      const baseAngle = player.facing === 1 ? clampedAngle : Math.PI - clampedAngle;

      room.projectiles.push({
        id: `${playerId}-${now}`,
        ownerId: playerId,
        x: player.x,
        y: player.y - PLAYER_RADIUS,
        vx: Math.cos(baseAngle) * clampedPower,
        vy: Math.sin(baseAngle) * clampedPower,
        bornAt: now,
      });
      player.cooldownUntil = now + FIRE_COOLDOWN_MS;
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/restart') {
      const body = await parseBody(req);
      const room = rooms.get(body.roomId);
      if (!room) {
        sendJSON(res, 404, { ok: false });
        return;
      }
      resetRoom(room);
      room.started = Object.keys(room.players).length === 2;
      sendJSON(res, 200, { ok: true });
      return;
    }

    serveStatic(req, res);
  } catch (err) {
    sendJSON(res, 500, { error: 'internal error', detail: err.message });
  }
});

setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    for (const [pid, p] of Object.entries(room.players)) {
      if (now - p.lastSeenAt > 30000) {
        delete room.players[pid];
      }
    }

    const ids = Object.keys(room.players);
    if (ids.length === 0) {
      rooms.delete(room.id);
      continue;
    }

    ids.forEach((id, index) => {
      const hp = room.players[id].hp;
      room.players[id] = { id, ...playerStartState(index), hp, lastSeenAt: room.players[id].lastSeenAt };
    });

    room.started = ids.length === 2;
    if (!room.started || room.winner) continue;

    room.projectiles = room.projectiles.filter((proj) => {
      const dt = 1 / 60;
      proj.vy += GRAVITY * dt;
      proj.x += proj.vx * dt;
      proj.y += proj.vy * dt;

      if (now - proj.bornAt > PROJECTILE_LIFETIME_MS) return false;
      if (proj.x < -100 || proj.x > ARENA_WIDTH + 100 || proj.y > ARENA_HEIGHT + 100) return false;

      for (const target of Object.values(room.players)) {
        if (target.id === proj.ownerId || target.hp <= 0) continue;
        const dx = target.x - proj.x;
        const dy = target.y - PLAYER_RADIUS / 2 - proj.y;
        const radius = PLAYER_RADIUS + PROJECTILE_RADIUS;

        if (dx * dx + dy * dy <= radius * radius && now - room.lastHitAt > HIT_COOLDOWN_MS) {
          target.hp -= 1;
          room.lastHitAt = now;
          if (target.hp <= 0) room.winner = proj.ownerId;
          return false;
        }
      }
      return true;
    });
  }
}, TICK_RATE);

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
