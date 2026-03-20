// スキーママイグレーション管理
// バージョン番号ベースで順序実行。market_cache に 'schema_version' として記録。

import { getCacheValue, setCacheValue } from './db';

interface Migration {
  version: number;
  description: string;
  up: (db: D1Database) => Promise<void>;
}

const migrations: Migration[] = [
  {
    version: 2,
    description: 'positions に source, oanda_trade_id カラム + instrument_scores テーブル',
    async up(db) {
      try {
        await db.prepare(`ALTER TABLE positions ADD COLUMN source TEXT DEFAULT 'paper'`).run();
        await db.prepare(`ALTER TABLE positions ADD COLUMN oanda_trade_id TEXT`).run();
      } catch {}
      await db.prepare(`CREATE TABLE IF NOT EXISTS instrument_scores (
        pair TEXT PRIMARY KEY, total_trades INTEGER DEFAULT 0,
        win_rate REAL DEFAULT 0, avg_rr REAL DEFAULT 0,
        sharpe REAL DEFAULT 0, correlation REAL DEFAULT 0,
        score REAL DEFAULT 0, updated_at TEXT)`).run();
    },
  },
  {
    version: 3,
    description: 'パフォーマンス用インデックス追加',
    async up(db) {
      await db.batch([
        db.prepare('CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status)'),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_positions_pair_status ON positions(pair, status)'),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_decisions_pair_created ON decisions(pair, created_at DESC)'),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_system_logs_id_desc ON system_logs(id DESC)'),
      ]);
    },
  },
  {
    version: 4,
    description: '旧PnL(pt)→円に変換',
    async up(db) {
      await db.prepare(`UPDATE positions SET pnl = pnl * 100 WHERE pair = 'S&P500' AND status = 'CLOSED' AND pnl IS NOT NULL`).run();
      await db.prepare(`UPDATE positions SET pnl = pnl * 50 WHERE pair = 'US10Y' AND status = 'CLOSED' AND pnl IS NOT NULL`).run();
      await db.prepare(`UPDATE positions SET pnl = pnl * 10 WHERE pair = 'Nikkei225' AND status = 'CLOSED' AND pnl IS NOT NULL`).run();
    },
  },
];

/** 未適用マイグレーションを順次実行 */
export async function runMigrations(db: D1Database): Promise<void> {
  // 現在のバージョンを取得（旧フラグとの互換性も考慮）
  let currentVersion = 0;
  const versionStr = await getCacheValue(db, 'schema_version');
  if (versionStr) {
    currentVersion = parseInt(versionStr, 10) || 0;
  } else {
    // 旧フラグからバージョンを推定（既存環境との互換性）
    const v2 = await getCacheValue(db, 'schema_v2_migrated');
    const v3 = await getCacheValue(db, 'schema_v3_indexes');
    const pnl = await getCacheValue(db, 'pnl_yen_migrated');
    if (pnl) currentVersion = 4;
    else if (v3) currentVersion = 3;
    else if (v2) currentVersion = 2;
  }

  const pending = migrations.filter(m => m.version > currentVersion);
  if (pending.length === 0) return;

  for (const m of pending) {
    try {
      await m.up(db);
      console.log(`[migration] v${m.version}: ${m.description}`);
    } catch (e) {
      console.log(`[migration] v${m.version} partial: ${String(e).slice(0, 100)}`);
    }
    await setCacheValue(db, 'schema_version', String(m.version));
  }
}
