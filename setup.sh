#!/bin/bash
set -e

echo "=== fx-sim-v1 セットアップ開始 ==="

# ─── 前提チェック ───────────────────────────────────────────
if ! command -v wrangler &>/dev/null; then
  echo "❌ wrangler が見つかりません。npm install 後に再実行してください。"
  echo "   $ npm install"
  exit 1
fi

if ! wrangler whoami &>/dev/null; then
  echo "❌ Cloudflare にログインしていません。"
  echo "   $ wrangler login"
  exit 1
fi

# ─── 1. 依存インストール ────────────────────────────────────
echo ""
echo "[1/5] 依存パッケージインストール..."
npm install

# ─── 2. D1 作成 & wrangler.toml 自動更新 ────────────────────
echo ""
echo "[2/5] D1データベース作成..."

DB_OUTPUT=$(wrangler d1 create fx-sim-v1-db 2>&1 || true)
DB_ID=$(echo "$DB_OUTPUT" | grep -oP 'database_id\s*=\s*"\K[^"]+' || true)

if [ -z "$DB_ID" ]; then
  # 既に存在する場合はリストから取得
  DB_ID=$(wrangler d1 list 2>/dev/null \
    | grep "fx-sim-v1-db" \
    | awk '{for(i=1;i<=NF;i++) if($i ~ /^[0-9a-f-]{36}$/) print $i}' \
    | head -1)
fi

if [ -z "$DB_ID" ]; then
  echo "❌ D1のIDが取得できませんでした。手動で wrangler.toml を更新してください。"
  exit 1
fi

# wrangler.toml の YOUR_D1_DATABASE_ID を実際のIDに置換
if grep -q "YOUR_D1_DATABASE_ID" wrangler.toml; then
  sed -i "s/YOUR_D1_DATABASE_ID/$DB_ID/" wrangler.toml
  echo "  ✅ D1 ID: $DB_ID を wrangler.toml に書き込みました"
else
  echo "  ℹ️  wrangler.toml は既に更新済みです (ID: $DB_ID)"
fi

# ─── 3. スキーマ適用 ──────────────────────────────────────
echo ""
echo "[3/5] スキーマ適用..."
wrangler d1 execute fx-sim-v1-db --file=schema.sql
echo "  ✅ スキーマ適用完了"

# ─── 4. Secret 設定（ここだけ手動入力が必要） ────────────────
echo ""
echo "[4/5] APIキー設定（キーを入力してください）..."
echo ""
echo "--- GEMINI_API_KEY ---"
echo "  取得先: https://aistudio.google.com/app/apikey"
wrangler secret put GEMINI_API_KEY

echo ""
echo "--- FRED_API_KEY ---"
echo "  取得先: https://fred.stlouisfed.org/docs/api/api_key.html"
wrangler secret put FRED_API_KEY

# ─── 5. デプロイ ─────────────────────────────────────────
echo ""
echo "[5/5] デプロイ..."
wrangler deploy
echo ""
echo "=== ✅ セットアップ完了 ==="
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "よく使うコマンド:"
echo "  ログ確認:   wrangler tail --format=pretty"
echo "  DB確認:     wrangler d1 execute fx-sim-v1-db \\"
echo "                --command=\"SELECT * FROM decisions ORDER BY id DESC LIMIT 5;\""
echo "  PnL確認:    wrangler d1 execute fx-sim-v1-db \\"
echo "                --command=\"SELECT id,direction,entry_rate,close_rate,pnl,close_reason FROM positions ORDER BY id DESC LIMIT 10;\""
echo "  ローカル実行: wrangler dev"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
