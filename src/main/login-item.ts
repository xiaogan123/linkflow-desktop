export interface LoginItemState {openAtLogin:boolean;status?:string;executableWillLaunchAtLogin?:boolean}
export interface LoginItemPort {
  packaged:boolean;
  platform:string;
  read:()=>LoginItemState;
  write:(openAtLogin:boolean,enabled?:boolean)=>void;
}

function effective(state:LoginItemState,platform:string):boolean {
  if(platform==='win32')return state.openAtLogin&&state.executableWillLaunchAtLogin===true;
  return state.openAtLogin&&state.status==='enabled';
}

/** Confirm the OS preference before committing local settings; compensate on failure. */
export function withLoginItemPreference<T>(port:LoginItemPort,requested:boolean|undefined,commit:()=>T):T {
  if(requested===undefined)return commit();
  if(!port.packaged){if(requested)throw Error('开机启动请在打包客户端中开启');return commit()}
  if(!['darwin','win32'].includes(port.platform))throw Error('此系统尚不支持登录启动设置，设置未保存');
  let before:LoginItemState;
  try{before=port.read()}catch{throw Error('无法读取系统登录启动状态，设置未保存')}
  const matches=(state:LoginItemState)=>requested?effective(state,port.platform):!state.openAtLogin&&(port.platform!=='win32'||state.executableWillLaunchAtLogin!==true);
  if(matches(before))return commit();
  const restore=()=>{
    port.write(before.openAtLogin,port.platform==='win32'?before.executableWillLaunchAtLogin:undefined);
    const restored=port.read();
    if(restored.openAtLogin!==before.openAtLogin||effective(restored,port.platform)!==effective(before,port.platform))throw Error('系统登录项恢复尚未确认');
  };
  let error:unknown;
  try{
    port.write(requested,port.platform==='win32'?requested:undefined);
    const actual=port.read();
    if(!matches(actual))throw Error(actual.status==='requires-approval'?'系统尚未批准登录启动，请检查系统设置中的登录项权限；本次设置未保存':'系统未确认登录启动设置生效，本次设置未保存');
    return commit();
  }catch(cause){error=cause}
  try{restore()}catch{throw Error('设置未保存，系统登录启动状态也未能恢复确认；请检查系统登录项后再试')}
  if(error instanceof Error&&/本次设置未保存/.test(error.message))throw error;
  throw Error('设置保存失败，系统登录启动已恢复原状态；本次设置未保存');
}
