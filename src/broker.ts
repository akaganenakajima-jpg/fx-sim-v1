// BrokerAdapter — ペーパー/実弾の抽象層
// PaperBroker: 従来のD1記録のみ
// OandaBroker: OANDA REST API v20 経由で実弾発注
// BrokerRouter: 銘柄ごとにBrokerを振り分け

import { insertSystemLog } from './db';
import type { InstrumentConfig } from './instruments';

// ─── 型定義 ─────────────────────────────────────

export interface OrderParams {
  pair: string;
  oandaSymbol: string | null;
  direction: 'BUY' | 'SELL';
  entryRate: number;
  tpRate: number | null;
  slRate: number | null;
  lot: number;
}

export interface CloseParams {
  positionId: number;
  oandaTradeId?: string | null;
  pair: string;
  closeRate: number;
  reason: string;
  pnl: number;
}

export interface UpdateSLParams {
  positionId: number;
  oandaTradeId?: string | null;
  newSlRate: number;
}

export interface BrokerResult {
  success: boolean;
  oandaTradeId?: string;
  error?: string;
}

export interface BrokerAdapter {
  readonly name: string;
  openPosition(params: OrderParams): Promise<BrokerResult>;
  closePosition(params: CloseParams): Promise<BrokerResult>;
  updateStopLoss(params: UpdateSLParams): Promise<BrokerResult>;
}

// ─── OANDA API ヘルパー ─────────────────────────

const OANDA_TIMEOUT_MS = 10_000;

function oandaBaseUrl(isLive: boolean): string {
  return isLive
    ? 'https://api-fxtrade.oanda.com'
    : 'https://api-fxpractice.oanda.com';
}

async function oandaFetch(
  path: string,
  method: string,
  token: string,
  accountId: string,
  isLive: boolean,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const url = `${oandaBaseUrl(isLive)}/v3/accounts/${accountId}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OANDA_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept-Datetime-Format': 'RFC3339',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    clearTimeout(timeout);
    const msg = String(e);
    if (msg.includes('abort')) {
      return { ok: false, status: 0, data: { error: `OANDA timeout (${OANDA_TIMEOUT_MS}ms)` } };
    }
    return { ok: false, status: 0, data: { error: msg.slice(0, 200) } };
  }
}

// ─── OandaBroker ────────────────────────────────

export class OandaBroker implements BrokerAdapter {
  readonly name = 'oanda';
  private token: string;
  private accountId: string;
  private isLive: boolean;

  constructor(token: string, accountId: string, isLive: boolean) {
    this.token = token;
    this.accountId = accountId;
    this.isLive = isLive;
  }

  async openPosition(params: OrderParams): Promise<BrokerResult> {
    if (!params.oandaSymbol) {
      return { success: false, error: 'No OANDA symbol mapped' };
    }

    // OANDA の units: BUY → 正の数、SELL → 負の数
    // lot 1.0 = 1通貨単位（FXの場合）。実際のunitsはlot * 基準単位
    const units = params.direction === 'BUY'
      ? Math.round(params.lot * 1)   // 最小ロット（後でRiskGuardで調整）
      : -Math.round(params.lot * 1);

    const order: Record<string, unknown> = {
      type: 'MARKET',
      instrument: params.oandaSymbol,
      units: String(units),
      timeInForce: 'FOK',  // Fill or Kill
    };

    // TP/SL をオーダーに付与
    if (params.tpRate != null) {
      order.takeProfitOnFill = { price: params.tpRate.toFixed(5) };
    }
    if (params.slRate != null) {
      order.stopLossOnFill = { price: params.slRate.toFixed(5) };
    }

    const res = await oandaFetch(
      '/orders',
      'POST',
      this.token,
      this.accountId,
      this.isLive,
      { order }
    );

    if (!res.ok) {
      const errMsg = JSON.stringify(res.data).slice(0, 200);
      console.error(`[oanda] Order failed: ${res.status} ${errMsg}`);
      return { success: false, error: `OANDA ${res.status}: ${errMsg}` };
    }

    // レスポンスからトレードIDを取得
    const data = res.data as Record<string, unknown>;
    const filled = data.orderFillTransaction as Record<string, unknown> | undefined;
    const tradeId = filled?.tradeOpened
      ? (filled.tradeOpened as Record<string, unknown>).tradeID as string
      : undefined;

    console.log(`[oanda] Order filled: ${params.oandaSymbol} ${params.direction} tradeId=${tradeId}`);
    return { success: true, oandaTradeId: tradeId };
  }

  async closePosition(params: CloseParams): Promise<BrokerResult> {
    if (!params.oandaTradeId) {
      return { success: false, error: 'No OANDA trade ID' };
    }

    const res = await oandaFetch(
      `/trades/${params.oandaTradeId}/close`,
      'PUT',
      this.token,
      this.accountId,
      this.isLive
    );

    if (!res.ok) {
      const errMsg = JSON.stringify(res.data).slice(0, 200);
      console.error(`[oanda] Close failed: ${res.status} ${errMsg}`);
      return { success: false, error: `OANDA ${res.status}: ${errMsg}` };
    }

    console.log(`[oanda] Trade closed: ${params.oandaTradeId} reason=${params.reason}`);
    return { success: true };
  }

  async updateStopLoss(params: UpdateSLParams): Promise<BrokerResult> {
    if (!params.oandaTradeId) {
      return { success: false, error: 'No OANDA trade ID' };
    }

    const res = await oandaFetch(
      `/trades/${params.oandaTradeId}/orders`,
      'PUT',
      this.token,
      this.accountId,
      this.isLive,
      { stopLoss: { price: params.newSlRate.toFixed(5) } }
    );

    if (!res.ok) {
      const errMsg = JSON.stringify(res.data).slice(0, 200);
      console.error(`[oanda] SL update failed: ${res.status} ${errMsg}`);
      return { success: false, error: `OANDA ${res.status}: ${errMsg}` };
    }

    console.log(`[oanda] SL updated: trade=${params.oandaTradeId} newSL=${params.newSlRate}`);
    return { success: true };
  }
}

// ─── PaperBroker ────────────────────────────────

export class PaperBroker implements BrokerAdapter {
  readonly name = 'paper';

  async openPosition(_params: OrderParams): Promise<BrokerResult> {
    // D1への記録は呼び出し元（index.ts）が行う
    return { success: true };
  }

  async closePosition(_params: CloseParams): Promise<BrokerResult> {
    // D1への記録は呼び出し元（position.ts）が行う
    return { success: true };
  }

  async updateStopLoss(_params: UpdateSLParams): Promise<BrokerResult> {
    // D1への更新は呼び出し元（position.ts）が行う
    return { success: true };
  }
}

// ─── BrokerRouter ───────────────────────────────

export interface BrokerEnv {
  OANDA_API_TOKEN?: string;
  OANDA_ACCOUNT_ID?: string;
  OANDA_LIVE?: string;
  TRADING_ENABLED?: string;
}

const paperBroker = new PaperBroker();

export function getBroker(instrument: InstrumentConfig, env: BrokerEnv): BrokerAdapter {
  // TRADING_ENABLED が false → 全銘柄ペーパー
  if (env.TRADING_ENABLED !== 'true') return paperBroker;

  // OANDA設定が不完全 → ペーパー
  if (!env.OANDA_API_TOKEN || !env.OANDA_ACCOUNT_ID) return paperBroker;

  // 銘柄が oanda 指定で、OANDAシンボルがある場合のみ OandaBroker
  if (instrument.broker === 'oanda' && instrument.oandaSymbol) {
    return new OandaBroker(
      env.OANDA_API_TOKEN,
      env.OANDA_ACCOUNT_ID,
      env.OANDA_LIVE === 'true'
    );
  }

  return paperBroker;
}

/** OANDA失敗時のフォールバック: ログを記録してペーパーに切替 */
export async function withFallback(
  broker: BrokerAdapter,
  action: () => Promise<BrokerResult>,
  db: D1Database,
  context: string
): Promise<BrokerResult> {
  const result = await action();

  if (!result.success && broker.name === 'oanda') {
    console.warn(`[broker] OANDA failed for ${context}: ${result.error}. Falling back to paper.`);
    await insertSystemLog(db, 'WARN', 'BROKER',
      `OANDA発注失敗→ペーパーフォールバック: ${context}`,
      result.error ?? undefined
    );
    return { success: true, error: `Fallback to paper: ${result.error}` };
  }

  return result;
}
