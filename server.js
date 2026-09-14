const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 9080;
let nextId = 1;
const players = new Map();
const vehicles = new Map();

const VEHICLE_TYPES = new Set(['bus', 'ambulancia', 'barco', 'camion']);

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(data, except = null) {
  const payload = JSON.stringify(data);
  for (const [, player] of players) {
    if (player.ws !== except && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(payload);
    }
  }
}

function finite(v, fallback) {
  return Number.isFinite(Number(v)) ? Number(v) : fallback;
}

function cleanName(value) {
  let name = String(value ?? '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) name = 'Jugador';
  return name.slice(0, 24);
}

function vehicleStateMessage(vehicle) {
  return {
    type: 'vehicle_state',
    vehicle_id: vehicle.vehicle_id,
    vehicle_type: vehicle.vehicle_type,
    x: vehicle.x,
    y: vehicle.y,
    z: vehicle.z,
    rx: vehicle.rx,
    ry: vehicle.ry,
    rz: vehicle.rz,
    driver_id: vehicle.driver_id || ''
  };
}

function playerStateMessage(player) {
  const msg = {
    type: 'player_state',
    id: player.id,
    x: player.x,
    y: player.y,
    z: player.z,
    ry: player.ry,
    name: player.name,
    in_vehicle: player.in_vehicle,
    vehicle_type: player.vehicle_type,
    vehicle_id: player.vehicle_id
  };
  if (player.in_vehicle) {
    msg.lx = player.lx;
    msg.ly = player.ly;
    msg.lz = player.lz;
    msg.lry = player.lry;
    if (player.vehicle_id && vehicles.has(player.vehicle_id)) {
      msg.vehicle = vehicleStateMessage(vehicles.get(player.vehicle_id));
    }
  }
  return msg;
}

wss = null;

const httpServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Monte Hermoso RP multiplayer server OK\n');
});

wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws) => {
  const id = String(nextId++);
  const player = {
    id, ws,
    x: 0, y: 1.15, z: -15, ry: 0,
    name: 'Jugador',
    in_vehicle: false,
    vehicle_type: '',
    vehicle_id: '',
    lx: 0, ly: 0, lz: 0, lry: 0
  };
  players.set(id, player);

  send(ws, {
    type: 'welcome',
    id,
    vehicles: Array.from(vehicles.values()).map(vehicleStateMessage)
  });

  for (const [otherId, other] of players) {
    if (otherId !== id) send(ws, playerStateMessage(other));
  }
  broadcast({ type: 'player_joined', ...playerStateMessage(player) }, ws);

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (!data) return;

    // Los clientes pueden enviar el estado del vehiculo de forma independiente.
    // El servidor lo retransmite a todos los demas clientes sin usarlo como estado del jugador.
    if (data.type === 'vehicle_state') {
      const vehicleType = String(data.vehicle_type || '');
      const vehicleId = String(data.vehicle_id || '');
      if (!VEHICLE_TYPES.has(vehicleType) || !vehicleId) return;
      const old = vehicles.get(vehicleId) || {
        vehicle_id: vehicleId, vehicle_type: vehicleType, x: 0, y: 0.65, z: 0, rx: 0, ry: 0, rz: 0, driver_id: ''
      };
      if (old.driver_id && old.driver_id !== player.id) return;
      const updated = {
        vehicle_id: vehicleId,
        vehicle_type: vehicleType,
        x: finite(data.x, old.x),
        y: finite(data.y, old.y),
        z: finite(data.z, old.z),
        rx: finite(data.rx, old.rx),
        ry: finite(data.ry, old.ry),
        rz: finite(data.rz, old.rz),
        driver_id: player.id
      };
      vehicles.set(vehicleId, updated);
      broadcast(vehicleStateMessage(updated), ws);
      return;
    }

    if (data.type === 'vehicle_removed') {
      const vehicleId = String(data.vehicle_id || '');
      if (!vehicleId) return;
      const vehicle = vehicles.get(vehicleId);
      if (!vehicle || vehicle.driver_id !== player.id) return;
      vehicles.delete(vehicleId);
      broadcast({ type: 'vehicle_removed', vehicle_id: vehicleId }, ws);
      return;
    }

    if (data.type === 'chat') {
      let message = String(data.message ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      if (!message) return;
      broadcast({ type: 'chat', id: player.id, name: player.name, message });
      return;
    }

    if (data.type !== 'state') return;

    player.x = finite(data.x, player.x);
    player.y = finite(data.y, player.y);
    player.z = finite(data.z, player.z);
    player.ry = finite(data.ry, player.ry);
    player.name = cleanName(data.name);

    const requestedVehicle = String(data.vehicle_type || '');
    const requestedVehicleId = String(data.vehicle_id || '');
    const previousVehicleId = player.vehicle_id;
    player.in_vehicle = data.in_vehicle === true && VEHICLE_TYPES.has(requestedVehicle) && !!requestedVehicleId;
    player.vehicle_type = player.in_vehicle ? requestedVehicle : '';
    player.vehicle_id = player.in_vehicle ? requestedVehicleId : '';

    if (previousVehicleId && previousVehicleId !== player.vehicle_id) {
      const previousVehicle = vehicles.get(previousVehicleId);
      if (previousVehicle && previousVehicle.driver_id === player.id) {
        vehicles.delete(previousVehicleId);
        broadcast({ type: 'vehicle_removed', vehicle_id: previousVehicleId }, ws);
      }
    }

    if (player.in_vehicle) {
      player.lx = finite(data.lx, player.lx);
      player.ly = finite(data.ly, player.ly);
      player.lz = finite(data.lz, player.lz);
      player.lry = finite(data.lry, player.lry);

      const v = data.vehicle;
      if (v && typeof v === 'object' && requestedVehicle === String(v.vehicle_type) && requestedVehicleId === String(v.vehicle_id) && VEHICLE_TYPES.has(requestedVehicle)) {
        const old = vehicles.get(requestedVehicleId) || {
          vehicle_id: requestedVehicleId, vehicle_type: requestedVehicle, x: 0, y: 0.65, z: 0, rx: 0, ry: 0, rz: 0, driver_id: ''
        };
        if (old.driver_id && old.driver_id !== player.id) return;
        const updated = {
          vehicle_id: requestedVehicleId,
          vehicle_type: requestedVehicle,
          x: finite(v.x, old.x),
          y: finite(v.y, old.y),
          z: finite(v.z, old.z),
          rx: finite(v.rx, old.rx),
          ry: finite(v.ry, old.ry),
          rz: finite(v.rz, old.rz),
          driver_id: player.id
        };
        vehicles.set(requestedVehicleId, updated);
        broadcast(vehicleStateMessage(updated), ws);
      }
    }

    broadcast(playerStateMessage(player), ws);
  });

  ws.on('close', () => {
    if (player.vehicle_id && vehicles.has(player.vehicle_id)) {
      const vehicle = vehicles.get(player.vehicle_id);
      if (vehicle.driver_id === id) {
        vehicles.delete(player.vehicle_id);
      }
    }
    players.delete(id);
    broadcast({ type: 'player_left', id, vehicle_id: player.vehicle_id });
    if (player.vehicle_id) {
      broadcast({ type: 'vehicle_removed', vehicle_id: player.vehicle_id });
    }
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Monte Hermoso RP multiplayer server listening on port ${PORT}`);
});
