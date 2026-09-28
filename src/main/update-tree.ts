import {createHash} from 'node:crypto';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {updateRawFs} from './update-files';

const rawFs=updateRawFs(),files=rawFs.promises;
const maximumEntries=100_000,maximumBytes=2*1024*1024*1024;

function encode(value:string|number):Buffer{const data=Buffer.from(String(value),'utf8'),length=Buffer.allocUnsafe(4);length.writeUInt32BE(data.length);return Buffer.concat([length,data])}
function inside(root:string,target:string):boolean{const path=relative(resolve(root),resolve(target));return path===''||path!==''&&path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path)}

/** Canonical digest of bundle paths, types, file bytes, executable bits and link targets. */
export async function hashUpdateTree(root:string):Promise<string>{
  const rootInfo=await files.lstat(root);if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw Error('更新应用树根目录无效');const hash=createHash('sha256');hash.update('LINKFLOW-UPDATE-TREE-1\0');let entries=0,totalBytes=0;
  async function walk(directory:string,prefix:string):Promise<void>{
    const children=(await files.readdir(directory,{withFileTypes:true})).sort((a,b)=>Buffer.from(a.name).compare(Buffer.from(b.name)));
    for(const child of children){
      if(++entries>maximumEntries)throw Error('更新应用文件数过多');const absolute=resolve(directory,child.name),path=prefix?`${prefix}/${child.name}`:child.name,info=await files.lstat(absolute);hash.update(encode(path));
      if(info.isSymbolicLink()){
        const target=await files.readlink(absolute),resolvedTarget=resolve(dirname(absolute),target);if(!inside(root,resolvedTarget))throw Error('更新应用含有越界符号链接');hash.update(encode('L'));hash.update(encode(target));continue;
      }
      if(info.isDirectory()){hash.update(encode('D'));hash.update(encode(info.mode&0o111));await walk(absolute,path);continue}
      if(!info.isFile())throw Error('更新应用含有不支持的文件类型');totalBytes+=info.size;if(totalBytes>maximumBytes)throw Error('更新应用解压后过大');hash.update(encode('F'));hash.update(encode(info.mode&0o111));hash.update(encode(info.size));for await(const chunk of rawFs.createReadStream(absolute))hash.update(chunk as Buffer);
    }
  }
  await walk(resolve(root),'');return hash.digest('hex');
}
