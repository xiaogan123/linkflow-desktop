import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';

// A public client ID is safe to ship. Keep this empty until the product's
// registered callback and a real consent round-trip have been accepted.
export const WORDPRESS_CLIENT={clientId:'',redirectUri:'http://127.0.0.1:47891/wordpress/callback'};
export interface WordPressGrant {accessToken:string;expiresAt:string;blogId?:string}
export interface WordPressOAuthOptions {
  client?:{clientId:string;redirectUri:string};
  openExternal:(url:string)=>Promise<unknown>;
  signal?:AbortSignal;
  timeoutMs?:number;
}

/** No password/secret grant, no token in renderer IPC or URL query strings. */
export async function authorizeWordPress(options:WordPressOAuthOptions):Promise<WordPressGrant>{
  const client=options.client??WORDPRESS_CLIENT;
  if(!/^\d{1,32}$/.test(client.clientId))throw Error('WordPress.com 接入尚未完成配置，暂不能授权。');
  const redirect=new URL(client.redirectUri);
  if(redirect.protocol!=='http:'||redirect.hostname!=='127.0.0.1'||Number(redirect.port)<1024||redirect.pathname!=='/wordpress/callback'||redirect.search||redirect.hash||redirect.username||redirect.password)throw Error('WordPress.com 回调配置无效');
  if(options.signal?.aborted)throw Error('WordPress.com 授权已取消');
  const state=randomBytes(32).toString('hex'),nonce=randomBytes(32).toString('hex');
  const authorization=new URL('https://public-api.wordpress.com/oauth2/authorize');
  authorization.search=new URLSearchParams({client_id:client.clientId,redirect_uri:client.redirectUri,response_type:'token',state}).toString();
  // No global scope: the platform's default limits access to the chosen blog.
  return await new Promise<WordPressGrant>((resolve,reject)=>{
    let settled=false;
    const server=createServer(async(req,res)=>{
      res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Connection','close');
      res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
      const deny=(status=400)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8'});res.end('请求无效，请返回外链助手重新授权。')};
      if(req.headers.host!==redirect.host)return deny(403);
      if(req.method==='GET'&&req.url===redirect.pathname){
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
        res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>外链助手 · WordPress.com</title><p id="result">正在完成授权…</p><script nonce="${nonce}">const fragment=location.hash.slice(1);history.replaceState(null,'',location.pathname);fetch(location.pathname+'/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fragment,nonce:'${nonce}'})}).then(r=>{document.getElementById('result').textContent=r.ok?'授权已返回外链助手，可以关闭此页。':'授权未完成，请回到外链助手重试。'}).catch(()=>{document.getElementById('result').textContent='连接已关闭，请回到外链助手重试。'});</script></html>`);
        return;
      }
      if(req.method!=='POST'||req.url!==redirect.pathname+'/token'||req.headers.origin!==redirect.origin||req.headers['content-type']!=='application/json')return deny(403);
      try{
        let body='';
        for await(const chunk of req){body+=chunk.toString('utf8');if(Buffer.byteLength(body)>8192){deny(413);return;}}
        const input=JSON.parse(body) as Record<string,unknown>;
        if(input.nonce!==nonce||typeof input.fragment!=='string')return deny(403);
        const values=new URLSearchParams(input.fragment);
        if([...values.keys()].some(key=>values.getAll(key).length!==1)||values.get('state')!==state)return deny(403);
        if(values.has('error')){res.once('finish',()=>finish(Error('WordPress.com 授权未完成或已拒绝')));return deny();}
        const token=values.get('access_token'),seconds=Number(values.get('expires_in')),type=values.get('token_type');
        const blogId=values.get('blog_id')??values.get('site_id')??undefined;
        if(!token||token.length>4096||/[\s\u0000-\u001f\u007f]/.test(token)||type?.toLowerCase()!=='bearer'||!Number.isFinite(seconds)||seconds<=0||seconds>366*86400||blogId!==undefined&&!/^\d{1,32}$/.test(blogId)||values.get('scope')?.split(/\s+/).includes('global'))return deny();
        const grant={accessToken:token,expiresAt:new Date(Date.now()+seconds*1000).toISOString(),...(blogId?{blogId}:{})};
        res.once('finish',()=>finish(undefined,grant));res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');
      }catch{if(!res.writableEnded)deny();}
    });
    server.requestTimeout=20_000;server.headersTimeout=15_000;
    const finish=(error?:Error,result?:WordPressGrant)=>{
      if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);
      server.close();server.closeAllConnections();
      if(error)reject(error);else if(result)resolve(result);else reject(Error('WordPress.com 授权未完成'));
    };
    const cancel=()=>finish(Error('WordPress.com 授权已取消'));
    const timer=setTimeout(()=>finish(Error('WordPress.com 授权超时，请重试')),Math.min(options.timeoutMs??300_000,300_000));
    options.signal?.addEventListener('abort',cancel,{once:true});
    server.on('error',()=>finish(Error('WordPress.com 授权回调无法启动，请关闭重复的连接操作后重试')));
    server.listen(Number(redirect.port),'127.0.0.1',()=>{
      if(settled){server.close();return;}
      Promise.resolve().then(()=>options.openExternal(authorization.toString())).catch(()=>finish(Error('无法打开 WordPress.com 授权页面')));
    });
    if(options.signal?.aborted)cancel();
  });
}
