/**
 * NDL（国立国会図書館）サーチAPIから絵本データを取得して
 * data/books-full.json を生成するスクリプト
 *
 * 使い方:
 *   node scripts/fetch-books.js
 *
 * 必要環境: Node.js 18以上（built-in fetch使用）
 *
 * NDL SRU API: https://ndlsearch.ndl.go.jp/api/sru
 * NDC 726.6 = 絵本
 */

const fs   = require('fs');
const path = require('path');

const OUTPUT   = path.join(__dirname, '..', 'data', 'books-full.json');
const PAGE     = 100;   // 1回のリクエストで取得する件数（最大100）
const TARGET   = 1000;  // 目標冊数
const DELAY_MS = 800;   // リクエスト間隔（NDLへの負荷軽減）

// ─── NDL SRU API ────────────────────────────────────────────────
const BASE = 'https://ndlsearch.ndl.go.jp/api/sru';

function buildUrl(start) {
  const params = new URLSearchParams({
    operation:      'searchRetrieve',
    version:        '1.2',
    recordSchema:   'dcndl',
    maximumRecords: PAGE,
    startRecord:    start,
    // 絵本（NDC 726.6）を対象。乳幼児・子ども向けに絞る
    query: 'NDC="726.6" AND mediaType="図書"',
  });
  return `${BASE}?${params}`;
}

// ─── XML パーサー（依存なし）────────────────────────────────────
function extractTag(xml, tag) {
  const re = new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
}

function extractAllTags(xml, tag) {
  const re = new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tag}>`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const val = m[1].replace(/<[^>]+>/g, '').trim();
    if (val) results.push(val);
  }
  return results;
}

function parseRecords(xml) {
  const recordRe = /<(?:srw:)?recordData>([\s\S]*?)<\/(?:srw:)?recordData>/gi;
  const books = [];
  let m;
  while ((m = recordRe.exec(xml)) !== null) {
    const rec = m[1];
    const title     = extractTag(rec, 'title');
    const creators  = extractAllTags(rec, 'creator');
    const publisher = extractTag(rec, 'publisher');
    const date      = extractTag(rec, 'date');
    const subjects  = extractAllTags(rec, 'subject');
    const desc      = extractTag(rec, 'description');
    const identifiers = extractAllTags(rec, 'identifier');

    if (!title) continue;

    // ISBN抽出
    const isbn = identifiers
      .map(s => s.replace(/[^0-9X]/g, ''))
      .find(s => s.length === 10 || s.length === 13) || null;

    books.push({
      title,
      author:    creators.join(' / '),
      publisher: publisher || '',
      year:      date ? parseInt(date.slice(0, 4)) || null : null,
      description: desc || '',
      subjects,
      isbn,
    });
  }
  return books;
}

function getTotalRecords(xml) {
  const m = xml.match(/<(?:srw:)?numberOfRecords>(\d+)<\/(?:srw:)?numberOfRecords>/);
  return m ? parseInt(m[1]) : 0;
}

// ─── 年齢グループ判定 ────────────────────────────────────────────
function guessAgeGroup(book) {
  const text = [book.title, book.author, book.publisher, ...book.subjects].join(' ');

  // 0-2歳のキーワード
  if (/あかちゃん|赤ちゃん|0歳|1歳|2歳|ボードブック|いないいない|ばあ|じゃあじゃあ|もこもこ/.test(text)) return '0-2';

  // 5-6歳のキーワード
  if (/5歳|6歳|年長|小学|読み聞かせ.*長め|長い話/.test(text)) return '5-6';

  // 有名な5-6歳向けシリーズ・作家
  if (/レオ[・.]レオニ|センダック|スイミー|100万回|おおきな木|エルマー/.test(text)) return '5-6';

  // 有名な0-2歳向け
  if (/だるまさん|松谷みよ子|まついのりこ|林明子.*あかちゃん/.test(text)) return '0-2';

  // デフォルトは3-4歳
  return '3-4';
}

// ─── タグ生成 ────────────────────────────────────────────────────
const TAG_MAP = {
  '動物': 'どうぶつ', '友達': 'ともだち', '友情': 'ともだち',
  '冒険': 'ぼうけん', '食べ物': 'たべもの', '料理': 'りょうり',
  '家族': 'かぞく', '夜': 'よる', '乗り物': 'のりもの',
  '繰り返し': 'くりかえし', '自然': 'しぜん', '笑い': 'わらい',
  '成長': 'せいちょう', '勇気': 'ゆうき', '考える': 'かんがえる',
};

function makeTags(subjects) {
  const tags = new Set();
  for (const s of subjects) {
    for (const [jp, tag] of Object.entries(TAG_MAP)) {
      if (s.includes(jp)) tags.add(tag);
    }
  }
  return [...tags].slice(0, 4);
}

// ─── メイン ─────────────────────────────────────────────────────
async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('📚 NDLから絵本データを取得します...\n');

  // まず総件数を確認
  const firstUrl = buildUrl(1);
  console.log(`  リクエスト: ${firstUrl}\n`);
  const firstRes  = await fetch(firstUrl);
  const firstXml  = await firstRes.text();
  const total     = getTotalRecords(firstXml);
  console.log(`  NDL総件数: ${total} 件`);
  console.log(`  取得目標:  ${TARGET} 件\n`);

  const allRaw = parseRecords(firstXml);
  let start = PAGE + 1;

  while (allRaw.length < Math.min(TARGET, total) && start <= total) {
    await sleep(DELAY_MS);
    process.stdout.write(`\r  取得中... ${allRaw.length} / ${Math.min(TARGET, total)} 冊`);
    const url = buildUrl(start);
    try {
      const res  = await fetch(url);
      const xml  = await res.text();
      const recs = parseRecords(xml);
      allRaw.push(...recs);
      start += PAGE;
    } catch (e) {
      console.error(`\n  ⚠ エラー (start=${start}): ${e.message}`);
      start += PAGE;
    }
  }
  console.log(`\n\n  取得完了: ${allRaw.length} 件`);

  // 重複排除（タイトル+著者で）
  const seen  = new Set();
  const dedup = allRaw.filter(b => {
    const key = `${b.title}::${b.author}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`  重複除去後: ${dedup.length} 件`);

  // グループ分け
  const groups = { '0-2': [], '3-4': [], '5-6': [] };
  for (const raw of dedup) {
    const groupId = guessAgeGroup(raw);
    const id = `ndl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    groups[groupId].push({
      id,
      title:       raw.title,
      author:      raw.author,
      publisher:   raw.publisher,
      year:        raw.year,
      description: raw.description,
      tags:        makeTags(raw.subjects),
      isbn:        raw.isbn,
    });
  }

  const groupLabels = {
    '0-2': { label: '0〜2歳', emoji: '🍼', desc: '感覚・リズム・繰り返しが楽しい赤ちゃん絵本' },
    '3-4': { label: '3〜4歳', emoji: '🐻', desc: '物語の面白さに目覚める時期。繰り返し・共感・冒険がテーマ' },
    '5-6': { label: '5〜6歳', emoji: '🚀', desc: '深いテーマ・長い物語・想像力を刺激する絵本' },
  };

  const output = {
    generated: new Date().toISOString(),
    source: 'NDL（国立国会図書館）サーチAPI',
    total: dedup.length,
    groups: Object.entries(groups).map(([id, books]) => ({
      id,
      ...groupLabels[id],
      books,
    })),
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf-8');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ 生成完了: ${OUTPUT}`);
  console.log(`   0〜2歳: ${groups['0-2'].length} 冊`);
  console.log(`   3〜4歳: ${groups['3-4'].length} 冊`);
  console.log(`   5〜6歳: ${groups['5-6'].length} 冊`);
  console.log(`   合計:   ${dedup.length} 冊`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('次のステップ:');
  console.log('  git add data/books-full.json && git commit -m "Add full book dataset" && git push');
  console.log('  → GitHub Pages で自動的に読み込まれます\n');
}

main().catch(e => {
  console.error('❌ エラー:', e);
  process.exit(1);
});
