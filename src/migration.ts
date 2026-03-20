// スキーママイグレーション管理
// schema_version テーブルで番号管理。冪等性保証。

const MIGRATIONS: Array<{ version: number; description: string; sql: string }> = [
  {
    version: 1,
    description: 'schema_version テーブル作成',
    sql: `CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      description TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL
    )`,
  },
  {
    version: 2,
    description: 'positions に source, oanda_trade_id カラム + instrument_scores テーブル',
    sql: `CREATE TABLE IF NOT EXISTS instrument_scores (
      pair TEXT PRIMARY KEY, total_trades INTEGER DEFAULT 0,
      win_rate REAL DEFAULT 0, avg_rr REAL DEFAULT 0,
      sharpe REAL DEFAULT 0, correlation REAL DEFAULT 0,
      score REAL DEFAULT 0, updated_at TEXT)`,
  },
  {
    version: 3,
    description: 'パフォーマンス用インデックス追加',
    sql: `CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status)`,
  },
  {
    version: 4,
    description: 'パフォーマンス用インデックス追加 (pair_status)',
    sql: `CREATE INDEX IF NOT EXISTS idx_positions_pair_status ON positions(pair, status)`,
  },
  {
    version: 5,
    description: 'パフォーマンス用インデックス追加 (decisions)',
    sql: `CREATE INDEX IF NOT EXISTS idx_decisions_pair_created ON decisions(pair, created_at DESC)`,
  },
  {
    version: 6,
    description: 'パフォーマンス用インデックス追加 (system_logs)',
    sql: `CREATE INDEX IF NOT EXISTS idx_system_logs_id_desc ON system_logs(id DESC)`,
  },
  {
    version: 7,
    description: 'decisions に outcome カラム追加（AI的中率トラッキング）',
    sql: `CREATE TABLE IF NOT EXISTS _dummy_v7 (id INTEGER PRIMARY KEY)`,
    // ALTER TABLE は別途 run() で処理（下記 runMigrations 内の特殊ケース参照）
  },
  {
    version: 100,
    description: 'SL分析・トンプソンサンプリング用インデックス',
    sql: `CREATE INDEX IF NOT EXISTS idx_positions_close_reason ON positions(close_reason, closed_at DESC)`,
  },
  {
    version: 101,
    description: '決定履歴インデックス',
    sql: `CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_at DESC)`,
  },
];

export async function runMigrations(db: D1Database): Promise<void> {
  // schema_version テーブル自体がなければ先に作成（ブートストラップ）
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version INTEGER PRIMARY KEY,
       description TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`
  ).run();

  // 旧方式（market_cache の schema_version）からの移行: 適用済みとしてマーク
  // 旧バージョン管理では version 2〜5 相当が market_cache に記録されていた
  // 既存環境でも重複適用が起きないよう、旧フラグを確認して移行済み版数を推定する
  const appliedRows = await db
    .prepare('SELECT version FROM schema_version')
    .all<{ version: number }>();
  const appliedSet = new Set((appliedRows.results ?? []).map(r => r.version));

  // 旧方式の schema_version が market_cache にある場合、既適用バージョンを登録
  if (appliedSet.size === 0) {
    try {
      const legacyRow = await db
        .prepare(`SELECT value FROM market_cache WHERE key = 'schema_version'`)
        .first<{ value: string }>();
      if (legacyRow?.value) {
        const legacyVersion = parseInt(legacyRow.value, 10) || 0;
        // 旧バージョン 1〜5 は新方式 version 1〜6 に対応（既適用とみなす）
        // 旧 version 5 = outcomes カラム = 新方式 version 7 まで適用済み
        const markUpTo = legacyVersion >= 5 ? 7 : legacyVersion >= 4 ? 6 : legacyVersion >= 3 ? 6 : legacyVersion >= 2 ? 2 : 0;
        if (markUpTo > 0) {
          const now = new Date().toISOString();
          const toMark = MIGRATIONS.filter(m => m.version <= markUpTo);
          for (const m of toMark) {
            if (!appliedSet.has(m.version)) {
              await db.prepare(
                'INSERT OR IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)'
              ).bind(m.version, m.description, now).run();
              appliedSet.add(m.version);
            }
          }
          console.log(`[migration] 旧方式 v${legacyVersion} → 新方式 v${markUpTo} 移行完了`);
        }
      }
    } catch {
      // market_cache が存在しない場合は無視（新規環境）
    }
  }

  // 未適用のマイグレーションを順番に実行
  for (const m of MIGRATIONS) {
    if (appliedSet.has(m.version)) continue;

    // version 7 は ALTER TABLE（特殊処理）
    if (m.version === 7) {
      try {
        await db.prepare(`ALTER TABLE decisions ADD COLUMN outcome TEXT`).run();
      } catch {
        // カラムが既に存在する場合は無視
      }
      // outcome の事後紐付けは省略（新規データから自動記録）
      await db.prepare(
        'INSERT OR IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)'
      ).bind(m.version, m.description, new Date().toISOString()).run();
      console.log(`[migration] Applied v${m.version}: ${m.description}`);
      continue;
    }

    // version 2 は ALTER TABLE も含む
    if (m.version === 2) {
      try {
        await db.prepare(`ALTER TABLE positions ADD COLUMN source TEXT DEFAULT 'paper'`).run();
      } catch {}
      try {
        await db.prepare(`ALTER TABLE positions ADD COLUMN oanda_trade_id TEXT`).run();
      } catch {}
    }

    try {
      await db.prepare(m.sql).run();
      await db.prepare(
        'INSERT INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)'
      ).bind(m.version, m.description, new Date().toISOString()).run();
      console.log(`[migration] Applied v${m.version}: ${m.description}`);
    } catch (e) {
      const msg = String(e);
      if (msg.includes('already exists')) {
        await db.prepare(
          'INSERT OR IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)'
        ).bind(m.version, m.description, new Date().toISOString()).run();
        console.log(`[migration] v${m.version} already exists, marked as applied`);
      } else {
        console.error(`[migration] Failed v${m.version}: ${msg}`);
        throw e;
      }
    }
  }
}
