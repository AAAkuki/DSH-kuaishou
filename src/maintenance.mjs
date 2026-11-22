import fs from 'node:fs';
import path from 'node:path';

// 清理 state/video 里的中间文件（norm- / base- / join- / preview- / tpl- / diag-*），
// 只保留成品（auto-*、用户自己指定的）和最近的 N 个 mp4。
export function pruneVideoJunk({ root = process.cwd(), keepRecent = 5, dryRun = false } = {}) {
  const dir = path.join(root, 'state', 'video');
  if (!fs.existsSync(dir)) return { removed: 0, freedMB: 0, kept: [] };

  const files = fs.readdirSync(dir).filter((f) => {
    const p = path.join(dir, f);
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });

  const isJunk = (f) =>
    /^(norm|base|join|joined|preview|tpl|diag|st|sub|dbg)-/i.test(f) ||
    /\.txt$|\.json$/i.test(f) ||
    /-\d{13}-[a-z0-9]{4}\.(wav|png)$/i.test(f);   // 带随机后缀的临时 wav/png

  const junk = files.filter(isJunk);
  const recentMp4 = files
    .filter((f) => /\.mp4$/i.test(f) && !isJunk(f))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);

  const keep = new Set(recentMp4.slice(0, keepRecent).map((x) => x.f));
  let removed = 0;
  let bytes = 0;
  for (const f of junk) {
    // 最近成品不删（万一被误判）
    if (keep.has(f)) continue;
    const p = path.join(dir, f);
    try {
      const sz = fs.statSync(p).size;
      if (!dryRun) fs.rmSync(p, { force: true });
      removed++;
      bytes += sz;
    } catch {}
  }
  return { removed, freedMB: Number((bytes / 1024 / 1024).toFixed(1)), kept: [...keep] };
}
