/**
 * PnL card image renderer — Rick-style flex card for /mog.
 * 1200x675 PNG: starry dark background, coin art left, pixel-font stats right.
 */
import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { CallRecord } from './tracker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
GlobalFonts.registerFromPath(join(__dirname, '..', 'assets', 'PressStart2P.ttf'), 'PixelFont');

const W = 1200, H = 675;
const GREEN = '#9be826';
const RED = '#ff5252';
const GOLD = '#ffd75e';
const WHITE = '#f2f5ff';
const DIM = '#aab3cc';

function fmtMc(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function timeAgo(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

function stars(ctx: SKRSContext2D): void {
  for (let i = 0; i < 160; i++) {
    const x = Math.random() * W, y = Math.random() * H;
    const r = Math.random() * 1.6 + 0.3;
    ctx.globalAlpha = Math.random() * 0.7 + 0.15;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawClaw(ctx: SKRSContext2D, x: number, y: number, scale: number, color: string): void {
  // Same claw as the dashboard logo, scaled from a 24x24 viewbox
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  const seg = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  };
  seg(5, 2, 9, 14); seg(9, 2, 12, 14); seg(13, 2, 15, 14); seg(17, 4, 18, 12);
  ctx.beginPath(); ctx.moveTo(3, 18); ctx.quadraticCurveTo(12, 12, 21, 18); ctx.stroke();
  ctx.restore();
}

export interface CardData {
  rec: CallRecord;
  peakMult: number;
  peakMC: number;
  imageUrl?: string;
}

export async function renderPnlCard(data: CardData): Promise<Buffer> {
  const { rec, peakMult, peakMC } = data;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ── Background ──
  ctx.fillStyle = '#04050b';
  ctx.fillRect(0, 0, W, H);
  const grad = ctx.createRadialGradient(W * 0.28, H * 0.55, 60, W * 0.28, H * 0.55, 620);
  grad.addColorStop(0, 'rgba(30,40,80,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  stars(ctx);

  // Rounded border
  ctx.strokeStyle = 'rgba(150,170,220,0.25)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(6, 6, W - 12, H - 12, 28);
  ctx.stroke();

  // ── Brand (top-left) ──
  drawClaw(ctx, 36, 30, 2.2, GOLD);
  ctx.font = '22px PixelFont';
  ctx.fillStyle = GOLD;
  ctx.textAlign = 'left';
  ctx.fillText('PumpClaw', 104, 68);

  // ── Coin image (left, circular w/ glow) ──
  const cx = 300, cy = 400, cr = 190;
  if (data.imageUrl) {
    try {
      const res = await fetch(data.imageUrl, { signal: AbortSignal.timeout(3000) });
      const img = await loadImage(Buffer.from(await res.arrayBuffer()));
      ctx.save();
      ctx.shadowColor = peakMult >= 1 ? GREEN : RED;
      ctx.shadowBlur = 60;
      ctx.beginPath();
      ctx.arc(cx, cy, cr, 0, Math.PI * 2);
      ctx.fillStyle = '#0a0e17';
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, cr, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, cx - cr, cy - cr, cr * 2, cr * 2);
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(cx, cy, cr, 0, Math.PI * 2);
      ctx.stroke();
    } catch { drawClaw(ctx, cx - 130, cy - 140, 11, 'rgba(255,215,94,0.5)'); }
  } else {
    drawClaw(ctx, cx - 130, cy - 140, 11, 'rgba(255,215,94,0.5)');
  }

  // ── Right column (right-aligned) ──
  const rx = W - 64;
  ctx.textAlign = 'right';

  // $SYMBOL @ entryMC
  const sym = `$${rec.symbol}`.slice(0, 12).toUpperCase();
  ctx.font = '52px PixelFont';
  ctx.fillStyle = WHITE;
  ctx.fillText(`${sym} @ ${fmtMc(rec.entryMC)}`, rx, 150);

  // time ago
  ctx.font = '26px PixelFont';
  ctx.fillStyle = DIM;
  ctx.fillText(timeAgo(rec.entryTime), rx, 205);

  // caller
  ctx.font = '30px PixelFont';
  ctx.fillStyle = GOLD;
  ctx.fillText('PumpClaw', rx, 268);

  // Big gain — % under 10X, X-form at 10X+
  const up = peakMult >= 1;
  const gainStr = peakMult >= 10
    ? `${peakMult.toFixed(peakMult >= 100 ? 0 : 1)}X`
    : `${up ? '+' : ''}${((peakMult - 1) * 100).toFixed(0)}%`;
  ctx.font = '108px PixelFont';
  ctx.fillStyle = up ? GREEN : RED;
  ctx.shadowColor = up ? GREEN : RED;
  ctx.shadowBlur = 34;
  ctx.fillText(gainStr, rx, 440);
  ctx.shadowBlur = 0;

  // Reached peak MC
  ctx.font = '30px PixelFont';
  ctx.fillStyle = WHITE;
  ctx.fillText(`Reached ${fmtMc(peakMC)}`, rx, 560);

  // footer: mint (small, dim, left)
  ctx.textAlign = 'left';
  ctx.font = '13px PixelFont';
  ctx.fillStyle = 'rgba(170,179,204,0.45)';
  ctx.fillText(rec.mint, 36, H - 28);

  return canvas.toBuffer('image/png');
}
