import { safeStorage } from 'electron';
import type { SecretStore } from '../shared/types';
import type { Store } from './store';

export class Vault implements SecretStore {
  constructor(private store:Store){}
  ready=false;
  available(){return this.ready=safeStorage.isEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text')}
  async get(key:string){const cipher=this.store.getCipher(key);if(!cipher)return undefined;if(!this.available())throw new Error('系统钥匙串不可用，请解锁后重试');return safeStorage.decryptString(Buffer.from(cipher,'base64'))}
  async set(key:string,value:string){if(!this.available())throw new Error('系统钥匙串不可用，不能保存密码');this.store.setCipher(key,safeStorage.encryptString(value).toString('base64'))}
  async delete(key:string){this.store.deleteCipher(key)}
  async exportSecrets(){const out:Record<string,string>={};for(const key of Object.keys(this.store.allCiphers()))out[key]=(await this.get(key))!;return out}
  encryptSecrets(secrets:Record<string,string>){if(!this.available())throw new Error('系统钥匙串不可用');return Object.fromEntries(Object.entries(secrets).map(([k,v])=>[k,safeStorage.encryptString(v).toString('base64')]))}
}
export { encryptBackup, decryptBackup } from './backup';
