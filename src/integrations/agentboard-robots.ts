import type {OpenAgentChatDependencies} from './openagentchat';
import {AGENTBOARD_ORIGIN} from './agentboard';
// This profile route is public. A 404 robots response means no robots rules;
// transport failures and unexpected redirects must not be treated as permission.
export async function readAgentboardRobots(deps:OpenAgentChatDependencies={}):Promise<string>{
  const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,Math.min(60000,Math.max(100,deps.timeoutMs??25000)));
  deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)abort();
  const wait=<T>(promise:Promise<T>)=>new Promise<T>((resolve,reject)=>{const stop=()=>{controller.signal.removeEventListener('abort',stop);reject(Error('Agentboard robots 请求已取消'))};if(controller.signal.aborted){void promise.catch(()=>{});stop();return}controller.signal.addEventListener('abort',stop,{once:true});promise.then(value=>{controller.signal.removeEventListener('abort',stop);resolve(value)},error=>{controller.signal.removeEventListener('abort',stop);reject(error)})});
  let response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
    if(controller.signal.aborted)throw Error('Agentboard robots 请求已取消');
    const url=AGENTBOARD_ORIGIN+'/robots.txt';response=await wait((deps.fetch??fetch)(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'text/plain'}}));
    if(response.redirected||response.url&&response.url!==url)throw Error('Agentboard robots 路径已改变');
    if(response.status===404)return '';
    if(response.status!==200||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='text/plain')throw Error('Agentboard robots 不可读取');
    const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>256000))throw Error('Agentboard robots 过大');
    reader=response.body?.getReader();if(!reader)return '';const parts:Buffer[]=[];let size=0;
    for(;;){const next=await wait(reader.read());if(next.done)break;size+=next.value.length;if(size>256000)throw Error('Agentboard robots 过大');parts.push(Buffer.from(next.value))}
    return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts));
  }finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort);if(reader)void reader.cancel().catch(()=>{});else if(response?.body&&!response.body.locked)void response.body.cancel().catch(()=>{})}
}

export function agentboardRobotsAllows(text:string,path:string,agent:string):boolean{
  const groups:Array<{agents:string[];rules:Array<{allow:boolean;path:string}>}>=[];let current={agents:[] as string[],rules:[] as Array<{allow:boolean;path:string}>};
  for(const line of text.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/)){const match=line.replace(/#.*$/,'').trim().match(/^([^:]+):\s*(.*)$/);if(!match)continue;const key=match[1].trim().toLowerCase(),value=match[2].trim();if(key==='user-agent'){if(current.rules.length){groups.push(current);current={agents:[],rules:[]}}current.agents.push(value.toLowerCase())}else if((key==='allow'||key==='disallow')&&current.agents.length&&value)current.rules.push({allow:key==='allow',path:value})}groups.push(current);
  const matches=groups.map(group=>({...group,score:Math.max(-1,...group.agents.map(value=>value==='*'?0:agent.toLowerCase().startsWith(value)?value.length:-1))})).filter(group=>group.score>=0);if(!matches.length)return true;
  const score=Math.max(...matches.map(group=>group.score));let winner:{allow:boolean;length:number}|undefined;
  for(const rule of matches.filter(group=>group.score===score).flatMap(group=>group.rules)){const end=rule.path.endsWith('$'),expression=rule.path.replace(/\$$/,'').split('*').map(value=>value.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*');if(!new RegExp('^'+expression+(end?'$':'')).test(path))continue;const length=Buffer.byteLength(rule.path.replace(/[*$]/g,''));if(!winner||length>winner.length||length===winner.length&&rule.allow)winner={allow:rule.allow,length}}
  return winner?.allow??true;
}
