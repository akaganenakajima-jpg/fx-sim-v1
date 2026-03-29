/**
 * weekend.ts ユニットテスト
 *
 * IPA §テスト設計 / CLAUDE.md §週末市場クローズ制約
 *
 * テスト観点:
 *   T1. 週末クローズ判定（getWeekendStatus）— 土曜・日曜22:00前後の境界値
 *   T2. 取引可能銘柄フィルタ（getTradeableInstruments）— クローズ中はクリプトのみ
 *   T3. 再発防止: Path B の銘柄フィルタが意図通り動作することを担保
 *
 * なぜこのテストが必要か（根本原因 2026-03-29 の再発防止）:
 *   - Path A廃止時に週末制限ガードが消え、週末でもFX銘柄がエントリーされるバグが発生
 *   - このテストがあれば「getTradeableInstruments が週末にFXを返す」状態を検出できる
 */

import { describe, it, expect } from 'vitest';
import { getWeekendStatus, getTradeableInstruments, CRYPTO_PAIRS, CRYPTO_PAIRS_SET } from './weekend';

// ---------------------------------------------------------------------------
// テスト用ヘルパー
// ---------------------------------------------------------------------------

/** UTC日時を Date オブジェクトに変換 */
function utc(day: number, hour: number, min = 0): Date {
  // 2026-03-30は月曜日(day=1)を基準に曜日を指定
  // day: 0=日, 1=月, 2=火, 3=水, 4=木, 5=金, 6=土
  const base = new Date('2026-03-30T00:00:00Z'); // 月曜
  const offset = day - 1; // 月曜=0
  const d = new Date(base);
  d.setUTCDate(base.getUTCDate() + offset);
  d.setUTCHours(hour, min, 0, 0);
  return d;
}

/** テスト用銘柄リスト（実際の INSTRUMENTS の縮小版） */
const DUMMY_INSTRUMENTS = [
  { pair: 'USD/JPY' },
  { pair: 'EUR/USD' },
  { pair: 'BTC/USD' },
  { pair: 'ETH/USD' },
  { pair: 'SOL/USD' },
  { pair: 'Nikkei225' },
  { pair: 'S&P500' },
];

// ---------------------------------------------------------------------------
// T1: getWeekendStatus — 市場クローズ判定
// ---------------------------------------------------------------------------

describe('T1: getWeekendStatus — 市場クローズ判定', () => {
  it('土曜日は終日 marketClosed=true', () => {
    expect(getWeekendStatus(utc(6, 0)).marketClosed).toBe(true);
    expect(getWeekendStatus(utc(6, 12)).marketClosed).toBe(true);
    expect(getWeekendStatus(utc(6, 23)).marketClosed).toBe(true);
  });

  it('日曜 21:59 UTC は marketClosed=true', () => {
    expect(getWeekendStatus(utc(0, 21, 59)).marketClosed).toBe(true);
  });

  it('日曜 22:00 UTC はウォームアップ開始 — marketClosed=false', () => {
    expect(getWeekendStatus(utc(0, 22, 0)).marketClosed).toBe(false);
  });

  it('月曜 03:00 UTC は通常運転 — marketClosed=false', () => {
    expect(getWeekendStatus(utc(1, 3, 0)).marketClosed).toBe(false);
  });

  it('平日（火〜木）は marketClosed=false', () => {
    expect(getWeekendStatus(utc(2, 12)).marketClosed).toBe(false);
    expect(getWeekendStatus(utc(3, 9)).marketClosed).toBe(false);
    expect(getWeekendStatus(utc(4, 15)).marketClosed).toBe(false);
  });

  it('金曜 21:00 UTC（NYクローズ）以降は marketClosed=true', () => {
    expect(getWeekendStatus(utc(5, 21, 0)).marketClosed).toBe(true);
    expect(getWeekendStatus(utc(5, 23)).marketClosed).toBe(true);
  });

  it('金曜 20:59 UTC はまだ Phase 3（強制決済）— marketClosed=false', () => {
    expect(getWeekendStatus(utc(5, 20, 59)).marketClosed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T2: getTradeableInstruments — 取引可能銘柄フィルタ
// ---------------------------------------------------------------------------

describe('T2: getTradeableInstruments — 取引可能銘柄フィルタ', () => {
  it('市場クローズ中は CRYPTO_PAIRS のみ返す', () => {
    const saturday = utc(6, 12);
    const status = getWeekendStatus(saturday);
    expect(status.marketClosed).toBe(true);

    const tradeable = getTradeableInstruments(DUMMY_INSTRUMENTS, status);
    const pairs = tradeable.map(i => i.pair);

    expect(pairs).toContain('BTC/USD');
    expect(pairs).toContain('ETH/USD');
    expect(pairs).toContain('SOL/USD');
    expect(pairs).not.toContain('USD/JPY');
    expect(pairs).not.toContain('EUR/USD');
    expect(pairs).not.toContain('Nikkei225');
    expect(pairs).not.toContain('S&P500');
  });

  it('平日は全銘柄を返す', () => {
    const wednesday = utc(3, 10);
    const status = getWeekendStatus(wednesday);
    expect(status.marketClosed).toBe(false);

    const tradeable = getTradeableInstruments(DUMMY_INSTRUMENTS, status);
    expect(tradeable.length).toBe(DUMMY_INSTRUMENTS.length);
  });

  it('月曜ウォームアップ（Phase -1）は全銘柄を返す', () => {
    const mondayWarmup = utc(0, 23); // 日曜23:00 = Phase -1
    const status = getWeekendStatus(mondayWarmup);
    expect(status.phase).toBe(-1);
    expect(status.marketClosed).toBe(false);

    const tradeable = getTradeableInstruments(DUMMY_INSTRUMENTS, status);
    expect(tradeable.length).toBe(DUMMY_INSTRUMENTS.length);
  });
});

// ---------------------------------------------------------------------------
// T3: 再発防止テスト — Path B 銘柄フィルタの意図確認
// ---------------------------------------------------------------------------

describe('T3: 再発防止 — Path B が週末にFXを取引しないこと', () => {
  it('[根本原因再発防止] 週末クローズ中に getTradeableInstruments を経由すると USD/JPY が除外される', () => {
    // このテストが失敗 = 週末制限ガードが壊れた、または削除された
    const sunday = utc(0, 10); // 日曜10:00 UTC = Phase 4
    const status = getWeekendStatus(sunday);
    expect(status.marketClosed).toBe(true);

    const tradeable = getTradeableInstruments(DUMMY_INSTRUMENTS, status);
    const fxPairs = tradeable.filter(i => !CRYPTO_PAIRS_SET.has(i.pair));
    expect(fxPairs).toHaveLength(0); // FX銘柄が1件でも含まれたら失敗
  });

  it('CRYPTO_PAIRS は weekend.ts の Single Source of Truth から来ること', () => {
    // CRYPTO_PAIRS が正しく定義されているかの基本確認
    expect(CRYPTO_PAIRS).toContain('BTC/USD');
    expect(CRYPTO_PAIRS).toContain('ETH/USD');
    expect(CRYPTO_PAIRS).toContain('SOL/USD');
    expect(CRYPTO_PAIRS.length).toBe(3);
    // Set版も一致していること
    expect(CRYPTO_PAIRS_SET.size).toBe(3);
  });
});
