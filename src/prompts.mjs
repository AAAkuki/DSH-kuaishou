// 提示词库：把「怎么说话 / 怎么选题 / 怎么写脚本」从代码里拆出来，变成可编辑的 markdown。
//
// 设计：
//  · 两层目录：内置 `prompts/`（随包发布、升级覆盖）→ 自定义 `state/prompts/`（同名覆盖内置，永不被覆盖）；
//  · 语法只有一种：`{{变量}}`；渲染时**保留**未知变量并在 missing 里报出来，而不是静默变成空字符串
//    （空字符串会让模型以为"这段本来就没有"，比报错更难查）；
//  · 文件格式：第一行 `# 标题`，其余是正文；正文里的 `{{}}` 由调用方给值。
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './config.mjs';

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/** 解析 markdown：第一个 `# ` 行当标题。 */
export function parsePrompt(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  let title = '';
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^#\s+(.+)$/.exec(lines[i].trim());
    if (m) { title = m[1].trim(); bodyStart = i + 1; break; }
    if (lines[i].trim() && !lines[i].trim().startsWith('<!--')) break;
  }
  return { title, body: lines.slice(bodyStart).join('\n').trim() };
}

/** 找出模板里用到的变量名（去重、保持出现顺序）。 */
export function extractVars(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(VAR_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** 渲染：替换已知变量；未知的保留原样并记进 missing。 */
export function renderTemplate(text, vars = {}) {
  const missing = [];
  const out = String(text ?? '').replace(VAR_RE, (whole, name) => {
    const v = vars[name];
    if (v === undefined || v === null || v === '') { missing.push(name); return whole; }
    return String(v);
  });
  return { text: out, missing };
}

export class PromptLibrary {
  constructor({ cfg = {}, root = projectRoot() } = {}) {
    this.cfg = cfg;
    this.root = root;
    this.builtinDir = path.resolve(root, cfg.prompts?.dir ?? 'prompts');
    this.customDir = path.resolve(root, cfg.prompts?.customDir ?? 'state/prompts');
  }

  /** 内置 + 自定义合并后的 id 列表（自定义覆盖同名内置）。 */
  list() {
    const seen = new Map();
    for (const [source, dir] of [['builtin', this.builtinDir], ['custom', this.customDir]]) {
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        const id = f.slice(0, -3);
        const p = path.join(dir, f);
        const stat = fs.statSync(p);
        const { title } = parsePrompt(fs.readFileSync(p, 'utf8'));
        const prev = seen.get(id);
        // custom 覆盖 builtin
        if (prev && source === 'builtin') continue;
        seen.set(id, { id, title, source, path: p, bytes: stat.size, updatedAt: stat.mtime.toISOString() });
      }
    }
    return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id) {
    if (!/^[a-zA-Z0-9._-]+$/.test(String(id ?? ''))) throw new Error(`非法提示词 id：${id}`);
    for (const [source, dir] of [['custom', this.customDir], ['builtin', this.builtinDir]]) {
      const p = path.join(dir, `${id}.md`);
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const { title, body } = parsePrompt(raw);
        return { id, title, source, path: p, body, vars: extractVars(raw) };
      }
    }
    const known = this.list().map((x) => x.id).join(', ');
    throw new Error(`没有提示词「${id}」；现有：${known || '(空)'}`);
  }

  render(id, vars = {}) {
    const p = this.get(id);
    const { text, missing } = renderTemplate(p.body, vars);
    return { ...p, text, missing, usedVars: Object.keys(vars) };
  }

  /** 保存自定义提示词（覆盖内置）。正文必须是 markdown；标题取自首个 `# ` 行。 */
  save(id, content) {
    if (!/^[a-zA-Z0-9._-]+$/.test(String(id ?? ''))) throw new Error(`非法提示词 id：${id}`);
    const text = String(content ?? '').trim();
    if (!text) throw new Error('提示词内容不能为空');
    fs.mkdirSync(this.customDir, { recursive: true });
    const target = path.join(this.customDir, `${id}.md`);
    const header = /^#\s+/.test(text) ? '' : `# ${id}\n\n`;
    fs.writeFileSync(target, `${header}${text}\n`, 'utf8');
    return { id, path: target, bytes: Buffer.byteLength(text, 'utf8') };
  }

  /** 删除自定义覆盖，让内置版本重新生效。 */
  reset(id) {
    if (!/^[a-zA-Z0-9._-]+$/.test(String(id ?? ''))) throw new Error(`非法提示词 id：${id}`);
    const target = path.join(this.customDir, `${id}.md`);
    const existed = fs.existsSync(target);
    if (existed) fs.rmSync(target, { force: true });
    return { id, removed: existed, nowFrom: existed ? 'builtin' : 'unchanged' };
  }
}
