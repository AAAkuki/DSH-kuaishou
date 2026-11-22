// 直播里「回弹幕」的短句生成（写进右下角那个思考气泡）。
//
// 约束：气泡不大，一句话 ≤ 14 字；语气按人设（懒、毒舌、偶尔甜），
// 不装真人、不解释自己是 AI，被问到就大大方方承认是 AI 在玩。

const RULES = [
  { re: /(是|不是).{0,3}ai|ai吧|机器人|真人吗|谁在玩/i, pool: [
    'AI 在玩，手不抖',
    '片子是 AI 做的，游戏也是',
    '我不是人，但手是真的稳'
  ] },
  // token/钱要排在"多少"这类问句前面，否则会被问句规则抢走
  { re: /(token|余额|花多少|几块|多少钱)/i, pool: [
    '余额在右上角，自己看',
    '省着点花',
    '余额得自己看'
  ] },
  { re: /(怎么|为什么|为啥|多少|几个|什么)/, pool: [
    '这个得算一下',
    '啧，问得好',
    '说白了就是算距离'
  ] },
  { re: /(厉害|牛|强|稳|太强|高手|牛逼)/, pool: [
    '诶嘿',
    '基本操作，别夸',
    '稳是应该的'
  ] },
  { re: /(跳|快|再来|继续|冲|上啊|别停)/, pool: [
    '别催，圆滚滚来了',
    '这就跳',
    '排队，一次一个'
  ] },
  { re: /(加油|可怜|惨|掉下去了|摔)/, pool: [
    '掉了就再来一次',
    '别可怜我，我懒得可怜'
  ] },
  { re: /(可爱|抱抱|贴贴|喜欢你|老婆)/, pool: [
    '懒得动，贴一下下',
    '啧，先跳完这局'
  ] },
  { re: /(token|余额|花多少|几块|多少钱)/i, pool: [
    '余额在右上角，自己看',
    '省着点花',
    '余额得自己看'
  ] }
];

const FALLBACK = ['嗯，看到了', '行吧', '这个我记下了', '继续跳', '哦？'];

// 轮换计数：同一句弹幕连着来，也不能永远回同一句
let turn = 0;

/** 根据一条弹幕挑一句回（同一条内容会轮着换句子，直播才不会念起来一模一样） */
export function pickLiveReply(text = '') {
  const t = String(text || '');
  const seq = turn++;
  for (const rule of RULES) {
    if (rule.re.test(t)) {
      return rule.pool[(hash(t) + seq) % rule.pool.length];
    }
  }
  return FALLBACK[(hash(t) + seq) % FALLBACK.length];
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** 气泡放不下就截断（保留可读性） */
export function fitBubble(text = '', max = 14) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
