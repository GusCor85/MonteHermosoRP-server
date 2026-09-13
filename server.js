const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 9080;
let nextId = 1;
const players = new Map();

const httpServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Monte Hermoso RP multiplayer server OK\n');
});

const wss = new WebSocket.Server({ server: httpServer });

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(data, except = null) {
  const payload = JSON.stringify(data);
  for (const [id, player] of players) {
    if (player.ws !== except && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(payload);
    }
  }
}

function stateMessage(player) {
  return {
    type: 'player_state', id: player.id,
    x: player.x, y: player.y, z: player.z, ry: player.ry
  };
}

wss.on('connection', (ws) => {
  const id = String(nextId++);
  const player = { id, ws, x: 0, y: 1.15, z: -15, ry: 0 };
  players.set(id, player);

  send(ws, { type: 'welcome', id });
  for (const [otherId, other] of players) {
    if (otherId !== id) send(ws, stateMessage(other));
  }
  broadcast({ type: 'player_joined', ...stateMessage(player) }, ws);

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (!data || data.type !== 'state') return;

    const finite = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
    player.x = finite(data.x, player.x);
    player.y = finite(data.y, player.y);
    player.z = finite(data.z, player.z);
    player.ry = finite(data.ry, player.ry);

    broadcast(stateMessage(player), ws);
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'player_left', id });
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Monte Hermoso RP server listening on port ${PORT}`);
});
