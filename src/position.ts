// ポジション管理（TP/SL チェック + ブローカー統合）
// 同時オープンポジションは銘柄ごとに最大1件

import { getOpenPositions, getOpenPositionByPair, closePosition, insertSystemLog, updateDecisionOutcome, getRecentTPOpposite } from './db';
import type { Position } from './db';
import { INSTRUMENTS, type InstrumentConfig } from './instruments';
import { getBroker, withFallback, type BrokerEnv } from './broker';
import { kellyFraction, logReturn } from './stats';
import { sendNotification, buildTpSlMessage } from './notify';
import { updateThompsonParams } from './thompson';
import { logTradeJournal } from './trade-journal';
import { getCurrentBalance } from './risk-manager';
import { TP_COOLDOWN_MIN, MAX_RISK_PER_TRADE_PCT, MIN_TRADES_FOR_KELLY } from './constants';
import { calcATR } from './logic-indicators';

function calcPnl(
  direction: 'BUY' | 'SELL',
  entryRate: number,
  closeRate: number,
  pnlMultiplier: number
): number {
  return direction === 'BUY'
    ? (closeRate - entryRate) * pnlMultiplier
    : (entryRate - closeRate) * pnlMultiplier;
}

/** 実現RR計算: 実現利益 / 初期リスク（エントリー時SL距離）
 *  RR ≥ 1.0 = 勝ち（リスクと同等以上のリターン）
 *  RR < 1.0 = 負け */
export function calcRealizedRR(direction: string, entryRate: number, closeRate: number, slRate: number): number {
  if (direction === 'BUY') {
    const risk = entryRate - slRate;
    if (risk <= 0) {
      // トレイリングストップでSLがentry上方に移動済み → SL決済でも利益確定 → 勝ち(≥1.0)
      return 1.0;
    }
    return (closeRate - entryRate) / risk;
  } else {
    const risk = slRate - entryRate;
    if (risk <= 0) {
      // トレイリングストップでSLがentry下方に移動済み → SL決済でも利益確定 → 勝ち(≥1.0)
      return 1.0;
    }
    return (entryRate - closeRate) / risk;
  }
}

function shouldTriggerTP(pos: Position, currentRate: number): boolean {
  if (pos.tp_rate == null) return false;
  return pos.direction === 'BUY'
    ? currentRate >= pos.tp_rate
    : currentRate <= pos.tp_rate;
}

function shouldTriggerSL(pos: Position, currentRate: number): boolean {
  if (pos.sl_rate == null) return false;
  return pos.direction === 'BUY'
    ? currentRate <= pos.sl_rate
    : currentRate >= pos.sl_rate;
}

/** 全銘柄のオープンポジションを一括チェック（instrument map で PnL乗数を解決） */
export async function checkAndCloseAllPositions(
  db: D1Database,
  prices: Map<string, number | null>,
  instruments: InstrumentConfig[],
  brokerEnv?: BrokerEnv,
  webhookUrl?: string,
): Promise<void> {
  const positions = await getOpenPositions(db);
  const instrMap = new Map(instruments.map((i) => [i.pair, i]));

  for (const pos of positions) {
    const currentRate = prices.get(pos.pair);
    if (currentRate == null) continue;

    const instr = instrMap.get(pos.pair);
    if (!instr) {
      // 除外銘柄のポジション — 誤った pnlMultiplier で計算すると大事故になるためスキップ
      console.log(`[position] WARN: ${pos.pair} id=${pos.id} は有効銘柄リストに存在しない → TP/SLチェック スキップ`);
      continue;
    }
    const multiplier = instr.pnlMultiplier;

    // ── instrument_params 一括取得（Ph.8 + Ph.10b） ──
    const paramRow = await db.prepare(
      'SELECT max_hold_minutes, time_based_exit_minutes, trailing_step_atr FROM instrument_params WHERE pair=?'
    ).bind(pos.pair).first<{max_hold_minutes: number; time_based_exit_minutes: number; trailing_step_atr: number}>();
    const maxHold = paramRow?.max_hold_minutes ?? 480;
    if (maxHold > 0 && maxHold < 9999) {
      const entryTime = new Date(pos.entry_at).getTime();
      const holdMinutes = (Date.now() - entryTime) / 60000;
      if (holdMinutes > maxHold) {
        const pnl = calcPnl(pos.direction, pos.entry_rate, currentRate, multiplier);
        const lr = logReturn(pos.entry_rate, currentRate);
        const timeRealizedRR = pos.sl_rate != null ? calcRealizedRR(pos.direction, pos.entry_rate, currentRate, pos.sl_rate) : 0;

        // T08: RR >= 0.5 かつ maxHold×2 以内なら延期（TP/SLに委ねる）
        if (timeRealizedRR >= 0.5 && holdMinutes <= maxHold * 2) {
          // SLを建値以上に引き上げ（利益確保）
          if (pos.sl_rate != null) {
            const isBuy = pos.direction === 'BUY';
            const breakeven = pos.entry_rate;
            const shouldMove = isBuy ? pos.sl_rate < breakeven : pos.sl_rate > breakeven;
            if (shouldMove) {
              await db.prepare('UPDATE positions SET sl_rate = ? WHERE id = ?').bind(breakeven, pos.id).run();
              console.log(`[position] TIME_STOP延期: ${pos.pair} id=${pos.id} RR=${timeRealizedRR.toFixed(2)} — SLを建値${breakeven}に引き上げ`);
            }
          }
          continue;
        }

        console.log(`[position] TIME_STOP: ${pos.pair} id=${pos.id} held=${Math.round(holdMinutes)}min > ${maxHold}min pnl=${pnl.toFixed(2)}`);
        await closePosition(db, pos.id, currentRate, 'TIME_STOP', pnl, lr, timeRealizedRR);
        await updateDecisionOutcome(db, pos.pair, pos.direction, pos.entry_at, timeRealizedRR >= 1.0 ? 'WIN' : 'LOSE');
        await insertSystemLog(db, 'INFO', 'POSITION',
          `時間切れ決済: ${pos.pair} ${pos.direction} ${Math.round(holdMinutes)}分保有 PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
          JSON.stringify({ id: pos.id, holdMinutes: Math.round(holdMinutes), maxHold, pnl }));
        continue;
      }
    }

    // ── Ph.10b: 建値撤退タイムリミット（TIME_LIMIT） ──
    // time_based_exit_minutes を超過 かつ RR < 0.5 なら損切り前に撤退
    // max_hold_minutes（TIME_STOP）とは独立: TIME_LIMITは「まだ利が乗っていない」ポジションの早期撤退
    const timeLimitMin = paramRow?.time_based_exit_minutes ?? 0;
    if (timeLimitMin > 0 && pos.sl_rate != null) {
      const entryTime = new Date(pos.entry_at).getTime();
      const holdMin = (Date.now() - entryTime) / 60000;
      if (holdMin > timeLimitMin) {
        const rr = calcRealizedRR(pos.direction, pos.entry_rate, currentRate, pos.sl_rate);
        if (rr < 0.5) {
          const pnl = calcPnl(pos.direction, pos.entry_rate, currentRate, multiplier);
          const lr = logReturn(pos.entry_rate, currentRate);
          console.log(`[position] TIME_LIMIT: ${pos.pair} id=${pos.id} held=${Math.round(holdMin)}min > ${timeLimitMin}min RR=${rr.toFixed(2)} pnl=${pnl.toFixed(2)}`);
          await closePosition(db, pos.id, currentRate, 'TIME_LIMIT', pnl, lr, rr);
          await updateDecisionOutcome(db, pos.pair, pos.direction, pos.entry_at, rr >= 1.0 ? 'WIN' : 'LOSE');
          await insertSystemLog(db, 'INFO', 'POSITION',
            `建値撤退: ${pos.pair} ${pos.direction} ${Math.round(holdMin)}分保有 RR=${rr.toFixed(2)} PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
            JSON.stringify({ id: pos.id, holdMin: Math.round(holdMin), timeLimitMin, rr, pnl }));
          continue;
        }
      }
    }

    // トレイリングストップ: 含み益が activation 幅を超えたらSLを引き上げ
    // Ph.10b: trailing_step_atr > 0 の場合、シャンデリアエグジット（ATR×倍率）で動的距離を使用
    if (instr && pos.sl_rate != null) {
      const activation = instr.trailingActivation;
      let distance = instr.trailingDistance;

      // シャンデリアエグジット: ATRベースの動的距離
      const chandelierAtr = paramRow?.trailing_step_atr ?? 0;
      if (chandelierAtr > 0) {
        // 直近レートからATRを計算（market_cache から取得、なければ固定距離のまま）
        const rateRows = await db.prepare(
          'SELECT value FROM market_cache WHERE key = ?'
        ).bind(`closes_${pos.pair}`).first<{value: string}>();
        if (rateRows?.value) {
          try {
            const closes: number[] = JSON.parse(rateRows.value);
            const currentAtr = calcATR(closes, 14);
            if (currentAtr !== null) {
              distance = currentAtr * chandelierAtr;
            }
          } catch { /* parse失敗時は固定距離を使用 */ }
        }
      }
      const isBuy = pos.direction === 'BUY';
      const profit = isBuy
        ? currentRate - pos.entry_rate
        : pos.entry_rate - currentRate;

      if (profit >= activation) {
        const newSl = isBuy
          ? currentRate - distance
          : currentRate + distance;
        // SLは利益方向にのみ移動（BUY: 上方向、SELL: 下方向）
        const shouldUpdate = isBuy
          ? newSl > pos.sl_rate
          : newSl < pos.sl_rate;

        if (shouldUpdate) {
          const oldSl = pos.sl_rate;
          await db.prepare('UPDATE positions SET sl_rate = ? WHERE id = ?').bind(newSl, pos.id).run();
          console.log(`[position] Trailing SL: ${pos.pair} id=${pos.id} SL ${oldSl.toFixed(4)} → ${newSl.toFixed(4)}`);
          await insertSystemLog(db, 'INFO', 'TRAILING',
            `トレイリングSL: ${pos.pair} ${oldSl.toFixed(4)} → ${newSl.toFixed(4)}`,
            JSON.stringify({ id: pos.id, direction: pos.direction, entry: pos.entry_rate, oldSl, newSl, currentRate }));
          pos.sl_rate = newSl; // 以降のSLチェックで新しいSLを使う

          // OANDA実弾: ブローカーのSLも更新
          if (pos.source === 'oanda' && pos.oanda_trade_id && instr && brokerEnv) {
            const broker = getBroker(instr, brokerEnv);
            if (broker.name === 'oanda') {
              await withFallback(broker, () => broker.updateStopLoss({
                positionId: pos.id,
                oandaTradeId: pos.oanda_trade_id,
                newSlRate: newSl,
              }), db, `trailing-sl ${pos.pair}`);
            }
          }
        }
      }
    }

    // テスタ施策10: 分割決済 — TP1(RR1:1地点)で決済 + 建値ストップ
    if (pos.sl_rate != null && !pos.tp1_hit && pos.lot > 0) {
      const slDist = Math.abs(pos.entry_rate - pos.sl_rate);
      const isBuy = pos.direction === 'BUY';
      const tp1Rate = isBuy ? pos.entry_rate + slDist : pos.entry_rate - slDist;
      const tp1Hit = isBuy ? currentRate >= tp1Rate : currentRate <= tp1Rate;

      if (tp1Hit && slDist > 0) {
        // Ph.8: tp1_ratio パラメーター化（デフォルト0.5）
        const tp1Params = await db.prepare(
          'SELECT tp1_ratio FROM instrument_params WHERE pair=?'
        ).bind(pos.pair).first<{tp1_ratio: number}>();
        const tp1Ratio = tp1Params?.tp1_ratio ?? 0.5;
        const halfLot = pos.lot * tp1Ratio;
        const partialPnl = calcPnl(pos.direction, pos.entry_rate, currentRate, multiplier) * tp1Ratio;
        console.log(`[position] TP1 hit: ${pos.pair} id=${pos.id} partial_close=${(tp1Ratio * 100).toFixed(0)}% pnl=${partialPnl.toFixed(2)}`);

        // tp1_ratio部分決済 + SLを建値に移動 + tp1_hit フラグ
        await db.prepare(
          `UPDATE positions SET lot = lot * ?, partial_closed_lot = COALESCE(partial_closed_lot, 0) + ?,
           sl_rate = entry_rate, tp1_hit = 1 WHERE id = ?`
        ).bind(1 - tp1Ratio, halfLot, pos.id).run();
        pos.lot = pos.lot * (1 - tp1Ratio);
        pos.sl_rate = pos.entry_rate;
        pos.tp1_hit = 1;

        await insertSystemLog(db, 'INFO', 'POSITION',
          `TP1分割決済: ${pos.pair} 50%決済 PnL+${partialPnl.toFixed(2)} SL→建値`,
          JSON.stringify({ id: pos.id, tp1Rate, currentRate, halfLot }));

        // OANDA実弾: 部分決済 + SL更新
        if (pos.source === 'oanda' && pos.oanda_trade_id && instr && brokerEnv) {
          const broker = getBroker(instr, brokerEnv);
          if (broker.name === 'oanda') {
            await withFallback(broker, () => broker.updateStopLoss({
              positionId: pos.id, oandaTradeId: pos.oanda_trade_id,
              newSlRate: pos.entry_rate,
            }), db, `tp1-sl ${pos.pair}`);
          }
        }
      }
    }

    if (shouldTriggerTP(pos, currentRate)) {
      const pnl = calcPnl(pos.direction, pos.entry_rate, currentRate, multiplier);
      const lr = logReturn(pos.entry_rate, currentRate);
      console.log(`[position] TP hit: ${pos.pair} id=${pos.id} pnl=${pnl.toFixed(2)}`);

      // OANDA実弾: ブローカー側もクローズ
      if (pos.source === 'oanda' && pos.oanda_trade_id && instr && brokerEnv) {
        const broker = getBroker(instr, brokerEnv);
        if (broker.name === 'oanda') {
          await withFallback(broker, () => broker.closePosition({
            positionId: pos.id, oandaTradeId: pos.oanda_trade_id,
            pair: pos.pair, closeRate: currentRate, reason: 'TP', pnl,
          }), db, `tp-close ${pos.pair}`);
        }
      }

      const tpRealizedRR = pos.sl_rate != null
        ? calcRealizedRR(pos.direction, pos.entry_rate, currentRate, pos.sl_rate)
        : 1.0; // sl_rate未設定（日本株等）のTP → 勝ちとして扱う
      await closePosition(db, pos.id, currentRate, 'TP', pnl, lr, tpRealizedRR);
      // TP 通知（currentRate はこの時点で number に絞り込まれている）
      await sendNotification(webhookUrl, buildTpSlMessage({
        pair: pos.pair,
        direction: pos.direction as 'BUY' | 'SELL',
        reason: 'TP',
        pnl,
        entryRate: pos.entry_rate,
        closeRate: currentRate,
        // 施策22: 手法・レジーム・確信度・実現RRを通知に追加
        strategy: pos.strategy ?? undefined,
        regime: pos.regime ?? undefined,
        confidence: pos.confidence ?? null,
        realizedRR: tpRealizedRR,
      }));
      await updateDecisionOutcome(db, pos.pair, pos.direction, pos.entry_at, tpRealizedRR >= 1.0 ? 'WIN' : 'LOSE');
      // トンプソン・サンプリングパラメータ更新
      await updateThompsonParams(db, pos.pair, tpRealizedRR >= 1.0).catch(() => {});
      await insertSystemLog(db, 'INFO', 'POSITION',
        `TP決済: ${pos.pair} ${pos.direction} PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
        JSON.stringify({ id: pos.id, entry: pos.entry_rate, close: currentRate, pnl }));
      // テスタ施策13: トレード日誌自動記録
      await logTradeJournal(db,
        { ...pos, close_rate: currentRate, pnl, closed_at: new Date().toISOString(), close_reason: 'TP' },
        { strategy: pos.strategy ?? undefined, regime: pos.regime ?? undefined, session: pos.session ?? undefined, confidence: pos.confidence ?? undefined },
      ).catch(() => {});
    } else if (shouldTriggerSL(pos, currentRate)) {
      const pnl = calcPnl(pos.direction, pos.entry_rate, currentRate, multiplier);
      const lr = logReturn(pos.entry_rate, currentRate);
      console.log(`[position] SL hit: ${pos.pair} id=${pos.id} pnl=${pnl.toFixed(2)}`);

      // OANDA実弾: ブローカー側もクローズ
      if (pos.source === 'oanda' && pos.oanda_trade_id && instr && brokerEnv) {
        const broker = getBroker(instr, brokerEnv);
        if (broker.name === 'oanda') {
          await withFallback(broker, () => broker.closePosition({
            positionId: pos.id, oandaTradeId: pos.oanda_trade_id,
            pair: pos.pair, closeRate: currentRate, reason: 'SL', pnl,
          }), db, `sl-close ${pos.pair}`);
        }
      }

      const slRealizedRR = pos.sl_rate != null
        ? calcRealizedRR(pos.direction, pos.entry_rate, currentRate, pos.sl_rate)
        : 0; // sl_rate未設定のSL → 負けとして扱う
      await closePosition(db, pos.id, currentRate, 'SL', pnl, lr, slRealizedRR);
      // SL 通知
      await sendNotification(webhookUrl, buildTpSlMessage({
        pair: pos.pair,
        direction: pos.direction as 'BUY' | 'SELL',
        reason: 'SL',
        pnl,
        entryRate: pos.entry_rate,
        closeRate: currentRate,
        // 施策22: 手法・レジーム・確信度・実現RRを通知に追加
        strategy: pos.strategy ?? undefined,
        regime: pos.regime ?? undefined,
        confidence: pos.confidence ?? null,
        realizedRR: slRealizedRR,
      }));
      await updateDecisionOutcome(db, pos.pair, pos.direction, pos.entry_at, slRealizedRR >= 1.0 ? 'WIN' : 'LOSE');
      // トンプソン・サンプリングパラメータ更新
      await updateThompsonParams(db, pos.pair, slRealizedRR >= 1.0).catch(() => {});
      await insertSystemLog(db, 'WARN', 'POSITION',
        `SL決済: ${pos.pair} ${pos.direction} PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
        JSON.stringify({ id: pos.id, entry: pos.entry_rate, close: currentRate, pnl }));

      // テスタ施策13: トレード日誌自動記録
      await logTradeJournal(db,
        { ...pos, close_rate: currentRate, pnl, closed_at: new Date().toISOString(), close_reason: 'SL' },
        { strategy: pos.strategy ?? undefined, regime: pos.regime ?? undefined, session: pos.session ?? undefined, confidence: pos.confidence ?? undefined },
      ).catch(() => {});

      // ドローダウン検知: 直近3件がすべてSLなら警告（60分デバウンス）
      try {
        const recent = await db.prepare(
          `SELECT close_reason FROM positions WHERE status = 'CLOSED' ORDER BY closed_at DESC LIMIT 3`
        ).all<{ close_reason: string }>();
        const reasons = (recent.results ?? []).map(r => r.close_reason);
        if (reasons.length >= 3 && reasons.every(r => r === 'SL')) {
          // 60分デバウンス: market_cache で最終アラート時刻をチェック
          const cdKey = 'drawdown_alert_cd';
          const cdRow = await db.prepare('SELECT value, updated_at FROM market_cache WHERE key = ?')
            .bind(cdKey).first<{ value: string; updated_at: string }>();
          const lastAlertMs = cdRow ? new Date(cdRow.updated_at).getTime() : 0;
          const nowMs = Date.now();
          if (nowMs - lastAlertMs >= 60 * 60 * 1000) { // 60分以上経過
            const totalSlPnl = await db.prepare(
              `SELECT COALESCE(SUM(pnl), 0) AS slLoss FROM positions WHERE status = 'CLOSED' AND close_reason = 'SL' ORDER BY closed_at DESC LIMIT 3`
            ).first<{ slLoss: number }>();
            await insertSystemLog(db, 'WARN', 'DRAWDOWN',
              `⚠️ 3連続SL損切 — 累計損失 ¥${Math.round(totalSlPnl?.slLoss ?? 0)}`);
            console.warn(`[position] ⚠️ DRAWDOWN: 3 consecutive SL hits`);
            // クールダウン時刻を記録
            await db.prepare(
              `INSERT INTO market_cache (key, value, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
            ).bind(cdKey, 'alerted', new Date().toISOString()).run();
          }
        }
      } catch {}
    }
  }
}



export async function openPosition(
  db: D1Database,
  pair: string,
  direction: 'BUY' | 'SELL',
  entryRate: number,
  tpRate: number | null,
  slRate: number | null,
  source: 'paper' | 'oanda' = 'paper',
  oandaTradeId: string | null = null,
  _webhookUrl?: string,
  extra?: {
    strategy?: string | null;
    regime?: string | null;
    session?: string | null;
    confidence?: number | null;
    pnlMultiplier?: number;
    trigger?: string | null;  // 'RATE'=レート変動, 'SCHED'=定期30m, 'NEWS'=ニュース
  },
): Promise<void> {
  const existing = await getOpenPositionByPair(db, pair);
  if (existing) {
    console.log(`[position] Already has open position for ${pair}, skipping`);
    return;
  }

  // T11: セッション時間ガード（取引時間外のエントリーを拒否）
  const instConfig = INSTRUMENTS.find(i => i.pair === pair);
  if (instConfig) {
    const now = new Date();
    if (instConfig.tradingHoursJST) {
      // 日本株: JST = UTC+9
      const jstHour = (now.getUTCHours() + 9) % 24;
      const { open, close } = instConfig.tradingHoursJST;
      if (jstHour < open || jstHour >= close) {
        console.log(`[position] セッション外: ${pair} JST ${jstHour}時 (許可: ${open}-${close}) — エントリー拒否`);
        return;
      }
    }
    if (instConfig.tradingHoursET) {
      // 米国株: ET = UTC-4 (EDT) or UTC-5 (EST)。簡易的にUTC-4（EDT）を使用
      const etHour = (now.getUTCHours() - 4 + 24) % 24;
      const { open, close } = instConfig.tradingHoursET;
      // open=9.5 → 9:30以降、close=16 → 16:00まで
      const etTime = etHour + now.getUTCMinutes() / 60;
      if (etTime < open || etTime >= close) {
        console.log(`[position] セッション外: ${pair} ET ${etTime.toFixed(1)}h (許可: ${open}-${close}) — エントリー拒否`);
        return;
      }
    }
  }

  // SL方向最終防衛ライン（entryRate基準）
  // currentRate基準のサニティチェックは市場変動でバイパスされうるため、
  // openPosition自体でentryRate vs slRateの方向を再検証する
  if (slRate != null) {
    if (direction === 'BUY' && slRate >= entryRate) {
      await insertSystemLog(db, 'WARN', 'SANITY',
        `SL方向エラー: BUY sl=${slRate} >= entry=${entryRate} — エントリー拒否`,
        JSON.stringify({ pair, direction, entryRate, slRate }));
      console.warn(`[position] SL direction error: BUY pair=${pair} sl=${slRate} >= entry=${entryRate}, skipping`);
      return;
    }
    if (direction === 'SELL' && slRate <= entryRate) {
      await insertSystemLog(db, 'WARN', 'SANITY',
        `SL方向エラー: SELL sl=${slRate} <= entry=${entryRate} — エントリー拒否`,
        JSON.stringify({ pair, direction, entryRate, slRate }));
      console.warn(`[position] SL direction error: SELL pair=${pair} sl=${slRate} <= entry=${entryRate}, skipping`);
      return;
    }
  }

  // TP後クールダウン: 同銘柄の逆方向TPからTP_COOLDOWN_MIN分以内は逆張りエントリー禁止
  const recentTP = await getRecentTPOpposite(db, pair, direction, TP_COOLDOWN_MIN);
  if (recentTP) {
    const minAgo = Math.round((Date.now() - new Date(recentTP.closed_at).getTime()) / 60000);
    await insertSystemLog(db, 'INFO', 'COOLDOWN',
      `TP後クールダウン: ${pair} ${direction}エントリーをブロック (${minAgo}分前に逆${recentTP.direction}がTP)`,
      JSON.stringify({ pair, blockedDir: direction, tpId: recentTP.id, tpDir: recentTP.direction, minAgo, cooldownMin: TP_COOLDOWN_MIN }));
    console.log(`[position] TP-cooldown block: ${pair} ${direction} (${minAgo}min after ${recentTP.direction} TP)`);
    return;
  }

  // ポジションサイジング: ケリー基準（勝率 × RR比）
  // サンプル数20件以上で Kelly ゲートを適用:
  //   Kelly < 0   → 期待値マイナス銘柄 → エントリー停止
  //   Kelly < 0.1 → 最小ロット (0.1)
  //   Kelly ≥ 0.1 → Kelly 値をそのままロットに使用（上限 1.0）
  const perfRow = await db
    .prepare(`SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN realized_rr >= 1.0 THEN 1 ELSE 0 END), 0) as wins,
      COALESCE(AVG(CASE WHEN realized_rr >= 1.0 THEN pnl ELSE NULL END), 0) as avgWin,
      COALESCE(AVG(CASE WHEN realized_rr IS NULL OR realized_rr < 1.0 THEN ABS(pnl) ELSE NULL END), 1) as avgLoss
      FROM positions WHERE pair = ? AND status = 'CLOSED'`)
    .bind(pair)
    .first<{ total: number; wins: number; avgWin: number; avgLoss: number }>();
  let lot = 1.0;
  if (perfRow && perfRow.total >= MIN_TRADES_FOR_KELLY) {
    const winRate = perfRow.wins / perfRow.total;
    const avgRR = perfRow.avgLoss > 0 ? perfRow.avgWin / perfRow.avgLoss : 0;
    const kelly = kellyFraction(winRate, avgRR);
    // Kelly ゲート: 負のKellyは期待値マイナス → 取引停止
    if (kelly < 0) {
      await insertSystemLog(db, 'WARN', 'KELLY',
        `Kelly負: ${pair} ${direction}エントリーをブロック (kelly=${kelly.toFixed(3)})`,
        JSON.stringify({ pair, kelly, winRate: winRate.toFixed(3), avgRR: avgRR.toFixed(3), total: perfRow.total }));
      console.warn(`[position] Kelly block: ${pair} kelly=${kelly.toFixed(3)} (wr=${(winRate*100).toFixed(0)}% rr=${avgRR.toFixed(2)}) n=${perfRow.total}`);
      return;
    }
    // Kelly 比例ロットサイジング: Kelly<0.1→最小, Kelly≥0.1→Kelly値（上限1.0）
    lot = kelly < 0.1 ? 0.1 : Math.min(kelly, 1.0);
    console.log(`[position] Kelly: ${pair} wr=${(winRate*100).toFixed(0)}% rr=${avgRR.toFixed(2)} f=${kelly.toFixed(3)} → lot=${lot.toFixed(2)}`);
  }

  // SL幅ベースポジションサイズ（複利・残高1%リスク上限）
  // Kelly値がSL幅ベース上限を超える場合は上限に切り下げる
  if (slRate != null) {
    const slPips = Math.abs(entryRate - slRate);
    const multiplier = extra?.pnlMultiplier ?? 1;
    const riskPerLot = slPips * multiplier;
    const balance = await getCurrentBalance(db);
    const maxRisk = balance * MAX_RISK_PER_TRADE_PCT;
    if (riskPerLot > 0) {
      const slBasedLot = maxRisk / riskPerLot;
      if (slBasedLot < lot) {
        console.log(`[position] SL-based lot cap: ${pair} kelly=${lot.toFixed(2)} sl_lot=${slBasedLot.toFixed(2)} bal=${balance.toFixed(0)}`);
        lot = slBasedLot;
      }
    }
  }

  await db
    .prepare(
      `INSERT INTO positions
         (pair, direction, entry_rate, tp_rate, sl_rate, lot, status, entry_at, source, oanda_trade_id,
          strategy, regime, session, confidence, original_lot, trigger)
       VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(pair, direction, entryRate, tpRate, slRate, lot, new Date().toISOString(), source, oandaTradeId,
      extra?.strategy ?? null, extra?.regime ?? null, extra?.session ?? null, extra?.confidence ?? null, lot,
      extra?.trigger ?? null)
    .run();

  console.log(`[position] Opened ${pair} ${direction} @ ${entryRate} TP=${tpRate} SL=${slRate} [${source}${oandaTradeId ? ` trade=${oandaTradeId}` : ''}]`);
}
