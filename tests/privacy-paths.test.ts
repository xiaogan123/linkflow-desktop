import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {hasPersonalMacPath}=createRequire(import.meta.url)('../scripts/lib/privacy-paths.mjs');
const home=(name:string)=>'/'+'Users/'+name+'/';
test('official Blogger API routes are not private home paths',()=>{
 for(const route of ["'/users/self/blogs'",'`/users/self/blogs/${id}`',"'/blogger/v3/users/self/blogs'",'https://www.googleapis.com/blogger/v3/users/self/blogs/100'])assert.equal(hasPersonalMacPath(route),false);
});
test('Blogger route exclusion preserves home path and near-match detection',()=>{
 for(const value of [home('alice')+'file',home('self')+'blogs','/users/'+'alice/file','/users/'+'self/notblogs','/users/'+'self/blogs-private',"'/users/self/blogs' "+home('alice')+'file','/users/self/blogs'+home('alice')+'file'])assert.equal(hasPersonalMacPath(value),true,value);
});
