// 一键签到命令行：复用本项目各站点的登录凭证（auth.<site>.json），
// 不读桌面端文件、不依赖服务是否启动。
//
//   node checkin.mjs                    查全部站点签到状态
//   node checkin.mjs --claim            全部站点一键领取今日签到
//   node checkin.mjs --growth           一键签到 + 成长中心全量（旅行/任务/补登/兑换/抽奖/盲盒）
//   node checkin.mjs --site cn-cli      只看/只领某一个站点
//   node checkin.mjs --claim --site cn-cli
import { loadConfig, siteKeys } from './src/config.mjs';
import { checkinStatusAll, checkinAll, runGrowthAll } from './src/checkin.mjs';
import { recordCheckinRun } from './src/auto-checkin.mjs';
import { log } from './src/log.mjs';

const cfg = loadConfig();
const args = process.argv.slice(2);
const sitesArg = args.indexOf('--site');
const only = sitesArg >= 0 ? args[sitesArg + 1] : null;
const sites = only ? [only] : siteKeys(cfg);
const wantClaim = args.includes('--claim');
const wantGrowth = args.includes('--growth');

if (only && !cfg.sites?.[only]) {
  console.error(`未知站点：${only}\n可用站点：${siteKeys(cfg).join(', ')}`);
  process.exit(1);
}

function line(r) {
  if (r.result === 'CLAIMED') return `✅ [${r.site}] ${r.report}`;
  if (r.result === 'ALREADY') return `☑️ [${r.site}] ${r.report}`;
  if (r.result === 'INACTIVE') return `⏸️ [${r.site}] ${r.report}`;
  if (r.result === 'NO_SESSION') return `🔑 [${r.site}] 未登录：${r.report} → node login.mjs --site ${r.site}`;
  return `❌ [${r.site}] ${r.report}`;
}

try {
  if (wantGrowth) {
    const r = await runGrowthAll(cfg, sites, { includeCheckin: true });
    for (const x of r.results) {
      if (x.ok) console.log(`🌱 [${x.site}] ${x.report}`);
      else console.log(`❌ [${x.site}] ${x.report}`);
    }
    recordCheckinRun({ claimed: r.results.reduce((n, x) => n + (x.creditsGained || 0), 0), count: r.count, results: r.results }, { trigger: 'cli-growth' });
  } else if (wantClaim) {
    const r = await checkinAll(cfg, sites);
    for (const x of r.results) console.log(line(x));
    recordCheckinRun(r, { trigger: 'cli' });
    log(`一键签到：${r.claimed}/${r.count} 个站点领取成功`);
  } else {
    const r = await checkinStatusAll(cfg, sites);
    for (const x of r.results) {
      if (!x.ok) {
        console.log(`❌ [${x.site}] 状态查询失败：${x.error}`);
        continue;
      }
      const state = x.active === false ? '活动未开启' : (x.todayCheckedIn ? '今日已签' : '今日未签');
      console.log(`■ [${x.site}] ${state}${x.streakDays != null ? `（连续 ${x.streakDays} 天` : ''}${x.totalCredits != null ? `，累计 ${x.totalCredits}` : ''}${x.streakDays != null ? '）' : ''}`);
    }
    console.log('\n领取今日签到：node checkin.mjs --claim');
  }
} catch (e) {
  console.error('签到失败：' + e.message);
  process.exit(1);
}
