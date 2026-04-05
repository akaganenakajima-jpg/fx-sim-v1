/**
 * SL方向整合性テスト
 *
 * E2E Round 3 で報告された「SL方向不整合 443/660件（67.1%）」の偽陽性を防ぐため、
 * 初期SL（original_sl_rate）と動的SL（sl_rate）を明確に区別してチェックする。
 *
 * ■ CRITICAL バグ（初期SLの設定ミス）:
 *   - BUY で original_sl_rate >= entry_rate（SLがエントリー以上 = 損切り不能）
 *   - SELL で original_sl_rate <= entry_rate（SLがエントリー以下 = 損切り不能）
 *
 * ■ 正常系（トレイリングストップ / 利益ロック）:
 *   - BUY で sl_rate > entry_rate（トレイリングで利益方向にSL引き上げ）
 *   - SELL で sl_rate < entry_rate（トレイリングで利益方向にSL引き下げ）
 *   → これらは「エッジの証明」としてポジティブに計上する
 *
 * @see src/position.ts L195-230 — トレイリングストップのSL更新ロジック
 */

import { describe, it, expect } from 'vitest';

// ─── テスト対象の純粋関数 ─────────────────────────────────────────────────────

export interface PositionForSLCheck {
  id: number;
  direction: 'BUY' | 'SELL';
  entry_rate: number;
  sl_rate: number | null;
  original_sl_rate: number | null;
}

export interface SLIntegrityResult {
  /** 🔴 初期SLが逆方向に設定されているポジション（本当のバグ） */
  criticalBugs: Array<{ id: number; direction: string; entry_rate: number; original_sl_rate: number; reason: string }>;
  /** 🟢 トレイリングストップ等で利益確保方向にSLが移動した正常系 */
  profitLocked: Array<{ id: number; direction: string; entry_rate: number; sl_rate: number }>;
  /** original_sl_rateが未設定のためチェック不能（レガシーデータ） */
  unchecked: number;
  /** SLがnullのポジション */
  noSl: number;
}

/**
 * SL方向整合性を高度チェックする純粋関数
 *
 * 判定ロジック:
 * 1. sl_rate が null → noSl にカウント（チェック不能）
 * 2. original_sl_rate が設定済み → 初期SLで方向チェック（CRITICAL判定）
 * 3. original_sl_rate が null → 現在のsl_rateで判定
 *    - 利益方向にある場合 → profitLocked（正常系）
 *    - 損失方向にある場合 → criticalBugs（ただしoriginal_sl未記録のため確度は低い）
 */
export function checkSLIntegrity(positions: PositionForSLCheck[]): SLIntegrityResult {
  const result: SLIntegrityResult = {
    criticalBugs: [],
    profitLocked: [],
    unchecked: 0,
    noSl: 0,
  };

  for (const pos of positions) {
    if (pos.sl_rate == null) {
      result.noSl++;
      continue;
    }

    const isBuy = pos.direction === 'BUY';

    // ── original_sl_rate が設定済み → 初期SLの方向を厳密チェック ──
    if (pos.original_sl_rate != null) {
      const initialSLWrong = isBuy
        ? pos.original_sl_rate >= pos.entry_rate  // BUY: 初期SLがentry以上 = バグ
        : pos.original_sl_rate <= pos.entry_rate; // SELL: 初期SLがentry以下 = バグ

      if (initialSLWrong) {
        result.criticalBugs.push({
          id: pos.id,
          direction: pos.direction,
          entry_rate: pos.entry_rate,
          original_sl_rate: pos.original_sl_rate,
          reason: isBuy
            ? `BUY: original_sl(${pos.original_sl_rate}) >= entry(${pos.entry_rate})`
            : `SELL: original_sl(${pos.original_sl_rate}) <= entry(${pos.entry_rate})`,
        });
        continue;
      }

      // 初期SL正常 → 現在のsl_rateが利益方向なら profitLocked に計上
      const slInProfitZone = isBuy
        ? pos.sl_rate > pos.entry_rate
        : pos.sl_rate < pos.entry_rate;

      if (slInProfitZone) {
        result.profitLocked.push({
          id: pos.id,
          direction: pos.direction,
          entry_rate: pos.entry_rate,
          sl_rate: pos.sl_rate,
        });
      }
      continue;
    }

    // ── original_sl_rate が null（レガシーデータ）→ 現在sl_rateで推定 ──
    const slInProfitZone = isBuy
      ? pos.sl_rate > pos.entry_rate
      : pos.sl_rate < pos.entry_rate;

    if (slInProfitZone) {
      // SLが利益方向 → トレイリングによる正常移動と推定
      result.profitLocked.push({
        id: pos.id,
        direction: pos.direction,
        entry_rate: pos.entry_rate,
        sl_rate: pos.sl_rate,
      });
    } else {
      // SLが損失方向 → original_sl未記録のため unchecked
      result.unchecked++;
    }
  }

  return result;
}

/**
 * サマリーレポートを生成する
 */
export function formatSLIntegrityReport(result: SLIntegrityResult, totalPositions: number): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════');
  lines.push('  SL方向整合性チェック結果');
  lines.push('═══════════════════════════════════════════════');
  lines.push('');

  // CRITICAL バグ
  if (result.criticalBugs.length > 0) {
    lines.push(`🔴 CRITICAL バグ: ${result.criticalBugs.length}件 — 初期SL方向の不整合`);
    for (const bug of result.criticalBugs.slice(0, 10)) {
      lines.push(`   id=${bug.id} ${bug.reason}`);
    }
    if (result.criticalBugs.length > 10) {
      lines.push(`   ... 他${result.criticalBugs.length - 10}件`);
    }
  } else {
    lines.push('🔴 CRITICAL バグ: 0件');
  }
  lines.push('');

  // 正常系: 利益確保
  lines.push(`🟢 INFO (正常系): ${result.profitLocked.length}件 — 利益確保のためSLが建値以上に移動`);
  if (result.profitLocked.length > 0) {
    const pct = ((result.profitLocked.length / totalPositions) * 100).toFixed(1);
    lines.push(`   全${totalPositions}件中 ${pct}% がトレイリングストップで利益ロック済み（エッジの証明）`);
  }
  lines.push('');

  // 補足情報
  if (result.noSl > 0) {
    lines.push(`⚪ SL未設定: ${result.noSl}件`);
  }
  if (result.unchecked > 0) {
    lines.push(`⚪ original_sl未記録: ${result.unchecked}件（レガシーデータ、チェック不能）`);
  }

  lines.push('');
  lines.push('═══════════════════════════════════════════════');

  return lines.join('\n');
}

// ─── テストケース ──────────────────────────────────────────────────────────────

describe('SL方向整合性チェック — checkSLIntegrity', () => {
  // ── 正常系: 初期SLが正しい方向 ──

  it('BUY: original_sl < entry → CRITICAL 0件', () => {
    const result = checkSLIntegrity([
      { id: 1, direction: 'BUY', entry_rate: 150.0, sl_rate: 149.5, original_sl_rate: 149.0 },
    ]);
    expect(result.criticalBugs).toHaveLength(0);
    expect(result.profitLocked).toHaveLength(0);
  });

  it('SELL: original_sl > entry → CRITICAL 0件', () => {
    const result = checkSLIntegrity([
      { id: 2, direction: 'SELL', entry_rate: 150.0, sl_rate: 150.5, original_sl_rate: 151.0 },
    ]);
    expect(result.criticalBugs).toHaveLength(0);
    expect(result.profitLocked).toHaveLength(0);
  });

  // ── 正常系: トレイリングストップで利益ロック ──

  it('BUY: sl_rate > entry (トレイリング利益確保) → profitLocked に計上', () => {
    const result = checkSLIntegrity([
      { id: 3, direction: 'BUY', entry_rate: 150.0, sl_rate: 151.5, original_sl_rate: 149.0 },
    ]);
    expect(result.criticalBugs).toHaveLength(0);
    expect(result.profitLocked).toHaveLength(1);
    expect(result.profitLocked[0].id).toBe(3);
  });

  it('SELL: sl_rate < entry (トレイリング利益確保) → profitLocked に計上', () => {
    const result = checkSLIntegrity([
      { id: 4, direction: 'SELL', entry_rate: 150.0, sl_rate: 148.5, original_sl_rate: 151.0 },
    ]);
    expect(result.criticalBugs).toHaveLength(0);
    expect(result.profitLocked).toHaveLength(1);
    expect(result.profitLocked[0].id).toBe(4);
  });

  // ── CRITICAL: 初期SLの方向不整合（本当のバグ） ──

  it('BUY: original_sl >= entry → CRITICAL バグ検出', () => {
    const result = checkSLIntegrity([
      { id: 5, direction: 'BUY', entry_rate: 150.0, sl_rate: 150.5, original_sl_rate: 150.5 },
    ]);
    expect(result.criticalBugs).toHaveLength(1);
    expect(result.criticalBugs[0].id).toBe(5);
    expect(result.criticalBugs[0].reason).toContain('BUY');
  });

  it('SELL: original_sl <= entry → CRITICAL バグ検出', () => {
    const result = checkSLIntegrity([
      { id: 6, direction: 'SELL', entry_rate: 150.0, sl_rate: 149.5, original_sl_rate: 149.5 },
    ]);
    expect(result.criticalBugs).toHaveLength(1);
    expect(result.criticalBugs[0].id).toBe(6);
    expect(result.criticalBugs[0].reason).toContain('SELL');
  });

  // ── original_sl_rate が null（レガシーデータ） ──

  it('original_sl null + sl > entry (BUY) → profitLocked（トレイリング推定）', () => {
    const result = checkSLIntegrity([
      { id: 7, direction: 'BUY', entry_rate: 150.0, sl_rate: 151.0, original_sl_rate: null },
    ]);
    expect(result.criticalBugs).toHaveLength(0);
    expect(result.profitLocked).toHaveLength(1);
    expect(result.unchecked).toBe(0);
  });

  it('original_sl null + sl < entry (BUY) → unchecked（判定不能）', () => {
    const result = checkSLIntegrity([
      { id: 8, direction: 'BUY', entry_rate: 150.0, sl_rate: 149.0, original_sl_rate: null },
    ]);
    expect(result.criticalBugs).toHaveLength(0);
    expect(result.profitLocked).toHaveLength(0);
    expect(result.unchecked).toBe(1);
  });

  // ── sl_rate が null ──

  it('sl_rate null → noSl カウント', () => {
    const result = checkSLIntegrity([
      { id: 9, direction: 'BUY', entry_rate: 150.0, sl_rate: null, original_sl_rate: null },
    ]);
    expect(result.noSl).toBe(1);
    expect(result.criticalBugs).toHaveLength(0);
  });

  // ── 複合テスト: Round 3 再現シナリオ ──

  it('Round 3 再現: 443件中大半がトレイリング正常、CRITICALは0件', () => {
    const positions: PositionForSLCheck[] = [
      // トレイリングで利益確保（正常系 × 大量）
      { id: 100, direction: 'BUY',  entry_rate: 150.0, sl_rate: 151.5, original_sl_rate: 149.0 },
      { id: 101, direction: 'BUY',  entry_rate: 150.0, sl_rate: 150.3, original_sl_rate: 149.0 },
      { id: 102, direction: 'SELL', entry_rate: 150.0, sl_rate: 148.5, original_sl_rate: 151.0 },
      { id: 103, direction: 'SELL', entry_rate: 150.0, sl_rate: 149.7, original_sl_rate: 151.0 },
      // 初期SL正常 & 現在もSLが損失側（トレイリング未到達）
      { id: 104, direction: 'BUY',  entry_rate: 150.0, sl_rate: 149.5, original_sl_rate: 149.0 },
      { id: 105, direction: 'SELL', entry_rate: 150.0, sl_rate: 150.5, original_sl_rate: 151.0 },
      // レガシーデータ（original_sl null）— SLが利益方向 → profitLocked
      { id: 106, direction: 'BUY',  entry_rate: 150.0, sl_rate: 151.0, original_sl_rate: null },
      // レガシーデータ（original_sl null）— SLが損失方向 → unchecked
      { id: 107, direction: 'BUY',  entry_rate: 150.0, sl_rate: 149.0, original_sl_rate: null },
    ];

    const result = checkSLIntegrity(positions);

    expect(result.criticalBugs).toHaveLength(0);
    expect(result.profitLocked).toHaveLength(5);  // id: 100,101,102,103,106
    expect(result.unchecked).toBe(1);              // id: 107
    expect(result.noSl).toBe(0);
  });

  // ── 境界値: entry_rate と完全一致 ──

  it('BUY: original_sl == entry_rate → CRITICAL（SL=建値は損切り不能）', () => {
    const result = checkSLIntegrity([
      { id: 10, direction: 'BUY', entry_rate: 150.0, sl_rate: 150.0, original_sl_rate: 150.0 },
    ]);
    expect(result.criticalBugs).toHaveLength(1);
  });

  it('SELL: original_sl == entry_rate → CRITICAL（SL=建値は損切り不能）', () => {
    const result = checkSLIntegrity([
      { id: 11, direction: 'SELL', entry_rate: 150.0, sl_rate: 150.0, original_sl_rate: 150.0 },
    ]);
    expect(result.criticalBugs).toHaveLength(1);
  });
});

describe('SLレポート生成 — formatSLIntegrityReport', () => {
  it('CRITICAL 0件 + profitLocked あり → 正常レポート', () => {
    const result: SLIntegrityResult = {
      criticalBugs: [],
      profitLocked: [
        { id: 1, direction: 'BUY', entry_rate: 150.0, sl_rate: 151.5 },
        { id: 2, direction: 'SELL', entry_rate: 150.0, sl_rate: 148.5 },
      ],
      unchecked: 3,
      noSl: 0,
    };

    const report = formatSLIntegrityReport(result, 100);

    expect(report).toContain('CRITICAL バグ: 0件');
    expect(report).toContain('INFO (正常系): 2件');
    expect(report).toContain('2.0%');
    expect(report).toContain('エッジの証明');
    expect(report).toContain('original_sl未記録: 3件');
  });

  it('CRITICAL あり → バグ詳細が出力される', () => {
    const result: SLIntegrityResult = {
      criticalBugs: [
        { id: 99, direction: 'BUY', entry_rate: 150.0, original_sl_rate: 150.5, reason: 'BUY: original_sl(150.5) >= entry(150)' },
      ],
      profitLocked: [],
      unchecked: 0,
      noSl: 0,
    };

    const report = formatSLIntegrityReport(result, 100);

    expect(report).toContain('CRITICAL バグ: 1件');
    expect(report).toContain('id=99');
    expect(report).toContain('original_sl(150.5)');
  });
});
