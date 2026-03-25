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
  // Ph.6: Path A廃止 + 拡張ロジックパラメーター
  // v212 はリモートDBに既適用のためダミー（v212特殊ハンドラーもスキップされる）→ v214 で実施
  {
    version: 212,
    description: 'instrument_params に拡張ロジックパラメーター5カラム追加（vix_tp/sl_scale, strategy_primary, min_signal_strength, macro_sl_scale）',
    sql: `CREATE TABLE IF NOT EXISTS _dummy_v212 (id INTEGER PRIMARY KEY)`,
  },
  // v213 はリモートDB側で別途適用済み（news_temp_params + news_trigger_log）→ ここには定義不要
  // v214: instrument_params に拡張ロジックパラメーター5カラム追加（v212衝突回避のため再設定）
  {
    version: 214,
    description: 'instrument_params に拡張ロジックパラメーター5カラム追加（Ph.6 Path A廃止 v212衝突回避）',
    sql: `CREATE TABLE IF NOT EXISTS _dummy_v214 (id INTEGER PRIMARY KEY)`,
  },
  // Ph.7: 重みつきエントリースコアリング
  {
    version: 215,
    description: '重みつきエントリースコアリング パラメーター追加（w_rsi/w_er/w_mtf/w_sr/w_pa/entry_score_min/min_rr_ratio）',
    sql: `CREATE TABLE IF NOT EXISTS _dummy_v215 (id INTEGER PRIMARY KEY)`,
  },
  // Ph.8: 金融理論ベース10パラメーター追加
  {
    version: 216,
    description: 'instrument_params に金融理論ベース10パラメーター追加（保有時間/クールダウン/連敗縮退/日次上限/トレイリングATR/TP1比率/セッション/レビュー最低N）',
    sql: `CREATE TABLE IF NOT EXISTS _dummy_v216 (id INTEGER PRIMARY KEY)`,
  },
  // Ph.9: エントリー精度7パラメーター追加（BB/ダイバージェンス/根拠多様性/ER上限）
  {
    version: 217,
    description: 'instrument_params にエントリー精度7パラメーター追加（bb_period/bb_squeeze_threshold/w_bb/w_div/divergence_lookback/min_confirm_signals/er_upper_limit）',
    sql: `CREATE TABLE IF NOT EXISTS _dummy_v217 (id INTEGER PRIMARY KEY)`,
  },
  // アクティビティフィード: 指標変化ログテーブル（RSI/ER変化をフィード表示）
  {
    version: 218,
    description: 'indicator_logs テーブル追加（RSI/ER変化ログ・アクティビティフィード用）',
    sql: `CREATE TABLE IF NOT EXISTS indicator_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pair        TEXT    NOT NULL,
  metric      TEXT    NOT NULL,
  prev_value  REAL    NOT NULL,
  curr_value  REAL    NOT NULL,
  direction   TEXT    NOT NULL,
  note        TEXT,
  created_at  TEXT    NOT NULL
)`,
  },
  // v219: RR≥1.0勝率統一 — positions に realized_rr カラム追加
  {
    version: 219,
    description: 'positions に realized_rr カラム追加（RR≥1.0勝率統一）',
    sql: 'ALTER TABLE positions ADD COLUMN realized_rr REAL',
  },
  // v220: instrument_scores に期間別RR集計カラム追加
  {
    version: 220,
    description: 'instrument_scores に期間別RR集計カラム追加（rr_30t/wr_30t/rr_daily/rr_weekly/rr_monthly/rr_trend）',
    sql: `CREATE TABLE IF NOT EXISTS _dummy_v220 (id INTEGER PRIMARY KEY)`,
  },
  // v221: positions に mae カラム追加（取引履歴: 最大含み損）
  {
    version: 221,
    description: 'positions に mae カラム追加（Max Adverse Excursion: 最大含み損）',
    sql: 'ALTER TABLE positions ADD COLUMN mae REAL',
  },
  // v222: positions に mfe カラム追加（取引履歴: 最大含み益）
  {
    version: 222,
    description: 'positions に mfe カラム追加（Max Favorable Excursion: 最大含み益）',
    sql: 'ALTER TABLE positions ADD COLUMN mfe REAL',
  },
  // v223: positions に original_sl_rate カラム追加（エントリー時SL保存 — realized_rr正規化用）
  // CLAUDE.md定義: 実現RR = 実現利益 / 初期リスク（エントリー時のSL距離）
  // trailing/TP1でsl_rateが変動しても初期リスクは不変
  {
    version: 223,
    description: 'positions に original_sl_rate カラム追加（エントリー時SL距離でのRR計算正規化）',
    sql: 'ALTER TABLE positions ADD COLUMN original_sl_rate REAL',
  },
  // v224: 旧データ修正 — realized_rr=0.00かつPnL>0の誤計算レコードをNULLに置換
  // 原因: trailing/TP1でsl_rate=entry_rateになった後の決済 → リスク距離=0 → 0返し
  // 修正: original_sl_rateが未存在の旧記録はNULL（計算不能）として扱う
  {
    version: 224,
    description: '旧realized_rr誤計算修正: pnl>0かつrealized_rr=0.0の誤レコードをNULLに置換',
    sql: `UPDATE positions SET realized_rr = NULL
          WHERE status = 'CLOSED' AND realized_rr = 0.0 AND pnl > 0`,
  },
  // v225: realized_rr 全件再計算 — Bロジック（値幅ベース・方向補正・ABS分母）統一
  // v219のバックフィルはABS未使用で trailing後SLがentry超えると負のRRになるバグがあった
  // original_sl_rate優先、なければsl_rateを使用。ABS(entry - sl)で常に正の分母を保証
  {
    version: 225,
    description: 'realized_rr全件再計算: Bロジック（ABS分母+方向補正+original_sl_rate優先）統一',
    sql: `UPDATE positions SET realized_rr =
            CASE direction
              WHEN 'BUY' THEN (close_rate - entry_rate) / NULLIF(ABS(entry_rate - COALESCE(original_sl_rate, sl_rate)), 0)
              WHEN 'SELL' THEN (entry_rate - close_rate) / NULLIF(ABS(entry_rate - COALESCE(original_sl_rate, sl_rate)), 0)
            END
          WHERE status = 'CLOSED' AND close_rate IS NOT NULL AND COALESCE(original_sl_rate, sl_rate) IS NOT NULL`,
  },
  // v226: OPEN/CLOSEDポジションの original_sl_rate バックフィル
  // v223でカラム追加前に作成されたポジションは original_sl_rate=null
  // sl_rateがまだ変動していない（trailingでentry超えていない）ポジションのsl_rateを初期値として記録
  {
    version: 226,
    description: 'original_sl_rateバックフィル: NULL既存ポジションにsl_rateをコピー',
    sql: `UPDATE positions SET original_sl_rate = sl_rate WHERE original_sl_rate IS NULL AND sl_rate IS NOT NULL`,
  },
  // v227: v226バックフィル後のrealized_rr再計算（v225と同一SQL）
  // v225が先にデプロイ済みの場合、v226でoriginal_sl_rateを埋めた後に再計算が必要
  {
    version: 227,
    description: 'realized_rr再計算(v226バックフィル後): original_sl_rate充填済みで再計算',
    sql: `UPDATE positions SET realized_rr =
            CASE direction
              WHEN 'BUY' THEN (close_rate - entry_rate) / NULLIF(ABS(entry_rate - COALESCE(original_sl_rate, sl_rate)), 0)
              WHEN 'SELL' THEN (entry_rate - close_rate) / NULLIF(ABS(entry_rate - COALESCE(original_sl_rate, sl_rate)), 0)
            END
          WHERE status = 'CLOSED' AND close_rate IS NOT NULL AND COALESCE(original_sl_rate, sl_rate) IS NOT NULL`,
  },
  // v228: realized_rr=NULL残存レコード救済
  // sl_rateもoriginal_sl_rateもNULLのレコードは通常のRR計算不能
  // → realized_rr = 0 として記録（「計算不能」ではなく「リスク距離不明のため中立」扱い）
  {
    version: 228,
    description: 'realized_rr=NULL残存レコードを0で埋める（SL不明のため中立RR）',
    sql: `UPDATE positions SET realized_rr = 0
          WHERE status = 'CLOSED' AND realized_rr IS NULL AND close_rate IS NOT NULL`,
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

    // version 212: ダミー（v212はリモートDBに既適用済みのためスキップされるはず）
    if (m.version === 212) {
      await db.prepare(
        'INSERT OR IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)'
      ).bind(m.version, m.description, new Date().toISOString()).run();
      console.log(`[migration] Applied v${m.version}: ${m.description} (dummy)`);
      continue;
    }

    // version 214: instrument_params に拡張ロジックパラメーター5カラム追加（v212衝突回避）
    if (m.version === 214) {
      for (const col of [
        'ALTER TABLE instrument_params ADD COLUMN vix_tp_scale REAL NOT NULL DEFAULT 1.0',
        'ALTER TABLE instrument_params ADD COLUMN vix_sl_scale REAL NOT NULL DEFAULT 1.0',
        "ALTER TABLE instrument_params ADD COLUMN strategy_primary TEXT NOT NULL DEFAULT 'mean_reversion'",
        'ALTER TABLE instrument_params ADD COLUMN min_signal_strength REAL NOT NULL DEFAULT 0.0',
        'ALTER TABLE instrument_params ADD COLUMN macro_sl_scale REAL NOT NULL DEFAULT 1.0',
      ]) {
        try { await db.prepare(col).run(); } catch {}
      }
      await db.prepare(
        'INSERT OR IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)'
      ).bind(m.version, m.description, new Date().toISOString()).run();
      console.log(`[migration] Applied v${m.version}: ${m.description}`);
      continue;
    }

    // version 215: Ph.7 重みつきエントリースコアリング パラメーター追加
    if (m.version === 215) {
      for (const col of [
        'ALTER TABLE instrument_params ADD COLUMN w_rsi REAL NOT NULL DEFAULT 0.35',
        'ALTER TABLE instrument_params ADD COLUMN w_er REAL NOT NULL DEFAULT 0.25',
        'ALTER TABLE instrument_params ADD COLUMN w_mtf REAL NOT NULL DEFAULT 0.20',
        'ALTER TABLE instrument_params ADD COLUMN w_sr REAL NOT NULL DEFAULT 0.10',
        'ALTER TABLE instrument_params ADD COLUMN w_pa REAL NOT NULL DEFAULT 0.10',
        'ALTER TABLE instrument_params ADD COLUMN entry_score_min REAL NOT NULL DEFAULT 0.30',
        'ALTER TABLE instrument_params ADD COLUMN min_rr_ratio REAL NOT NULL DEFAULT 1.5',
      ]) {
        try { await db.prepare(col).run(); } catch {}
      }
      await db.prepare(
        'INSERT OR IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)'
      ).bind(m.version, m.description, new Date().toISOString()).run();
      console.log(`[migration] Applied v${m.version}: ${m.description}`);
      continue;
    }

    // version 216: Ph.8 金融理論ベース10パラメーター追加
    if (m.version === 216) {
      for (const col of [
        'ALTER TABLE instrument_params ADD COLUMN max_hold_minutes INTEGER NOT NULL DEFAULT 480',
        'ALTER TABLE instrument_params ADD COLUMN cooldown_after_sl INTEGER NOT NULL DEFAULT 5',
        'ALTER TABLE instrument_params ADD COLUMN consecutive_loss_shrink INTEGER NOT NULL DEFAULT 3',
        'ALTER TABLE instrument_params ADD COLUMN daily_max_entries INTEGER NOT NULL DEFAULT 5',
        'ALTER TABLE instrument_params ADD COLUMN trailing_activation_atr REAL NOT NULL DEFAULT 2.0',
        'ALTER TABLE instrument_params ADD COLUMN trailing_distance_atr REAL NOT NULL DEFAULT 1.0',
        'ALTER TABLE instrument_params ADD COLUMN tp1_ratio REAL NOT NULL DEFAULT 0.5',
        'ALTER TABLE instrument_params ADD COLUMN session_start_utc INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE instrument_params ADD COLUMN session_end_utc INTEGER NOT NULL DEFAULT 24',
        'ALTER TABLE instrument_params ADD COLUMN review_min_trades INTEGER NOT NULL DEFAULT 50',
      ]) {
        try { await db.prepare(col).run(); } catch {}
      }
      await db.prepare(
        'INSERT OR IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)'
      ).bind(m.version, m.description, new Date().toISOString()).run();
      console.log(`[migration] Applied v${m.version}: ${m.description}`);
      continue;
    }

    // version 217: Ph.9 エントリー精度7パラメーター追加
    if (m.version === 217) {
      for (const col of [
        'ALTER TABLE instrument_params ADD COLUMN bb_period INTEGER NOT NULL DEFAULT 20',
        'ALTER TABLE instrument_params ADD COLUMN bb_squeeze_threshold REAL NOT NULL DEFAULT 0.4',
        'ALTER TABLE instrument_params ADD COLUMN w_bb REAL NOT NULL DEFAULT 0.10',
        'ALTER TABLE instrument_params ADD COLUMN w_div REAL NOT NULL DEFAULT 0.05',
        'ALTER TABLE instrument_params ADD COLUMN divergence_lookback INTEGER NOT NULL DEFAULT 14',
        'ALTER TABLE instrument_params ADD COLUMN min_confirm_signals INTEGER NOT NULL DEFAULT 2',
        'ALTER TABLE instrument_params ADD COLUMN er_upper_limit REAL NOT NULL DEFAULT 0.85',
      ]) {
        try { await db.prepare(col).run(); } catch {}
      }
      await db.prepare(
        'INSERT OR IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)'
      ).bind(m.version, m.description, new Date().toISOString()).run();
      console.log(`[migration] Applied v${m.version}: ${m.description}`);
      continue;
    }

    // version 219: positions に realized_rr カラム追加 + バックフィル
    if (m.version === 219) {
      try {
        await db.prepare('ALTER TABLE positions ADD COLUMN realized_rr REAL').run();
      } catch {}
      // バックフィル: 既存クローズ済みポジションの realized_rr を計算
      try {
        await db.prepare(`
          UPDATE positions SET realized_rr =
            CASE direction
              WHEN 'BUY' THEN (close_rate - entry_rate) / NULLIF(entry_rate - sl_rate, 0)
              WHEN 'SELL' THEN (entry_rate - close_rate) / NULLIF(sl_rate - entry_rate, 0)
            END
          WHERE status = 'CLOSED' AND realized_rr IS NULL AND sl_rate IS NOT NULL AND close_rate IS NOT NULL
        `).run();
        console.log('[migration] v219: realized_rr backfill complete');
      } catch (e) {
        console.warn('[migration] v219 backfill warning:', e);
      }
      await db.prepare(
        'INSERT OR IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)'
      ).bind(m.version, m.description, new Date().toISOString()).run();
      console.log(`[migration] Applied v${m.version}: ${m.description}`);
      continue;
    }

    // version 220: instrument_scores に期間別RR集計カラム追加
    if (m.version === 220) {
      for (const col of [
        'ALTER TABLE instrument_scores ADD COLUMN rr_30t REAL',
        'ALTER TABLE instrument_scores ADD COLUMN wr_30t REAL',
        'ALTER TABLE instrument_scores ADD COLUMN rr_daily REAL',
        'ALTER TABLE instrument_scores ADD COLUMN rr_weekly REAL',
        'ALTER TABLE instrument_scores ADD COLUMN rr_monthly REAL',
        "ALTER TABLE instrument_scores ADD COLUMN rr_trend TEXT DEFAULT 'STABLE'",
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
