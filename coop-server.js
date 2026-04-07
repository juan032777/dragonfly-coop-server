// ── DRAGONFLY’S FLIGHT — CO-OP SERVER ──────────────────────────────
// Stack: Node.js + Socket.io
// Deploy: Railway.app (drag and drop this file)
// Supports: Real-time 2-player co-op, room codes, reconnection

const http = require(‘http’);
const server = http.createServer((req, res) => {
// Health check endpoint for Railway
res.writeHead(200, { ‘Content-Type’: ‘application/json’ });
res.end(JSON.stringify({
status: ‘ok’,
game: “Dragonfly’s Flight Co-op Server”,
rooms: Object.keys(rooms).length,
players: Object.keys(players).length,
uptime: Math.floor(process.uptime()) + ‘s’
}));
});

const { Server } = require(‘socket.io’);
const io = new Server(server, {
cors: {
origin: ‘*’, // Allow all origins — restrict to your domain in production
methods: [‘GET’, ‘POST’]
},
pingTimeout: 10000,
pingInterval: 5000
});

// ── DATA STRUCTURES ──────────────────────────────────────────────────

const rooms   = {}; // roomCode -> { players: [socketId, socketId], state, level, created }
const players = {}; // socketId -> { roomCode, playerNum, name, ready }

// Generate a human-readable room code like DRAG-4829
function generateRoomCode() {
const chars = ‘ABCDEFGHJKLMNPQRSTUVWXYZ23456789’;
let code = ‘DRAG-’;
for (let i = 0; i < 4; i++) {
code += chars[Math.floor(Math.random() * chars.length)];
}
// Ensure uniqueness
return rooms[code] ? generateRoomCode() : code;
}

// ── CONNECTION HANDLER ───────────────────────────────────────────────

io.on(‘connection’, (socket) => {
console.log(`[+] Player connected: ${socket.id}`);

// ── CREATE ROOM ─────────────────────────────────────────────────
socket.on(‘createRoom’, (data) => {
const code = generateRoomCode();
rooms[code] = {
code,
players: [socket.id],
host: socket.id,
state: ‘waiting’,      // waiting | countdown | playing | levelclear | dead
level: data.level || ‘e1’,
worldId: data.worldId || ‘earth’,
created: Date.now(),
lastActivity: Date.now()
};
players[socket.id] = {
roomCode: code,
playerNum: 1,
name: data.name || ‘Player 1’,
skin: data.skin || ‘default’,
ready: false,
alive: true,
x: 0, y: 0, vy: 0
};
socket.join(code);
socket.emit(‘roomCreated’, {
code,
playerNum: 1,
message: `Room ${code} created! Share this code with your friend.`
});
console.log(`[ROOM] Created: ${code} by ${socket.id}`);
});

// ── JOIN ROOM ────────────────────────────────────────────────────
socket.on(‘joinRoom’, (data) => {
const code = data.code.toUpperCase().trim();
const room = rooms[code];

```
if (!room) {
  socket.emit('joinError', { message: 'Room not found. Check the code and try again.' });
  return;
}
if (room.players.length >= 2) {
  socket.emit('joinError', { message: 'Room is full. Ask your friend to create a new room.' });
  return;
}
if (room.state === 'playing') {
  socket.emit('joinError', { message: 'Game already in progress.' });
  return;
}

// Join the room
room.players.push(socket.id);
room.state = 'countdown';
room.lastActivity = Date.now();

players[socket.id] = {
  roomCode: code,
  playerNum: 2,
  name: data.name || 'Player 2',
  skin: data.skin || 'default',
  ready: false,
  alive: true,
  x: 0, y: 0, vy: 0
};

socket.join(code);

// Tell the joining player they're in
socket.emit('roomJoined', {
  code,
  playerNum: 2,
  level: room.level,
  worldId: room.worldId,
  hostName: players[room.host]?.name || 'Player 1',
  hostSkin: players[room.host]?.skin || 'default'
});

// Tell the host someone joined
io.to(room.host).emit('partnerJoined', {
  name: data.name || 'Player 2',
  skin: data.skin || 'default'
});

// Start countdown for both players
io.to(code).emit('countdown', { count: 3 });
let count = 3;
const countInterval = setInterval(() => {
  count--;
  if (count > 0) {
    io.to(code).emit('countdown', { count });
  } else {
    clearInterval(countInterval);
    room.state = 'playing';
    io.to(code).emit('gameStart', {
      level: room.level,
      worldId: room.worldId
    });
    console.log(`[GAME] Started in room ${code}`);
  }
}, 1000);

console.log(`[ROOM] ${socket.id} joined room ${code}`);
```

});

// ── POSITION SYNC (called ~60x per second per player) ───────────
socket.on(‘position’, (data) => {
const p = players[socket.id];
if (!p || !p.roomCode) return;
const room = rooms[p.roomCode];
if (!room || room.state !== ‘playing’) return;

```
// Update stored position
p.x = data.x;
p.y = data.y;
p.vy = data.vy;
p.alive = data.alive;
room.lastActivity = Date.now();

// Broadcast to the OTHER player in the room only
socket.to(p.roomCode).emit('partnerPosition', {
  x: data.x,
  y: data.y,
  vy: data.vy,
  alive: data.alive,
  skin: p.skin,
  trail: data.trail || []
});
```

});

// ── GAME EVENTS (moth collected, life lost, boss hit, etc.) ─────
socket.on(‘gameEvent’, (data) => {
const p = players[socket.id];
if (!p || !p.roomCode) return;
const room = rooms[p.roomCode];
if (!room) return;

```
room.lastActivity = Date.now();

// Broadcast event to partner
socket.to(p.roomCode).emit('partnerEvent', {
  type: data.type,   // 'mothCollect' | 'die' | 'bossHit' | 'levelClear' | 'powerup'
  data: data.payload
});

// Handle level clear — both players must clear
if (data.type === 'levelClear') {
  if (!room.clearCount) room.clearCount = 0;
  room.clearCount++;
  if (room.clearCount >= 2) {
    // Both players cleared — advance level
    room.clearCount = 0;
    io.to(p.roomCode).emit('bothCleared', {
      nextLevel: data.payload?.nextLevel
    });
  } else {
    // Waiting for partner
    socket.emit('waitingForPartner', {
      message: 'Waiting for your partner to finish...'
    });
  }
}

// Handle player death
if (data.type === 'die') {
  p.alive = false;
  socket.to(p.roomCode).emit('partnerDied', {
    playerNum: p.playerNum
  });

  // Check if both dead
  const allDead = room.players.every(id => players[id] && !players[id].alive);
  if (allDead) {
    room.state = 'dead';
    io.to(p.roomCode).emit('bothDead');
  }
}

// Handle revive (watched ad)
if (data.type === 'revive') {
  p.alive = true;
  socket.to(p.roomCode).emit('partnerRevived', {
    playerNum: p.playerNum
  });
}
```

});

// ── CHAT / EMOTES ────────────────────────────────────────────────
socket.on(‘emote’, (data) => {
const p = players[socket.id];
if (!p || !p.roomCode) return;
// Broadcast emote to partner (thumbs up, skull, heart, etc.)
socket.to(p.roomCode).emit(‘partnerEmote’, {
emote: data.emote  // ‘👍’ | ‘💀’ | ‘❤️’ | ‘😂’ | ‘🔥’
});
});

// ── DISCONNECT ───────────────────────────────────────────────────
socket.on(‘disconnect’, () => {
const p = players[socket.id];
if (p && p.roomCode) {
const room = rooms[p.roomCode];
if (room) {
// Notify partner of disconnection
socket.to(p.roomCode).emit(‘partnerDisconnected’, {
playerNum: p.playerNum,
message: ‘Your partner disconnected. Waiting 30 seconds for reconnect…’
});

```
    // Give 30 seconds for reconnect before closing room
    setTimeout(() => {
      const r = rooms[p.roomCode];
      if (r && !r.players.find(id => id !== socket.id && players[id])) {
        delete rooms[p.roomCode];
        console.log(`[ROOM] Closed: ${p.roomCode} (no reconnect)`);
      }
    }, 30000);

    // Remove disconnected player from room
    if (room.players) {
      room.players = room.players.filter(id => id !== socket.id);
    }
    room.state = 'waiting';
  }
  delete players[socket.id];
}
console.log(`[-] Player disconnected: ${socket.id}`);
```

});

// ── RECONNECT ────────────────────────────────────────────────────
socket.on(‘reconnectRoom’, (data) => {
const code = data.code;
const room = rooms[code];
if (!room) {
socket.emit(‘reconnectFailed’, { message: ‘Room expired. Please create a new room.’ });
return;
}
// Re-add player to room
room.players.push(socket.id);
players[socket.id] = {
roomCode: code,
playerNum: data.playerNum,
name: data.name,
skin: data.skin,
ready: true,
alive: true,
x: 0, y: 0, vy: 0
};
socket.join(code);
socket.emit(‘reconnected’, { code, playerNum: data.playerNum });
socket.to(code).emit(‘partnerReconnected’, { playerNum: data.playerNum });
console.log(`[RECONNECT] ${socket.id} rejoined ${code}`);
});
});

// ── CLEANUP STALE ROOMS ─────────────────────────────────────────────
// Remove rooms inactive for more than 2 hours
setInterval(() => {
const now = Date.now();
Object.keys(rooms).forEach(code => {
if (now - rooms[code].lastActivity > 2 * 60 * 60 * 1000) {
delete rooms[code];
console.log(`[CLEANUP] Removed stale room: ${code}`);
}
});
}, 10 * 60 * 1000); // Check every 10 minutes

// ── START SERVER ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
console.log(`╔══════════════════════════════════════════╗ ║   Dragonfly's Flight Co-op Server       ║ ║   Running on port ${PORT}                   ║ ║   Ready for players                     ║ ╚══════════════════════════════════════════╝`);
});
