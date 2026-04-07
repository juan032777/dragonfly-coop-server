var http = require(‘http’);
var crypto = require(‘crypto’);

var clients = {};
var rooms = {};

function genId(){ return crypto.randomBytes(8).toString(‘hex’); }

function genCode(){
var chars = ‘ABCDEFGHJKLMNPQRSTUVWXYZ23456789’;
var c = ‘DRAG-’;
for(var i=0;i<4;i++) c += chars[Math.floor(Math.random()*chars.length)];
return rooms[c] ? genCode() : c;
}

function handshake(req, socket){
var key = req.headers[‘sec-websocket-key’];
var accept = crypto.createHash(‘sha1’)
.update(key + ‘258EAFA5-E914-47DA-95CA-C5AB0DC85B11’)
.digest(‘base64’);
socket.write(
‘HTTP/1.1 101 Switching Protocols\r\n’ +
‘Upgrade: websocket\r\nConnection: Upgrade\r\n’ +
’Sec-WebSocket-Accept: ’ + accept + ‘\r\n\r\n’
);
}

function parseFrame(buf){
if(buf.length < 2) return null;
var masked = (buf[1] & 0x80) !== 0;
var len = buf[1] & 0x7f;
var offset = 2;
if(len === 126){ len = buf.readUInt16BE(2); offset = 4; }
if(buf.length < offset + (masked?4:0) + len) return null;
var payload;
if(masked){
var mask = buf.slice(offset, offset+4); offset += 4;
payload = Buffer.alloc(len);
for(var i=0;i<len;i++) payload[i] = buf[offset+i] ^ mask[i%4];
} else {
payload = buf.slice(offset, offset+len);
}
return { opcode: buf[0]&0x0f, payload: payload.toString(), len: offset+len };
}

function buildFrame(data){
var payload = Buffer.from(data, ‘utf8’);
var len = payload.length;
var header;
if(len < 126){ header = Buffer.alloc(2); header[0]=0x81; header[1]=len; }
else { header = Buffer.alloc(4); header[0]=0x81; header[1]=126; header.writeUInt16BE(len,2); }
return Buffer.concat([header, payload]);
}

function send(id, obj){
var c = clients[id];
if(!c || !c.ws || c.ws.destroyed) return;
try{ c.ws.write(buildFrame(JSON.stringify(obj))); }catch(e){}
}

function broadcast(code, obj, skip){
var r = rooms[code];
if(!r) return;
r.players.forEach(function(id){ if(id !== skip) send(id, obj); });
}

var server = http.createServer(function(req, res){
res.setHeader(‘Access-Control-Allow-Origin’,’*’);
res.writeHead(200, {‘Content-Type’:‘application/json’});
res.end(JSON.stringify({
status:‘ok’,
rooms: Object.keys(rooms).length,
players: Object.keys(clients).length,
uptime: Math.floor(process.uptime()) + ‘s’
}));
});

server.on(‘upgrade’, function(req, socket){
if(!req.headers[‘sec-websocket-key’]){ socket.destroy(); return; }
handshake(req, socket);
var id = genId();
clients[id] = { ws:socket, roomCode:null, playerNum:1, name:‘Player’, skin:‘default’, alive:true };
console.log(’[+] ’ + id);
send(id, {type:‘connected’, id:id});

var buf = Buffer.alloc(0);
socket.on(‘data’, function(chunk){
buf = Buffer.concat([buf, chunk]);
while(true){
var frame = parseFrame(buf);
if(!frame) break;
if(frame.opcode === 8){ socket.destroy(); break; }
if(frame.opcode === 1){
try{ handleMsg(id, JSON.parse(frame.payload)); }catch(e){}
}
buf = buf.slice(frame.len);
}
});
socket.on(‘close’, function(){ disconnect(id); });
socket.on(‘error’, function(){ disconnect(id); });
});

function handleMsg(id, msg){
var c = clients[id];
if(!c) return;

if(msg.type === ‘createRoom’){
var code = genCode();
rooms[code] = { players:[id], host:id, state:‘waiting’, lastActivity:Date.now() };
c.roomCode = code; c.playerNum = 1;
c.name = msg.name||‘Player 1’; c.skin = msg.skin||‘default’;
send(id, {type:‘roomCreated’, code:code, playerNum:1});
console.log(’[ROOM] Created ’ + code);
}

else if(msg.type === ‘joinRoom’){
var code = (msg.code||’’).toUpperCase().trim();
var r = rooms[code];
if(!r){ send(id,{type:‘joinError’,message:‘Room not found.’}); return; }
if(r.players.length >= 2){ send(id,{type:‘joinError’,message:‘Room is full.’}); return; }
r.players.push(id); r.state = ‘countdown’; r.lastActivity = Date.now();
c.roomCode = code; c.playerNum = 2;
c.name = msg.name||‘Player 2’; c.skin = msg.skin||‘default’;
var host = clients[r.host];
send(id, {type:‘roomJoined’, code:code, playerNum:2, hostName:host?host.name:‘Player 1’, hostSkin:host?host.skin:‘default’});
broadcast(code, {type:‘partnerJoined’, name:c.name, skin:c.skin}, id);
var count = 3;
var tick = setInterval(function(){
if(!rooms[code]){ clearInterval(tick); return; }
r.players.forEach(function(pid){ send(pid,{type:‘countdown’,count:count}); });
count–;
if(count < 0){
clearInterval(tick);
if(rooms[code]) rooms[code].state = ‘playing’;
r.players.forEach(function(pid){ send(pid,{type:‘gameStart’}); });
console.log(’[GAME] Started ’ + code);
}
}, 1000);
}

else if(msg.type === ‘position’){
if(!c.roomCode) return;
if(rooms[c.roomCode]) rooms[c.roomCode].lastActivity = Date.now();
broadcast(c.roomCode, {type:‘partnerPosition’, x:msg.x, y:msg.y, vy:msg.vy, alive:msg.alive, skin:c.skin, trail:msg.trail||[]}, id);
}

else if(msg.type === ‘gameEvent’){
if(!c.roomCode) return;
broadcast(c.roomCode, {type:‘partnerEvent’, event:msg.event, payload:msg.payload}, id);
if(msg.event === ‘die’){
c.alive = false;
var r = rooms[c.roomCode];
if(r){
var allDead = r.players.every(function(pid){ return clients[pid] && !clients[pid].alive; });
if(allDead) r.players.forEach(function(pid){ send(pid,{type:‘bothDead’}); });
}
}
if(msg.event === ‘revive’) c.alive = true;
}

else if(msg.type === ‘emote’){
if(!c.roomCode) return;
broadcast(c.roomCode, {type:‘partnerEmote’, emote:msg.emote}, id);
}
}

function disconnect(id){
var c = clients[id];
if(!c) return;
if(c.roomCode){
var r = rooms[c.roomCode];
if(r){
broadcast(c.roomCode, {type:‘partnerDisconnected’, playerNum:c.playerNum}, id);
r.players = r.players.filter(function(pid){ return pid !== id; });
if(r.players.length === 0){
var code = c.roomCode;
setTimeout(function(){ if(rooms[code] && rooms[code].players.length===0) delete rooms[code]; }, 30000);
} else {
r.state = ‘waiting’;
}
}
}
delete clients[id];
console.log(’[-] ’ + id);
}

setInterval(function(){
var now = Date.now();
Object.keys(rooms).forEach(function(code){
if(now - rooms[code].lastActivity > 7200000){ delete rooms[code]; }
});
}, 600000);

var PORT = process.env.PORT || 3000;
server.listen(PORT, function(){
console.log(’Dragonfly Co-op Server on port ’ + PORT);
});
