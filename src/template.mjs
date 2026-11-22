// 模板模式：用户给一张版式图（背景 + 说话框），插件只往框里打字，其它什么都不改。
//
// 关键设计：
//   · 图片按 cover 铺满 1080x1920（竖屏），但模板是横图 1176x628 → 需要用"上下留白/拉伸"策略
//   · 说话框位置用**相对坐标**（占图宽/高的比例）配置，换模板只改这几个数字
//   · 字幕用"多行居中 + 自动缩字号"，保证不溢出框
//
// 本模板实测坐标（1176x628 原图）：
//   框左 ≈ 512px，右 ≈ 1122px → 相对 0.435 ~ 0.954
//   框上 ≈ 405px，下 ≈ 580px → 相对 0.645 ~ 0.924
//   框内白色区域比外框再缩一点 → 内边距约 4%
import fs from 'node:fs';

/** 这个模板的默认框坐标（相对图片宽高 0~1） */
export const TEMPLATE_BOX = {
  x0: 0.442,
  y0: 0.652,
  x1: 0.947,
  y1: 0.918,
  /** 框内再缩进的比例（避免压到框边） */
  padX: 0.018,
  padY: 0.055,
  /** 框里的文字颜色/样式 */
  color: '0x2b4a7d',
  borderWidth: 0,
  boxAlpha: 0,
  lineGap: 1.18
};

/**
 * 把一张模板图 + 若干句文字，转成逐段 drawtext 参数。
 * @param {object} opts
 *   imageW/imageH  模板原图尺寸
 *   width/height   输出画布尺寸
 *   box            框坐标（相对）
 *   lines          要打的字（一次一句/或整段）
 *   font           字体路径
 *   maxFontSize    最大字号
 */
export function planTemplateText({ imageW, imageH, width, height, box = TEMPLATE_BOX, lines = [], font, maxFontSize = 54 }) {
  // 图片按 cover 铺满画布 → 计算缩放后图片在画布上的位置
  const scale = Math.max(width / imageW, height / imageH);
  const drawnW = imageW * scale;
  const drawnH = imageH * scale;
  const offX = (width - drawnW) / 2;
  const offY = (height - drawnH) / 2;

  // 框在画布上的像素矩形
  const bx0 = offX + box.x0 * drawnW;
  const bx1 = offX + box.x1 * drawnW;
  const by0 = offY + box.y0 * drawnH;
  const by1 = offY + box.y1 * drawnH;

  const padX = (bx1 - bx0) * box.padX;
  const padY = (by1 - by0) * box.padY;
  const textW = Math.max(40, bx1 - bx0 - padX * 2);
  const textH = Math.max(20, by1 - by0 - padY * 2);

  const cx = Math.round((bx0 + bx1) / 2);
  const cy = Math.round((by0 + by1) / 2);

  return {
    scale, drawnW, drawnH, offX, offY,
    box: { x0: Math.round(bx0), y0: Math.round(by0), x1: Math.round(bx1), y1: Math.round(by1) },
    textW: Math.round(textW),
    textH: Math.round(textH),
    cx, cy,
    font,
    maxFontSize: Math.max(16, Math.min(maxFontSize, Math.floor(textH / Math.max(1, lines.length) / 1.18))),
    color: box.color,
    borderWidth: box.borderWidth,
    boxAlpha: box.boxAlpha,
    lineGap: box.lineGap ?? 1.18
  };
}

/** 检测图片：是不是"有说话框"的模板（靠宽高比粗略判断，横图多半是版式图） */
export function looksLikeTemplate(imageW, imageH) {
  return imageW / imageH > 1.2;
}
