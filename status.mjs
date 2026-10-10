// 查看各站点登录状态与剩余积分（含积分组成与各部分到期时间）：
//   node status.mjs [--site intl-cli]
import { loadConfig } from './src/config.mjs';
import { humanizeUntil } from './src/credit.mjs';

const cfg = loadConfig();
const args = process.argv.slice(2);
const siteIdx = args.indexOf('--site');
const only = siteIdx >= 0 ? args[siteIdx + 1] : null;
const base = `http://${cfg.host}:${cfg.port}`;

try {
  const qs = only ? `?site=${encodeURIComponent(only)}` : '';
  const res = await fetch(`${base}/status${qs}`, { headers: { Authorization: 'Bearer ' + cfg.apiKey } });
  const j = await res.json();
  console.log(`服务：${base}  （HTTP ${res.status}）  默认站点：${j.default_site}`);
  console.log('');
  for (const s of j.sites || []) {
    console.log(`■ ${s.account_label || s.nickname || s.site}  （槽位 ${s.site}）`);
    console.log(`    账号：${s.nickname || '—'}${s.uid ? `   uid=${s.uid}` : ''}`);
    console.log(`    上游：${s.apiBase}`);
    if (s.enterprise_id) console.log(`    企业 ID：${s.enterprise_id}`);
    console.log(`    登录：${s.logged_in ? '已登录' : '未登录 → node login.mjs --site ' + s.site}`);
    if (s.token_expires_at) console.log(`    token 过期：${new Date(s.token_expires_at).toLocaleString()}`);

    const c = s.credit;
    if (c?.remain !== undefined) {
      console.log(`    剩余积分：${c.remain} ${c.unit || 'credits'}  （共 ${c.size}，已用 ${c.used}，${c.packageCount} 个套餐包）`);
      // 积分组成：每个套餐名一行，带剩余量与最近到期时间
      if (c.parts?.length) {
        console.log('    积分组成：');
        for (const p of c.parts) {
          const pct = c.remain > 0 ? ((p.remain / c.remain) * 100).toFixed(0) : '0';
          const exp = p.latestExpiry
            ? `最近到期 ${String(p.latestExpiry).slice(0, 10)}（${humanizeUntil(p.latestExpiry)}）`
            : '无到期时间';
          console.log(`      · ${p.package}  [${p.typeLabel}]  ${p.remain} / ${p.size}  (${pct}%)  ×${p.count}  ${exp}`);
        }
      }
      if (c.nextExpiry) {
        console.log(`    ⚠ 最近将过期：${c.nextExpiry.package}  剩余 ${c.nextExpiry.remain}，${String(c.nextExpiry.expiry).slice(0, 10)} 到期（还有 ${c.nextExpiry.daysLeft} 天）`);
      }
      if (c.lastExpiry) console.log(`    最后失效时间：${String(c.lastExpiry).slice(0, 10)}（${humanizeUntil(c.lastExpiry)}）`);
      if (c.inactiveCount) console.log(`    （另有 ${c.inactiveCount} 个已失效/已耗尽的包未计入）`);
    } else if (c?.error) {
      console.log(`    额度查询：${c.error}`);
    }
    console.log('');
  }
  console.log('查看 Prometheus 指标： curl -H "Authorization: Bearer <apiKey>" ' + base + '/metrics');
} catch (e) {
  console.log('服务未启动或端口不通：' + e.message);
  console.log('请先运行： node server.mjs   （或双击 start.cmd）');
}