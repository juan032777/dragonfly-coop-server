// ── DRAGONFLY’S FLIGHT — CO-OP SERVER (Zero Dependencies) ───────────
// Uses only Node.js built-ins — no npm install needed
// Deploy to Railway: upload this file + package.json

const http = require(‘http’);
const crypto = require(‘crypto’);

// Simple WebSocket server without any npm packages
const clients = {}; // socketId -> { ws, roomCode, playerNum, name, skin, alive, x, y }
const rooms   = {}; // roomCode -> { players:[id,id], host, state, created, lastActivity }

function generateId(){ return crypto.randomBytes(8).toString(‘hex’); }
function generateCode(){
const chars=‘ABCDEFGHJKLMNPQRSTUVWXYZ23456789’;
let c=‘DRAG-’;
for(let i=0;i<4;i++) c+=chars[Math.floor(Math.random()*chars.length)];
return rooms[c]?generateCode():c;
}

// WebSocket handshake
function wsHandshake(req, socket){
const key = req.headers[‘sec-websocket-key’];
const accept = crypto.createHash(‘sha1’)
.update(key+‘258EAFA5-E914-47DA-95CA-C5AB0DC85B11’)
.digest(‘base64’);
socket.write(
‘HTTP/1.1 101 Switching Protocols\r\n’+
‘Upgrade: websocket\r\nConnection: Upgrade\r\n’+
‘Sec-WebSocket-Accept: ‘+accept+’\r\n\r\n’
);
}

// Parse WebSocket frame
function parseFrame(buf){
if(buf.length<2) return null;
const fin=(buf[0]&0x80)!==0;
const opcode=buf[0]&0x0f;
const masked=(buf[1]&0x80)!==0;
let len=buf[1]&0x7f;
let offset=2;
if(len===126){len=buf.readUInt16BE(2);offset=4;}
else if(len===127){len=Number(buf.readBigUInt64BE(2));offset=10;}
if(buf.length<offset+(masked?4:0)+len) return null;
let payload;
if(masked){
const mask=buf.slice(offset,offset+4); offset+=4;
payload=Buffer.alloc(len);
for(let i=0;i<len;i++) payload[i]=buf[offset+i]^mask[i%4];
} else {
payload=buf.slice(offset,offset+len);
}
return {opcode,payload:payload.toString()};
}

// Build WebSocket frame
function buildFrame(data){
const payload=Buffer.from(data,‘utf8’);
const len=payload.length;
let header;
if(len<126){ header=Buffer.alloc(2); header[0]=0x81; header[1]=len; }
else if(len<65536){ header=Buffer.alloc(4); header[0]=0x81; header[1]=126; header.writeUInt16BE(len,2); }
else { header=Buffer.alloc(10); header[0]=0x81; header[1]=127; header.writeBigUInt64BE(BigInt(len),2); }
return Buffer.concat([header,payload]);
}

function send(id, obj){
const c=clients[id];
if(!c||!c.ws||c.ws.destroyed) return;
try{ c.ws.write(buildFrame(JSON.stringify(obj))); }catch(e){}
}

function broadcast(roomCode, obj, excludeId){
const r=rooms[roomCode]; if(!r) return;
r.players.forEach(id=>{ if(id!==excludeId) send(id,obj); });
}

const server=http.createServer((req,res)=>{
// CORS headers for all requests
res.setHeader(‘Access-Control-Allow-Origin’,’*’);
res.setHeader(‘Access-Control-Allow-Methods’,‘GET,POST,OPTIONS’);
res.setHeader(‘Access-Control-Allow-Headers’,’*’);
if(req.method===‘OPTIONS’){res.writeHead(204);res.end();return;}
res.writeHead(200,{‘Content-Type’:‘application/json’});
res.end(JSON.stringify({
status:‘ok’,
game:“Dragonfly’s Flight Co-op Server”,
rooms:Object.keys(rooms).length,
players:Object.keys(clients).length,
uptime:Math.floor(process.uptime())+‘s’,
protocol:‘native-websocket’
}));
});

server.on(‘upgrade’,(req,socket,head)=>{
if(!req.headers[‘sec-websocket-key’]){socket.destroy();return;}
wsHandshake(req,socket);
const id=generateId();
clients[id]={ws:socket,roomCode:null,playerNum:1,name:‘Player’,skin:‘default’,alive:true,x:0,y:0};
console.log(`[+] ${id} connected`);

let buf=Buffer.alloc(0);
socket.on(‘data’,chunk=>{
buf=Buffer.concat([buf,chunk]);
while(true){
const frame=parseFrame(buf);
if(!frame) break;
if(frame.opcode===8){socket.destroy();break;}
if(frame.opcode===1){
try{
const msg=JSON.parse(frame.payload);
handleMessage(id,msg);
}catch(e){}
}
// advance buffer
let len=buf[1]&0x7f, offset=2;
if(len===126){len=buf.readUInt16BE(2);offset=4;}
const masked=(buf[1]&0x80)!==0;
buf=buf.slice(offset+(masked?4:0)+len);
}
});

socket.on(‘close’,()=>handleDisconnect(id));
socket.on(‘error’,()=>handleDisconnect(id));

// Send connected confirmation
send(id,{type:‘connected’,id});
});

function handleMessage(id, msg){
const c=clients[id]; if(!c) return;

if(msg.type===‘createRoom’){
const code=generateCode();
rooms[code]={players:[id],host:id,state:‘waiting’,created:Date.now(),lastActivity:Date.now()};
c.roomCode=code; c.playerNum=1; c.name=msg.name||‘Player 1’; c.skin=msg.skin||‘default’;
send(id,{type:‘roomCreated’,code,playerNum:1});
console.log(`[ROOM] Created ${code}`);
}

else if(msg.type===‘joinRoom’){
const code=(msg.code||’’).toUpperCase().trim();
const r=rooms[code];
if(!r){send(id,{type:‘joinError’,message:‘Room not found.’});return;}
if(r.players.length>=2){send(id,{type:‘joinError’,message:‘Room is full.’});return;}
r.players.push(id); r.state=‘countdown’; r.lastActivity=Date.now();
c.roomCode=code; c.playerNum=2; c.name=msg.name||‘Player 2’; c.skin=msg.skin||‘default’;
send(id,{type:‘roomJoined’,code,playerNum:2,hostName:clients[r.host]?.name||‘Player 1’,hostSkin:clients[r.host]?.skin||‘default’});
broadcast(code,{type:‘partnerJoined’,name:c.name,skin:c.skin},id);
// Countdown
let count=3;
const tick=setInterval(()=>{
broadcast(code,{type:‘countdown’,count});
send(id,{type:‘countdown’,count});
count–;
if(count<0){
clearInterval(tick);
if(rooms[code]) rooms[code].state=‘playing’;
const gs={type:‘gameStart’};
r.players.forEach(pid=>send(pid,gs));
console.log(`[GAME] Started in ${code}`);
}
},1000);
}

else if(msg.type===‘position’){
if(!c.roomCode) return;
rooms[c.roomCode] && (rooms[c.roomCode].lastActivity=Date.now());
c.x=msg.x; c.y=msg.y; c.alive=msg.alive;
broadcast(c.roomCode,{type:‘partnerPosition’,x:msg.x,y:msg.y,vy:msg.vy,alive:msg.alive,skin:c.skin,trail:msg.trail||[]},id);
}

else if(msg.type===‘gameEvent’){
if(!c.roomCode) return;
broadcast(c.roomCode,{type:‘partnerEvent’,event:msg.event,payload:msg.payload},id);
if(msg.event===‘die’){
c.alive=false;
const r=rooms[c.roomCode];
if(r){
const allDead=r.players.every(pid=>clients[pid]&&!clients[pid].alive);
if(allDead) r.players.forEach(pid=>send(pid,{type:‘bothDead’}));
}
}
if(msg.event===‘revive’) c.alive=true;
}

else if(msg.type===‘emote’){
if(!c.roomCode) return;
broadcast(c.roomCode,{type:‘partnerEmote’,emote:msg.emote},id);
}
}

function handleDisconnect(id){
const c=clients[id]; if(!c) return;
if(c.roomCode){
const r=rooms[c.roomCode];
if(r){
broadcast(c.roomCode,{type:‘partnerDisconnected’,playerNum:c.playerNum},id);
r.players=r.players.filter(pid=>pid!==id);
if(r.players.length===0) setTimeout(()=>{ if(rooms[c.roomCode]&&rooms[c.roomCode].players.length===0) delete rooms[c.roomCode]; },30000);
else r.state=‘waiting’;
}
}
delete clients[id];
console.log(`[-] ${id} disconnected`);
}

// Cleanup stale rooms every 10 minutes
setInterval(()=>{
const now=Date.now();
Object.keys(rooms).forEach(code=>{
if(now-rooms[code].lastActivity>2*60*60*1000){delete rooms[code];console.log(`[CLEANUP] ${code}`);}
});
},10*60*1000);

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Dragonfly Co-op Server running on port ${PORT}`));
