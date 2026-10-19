export interface LoginItemState {openAtLogin:boolean;status?:string;executableWillLaunchAtLogin?:boolean}
export interface LoginItemPort {
  packaged:boolean;
  platform:string;
  read:()=>LoginItemState;
  write:(openAtLogin:boolean,enabled?:boolean)=>void;
}

export type LoginItemErrorCode='packaged_required'|'unsupported_platform'|'read_failed'|'approval_required'|'preference_unconfirmed'|'restore_unconfirmed'|'restore_failed'|'save_failed';
export class LoginItemError extends Error{
  constructor(readonly code:LoginItemErrorCode,message:string,options?:ErrorOptions){super(message,options);this.name='LoginItemError'}
}

/** Electron 44 parses the Windows lookup path as a command line (electron/electron#54364). */
export function loginItemReadOptions(platform:string,executablePath:string):{path?:string;args?:string[]} {
  // Its formatter strips these quotes for openAtLogin, while its legacy launch-item
  // lookup needs them to preserve spaces. The upstream fix accepts quoted paths too.
  return platform==='win32'?{path:`"${executablePath}"`,args:[]}:{};
}

function effective(state:LoginItemState,platform:string):boolean {
  if(platform==='win32')return state.openAtLogin&&state.executableWillLaunchAtLogin===true;
  return state.openAtLogin&&state.status==='enabled';
}

/** Confirm the OS preference before committing local settings; compensate on failure. */
export function withLoginItemPreference<T>(port:LoginItemPort,requested:boolean|undefined,commit:()=>T):T {
  if(requested===undefined)return commit();
  if(!port.packaged){if(requested)throw new LoginItemError('packaged_required','开机启动请在正式版外链助手中开启');return commit()}
  if(!['darwin','win32'].includes(port.platform))throw new LoginItemError('unsupported_platform','此系统尚不支持登录启动设置，设置未保存');
  let before:LoginItemState;
  try{before=port.read()}catch(error){throw new LoginItemError('read_failed','无法读取系统登录启动状态，设置未保存',{cause:error})}
  const matches=(state:LoginItemState)=>requested?effective(state,port.platform):!state.openAtLogin&&(port.platform!=='win32'||state.executableWillLaunchAtLogin!==true);
  if(matches(before))return commit();
  const restore=()=>{
    port.write(before.openAtLogin,port.platform==='win32'?before.executableWillLaunchAtLogin:undefined);
    const restored=port.read();
    if(restored.openAtLogin!==before.openAtLogin||effective(restored,port.platform)!==effective(before,port.platform))throw new LoginItemError('restore_unconfirmed','系统登录项恢复尚未确认');
  };
  let error:unknown;
  try{
    port.write(requested,port.platform==='win32'?requested:undefined);
    const actual=port.read();
    if(!matches(actual))throw new LoginItemError(actual.status==='requires-approval'?'approval_required':'preference_unconfirmed',actual.status==='requires-approval'?'系统尚未批准登录启动，请检查系统设置中的登录项权限；本次设置未保存':'系统未确认登录启动设置生效，本次设置未保存');
    return commit();
  }catch(cause){error=cause}
  try{restore()}catch(cause){throw new LoginItemError('restore_failed','设置未保存，系统登录启动状态也未能恢复确认；请检查系统登录项后再试',{cause})}
  if(error instanceof LoginItemError&&['approval_required','preference_unconfirmed'].includes(error.code))throw error;
  throw new LoginItemError('save_failed','设置保存失败，系统登录启动已恢复原状态；本次设置未保存',{cause:error});
}
