const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const restartBtn = document.getElementById('restart');

let me = null;
let roomState = null;
let drag = null;

const PLAYER_RADIUS = 28;
const PROJECTILE_RADIUS = 8;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API ${path} failed`);
  return res.json();
}

async function join() {
  me = await api('/api/join', { method: 'POST' });
  statusEl.textContent = `已加入房间 ${me.roomId}`;
  pollState();
}

async function pollState() {
  if (!me) return;
  try {
    roomState = await api(`/api/state?roomId=${me.roomId}&playerId=${me.playerId}`);
    render();
    updateStatus();
  } catch {
    statusEl.textContent = '与服务器连接中断，请刷新重试。';
  }
}

restartBtn.addEventListener('click', async () => {
  if (!me) return;
  await api('/api/restart', {
    method: 'POST',
    body: JSON.stringify({ roomId: me.roomId }),
  });
});

canvas.addEventListener('mousedown', (e) => {
  if (!canFire()) return;
  const p = mouse(e);
  const self = roomState.players[me.playerId];
  const dx = p.x - self.x;
  const dy = p.y - self.y;
  if (Math.hypot(dx, dy) <= PLAYER_RADIUS + 50) {
    drag = { start: { x: self.x, y: self.y - PLAYER_RADIUS }, now: p };
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (!drag) return;
  drag.now = mouse(e);
  render();
});

window.addEventListener('mouseup', async () => {
  if (!drag || !canFire()) {
    drag = null;
    return;
  }

  const self = roomState.players[me.playerId];
  const dx = drag.start.x - drag.now.x;
  const dy = drag.start.y - drag.now.y;
  const rawPower = Math.hypot(dx, dy) * 5;
  const power = Math.max(150, Math.min(900, rawPower));

  let angle = Math.atan2(dy, dx);
  if (self.facing === -1) {
    angle = Math.atan2(dy, -dx);
  }
  angle = Math.min(-0.15, Math.max(-Math.PI + 0.15, angle));

  await api('/api/fire', {
    method: 'POST',
    body: JSON.stringify({ roomId: me.roomId, playerId: me.playerId, power, angle }),
  });
  drag = null;
});

function canFire() {
  if (!roomState || !me || !roomState.started || roomState.winner) return false;
  const self = roomState.players[me.playerId];
  return self && self.cooldownUntil <= Date.now();
}

function updateStatus() {
  if (!me || !roomState) {
    statusEl.textContent = '连接中...';
    return;
  }

  const self = roomState.players[me.playerId];
  const count = Object.keys(roomState.players).length;

  if (!self) {
    statusEl.textContent = '你已掉线，刷新可重连。';
    return;
  }

  if (!roomState.started) {
    statusEl.textContent = `房间 ${me.roomId}：等待另一位玩家加入（${count}/2）`;
    return;
  }

  if (roomState.winner) {
    statusEl.textContent = roomState.winner === me.playerId ? '你赢了！点击重新开始再来一局。' : '你输了，点击重新开始。';
    return;
  }

  const cd = Math.max(0, self.cooldownUntil - Date.now());
  statusEl.textContent = cd > 0 ? `冷却中 ${Math.ceil(cd / 100) / 10}s` : '可发射：拖拽后松手';
}

function mouse(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * canvas.width,
    y: ((e.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function render() {
  if (!roomState) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGround();

  Object.values(roomState.players).forEach(drawPlayer);
  roomState.projectiles.forEach(drawProjectile);

  if (drag) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(drag.start.x, drag.start.y);
    ctx.lineTo(drag.now.x, drag.now.y);
    ctx.stroke();
  }
}

function drawGround() {
  ctx.fillStyle = 'rgba(40, 30, 16, 0.2)';
  ctx.fillRect(0, canvas.height - 65, canvas.width, 65);
}

function drawPlayer(p) {
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, PLAYER_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  const barW = 80;
  const hpRatio = Math.max(0, p.hp / 5);
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(p.x - barW / 2, p.y - 52, barW, 10);
  ctx.fillStyle = '#7bff73';
  ctx.fillRect(p.x - barW / 2, p.y - 52, barW * hpRatio, 10);

  ctx.fillStyle = '#fff';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(p.id === me?.playerId ? '你' : '对手', p.x, p.y + 5);
}

function drawProjectile(p) {
  ctx.fillStyle = '#ffeb81';
  ctx.beginPath();
  ctx.arc(p.x, p.y, PROJECTILE_RADIUS, 0, Math.PI * 2);
  ctx.fill();
}

setInterval(() => {
  pollState();
  if (roomState) render();
}, 60);

join();
