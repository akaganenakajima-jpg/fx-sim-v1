/**
 * session.ts ユニットテスト
 *
 * T024 応急対応: 新日本株9銘柄が session matrix に正しく登録されているか検証
 *
 * 確認項目:
 *   - 新9銘柄: tokyo=1.0, london=0, ny=0, overlap=0
 *   - 旧10銘柄: 既存挙動が壊れていないこと（回帰）
 *   - 米国株 / FX / crypto: 影響を受けていないこと
 */
import { describe, it, expect } from 'vitest';
import { getSessionInstrumentMultiplier } from './session';

// ─── helper ────────────────────────────────────────────────────────────────
type SessionName = 'tokyo' | 'london' | 'ny' | 'overlap';

interface Case {
  pair: string;
  session: SessionName;
  expected: number;
}

function run(cases: Case[]) {
  it.each(cases)('$pair @ $session → $expected', ({ pair, session, expected }) => {
    expect(getSessionInstrumentMultiplier(session, pair)).toBe(expected);
  });
}

// ─── 新9銘柄: T024 追加分 ──────────────────────────────────────────────────
describe('新9銘柄 — TSE閉場時はブロック', () => {
  const newJpStocks = [
    'さくらインターネット',
    '商船三井',
    '東京海上HD',
    '三菱商事',
    'トヨタ',
    '三菱重工',
    'IHI',
    'ANYCOLOR',
    'カバー',
  ];

  describe('tokyo = 1.0', () => {
    run(newJpStocks.map(pair => ({ pair, session: 'tokyo', expected: 1.0 })));
  });

  describe('london = 0（TSE閉場）', () => {
    run(newJpStocks.map(pair => ({ pair, session: 'london', expected: 0 })));
  });

  describe('ny = 0（TSE閉場）', () => {
    run(newJpStocks.map(pair => ({ pair, session: 'ny', expected: 0 })));
  });

  describe('overlap = 0（TSE閉場）', () => {
    run(newJpStocks.map(pair => ({ pair, session: 'overlap', expected: 0 })));
  });
});

// ─── 旧10銘柄: 回帰テスト ──────────────────────────────────────────────────
describe('旧10銘柄 — 既存挙動が壊れていないこと（回帰）', () => {
  const oldJpStocks = [
    '川崎汽船',
    '日本郵船',
    'ソフトバンクG',
    'レーザーテック',
    '東京エレクトロン',
    'ディスコ',
    'アドバンテスト',
    'ファーストリテイリング',
    '日本製鉄',
    '三菱UFJ',
  ];

  describe('tokyo = 1.0', () => {
    run(oldJpStocks.map(pair => ({ pair, session: 'tokyo', expected: 1.0 })));
  });

  describe('london = 0', () => {
    run(oldJpStocks.map(pair => ({ pair, session: 'london', expected: 0 })));
  });

  describe('ny = 0', () => {
    run(oldJpStocks.map(pair => ({ pair, session: 'ny', expected: 0 })));
  });

  describe('overlap = 0', () => {
    run(oldJpStocks.map(pair => ({ pair, session: 'overlap', expected: 0 })));
  });
});

// ─── early_morning: 全銘柄0 ────────────────────────────────────────────────
describe('early_morning — 全銘柄取引禁止', () => {
  const allJpStocks = [
    // 新9
    'さくらインターネット', '商船三井', '東京海上HD', '三菱商事', 'トヨタ',
    '三菱重工', 'IHI', 'ANYCOLOR', 'カバー',
    // 旧10
    '川崎汽船', '日本郵船', 'ソフトバンクG',
  ];
  run(allJpStocks.map(pair => ({ pair, session: 'early_morning' as any, expected: 0 })));
});

// ─── 米国株: 影響なし ─────────────────────────────────────────────────────
describe('米国株 — 影響を受けていないこと', () => {
  const cases: Case[] = [
    { pair: 'NVDA',  session: 'tokyo',   expected: 0   },
    { pair: 'NVDA',  session: 'london',  expected: 0.3 },
    { pair: 'NVDA',  session: 'ny',      expected: 1.0 },
    { pair: 'NVDA',  session: 'overlap', expected: 0.8 },
    { pair: 'AAPL',  session: 'tokyo',   expected: 0   },
    { pair: 'AAPL',  session: 'ny',      expected: 1.0 },
    { pair: 'TSLA',  session: 'london',  expected: 0.3 },
    { pair: 'GOOGL', session: 'ny',      expected: 1.0 },
  ];
  run(cases);
});

// ─── FX / crypto: 影響なし ────────────────────────────────────────────────
describe('FX / crypto — 影響を受けていないこと', () => {
  const cases: Case[] = [
    { pair: 'USD/JPY',  session: 'tokyo',   expected: 1.0 },
    { pair: 'USD/JPY',  session: 'london',  expected: 0.5 },
    { pair: 'USD/JPY',  session: 'ny',      expected: 0.8 },
    { pair: 'USD/JPY',  session: 'overlap', expected: 0.8 },
    { pair: 'EUR/USD',  session: 'london',  expected: 1.0 },
    { pair: 'BTC/USD',  session: 'ny',      expected: 1.0 },
    { pair: 'BTC/USD',  session: 'overlap', expected: 0.8 },
    { pair: 'SP500',    session: 'ny',      expected: 1.0 },
    { pair: 'NIKKEI225',session: 'tokyo',   expected: 1.0 },
  ];
  run(cases);
});
