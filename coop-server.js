var http = require(‘http’);
var crypto = require(‘crypto’);
var clients = {};
var rooms = {};
function id(){ return crypto.randomBytes(4).toString(‘hex’); }
function code(){ var c=‘DRAG-’,s=‘ABCDEFGHJKLMNPQRSTUVWXYZ23456789’; for(var i=0;i<4;i++)c+=s[Math.floor(Math.random()*s.length)]; return rooms[c]?code():c; }
function shake(req,sock){ var k=req.headers[‘sec-websocket-key’],a=crypto.createHash(‘sha1’).update(k+‘258EAFA5-E914-47DA-95CA-C5AB0DC85B11’).digest(‘base64’); sock.write(‘HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ‘+a+’\r\n\r\n’); }
function parse(b){ if(b.length<2)return null; var m=(b[1]&128)!==0,l=b[1]&127,o=2; if(l===126){l=b.readUInt16BE(2);o=4;} if(b.length<o+(m?4:0)+l)return null; var p; if(m){var k=b.slice(o,o+4);o+=4;p=Buffer.alloc(l);for(var i=0;i<l;i++)p[i]=b[o+i]^k[i%4];}else p=b.slice(o,o+l); return{op:b[0]&15,text:p.toString(),size:o+l}; }
function frame(s){ var p=Buffer.from(s,‘utf8’),l=p.length,h; if(l<126){h=Buffer.alloc(2);h[0]=129;h[1]=l;}else{h=Buffer.alloc(4);h[0]=129;h[1]=126;h.writeUInt16BE(l,2);} return Buffer.concat([h,p]); }
function send(id,obj){ var c=clients[id]; if(!c||c.ws.destroyed)return; try{c.ws.write(frame(JSON.stringify(obj)));}catch(e){} }
function bcast(room,obj,skip){ if(!rooms[room])return; rooms[room].players.forEach(function(p){if(p!==skip)send(p,obj);}); }
var server=http.createServer(function(req,res){ res.setHeader(‘Access-Control-Allow-Origin’,’*’); res.writeHead(200); res.end(JSON.stringify({ok:true,players:Object.keys(clients).length})); });
server.on(‘upgrade’,function(req,sock){
if(!req.headers[‘sec-websocket-key’]){sock.destroy();return;}
sock.setNoDelay(true);
shake(req,sock);
var i=id();
clients[i]={ws:sock,room:null,num:1,alive:true};
send(i,{type:‘connected’});
var buf=Buffer.alloc(0);
sock.on(‘data’,function(chunk){
try{
buf=Buffer.concat([buf,chunk]);
if(buf.length>65536){sock.destroy();return;}
while(true){
var f=parse(buf);
if(!f)break;
if(f.op===8){sock.destroy();break;}
if(f.op===1){try{msg(i,JSON.parse(f.text));}catch(e){}}
if(f.size<=0)break;
buf=buf.slice(f.size);
}
}catch(e){try{sock.destroy();}catch(e2){}}
});
sock.on(‘close’,function(){disc(i);});
sock.on(‘error’,function(){disc(i);});
});
function msg(i,m){
var c=clients[i];if(!c)return;
if(m.type===‘createRoom’){var r=code();rooms[r]={players:[i],host:i,ts:Date.now()};c.room=r;c.num=1;send(i,{type:‘roomCreated’,code:r,playerNum:1});}
else if(m.type===‘joinRoom’){
var r=(m.code||’’).toUpperCase().trim(),rm=rooms[r];
if(!rm){send(i,{type:‘joinError’,message:‘Room not found.’});return;}
if(rm.players.length>=2){send(i,{type:‘joinError’,message:‘Room is full.’});return;}
rm.players.push(i);c.room=r;c.num=2;
var h=clients[rm.host];
send(i,{type:‘roomJoined’,code:r,playerNum:2,hostName:h?h.name:‘P1’});
bcast(r,{type:‘partnerJoined’},i);
var n=3,t=setInterval(function(){
if(!rooms[r]){clearInterval(t);return;}
rm.players.forEach(function(p){send(p,{type:‘countdown’,count:n});});
n–;if(n<0){clearInterval(t);rm.players.forEach(function(p){send(p,{type:‘gameStart’});});}
},1000);
}
else if(m.type===‘position’){if(!c.room)return;bcast(c.room,{type:‘partnerPosition’,x:m.x,y:m.y,vy:m.vy,alive:m.alive,skin:m.skin,trail:m.trail||[]},i);}
else if(m.type===‘gameEvent’){if(!c.room)return;bcast(c.room,{type:‘partnerEvent’,event:m.event},i);}
else if(m.type===‘emote’){if(!c.room)return;bcast(c.room,{type:‘partnerEmote’,emote:m.emote},i);}
}
function disc(i){
var c=clients[i];if(!c)return;
if(c.room&&rooms[c.room]){bcast(c.room,{type:‘partnerDisconnected’},i);rooms[c.room].players=rooms[c.room].players.filter(function(p){return p!==i;});if(rooms[c.room].players.length===0)delete rooms[c.room];}
delete clients[i];
}
process.on(‘uncaughtException’,function(e){console.log(‘err:’+e.message);});
var PORT=process.env.PORT||3000;
server.listen(PORT,function(){console.log(‘up:’+PORT);});
