// 测试辅助：拿到一份可改的默认配置副本（避免用例之间互相污染）。
import { DEFAULTS } from '../src/config.mjs';

export { DEFAULTS };

export function deepMergeSafe(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object'
      ? deepMergeSafe(base[k], v)
      : v;
  }
  return out;
}

export function freshConfig(override = {}) {
  return deepMergeSafe(structuredClone(DEFAULTS), override);
}
