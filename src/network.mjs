import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const exec = promisify(execFile);
export const fingerprint = o => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0,16);
let cached = null, pending = null;
export async function networkSnapshot() {
  if (cached && Date.now() - Date.parse(cached.sampled_at) < 15_000) return cached;
  if (pending) return pending;
  pending = (async () => {
    let value;
    try {
      const options = {timeout:5000, maxBuffer:128_000, windowsHide:true};
      if (process.platform === 'win32') {
        const commands=readFileSync(new URL('./network-windows.ps1',import.meta.url),'utf8');
        const {stdout} = await exec('powershell.exe', ['-NoProfile','-NonInteractive','-Command',commands], options);
        value = JSON.parse(stdout.replace(/^\uFEFF/,''));
      } else if (process.platform === 'darwin') {
        const [routes, proxy, dns] = await Promise.all([
          exec('/sbin/route',['-n','get','default'],options),
          exec('/usr/sbin/scutil',['--proxy'],options),
          exec('/usr/sbin/scutil',['--dns'],options)
        ]);
        const iface = routes.stdout.match(/interface:\s*(\S+)/)?.[1] || null;
        value = {status:'observed',platform:'darwin',default_interface:iface,route_id:fingerprint(routes.stdout),system_proxy_id:fingerprint(proxy.stdout),dns_id:fingerprint(dns.stdout),physical_medium:'NOT_VERIFIED',effective_egress:'NOT_OBSERVED'};
      } else value = {status:'unsupported_platform',platform:process.platform,effective_egress:'NOT_OBSERVED'};
    } catch (error) { value = {status:'unavailable',platform:process.platform,error_code:String(error.code||'snapshot_failed'),effective_egress:'NOT_OBSERVED'}; }
    cached = {...value,network_id:fingerprint(value),sampled_at:new Date().toISOString()};
    return cached;
  })().finally(()=>{pending=null;});
  return pending;
}
