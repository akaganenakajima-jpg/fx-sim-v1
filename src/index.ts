// エントリーポイント
// scheduled: 1分ごとにレート取得→指標取得→TP/SL確認→フィルタ→Gemini判定→記録
// fetch:     GET / → ダッシュボード、GET /api/status → JSON、GET /style.css・/app.js → 静的ファイル

import { type Env } from './env';
import { withRunId } from './db';
import { getDashboardHtml } from './dashboard';
import { getApiStatus, getApiParams } from './api';
import { CSS } from './style.css';
import { JS } from './app.js';
import { decideRotation, getPendingRotations } from './rotation';
import { runCore } from './workflows/core-workflow';
import { runAnalysis } from './workflows/analysis-workflow';
import { runDailyScoring, runWeeklyScreening, runDailyAll, generateAiReport } from './workflows/daily-workflow';

/** 全レスポンスにセキュリティヘッダーを付与 */
function withSec(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('X-Frame-Options', 'DENY');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  h.set('X-XSS-Protection', '1; mode=block');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  h.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // HTTP → HTTPS リダイレクト（平文接続を拒否）
    if (url.protocol === 'http:') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    // GET専用ルートへの非GETメソッドを早期リジェクト（PUT/DELETE/PATCH → 405）
    const GET_ONLY_ROUTES = ['/api/status', '/api/params', '/api/scores', '/api/screener', '/api/ai-report', '/api/rotation/pending', '/api/rotation/history'];
    if (GET_ONLY_ROUTES.includes(url.pathname) && request.method !== 'GET' && request.method !== 'HEAD') {
      return withSec(new Response('Method Not Allowed', { status: 405 }));
    }
    const res = await (async (): Promise<Response> => {
    switch (url.pathname) {
      case '/':
        return new Response(getDashboardHtml(), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store' },
        });
      case '/style.css':
        return new Response(CSS, {
          headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' },
        });
      case '/app.js':
        return new Response(JS, {
          headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' },
        });
      case '/manifest.json':
        return new Response(JSON.stringify({
          name: 'FX Sim',
          short_name: 'FX Sim',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          background_color: '#000000',
          theme_color: '#000000',
          description: 'FX仮想トレードシミュレーター — Gemini AIによるリアルタイム売買判断',
          icons: [
            { src: '/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' },
            { src: '/icon-512.svg', sizes: '512x512', type: 'image/svg+xml' },
          ],
        }), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
        });
      case '/icon-192.svg':
      case '/icon-192.png':
      case '/icon-512.svg':
      case '/icon-512.png': {
        const size = url.pathname.includes('512') ? 512 : 192;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${Math.round(size * 0.2)}" fill="#1C1C1E"/><text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle" fill="#30D158" font-family="system-ui" font-size="${Math.round(size * 0.35)}" font-weight="800">FX</text></svg>`;
        return new Response(svg, {
          headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
        });
      }
      case '/robots.txt':
        return new Response('User-agent: *\nDisallow: /api/\n', {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
        });
      case '/api/status':
        try {
          const status = await getApiStatus(env.DB, {
            TRADING_ENABLED: env.TRADING_ENABLED, OANDA_LIVE: env.OANDA_LIVE,
            RISK_MAX_DAILY_LOSS: env.RISK_MAX_DAILY_LOSS, RISK_MAX_LIVE_POSITIONS: env.RISK_MAX_LIVE_POSITIONS,
            RISK_MAX_LOT_SIZE: env.RISK_MAX_LOT_SIZE, RISK_ANOMALY_THRESHOLD: env.RISK_ANOMALY_THRESHOLD,
          });
          // unpaired surrogateを除去して不正JSONを防止
          const json = JSON.stringify(status).replace(/[\uD800-\uDFFF]/g, '');
          return new Response(json, {
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      case '/api/params':
        try {
          const paramsData = await getApiParams(env.DB);
          return new Response(JSON.stringify(paramsData), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
          });
        }
      case '/api/rotation/pending':
        try {
          const pending = await getPendingRotations(env.DB);
          return new Response(JSON.stringify({ rotations: pending }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (e) {
          return new Response(JSON.stringify({ success: false, message: String(e) }), {
            headers: { 'Content-Type': 'application/json' },
            status: 500,
          });
        }
      case '/api/rotation/history':
        try {
          const histRows = await env.DB.prepare(
            'SELECT id, proposed_at, in_symbol, out_symbol, status, in_result_pnl, out_result_pnl FROM rotation_log ORDER BY proposed_at DESC LIMIT 20'
          ).all();
          return new Response(JSON.stringify({ rotations: histRows.results ?? [] }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (e) {
          return new Response(JSON.stringify({ success: false, message: String(e) }), {
            headers: { 'Content-Type': 'application/json' },
            status: 500,
          });
        }
      case '/api/rotation':
        if (request.method === 'POST') {
          // JSONパース失敗（空body含む）は 400 で返す
          let rotationBody: { id: number; action: 'approve' | 'reject' };
          try {
            rotationBody = await request.json() as { id: number; action: 'approve' | 'reject' };
          } catch {
            return new Response(JSON.stringify({ success: false, message: 'Invalid JSON body' }), {
              status: 400, headers: { 'Content-Type': 'application/json' },
            });
          }
          if (!rotationBody.id || typeof rotationBody.id !== 'number' || !['approve', 'reject'].includes(rotationBody.action)) {
            return new Response(JSON.stringify({ success: false, message: 'Invalid input' }), {
              status: 400, headers: { 'Content-Type': 'application/json' },
            });
          }
          try {
            const result = await decideRotation(env.DB, rotationBody.id, rotationBody.action);
            return new Response(JSON.stringify(result), {
              headers: { 'Content-Type': 'application/json' },
              status: result.success ? 200 : 404,
            });
          } catch (e) {
            return new Response(JSON.stringify({ success: false, message: String(e) }), {
              headers: { 'Content-Type': 'application/json' },
              status: 500,
            });
          }
        }
        return new Response('Method Not Allowed', { status: 405 });
      case '/api/scores': {
        try {
          const today = new Date().toISOString().split('T')[0];
          const rows = await env.DB.prepare(`
            SELECT symbol, theme_score, funda_score, momentum_score, total_score, rank, in_universe
            FROM stock_scores
            WHERE scored_at = ?
            ORDER BY rank ASC
            LIMIT 60
          `).bind(today).all();

          const trackingRows = await env.DB.prepare(
            "SELECT pair, added_at FROM active_instruments"
          ).all<{ pair: string; added_at: string }>();

          return new Response(JSON.stringify({
            scoredAt: today,
            scores: rows.results ?? [],
            trackingList: trackingRows.results ?? [],
          }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      case '/api/screener': {
        try {
          // AIスクリーナー選定済み銘柄（active_instruments の screener_us / screener_jp）
          const activeRows = await env.DB.prepare(`
            SELECT pair, source, added_at FROM active_instruments
            WHERE source IN ('screener_us', 'screener_jp')
            ORDER BY added_at DESC
          `).all<{ pair: string; source: string; added_at: string }>();

          // 直近のrotation_log（入替え履歴、最大20件）
          const rotationRows = await env.DB.prepare(`
            SELECT in_symbol, in_score, out_symbol, out_score, status, proposed_at, decided_at, market FROM rotation_log
            ORDER BY proposed_at DESC LIMIT 20
          `).all<{ in_symbol: string; in_score: number; out_symbol: string; out_score: number; status: string; proposed_at: string; decided_at: string | null; market: string }>();

          // スクリーニング結果キャッシュ（上位候補のスコア）
          const cacheRow = await env.DB.prepare(
            "SELECT value, updated_at FROM market_cache WHERE key = 'screener_results'"
          ).first<{ value: string; updated_at: string }>();
          const screenerCache = cacheRow ? { ...JSON.parse(cacheRow.value), updatedAt: cacheRow.updated_at } : null;

          return new Response(JSON.stringify({
            active: activeRows.results ?? [],
            rotation: rotationRows.results ?? [],
            screenerCache,
          }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      case '/api/ai-report': {
        try {
          const md = await generateAiReport(env.DB);
          return new Response(md, {
            headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-cache' },
          });
        } catch (e) {
          return new Response(`# Error\n\n${String(e).slice(0, 200)}`, {
            status: 500, headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
          });
        }
      }
      default:
        return new Response('Not Found', { status: 404 });
    }
    })();
    return withSec(res);
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    // runId をここで発行し withRunId でスコープ化する。
    // AsyncLocalStorage により、以降の非同期チェーン全体に runId が伝播する。
    // HTTP リクエストとは独立したコンテキストになるため汚染が発生しない。
    const runId = crypto.randomUUID().slice(0, 8);
    const cron = event.cron;
    switch (cron) {
      case '* * * * *':
        ctx.waitUntil(withRunId(runId, () => runCore(env)));
        break;
      case '*/5 * * * *':
        ctx.waitUntil(withRunId(runId, () => runAnalysis(env)));
        break;
      case '0 15 * * *':
        ctx.waitUntil(withRunId(runId, () => runDailyAll(env)));
        break;
      case '0 21 * * *':
        ctx.waitUntil(withRunId(runId, () => runDailyScoring(env)));
        break;
      case '0 18 * * 6':
        ctx.waitUntil(withRunId(runId, () => runWeeklyScreening(env)));
        break;
      default:
        ctx.waitUntil(withRunId(runId, () => runCore(env)));
    }
  },
};
