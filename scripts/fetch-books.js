/**
 * 絵本データ収集スクリプト
 *
 * 2つのソースからデータを取得して data/books-full.json を生成します:
 *   1. 絵本ナビ ScoreRanking（人気スコアランキング上位 ~800冊）
 *   2. 傑作絵本シリーズ（出版社別の名作シリーズをNDL APIで網羅）
 *
 * 使い方:
 *   cd <リポジトリルート>
 *   node scripts/fetch-books.js
 *
 * 必要環境:
 *   Node.js 18以上 / playwright インストール済み（reserve/ で npm install 済みなら OK）
 *   ※ playwright が未インストールの場合: npm install playwright
 */

const path  = require('path');
const fs    = require('fs');

// Playwright は reserve/ 配下にインストール済みなので相対パスで require
let chromium;
try {
  ({ chromium } = require(path.join(__dirname, '..', 'reserve', 'node_modules', 'playwright')));
} catch {
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('❌ playwright が見つかりません。');
    console.error('   cd reserve && npm install && cd ..');
    console.error('   または: npm install playwright');
    process.exit(1);
  }
}

const OUTPUT = path.join(__dirname, '..', 'data', 'books-full.json');

// ──────────────────────────────────────────────────────────────────
// 設定
// ──────────────────────────────────────────────────────────────────
const EHONNAVI_PAGES  = 8;    // 1ページ100冊 × 8 = ~800冊
const CRAWL_DELAY_MS  = 10000; // robots.txt の Crawl-delay: 10 に準拠
const NDL_DELAY_MS    = 800;

// 網羅する傑作シリーズ（NDL SRU で series= 検索）
const MASTERPIECE_SERIES = [
  // 福音館書店
  { series: '世界傑作絵本シリーズ',   group: '3-4', publisher: '福音館書店' },
  { series: 'こどものとも傑作集',     group: '3-4', publisher: '福音館書店' },
  { series: '日本傑作絵本シリーズ',   group: '3-4', publisher: '福音館書店' },
  { series: 'こどものとも年少版',     group: '0-2', publisher: '福音館書店' },
  { series: 'こどものとも0.1.2.',     group: '0-2', publisher: '福音館書店' },
  // 偕成社
  { series: '偕成社の創作絵本',       group: '3-4', publisher: '偕成社' },
  // 童心社
  { series: 'かがくのとも傑作集',     group: '3-4', publisher: '福音館書店' },
  // BL出版
  { series: '大型絵本',               group: '3-4', publisher: 'BL出版' },
  // ポプラ社
  { series: 'ポプラ社の絵本',         group: '3-4', publisher: 'ポプラ社' },
  // 年長向け
  { series: 'ブルーバックス絵本',     group: '5-6', publisher: '講談社' },
];

// ──────────────────────────────────────────────────────────────────
// 年齢グループ判定
// ──────────────────────────────────────────────────────────────────
const AGE_PATTERNS = {
  '0-2': [
    /赤ちゃん|あかちゃん|ベビー|0歳|1歳|2歳/,
    /ボードブック/,
    /いないいない|じゃあじゃあ|もこもこ|だるまさん/,
    /こどものとも0\.1\.2|年少版/,
  ],
  '5-6': [
    /5歳|6歳|小学|年長/,
    /スイミー|レオ.レオニ|センダック|100万回/,
    /せかいのめいさく|世界名作/,
  ],
};

function guessAgeGroup(title = '', author = '', series = '', publisher = '') {
  const text = `${title} ${author} ${series} ${publisher}`;
  for (const [group, patterns] of Object.entries(AGE_PATTERNS)) {
    if (patterns.some(p => p.test(text))) return group;
  }
  return '3-4';
}

// ──────────────────────────────────────────────────────────────────
// ① 絵本ナビ スクレイピング（Playwright）
// ──────────────────────────────────────────────────────────────────
async function scrapeEhonnavi(page, pageNo) {
  const url = `https://www.ehonnavi.net/ScoreRanking.asp${pageNo > 1 ? `?pageNo=${pageNo}` : ''}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const books = await page.evaluate(() => {
    const results = [];
    // 各書籍ブロックを検索（スコアランキングの書籍リンク）
    document.querySelectorAll('a[href*="/ehon00.asp?no="]').forEach(link => {
      const title = link.textContent.trim();
      if (!title || title.length < 2) return;

      const bookNo = (link.href.match(/no=(\d+)/) || [])[1];
      if (!bookNo) return;

      // 親要素を辿って著者・出版社・スコアを探す
      const container = link.closest('td, li, div') || link.parentElement;
      const text = container ? container.innerText : '';

      // 著者リンク
      const authorLinks = container
        ? [...container.querySelectorAll('a[href*="author.asp"]')].map(a => a.textContent.trim())
        : [];

      // 出版社リンク
      const pubLink = container
        ? container.querySelector('a[href*="publisher.asp"]')
        : null;
      const publisher = pubLink ? pubLink.textContent.trim() : '';

      // スコア（数値 x.xx 形式）
      const scoreMatch = text.match(/(\d\.\d{2})/);
      const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;

      results.push({
        bookNo,
        title,
        author: authorLinks.join(' / '),
        publisher,
        score,
        source: 'ehonnavi',
      });
    });
    return results;
  });

  // 重複除去（同ページ内に同じ本が複数リンクされることがある）
  const seen = new Set();
  return books.filter(b => {
    if (seen.has(b.bookNo)) return false;
    seen.add(b.bookNo);
    return true;
  });
}

// ──────────────────────────────────────────────────────────────────
// ② 絵本ナビ 書籍詳細ページから対象年齢・ISBNを取得
//    （上位 N 冊のみ詳細取得してISBNを充実させる）
// ──────────────────────────────────────────────────────────────────
async function fetchEhonnaviDetail(page, bookNo) {
  try {
    await page.goto(`https://www.ehonnavi.net/ehon00.asp?no=${bookNo}`, {
      waitUntil: 'domcontentloaded', timeout: 20000,
    });
    return await page.evaluate(() => {
      // ISBN
      const body = document.body.innerText;
      const isbnMatch = body.match(/ISBN[：:\s]*(97[89]\d{10}|\d{10})/);
      const isbn = isbnMatch ? isbnMatch[1] : null;

      // 対象年齢（「○歳から」パターン）
      const ageMatch = body.match(/([0-9０-９]+)歳(から|〜|～)/);
      let ageFrom = ageMatch ? parseInt(ageMatch[1]) : null;

      // あらすじ（meta descriptionまたは本文の最初の段落）
      const metaDesc = document.querySelector('meta[name="description"]');
      const description = metaDesc ? metaDesc.content.trim() : '';

      return { isbn, ageFrom, description };
    });
  } catch {
    return { isbn: null, ageFrom: null, description: '' };
  }
}

// ──────────────────────────────────────────────────────────────────
// ③ NDL SRU API でシリーズ検索
// ──────────────────────────────────────────────────────────────────
const NDL_BASE = 'https://ndlsearch.ndl.go.jp/api/sru';

function extractTagNDL(xml, tag) {
  const re = new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tag}>`, 'i');
  const m  = xml.match(re);
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
}
function extractAllTagsNDL(xml, tag) {
  const re = new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const v = m[1].replace(/<[^>]+>/g, '').trim();
    if (v) out.push(v);
  }
  return out;
}

async function fetchNDLSeries({ series, group, publisher }) {
  const query = `series="${series}"`;
  const url = `${NDL_BASE}?${new URLSearchParams({
    operation: 'searchRetrieve', version: '1.2',
    recordSchema: 'dcndl', maximumRecords: 100, startRecord: 1,
    query,
  })}`;

  try {
    const res = await fetch(url);
    const xml = await res.text();
    const recordRe = /<(?:srw:)?recordData>([\s\S]*?)<\/(?:srw:)?recordData>/gi;
    const books = [];
    let m;
    while ((m = recordRe.exec(xml)) !== null) {
      const rec   = m[1];
      const title = extractTagNDL(rec, 'title');
      if (!title) continue;
      const creators  = extractAllTagsNDL(rec, 'creator');
      const pub       = extractTagNDL(rec, 'publisher') || publisher;
      const date      = extractTagNDL(rec, 'date');
      const identifiers = extractAllTagsNDL(rec, 'identifier');
      const isbn = identifiers.map(s => s.replace(/[^0-9X]/g, '')).find(s => s.length === 13 || s.length === 10) || null;
      books.push({
        id: `series_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
        title, author: creators.join(' / '), publisher: pub,
        year: date ? parseInt(date.slice(0, 4)) || null : null,
        description: '', tags: [], isbn,
        groupId: group, series, source: 'ndl_series',
      });
    }
    return books;
  } catch (e) {
    console.error(`  ⚠ NDL series error (${series}): ${e.message}`);
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────
// メイン
// ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('📚 絵本データ収集スクリプト\n');
  console.log('  ソース 1: 絵本ナビ ScoreRanking（Playwright）');
  console.log('  ソース 2: 傑作シリーズ（NDL SRU API）\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'ja-JP' });
  const page    = await context.newPage();

  // ── 絵本ナビ スクレイピング ──────────────────────────────────
  console.log(`▶ 絵本ナビ: ${EHONNAVI_PAGES} ページ取得中...`);
  const ehonRaw = [];
  for (let p = 1; p <= EHONNAVI_PAGES; p++) {
    process.stdout.write(`  ページ ${p}/${EHONNAVI_PAGES} ... `);
    const books = await scrapeEhonnavi(page, p);
    ehonRaw.push(...books);
    console.log(`${books.length} 冊取得`);
    if (p < EHONNAVI_PAGES) await new Promise(r => setTimeout(r, CRAWL_DELAY_MS));
  }
  console.log(`  小計: ${ehonRaw.length} 冊\n`);

  // 上位200冊は詳細ページからISBN・年齢・あらすじを補完
  console.log('▶ 上位200冊の詳細情報を取得中（ISBN・年齢・あらすじ）...');
  const detailTarget = ehonRaw.slice(0, 200);
  for (let i = 0; i < detailTarget.length; i++) {
    const b = detailTarget[i];
    process.stdout.write(`\r  ${i + 1}/${detailTarget.length} 冊`);
    const detail = await fetchEhonnaviDetail(page, b.bookNo);
    b.isbn        = detail.isbn;
    b.ageFrom     = detail.ageFrom;
    b.description = detail.description;
    await new Promise(r => setTimeout(r, CRAWL_DELAY_MS));
  }
  console.log('\n  詳細取得完了\n');

  await browser.close();

  // ── NDL 傑作シリーズ ─────────────────────────────────────────
  console.log('▶ 傑作シリーズ（NDL）を取得中...');
  const seriesBooks = [];
  for (const s of MASTERPIECE_SERIES) {
    process.stdout.write(`  「${s.series}」... `);
    await new Promise(r => setTimeout(r, NDL_DELAY_MS));
    const books = await fetchNDLSeries(s);
    console.log(`${books.length} 冊`);
    seriesBooks.push(...books);
  }
  console.log(`  小計: ${seriesBooks.length} 冊\n`);

  // ── マージ・重複除去 ─────────────────────────────────────────
  console.log('▶ マージ・重複除去...');

  // 絵本ナビデータを正規化
  const ehonNorm = ehonRaw.map((b, i) => {
    let groupId;
    if (b.ageFrom !== null && b.ageFrom !== undefined) {
      groupId = b.ageFrom <= 2 ? '0-2' : b.ageFrom <= 4 ? '3-4' : '5-6';
    } else {
      groupId = guessAgeGroup(b.title, b.author);
    }
    return {
      id:          `ehon_${i + 1}`,
      title:       b.title,
      author:      b.author,
      publisher:   b.publisher,
      description: b.description || '',
      tags:        [],
      isbn:        b.isbn || null,
      score:       b.score,
      groupId,
      source:      'ehonnavi',
    };
  });

  const allBooks = [...ehonNorm, ...seriesBooks];

  // タイトル+著者 で重複除去
  const seen  = new Set();
  const dedup = allBooks.filter(b => {
    const key = `${b.title.replace(/\s/g, '')}::${b.author}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // グループ別に分類
  const groups = { '0-2': [], '3-4': [], '5-6': [] };
  dedup.forEach(b => {
    const g = b.groupId || '3-4';
    if (groups[g]) groups[g].push(b);
  });

  const groupMeta = {
    '0-2': { label: '0〜2歳', emoji: '🍼', desc: '感覚・リズム・繰り返しが楽しい赤ちゃん絵本' },
    '3-4': { label: '3〜4歳', emoji: '🐻', desc: '物語の面白さに目覚める時期。繰り返し・共感・冒険がテーマ' },
    '5-6': { label: '5〜6歳', emoji: '🚀', desc: '深いテーマ・長い物語・想像力を刺激する絵本' },
  };

  const output = {
    generated: new Date().toISOString(),
    sources: ['絵本ナビ ScoreRanking', 'NDL 傑作シリーズ'],
    total: dedup.length,
    groups: Object.entries(groups).map(([id, books]) => ({
      id, ...groupMeta[id], books,
    })),
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf-8');

  // ── 結果表示 ──────────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ 生成完了 → ${OUTPUT}`);
  console.log(`   0〜2歳: ${groups['0-2'].length} 冊`);
  console.log(`   3〜4歳: ${groups['3-4'].length} 冊`);
  console.log(`   5〜6歳: ${groups['5-6'].length} 冊`);
  console.log(`   合計:   ${dedup.length} 冊`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('次のステップ:');
  console.log('  git add data/books-full.json');
  console.log('  git commit -m "Add full book dataset"');
  console.log('  git push');
  console.log('  → GitHub Pages で自動的に1000冊が読み込まれます\n');
}

main().catch(e => {
  console.error('❌ エラー:', e);
  process.exit(1);
});
