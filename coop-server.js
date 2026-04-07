var http=require('http');var s=http.createServer(function(req,res){res.end('ok');});s.listen(process.env.PORT||3000,function(){console.log('up');});
