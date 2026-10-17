import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import type { State } from './store';
export const MAX_PORTABLE_BACKUP_BYTES=25*1024*1024;
const backupEnvelopeBytes=Buffer.byteLength(JSON.stringify({format:'linkflow-backup',version:1,salt:'A'.repeat(24),iv:'A'.repeat(16),tag:'A'.repeat(24),body:''}),'utf8');
function portableBackupBytesForClear(clear:string){return backupEnvelopeBytes+4*Math.ceil(Buffer.byteLength(clear,'utf8')/3)}
export function portableBackupFileBytes(data:unknown):number{return portableBackupBytesForClear(JSON.stringify(data))}
export function assertPortableBackupFits(data:unknown):void{if(portableBackupFileBytes(data)>MAX_PORTABLE_BACKUP_BYTES)throw new Error('数据将超过可恢复的备份容量上限，请减少导入数据后重试')}
export function encryptBackup(data:unknown,passphrase:string):Buffer{
  if(passphrase.length<12||passphrase.length>256)throw new Error('备份口令需为 12–256 个字符');
  const clear=JSON.stringify(data);if(portableBackupBytesForClear(clear)>MAX_PORTABLE_BACKUP_BYTES)throw new Error('数据将超过可恢复的备份容量上限，请减少导入数据后重试');
  const salt=randomBytes(16),iv=randomBytes(12),key=scryptSync(passphrase,salt,32);const cipher=createCipheriv('aes-256-gcm',key,iv);
  const body=Buffer.concat([cipher.update(clear,'utf8'),cipher.final()]);key.fill(0);
  return Buffer.from(JSON.stringify({format:'linkflow-backup',version:1,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),body:body.toString('base64')}));
}
export function decryptBackup(buffer:Buffer,passphrase:string):{state:State;secrets:Record<string,string>}{
  if(buffer.length>MAX_PORTABLE_BACKUP_BYTES)throw new Error('备份文件过大');
  try{const b=JSON.parse(buffer.toString('utf8'));if(b.format!=='linkflow-backup'||b.version!==1||![b.salt,b.iv,b.tag,b.body].every(x=>typeof x==='string'))throw Error();
    const salt=Buffer.from(b.salt,'base64'),iv=Buffer.from(b.iv,'base64'),tag=Buffer.from(b.tag,'base64');if(salt.length!==16||iv.length!==12||tag.length!==16)throw Error();
    const key=scryptSync(passphrase,salt,32),dec=createDecipheriv('aes-256-gcm',key,iv);dec.setAuthTag(tag);const clear=Buffer.concat([dec.update(Buffer.from(b.body,'base64')),dec.final()]);key.fill(0);return JSON.parse(clear.toString('utf8'));
  }catch{throw new Error('备份口令不正确，或文件已损坏')}
}
