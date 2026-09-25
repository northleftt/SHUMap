// Capture a verifiable deployed web bundle, then deploy new Worker code with those exact bytes.
// Never copies production content/database into staging. No auth credentials in snapshots.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [mode,environment,directory]=process.argv.slice(2);
if(!['capture','deploy','verify'].includes(mode)||!['prod','staging'].includes(environment)||!directory)throw Error('Usage: node scripts/deploy-backend-preserve-web.mjs capture|deploy|verify prod|staging <snapshot-directory>');
const base=environment==='prod'?'https://map.shutf.com':'https://staging.map.shutf.com';
const dir=path.resolve(directory),assets=path.join(dir,'assets');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function diskPath(urlPath){const decoded=decodeURIComponent(urlPath);if(!decoded.startsWith('/')||decoded.includes('..')||decoded.includes('\\'))throw Error('Unsafe asset path');return path.join(assets,decoded);}
async function fetchBytes(urlPath){
 let url=base+urlPath;
 for(let hop=0;hop<5;hop++){
  const response=await fetch(url,{redirect:'manual',headers:{'cache-control':'no-cache'}});
  if([301,302,303,307,308].includes(response.status)){const next=new URL(response.headers.get('location'),url);if(next.origin!==base)throw Error(`External redirect at ${urlPath}`);url=next.href;continue;}
  if(!response.ok)throw Error(`${urlPath}: HTTP ${response.status}`);
  return {bytes:Buffer.from(await response.arrayBuffer()),type:response.headers.get('content-type')||''};
 }
 throw Error(`Redirect loop at ${urlPath}`);
}
async function publicPaths(dir,relative=''){const entries=await fs.readdir(path.join(dir,relative),{withFileTypes:true});const result=[];for(const entry of entries){const name=path.posix.join(relative,entry.name);if(entry.isDirectory())result.push(...await publicPaths(dir,name));else if(entry.isFile())result.push('/'+name);}return result;}
function references(bytes,type,current){if(!/javascript|css|html/.test(type))return [];const text=bytes.toString();const refs=new Set();for(const match of text.matchAll(/(?:["'(])((?:\/assets\/|\.\.?\/)[^"'()\s<>]+)["')]/g)){const u=new URL(match[1],base+current);if(u.origin===base&&u.pathname.startsWith('/assets/'))refs.add(u.pathname);}return [...refs];}
if(mode==='capture'){
 await fs.mkdir(dir,{recursive:true});if(await fs.stat(path.join(dir,'snapshot.json')).catch(()=>null))throw Error('Snapshot already exists; use a new directory');
 const pending=['/',...await publicPaths(path.join(root,'public'))],files={};
 while(pending.length){const route=pending.shift();const key=route==='/'?'/index.html':route;if(files[key])continue;const {bytes,type}=await fetchBytes(route);if(route!=='/'&&type.includes('text/html')&&!route.endsWith('.html'))throw Error(`SPA fallback at ${route}`);const output=diskPath(key);await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,bytes);files[key]={sha256:digest(bytes),bytes:bytes.length,contentType:type};pending.push(...references(bytes,type,route));}
 const current=await fetchBytes('/');if(digest(current.bytes)!==files['/index.html'].sha256)throw Error('Remote deployment changed during capture');
 if(!Object.keys(files).some(p=>p.startsWith('/assets/')&&p.endsWith('.js')))throw Error('No app bundle discovered');
 await fs.writeFile(path.join(dir,'snapshot.json'),JSON.stringify({environment,base,capturedAt:new Date().toISOString(),files},null,2));console.log(`Captured ${Object.keys(files).length} verified assets from ${base}`);
}else{
 const snapshot=JSON.parse(await fs.readFile(path.join(dir,'snapshot.json'),'utf8'));if(snapshot.environment!==environment||snapshot.base!==base)throw Error('Snapshot environment mismatch');
 for(const [route,expected] of Object.entries(snapshot.files)){const bytes=await fs.readFile(diskPath(route));if(digest(bytes)!==expected.sha256||bytes.length!==expected.bytes)throw Error(`Local snapshot changed: ${route}`);}
 if(mode==='verify'){
  for(const [route,expected] of Object.entries(snapshot.files)){const current=await fetchBytes(route==='/index.html'?'/':route);if(digest(current.bytes)!==expected.sha256)throw Error(`Remote bytes differ: ${route}`);}console.log(`PASS: ${Object.keys(snapshot.files).length} remote web assets unchanged`);
 }else{
  for(const [route,expected] of Object.entries(snapshot.files)){const current=await fetchBytes(route==='/index.html'?'/':route);if(digest(current.bytes)!==expected.sha256)throw Error(`Remote web changed since capture: ${route}; recapture before deploy`);}
  const args=['deploy',...(environment==='staging'?['--env','staging']:[]),'--assets',assets,'--message',`backend-only; preserved web ${snapshot.files['/index.html'].sha256.slice(0,12)}`];
  const result=spawnSync(path.join(root,'node_modules/.bin/wrangler'),args,{cwd:root,env:process.env,stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);
 }
}
