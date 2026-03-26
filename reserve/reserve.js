/**
 * さいたま市立図書館 絵本自動予約スクリプト
 *
 * 使い方:
 *   1. cp .env.example .env  → .env に利用者番号とパスワードを記入
 *   2. npm install
 *   3. npx playwright install chromium
 *   4. node reserve.js
 *
 * books.html の「今週の予約リスト」からエクスポートした
 * reserve-list.json を読み込んで順番に予約します。
 */

require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─── 設定 ──────────────────────────────────────────────────────
const BASE_URL      = 'https://www.lib.city.saitama.jp';
const CARD_NUMBER   = process.env.LIBRARY_CARD_NUMBER;
const PASSWORD      = process.env.LIBRARY_PASSWORD;
const PICKUP_LIB    = process.env.PICKUP_LIBRARY || '';
const HEADLESS      = process.env.HEADLESS === 'true' || process.argv.includes('--headless');
const LIST_PATH     = process.env.RESERVE_LIST_PATH
  || path.join(__dirname, '..', 'reserve-list.json');

// ─── メイン ────────────────────────────────────────────────────
async function main() {
  // 0. 入力チェック
  if (!CARD_NUMBER || !PASSWORD) {
    console.error('❌ エラー: .env に LIBRARY_CARD_NUMBER と LIBRARY_PASSWORD を設定してください');
    process.exit(1);
  }

  // 1. 予約リスト読み込み
  if (!fs.existsSync(LIST_PATH)) {
    console.error(`❌ エラー: 予約リストが見つかりません → ${LIST_PATH}`);
    console.error('   books.html の「今週の予約リスト」から JSON をエクスポートしてください');
    process.exit(1);
  }

  const books = JSON.parse(fs.readFileSync(LIST_PATH, 'utf-8'));
  if (books.length === 0) {
    console.log('ℹ️  予約リストが空です。books.html でリストを作成してください。');
    process.exit(0);
  }

  console.log(`\n📚 さいたま市立図書館 自動予約スクリプト`);
  console.log(`   予約冊数: ${books.length} 冊`);
  console.log(`   ブラウザ: ${HEADLESS ? 'バックグラウンド' : '画面表示'}\n`);

  // 2. ブラウザ起動
  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: HEADLESS ? 0 : 300,  // 目視確認用に少し遅くする
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ja-JP',
  });
  const page = await context.newPage();

  const results = [];

  try {
    // 3. ログイン
    console.log('🔑 ログイン中...');
    await login(page);
    console.log('   ✅ ログイン成功\n');

    // 4. 各本を予約
    for (let i = 0; i < books.length; i++) {
      const book = books[i];
      console.log(`[${i + 1}/${books.length}] 「${book.title}」 を予約中...`);
      const result = await reserveBook(page, book);
      results.push(result);
      const icon = result.success ? '✅' : (result.skipped ? '⏭' : '❌');
      console.log(`   ${icon} ${result.message}\n`);
      // 連続アクセスの負荷軽減
      if (i < books.length - 1) await page.waitForTimeout(1500);
    }

  } catch (err) {
    console.error('❌ 予期しないエラーが発生しました:', err.message);
  } finally {
    await browser.close();
  }

  // 5. 結果サマリー
  const ok      = results.filter(r => r.success).length;
  const skipped = results.filter(r => r.skipped).length;
  const failed  = results.filter(r => !r.success && !r.skipped).length;

  console.log('═══════════════════════════════');
  console.log(`📊 結果サマリー`);
  console.log(`   ✅ 予約成功:   ${ok} 冊`);
  console.log(`   ⏭  スキップ:   ${skipped} 冊`);
  console.log(`   ❌ 失敗:       ${failed} 冊`);
  console.log('═══════════════════════════════\n');

  if (failed > 0) {
    console.log('⚠️  失敗した本:');
    results.filter(r => !r.success && !r.skipped).forEach(r => {
      console.log(`   - 「${r.title}」: ${r.message}`);
    });
  }

  // 6. 結果をファイルに保存
  const resultPath = path.join(__dirname, 'reserve-results.json');
  fs.writeFileSync(resultPath, JSON.stringify({
    date: new Date().toISOString(),
    results,
  }, null, 2));
  console.log(`\n💾 結果を保存しました → ${resultPath}`);
}

// ─── ログイン ──────────────────────────────────────────────────
async function login(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // ログインリンクをクリック（「マイページ」または「ログイン」）
  const loginLink = page.locator('a').filter({ hasText: /マイページ|ログイン|Login/ }).first();
  if (await loginLink.count() > 0) {
    await loginLink.click();
    await page.waitForLoadState('domcontentloaded');
  } else {
    // 直接ログインページへ
    await page.goto(`${BASE_URL}/idcheck`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  // 利用者番号入力
  await page.locator([
    'input[name*="id"]',
    'input[name*="card"]',
    'input[name*="userid"]',
    'input[name*="username"]',
    'input[type="text"]',
  ].join(', ')).first().fill(CARD_NUMBER);

  // パスワード入力
  await page.locator('input[type="password"]').first().fill(PASSWORD);

  // ログインボタン
  await page.locator([
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("ログイン")',
    'input[value*="ログイン"]',
  ].join(', ')).first().click();

  await page.waitForLoadState('domcontentloaded');

  // ログイン失敗チェック
  const errorMsg = await page.locator('text=/パスワードが違い|認証に失敗|ログインできません/').count();
  if (errorMsg > 0) {
    throw new Error('利用者番号またはパスワードが正しくありません');
  }
}

// ─── 1冊予約 ──────────────────────────────────────────────────
async function reserveBook(page, book) {
  try {
    // ① 検索
    const searchUrl = await buildSearchUrl(page, book);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // ② 検索結果から本を探す
    const bookLink = await findBookInResults(page, book);
    if (!bookLink) {
      return { title: book.title, success: false, skipped: false, message: '蔵書が見つかりませんでした（所蔵なし）' };
    }

    // ③ 詳細ページへ
    await bookLink.click();
    await page.waitForLoadState('domcontentloaded');

    // ④ 予約可能チェック（「予約不可」「貸出可能」等の状態確認）
    const unavailable = await page.locator('text=/予約できません|予約不可|所蔵なし/').count();
    if (unavailable > 0) {
      return { title: book.title, success: false, skipped: true, message: '現在予約できません（上限または在庫なし）' };
    }

    // ⑤ 予約ボタンをクリック
    const reserveBtn = page.locator([
      'button:has-text("予約")',
      'a:has-text("予約する")',
      'input[value*="予約"]',
    ].join(', ')).first();

    if (await reserveBtn.count() === 0) {
      return { title: book.title, success: false, skipped: false, message: '予約ボタンが見つかりませんでした' };
    }

    await reserveBtn.click();
    await page.waitForLoadState('domcontentloaded');

    // ⑥ 受取館の選択（設定されている場合）
    if (PICKUP_LIB) {
      const libSelect = page.locator('select').first();
      if (await libSelect.count() > 0) {
        await libSelect.selectOption({ label: PICKUP_LIB });
      }
    }

    // ⑦ 確認ボタン（確認画面がある場合）
    const confirmBtn = page.locator([
      'button:has-text("確認")',
      'button:has-text("確定")',
      'button:has-text("予約する")',
      'input[value*="確認"]',
      'input[value*="確定"]',
    ].join(', ')).first();

    if (await confirmBtn.count() > 0) {
      await confirmBtn.click();
      await page.waitForLoadState('domcontentloaded');
    }

    // ⑧ 成功確認
    const successMsg = await page.locator('text=/予約しました|予約を受け付け|予約完了/').count();
    if (successMsg > 0) {
      return { title: book.title, success: true, skipped: false, message: '予約しました' };
    }

    // ⑨ 既予約チェック
    const alreadyMsg = await page.locator('text=/すでに予約|既に予約/').count();
    if (alreadyMsg > 0) {
      return { title: book.title, success: false, skipped: true, message: 'すでに予約済みです' };
    }

    return { title: book.title, success: true, skipped: false, message: '予約リクエストを送信しました' };

  } catch (err) {
    return { title: book.title, success: false, skipped: false, message: `エラー: ${err.message}` };
  }
}

// ─── 検索URL構築 ───────────────────────────────────────────────
async function buildSearchUrl(page, book) {
  // ISBNがあれば ISBN 検索（より確実）
  if (book.isbn) {
    return `${BASE_URL}/index?search=true&isbn=${encodeURIComponent(book.isbn)}`;
  }
  // タイトル検索
  const q = encodeURIComponent(book.title);
  return `${BASE_URL}/index?search=true&title=${q}`;
}

// ─── 検索結果から本を探す ──────────────────────────────────────
async function findBookInResults(page, book) {
  await page.waitForTimeout(500);

  // 検索結果がない場合
  const noResult = await page.locator('text=/該当する資料がありません|0件/').count();
  if (noResult > 0) return null;

  // タイトルが完全一致するリンクを優先
  const exactLink = page.locator(`a:has-text("${book.title}")`).first();
  if (await exactLink.count() > 0) return exactLink;

  // 部分一致（タイトルの最初の10文字で検索）
  const shortTitle = book.title.substring(0, 10);
  const partialLink = page.locator(`a:has-text("${shortTitle}")`).first();
  if (await partialLink.count() > 0) return partialLink;

  // 最初の検索結果リンクを使う（フォールバック）
  const firstResult = page.locator('.item-title a, .result-title a, table tbody tr:first-child a').first();
  if (await firstResult.count() > 0) return firstResult;

  return null;
}

// ─── 実行 ──────────────────────────────────────────────────────
main().catch(err => {
  console.error('❌ 致命的なエラー:', err);
  process.exit(1);
});
