var http = require(‘http’);
var crypto = require(‘crypto’);
var clients = {};
var rooms = {};

function genId(){ return crypto.randomBytes(8).toString(‘hex’); }
function genCode(){
var chars = ‘ABCDEFGHJKLMNPQRSTUVWXYZ23456789’;
var c = ‘DRAG-’;
for(var i=0;i<4;i++) c+=chars[Math.floor(Math.random()*chars.length)];
return rooms[c]?genCode():c;
}
function hs(req,socket){
var k=req.headers[‘sec-websocket-key’];
var a=crypto.createHash(‘sha1’).update(k+‘258EAFA5-E914-47DA-95CA-C5AB0DC85B11’).digest(‘base64’);
socket.write(‘HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ‘+a+’\r\n\r\n’);
}
function parse(buf){
if(buf.length<2)return null;
var m=(buf[1]&0x80)!==0,l=buf[1]&0x7f,o=2;
if(l===126){l=buf.readUInt16BE(2);o=4;}
if(buf.length<o+(m?4:0)+l)return null;
var p;
if(m){var mask=buf.slice(o,o+4);o+=4;p=Buffer.alloc(l);for(var i=0;i<l;i++)p[i]=buf[o+i]^mask[i%4];}
else p=buf.slice(o,o+l);
return{op:buf[0]&0x0f,data:p.toString(),len:o+l};
}
function frame(d){
var p=Buffer.from(d,‘utf8’),l=p.length,h;
if(l<126){h=Buffer.alloc(2);h[0]=0x81;h[1]=l;}
else{h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(l,2);}
return Buffer.concat([h,p]);
}
function send(id,obj){
var c=clients[id];
if(!c||!c.ws||c.ws.destroyed)return;
try{c.ws.write(frame(JSON.stringify(obj)));}catch(e){}
}
function bcast(code,obj,skip){
var r=rooms[code];if(!r)return;
r.players.forEach(function(id){if(id!==skip)send(id,obj);});
}

var server=http.createServer(function(req,res){
res.setHeader(‘Access-Control-Allow-Origin’,’*’);
res.setHeader(‘Access-Control-Allow-Headers’,’*’);
if(req.method===‘OPTIONS’){res.writeHead(204);res.end();return;}
res.writeHead(200,{‘Content-Type’:‘application/json’});
res.end(JSON.stringify({ok:true,rooms:Object.keys(rooms).length,players:Object.keys(clients).length}));
});

server.on(‘upgrade’,function(req,socket,head){
socket.setNoDelay(true);
socket.setKeepAlive(true,30000);
if(!req.headers[‘sec-websocket-key’]){socket.destroy();return;}
hs(req,socket);
var id=genId();
clients[id]={ws:socket,roomCode:null,playerNum:1,name:‘P’,skin:‘default’,alive:true};
send(id,{type:‘connected’,id:id});
var buf=Buffer.alloc(0);
socket.on(‘data’,function(chunk){
buf=Buffer.concat([buf,chunk]);
while(true){
var f=parse(buf);if(!f)break;
if(f.op===8){socket.destroy();break;}
if(f.op===1){try{msg(id,JSON.parse(f.data));}catch(e){}}
buf=buf.slice(f.len);
}
});
socket.on(‘close’,function(){disc(id);});
socket.on(‘error’,function(){disc(id);});
});

function msg(id,m){
var c=clients[id];if(!c)return;
if(m.type===‘createRoom’){
var code=genCode();
rooms[code]={players:[id],host:id,state:‘waiting’,ts:Date.now()};
c.roomCode=code;c.playerNum=1;c.name=m.name||‘P1’;c.skin=m.skin||‘default’;
send(id,{type:‘roomCreated’,code:code,playerNum:1});
}
else if(m.type===‘joinRoom’){
var code=(m.code||’’).toUpperCase().trim();
var r=rooms[code];
if(!r){send(id,{type:‘joinError’,message:‘Room not found.’});return;}
if(r.players.length>=2){send(id,{type:‘joinError’,message:‘Room is full.’});return;}
r.players.push(id);r.state=‘countdown’;r.ts=Date.now();
c.roomCode=code;c.playerNum=2;c.name=m.name||‘P2’;c.skin=m.skin||‘default’;
var h=clients[r.host];
send(id,{type:‘roomJoined’,code:code,playerNum:2,hostName:h?h.name:‘P1’,hostSkin:h?h.skin:‘default’});
bcast(code,{type:‘partnerJoined’,name:c.name,skin:c.skin},id);
var n=3;
var t=setInterval(function(){
if(!rooms[code]){clearInterval(t);return;}
r.players.forEach(function(pid){send(pid,{type:‘countdown’,count:n});});
n–;
if(n<0){clearInterval(t);if(rooms[code])rooms[code].state=‘playing’;r.players.forEach(function(pid){send(pid,{type:‘gameStart’});});}
},1000);
}
else if(m.type===‘position’){
if(!c.roomCode)return;
bcast(c.roomCode,{type:‘partnerPosition’,x:m.x,y:m.y,vy:m.vy,alive:m.alive,skin:c.skin,trail:m.trail||[]},id);
}
else if(m.type===‘gameEvent’){
if(!c.roomCode)return;
bcast(c.roomCode,{type:‘partnerEvent’,event:m.event,payload:m.payload},id);
if(m.event===‘die’){
c.alive=false;
var r=rooms[c.roomCode];
if(r){var all=r.players.every(function(pid){return clients[pid]&&!clients[pid].alive;});if(all)r.players.forEach(function(pid){send(pid,{type:‘bothDead’});});}
}
if(m.event===‘revive’)c.alive=true;
}
else if(m.type===‘emote’){if(!c.roomCode)return;bcast(c.roomCode,{type:‘partnerEmote’,emote:m.emote},id);}
}

function disc(id){
var c=clients[id];if(!c)return;
if(c.roomCode){
var r=rooms[c.roomCode];
if(r){
bcast(c.roomCode,{type:‘partnerDisconnected’,playerNum:c.playerNum},id);
r.players=r.players.filter(function(pid){return pid!==id;});
if(r.players.length===0){var code=c.roomCode;setTimeout(function(){if(rooms[code]&&rooms[code].players.length===0)delete rooms[code];},30000);}
else r.state=‘waiting’;
}
}
delete clients[id];
}

setInterval(function(){
var now=Date.now();
Object.keys(rooms).forEach(function(code){if(now-rooms[code].ts>7200000)delete rooms[code];});
},600000);

var PORT=process.env.PORT||3000;
server.listen(PORT,function(){console.log(’OK port ’+PORT);});
