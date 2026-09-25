// Explicit operations tool; never grants access to an unpublished release.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [action,environment,id,daysText,reason]=process.argv.slice(2);
if(!['list','grant','revoke'].includes(action)||!['prod','staging'].includes(environment))throw Error('Usage: release-asset-lease.mjs list|grant|revoke prod|staging [releaseId] [days] [reason]');
const quote=s=>"'"+s.replaceAll("'","''")+"'";
let sql="select l.*,r.status,r.version from release_asset_leases l join releases r on r.id=l.release_id order by l.expires_at desc";
if(action!=='list'){
 if(!id||!/^[a-zA-Z0-9_-]+$/.test(id))throw Error('Invalid release ID');
 if(action==='revoke')sql=`delete from release_asset_leases where release_id=${quote(id)}`;
 else{
  const days=Number(daysText);if(!Number.isInteger(days)||days<1||days>90||!reason?.trim())throw Error('Grant requires 1–90 days and a reason');
  const now=new Date().toISOString(),expires=new Date(Date.now()+days*86400000).toISOString();
  sql=`insert into release_asset_leases(release_id,expires_at,reason,updated_at) select id,${quote(expires)},${quote(reason)},${quote(now)} from releases where id=${quote(id)} and status in ('active','superseded') and artifact_key is not null on conflict(release_id) do update set expires_at=excluded.expires_at,reason=excluded.reason,updated_at=excluded.updated_at; select * from release_asset_leases where release_id=${quote(id)}`;
 }
}
const result=spawnSync(path.join(root,'node_modules/.bin/wrangler'),['d1','execute',environment==='prod'?'shumap-v2':'shumap-v2-staging',...(environment==='staging'?['--env','staging']:[]),'--remote','--command',sql,'--json'],{cwd:root,env:process.env,stdio:'inherit'});process.exit(result.status||0);
