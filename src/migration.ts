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
  {
    version: 102,
    description: 'positions.log_return カラム追加',
    sql: 'ALTER TABLE positions ADD COLUMN log_return REAL',
  },
  {
    version: 103,
    description: 'decisions.prompt_version カラム追加',
    sql: 'ALTER TABLE decisions ADD COLUMN prompt_version TEXT',
  },
  {
    version: 110,
    description: 'instrument_scores に thompson_alpha カラム追加',
    sql: 'ALTER TABLE instrument_scores ADD COLUMN thompson_alpha REAL NOT NULL DEFAULT 1',
  },
  {
    version: 111,
    description: 'instrument_scores に thompson_beta カラム追加',
    sql: 'ALTER TABLE instrument_scores ADD COLUMN thompson_beta REAL NOT NULL DEFAULT 1',
  },
  {
    version: 200,
    description: 'risk_state テーブル新設（HWM・DD管理用）',
    sql: `CREATE TABLE IF NOT EXISTS risk_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  },
  // Phase 2: テクニカル基盤
  {
    version: 201,
    description: 'decisions に strategy カラム追加',
    sql: 'ALTER TABLE decisions ADD COLUMN strategy TEXT',
  },
  {
    version: 202,
    description: 'decisions に confidence カラム追加',
    sql: 'ALTER TABLE decisions ADD COLUMN confidence INTEGER',
  },
  {
    version: 203,
    description: 'positions に strategy/regime/session/confidence 追加（4カラム）',
    sql: `CREATE TABLE IF NOT EXISTS _dummy_v203 (id INTEGER PRIMARY KEY)`,
  },
  // Phase 3: ポジション管理
  {
    version: 204,
    description: 'positions に partial_closed_lot/original_lot/tp1_hit 追加',
    sql: `CREATE TABLE IF NOT EXISTS _dummy_v204 (id INTEGER PRIMARY KEY)`,
  },
  // Phase 5: PDCA自動化
  {
    version: 205,
    description: 'trade_logs テーブル新設 + インデックス',
    sql: `CREATE TABLE IF NOT EXISTS trade_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      pair TEXT NOT NULL,
      direction TEXT NOT NULL,
      strategy TEXT,
      regime TEXT,
      session TEXT,
      confidence INTEGER,
      entry_rate REAL NOT NULL,
      close_rate REAL,
      tp_rate REAL, sl_rate REAL,
      lot REAL,
      pnl REAL,
      rr_ratio REAL,
      entry_at TEXT NOT NULL,
      closed_at TEXT,
      close_reason TEXT,
      vix_at_entry REAL,
      atr_at_entry REAL,
      reasoning TEXT,
      created_at TEXT NOT NULL
    )`,
  },
  {
    version: 206,
    description: 'trade_logs インデックス追加',
    sql: `CREATE INDEX IF NOT EXISTS idx_trade_logs_strategy ON trade_logs(strategy, regime)`,
  },
  {
    version: 207,
    description: 'trade_logs pair インデックス追加',
    sql: `CREATE INDEX IF NOT EXISTS idx_trade_logs_pair ON trade_logs(pair, closed_at DESC)`,
  },
  {
    version: 208,
    description: 'decisions に skip_reason カラム追加（未実行理由表示用）',
    // NOTE: v208 は本番DBで旧定義（skip_reason）で適用済み。trigger は v211 で追加。
    sql: `CREATE TABLE IF NOT EXISTS _dummy_v208 (id INTEGER PRIMARY KEY)`,
  },
  {
    version: 209,
    description: 'token_usage テーブル新設（モデル別トークン使用量記録）',
    sql: `CREATE TABLE IF NOT EXISTS token_usage (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      model      TEXT    NOT NULL,
      call_type  TEXT    NOT NULL,
      pair       TEXT,
      input_tok  INTEGER NOT NULL DEFAULT 0,
      output_tok INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL
    )`,
  },
  {
    version: 210,
    description: 'token_usage インデックス追加',
    sql: `CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage(created_at DESC)`,
  },
  {
    version: 211,
    description: 'positions に trigger カラム追加（RATE/SCHED/NEWS トリガー識別）※v208の再適用対策',
    sql: 'ALTER TABLE positions ADD COLUMN trigger TEXT',
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

    // version 110/111 は ALTER TABLE（特殊処理: カラムが既存でも無視）
    if (m.version === 110) {
      try {
        await db.prepare(`ALTER TABLE instrument_scores ADD COLUMN thompson_alpha REAL NOT NULL DEFAULT 1`).run();
      } catch {
        // カラムが既に存在する場合は無視
      }
      await db.prepare(
        'INSERT OR IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)'
      ).bind(m.version, m.description, new Date().toISOString()).run();
      console.log(`[migration] Applied v${m.version}: ${m.description}`);
      continue;
    }
    if (m.version === 111) {
      try {
        await db.prepare(`ALTER TABLE instrument_scores ADD COLUMN thompson_beta REAL NOT NULL DEFAULT 1`).run();
      } catch {
        // カラムが既に存在する場合は無視
      }
      await db.prepare(
        'INSERT OR IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)'
      ).bind(m.version, m.description, new Date().toISOString()).run();
      console.log(`[migration] Applied v${m.version}: ${m.description}`);
      continue;
    }

    // version 201/202 は ALTER TABLE（カラムが既存でも無視）
    if (m.version === 201 || m.version === 202) {
      try {
        await db.prepare(m.sql).run();
      } catch {
        // カラムが既に存在する場合は無視
      }
      await db.prepare(
        'INSERT OR IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)'
      ).bind(m.version, m.description, new Date().toISOString()).run();
      console.log(`[migration] Applied v${m.version}: ${m.description}`);
      continue;
    }

    // version 203: positions に4カラム追加
    if (m.version === 203) {
      for (const col of [
        'ALTER TABLE positions ADD COLUMN strategy TEXT',
        'ALTER TABLE positions ADD COLUMN regime TEXT',
        'ALTER TABLE positions ADD COLUMN session TEXT',
        'ALTER TABLE positions ADD COLUMN confidence INTEGER',
      ]) {
        try { await db.prepare(col).run(); } catch {}
      }
      await db.prepare(
        'INSERT OR IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)'
      ).bind(m.version, m.description, new Date().toISOString()).run();
      console.log(`[migration] Applied v${m.version}: ${m.description}`);
      continue;
    }

    // version 204: positions に分割決済用3カラム追加
    if (m.version === 204) {
      for (const col of [
        'ALTER TABLE positions ADD COLUMN partial_closed_lot REAL DEFAULT 0',
        'ALTER TABLE positions ADD COLUMN original_lot REAL',
        'ALTER TABLE positions ADD COLUMN tp1_hit INTEGER DEFAULT 0',
      ]) {
        try { await db.prepare(col).run(); } catch {}
      }
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
      if (msg.includes('already exists') || msg.includes('duplicate column name')) {
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
