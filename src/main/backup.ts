import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import type { State } from './store';
export function encryptBackup(data:unknown,passphrase:string):Buffer{
  if(passphrase.length<12||passphrase.length>256)throw new Error('备份口令需为 12–256 个字符');
  const salt=randomBytes(16),iv=randomBytes(12),key=scryptSync(passphrase,salt,32);const cipher=createCipheriv('aes-256-gcm',key,iv);
  const body=Buffer.concat([cipher.update(JSON.stringify(data),'utf8'),cipher.final()]);key.fill(0);
  return Buffer.from(JSON.stringify({format:'linkflow-backup',version:1,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),body:body.toString('base64')}));
}
export function decryptBackup(buffer:Buffer,passphrase:string):{state:State;secrets:Record<string,string>}{
  if(buffer.length>25*1024*1024)throw new Error('备份文件过大');
  try{const b=JSON.parse(buffer.toString('utf8'));if(b.format!=='linkflow-backup'||b.version!==1||![b.salt,b.iv,b.tag,b.body].every(x=>typeof x==='string'))throw Error();
    const salt=Buffer.from(b.salt,'base64'),iv=Buffer.from(b.iv,'base64'),tag=Buffer.from(b.tag,'base64');if(salt.length!==16||iv.length!==12||tag.length!==16)throw Error();
    const key=scryptSync(passphrase,salt,32),dec=createDecipheriv('aes-256-gcm',key,iv);dec.setAuthTag(tag);const clear=Buffer.concat([dec.update(Buffer.from(b.body,'base64')),dec.final()]);key.fill(0);return JSON.parse(clear.toString('utf8'));
  }catch{throw new Error('备份口令不正确，或文件已损坏')}
}
