#!/usr/bin/env node

// insider-pulse — Track SEC Form 4 insider trades
// Usage: insider-pulse AAPL | insider-pulse --recent 7

const EDGAR_BASE = 'https://efts.sec.gov/LATEST/search-index?q=%22form+4%22&dateRange=custom';
const EDGAR_COMPANY = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=4&dateb=&owner=include&count=40&search_text=&action=getcompany&company=&CIK=TICKER&output=atom';
const FILING_BASE = 'https://www.sec.gov/Archives/edgar/data/';
const FULL_TEXT_SEARCH = 'https://efts.sec.gov/LATEST/search-index';
const SEC_SEARCH = 'https://efts.sec.gov/LATEST/search?q=%224%22&forms=4';
const HEADERS = { 'User-Agent': 'insider-pulse/0.1 (personal research tool)', Accept: 'application/json,application/xml,text/xml,application/atom+xml' };

// ── Helpers ──

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();
  if (args[0] === '--recent') {
    const days = parseInt(args[1] || '7', 10);
    return { mode: 'recent', days };
  }
  if (args[0] === '--help' || args[0] === '-h') usage();
  return { mode: 'ticker', ticker: args[0].toUpperCase() };
}

function usage() {
  console.log(`
  insider-pulse — Track SEC Form 4 insider trades

  Usage:
    insider-pulse AAPL          Look up recent insider trades for a ticker
    insider-pulse --recent 7    Show insider trades from the last N days
    insider-pulse --help        Show this help
  `);
  process.exit(0);
}

function fmtDate(d) {
  if (!d) return '—';
  return typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}

function fmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US');
}

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ── ASCII Table ──

function table(rows, columns) {
  if (rows.length === 0) { console.log('  No trades found.'); return; }
  const widths = columns.map(c => c.label.length);
  const formatted = rows.map(r => columns.map((c, i) => {
    const v = String(c.fn(r));
    if (v.length > widths[i]) widths[i] = v.length;
    return v;
  }));
  // cap widths
  widths.forEach((w, i) => { if (w > 30) widths[i] = 30; });

  const sep = '─';
  const headerLine = columns.map((c, i) => c.label.padEnd(widths[i])).join('  ');
  const divider = widths.map(w => sep.repeat(w)).join('──');
  console.log(`  ${headerLine}`);
  console.log(`  ${divider}`);
  formatted.forEach(row => {
    const line = row.map((v, i) => v.slice(0, widths[i]).padEnd(widths[i])).join('  ');
    console.log(`  ${line}`);
  });
}

const COLUMNS = [
  { label: 'Date', fn: r => fmtDate(r.date) },
  { label: 'Insider', fn: r => r.insider || '—' },
  { label: 'Title', fn: r => (r.title || '—').slice(0, 20) },
  { label: 'Type', fn: r => r.type || '—' },
  { label: 'Shares', fn: r => fmtNum(r.shares) },
  { label: 'Value', fn: r => fmtMoney(r.value) },
  { label: 'Ticker', fn: r => r.ticker || '—' },
];

// ── SEC EDGAR Fetching ──

async function fetchAtomFeed(ticker) {
  const url = EDGAR_COMPANY.replace('TICKER', encodeURIComponent(ticker));
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`EDGAR returned ${res.status}`);
  return res.text();
}

function parseAtomEntries(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRegex.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => { const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`); const mm = block.match(r); return mm ? mm[1].trim() : ''; };
    const linkMatch = block.match(/<link[^>]+href="([^"]+)"/);
    entries.push({
      title: get('title'),
      updated: get('updated'),
      summary: get('summary'),
      link: linkMatch ? linkMatch[1] : '',
    });
  }
  return entries;
}

// Fetch and parse actual Form 4 XML filing
async function fetchForm4Xml(indexUrl) {
  try {
    // indexUrl is like https://www.sec.gov/Archives/edgar/data/.../0001234-...-index.htm
    // We need to find the actual XML filing
    let base = indexUrl.replace(/-index\.htm.*$/, '').replace(/\/[^/]*$/, '/');
    if (indexUrl.includes('/Archives/')) {
      // Fetch the index page to find the XML
      const res = await fetch(indexUrl, { headers: HEADERS });
      if (!res.ok) return null;
      const html = await res.text();
      // Look for .xml link in the filing
      const xmlMatch = html.match(/href="([^"]*\.xml)"/i);
      if (!xmlMatch) return null;
      let xmlUrl = xmlMatch[1];
      if (!xmlUrl.startsWith('http')) {
        // relative URL
        const pathParts = indexUrl.split('/');
        pathParts.pop();
        xmlUrl = pathParts.join('/') + '/' + xmlUrl;
      }
      const xmlRes = await fetch(xmlUrl, { headers: HEADERS });
      if (!xmlRes.ok) return null;
      return xmlRes.text();
    }
  } catch { return null; }
  return null;
}

function parseForm4Transactions(xml) {
  const trades = [];
  const get = (block, tag) => { const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`); const m = block.match(r); return m ? m[1].trim() : ''; };

  // Issuer ticker
  const ticker = get(xml, 'issuerTradingSymbol');

  // Reporter (insider) info
  const reporterBlock = xml.match(/<reportingOwner>([\s\S]*?)<\/reportingOwner>/);
  const insider = reporterBlock ? get(reporterBlock[1], 'rptOwnerName') : '';
  const titleBlock = reporterBlock ? (reporterBlock[1].match(/<reportingOwnerRelationship>([\s\S]*?)<\/reportingOwnerRelationship>/) || [null, ''])[1] : '';
  let title = '';
  if (titleBlock) {
    const officerTitle = get(titleBlock, 'officerTitle');
    if (officerTitle) title = officerTitle;
    else if (titleBlock.includes('<isDirector>1</isDirector>') || titleBlock.includes('<isDirector>true</isDirector>')) title = 'Director';
    else if (titleBlock.includes('<isTenPercentOwner>1</isTenPercentOwner>') || titleBlock.includes('<isTenPercentOwner>true</isTenPercentOwner>')) title = '10% Owner';
  }

  // Non-derivative transactions (the ones we want — actual buys/sells)
  const ndRegex = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g;
  let m;
  while ((m = ndRegex.exec(xml)) !== null) {
    const tx = m[1];
    const code = get(tx, 'transactionCode');
    // P = purchase, S = sale, skip others (A=grant, M=exercise, G=gift, etc.)
    if (code !== 'P' && code !== 'S') continue;

    const shares = parseFloat(get(tx, 'transactionShares') || get(tx, 'sharesAmount') || '0');
    const price = parseFloat(get(tx, 'transactionPricePerShare') || get(tx, 'pricePerShare') || '0');
    const date = get(tx, 'transactionDate') ? get(get(tx, 'transactionDate'), 'value') || get(tx, 'transactionDate') : '';
    const value = shares && price ? shares * price : null;

    trades.push({
      ticker: ticker.toUpperCase(),
      insider: cleanName(insider),
      title,
      type: code === 'P' ? 'BUY' : 'SELL',
      shares,
      price,
      value,
      date: date || null,
    });
  }
  return trades;
}

function cleanName(name) {
  if (!name) return '';
  // SEC often has "LASTNAME FIRSTNAME" or various formats
  return name.replace(/\s+/g, ' ').trim().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// ── SEC Full-Text Search API (for --recent) ──

async function searchRecentFilings(days) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const dateFrom = fmtDate(from);
  const dateTo = fmtDate(to);
  const url = `https://efts.sec.gov/LATEST/search-index?q=%224%22&forms=4&startdt=${dateFrom}&enddt=${dateTo}&start=0&count=40`;
  // The full-text search API
  const searchUrl = `https://efts.sec.gov/LATEST/search?q=%224%22&forms=4&dateRange=custom&startdt=${dateFrom}&enddt=${dateTo}`;
  const res = await fetch(searchUrl, { headers: { ...HEADERS, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`SEC search returned ${res.status}`);
  return res.json();
}

// ── Cluster Detection ──

function detectClusters(trades, windowDays = 7) {
  const byTicker = {};
  for (const t of trades) {
    if (t.type !== 'BUY') continue;
    (byTicker[t.ticker] ??= []).push(t);
  }
  const clusters = [];
  for (const [ticker, buys] of Object.entries(byTicker)) {
    if (buys.length < 2) continue;
    buys.sort((a, b) => new Date(a.date) - new Date(b.date));
    // Check if multiple insiders bought within window
    const insiders = new Set(buys.map(b => b.insider));
    if (insiders.size >= 2) {
      const first = new Date(buys[0].date);
      const last = new Date(buys[buys.length - 1].date);
      if ((last - first) / 86400000 <= windowDays) {
        clusters.push({ ticker, count: insiders.size, insiders: [...insiders], buys });
      }
    }
  }
  return clusters;
}

// ── Main flows ──

async function lookupTicker(ticker) {
  console.log(`\n  Fetching Form 4 filings for ${ticker}...\n`);

  const xml = await fetchAtomFeed(ticker);
  const entries = parseAtomEntries(xml);

  if (entries.length === 0) {
    console.log('  No Form 4 filings found for this ticker.');
    return;
  }

  const allTrades = [];
  let processed = 0;

  for (const entry of entries.slice(0, 15)) {
    // Rate limit: SEC asks for max 10 req/sec
    if (processed > 0) await new Promise(r => setTimeout(r, 150));

    const filingXml = await fetchForm4Xml(entry.link);
    if (filingXml) {
      const trades = parseForm4Transactions(filingXml);
      allTrades.push(...trades);
    }
    processed++;
    process.stderr.write(`\r  Processing filing ${processed}/${Math.min(entries.length, 15)}...`);
  }
  process.stderr.write('\r' + ' '.repeat(50) + '\r');

  if (allTrades.length === 0) {
    console.log('  No non-derivative buy/sell transactions found.');
    console.log('  (Option exercises and grants are filtered out)');
    return;
  }

  allTrades.sort((a, b) => new Date(b.date) - new Date(a.date));
  table(allTrades, COLUMNS);

  // Cluster detection
  const clusters = detectClusters(allTrades);
  if (clusters.length > 0) {
    console.log('\n  🔥 CLUSTER BUYS DETECTED:');
    for (const c of clusters) {
      console.log(`  ► ${c.ticker}: ${c.count} insiders bought within 7 days (${c.insiders.join(', ')})`);
    }
  }
  console.log();
}

async function lookupRecent(days) {
  console.log(`\n  Fetching recent Form 4 filings (last ${days} days)...\n`);

  const data = await searchRecentFilings(days);
  const hits = data.hits?.hits || data.filings || [];

  if (hits.length === 0 && data.hits?.total?.value === 0) {
    console.log('  No recent filings found.');
    return;
  }

  // The EFTS search returns filing metadata; we need to fetch actual XMLs
  const allTrades = [];
  const filingUrls = [];

  // Extract filing URLs from search results
  if (data.hits?.hits) {
    for (const hit of data.hits.hits.slice(0, 15)) {
      const url = hit._source?.file_url || hit._id;
      if (url) filingUrls.push(url.startsWith('http') ? url : `https://www.sec.gov${url}`);
    }
  } else if (data.filings) {
    for (const f of data.filings.slice(0, 15)) {
      const url = f.linkToFilingDetails || f.primaryDocUrl;
      if (url) filingUrls.push(url.startsWith('http') ? url : `https://www.sec.gov${url}`);
    }
  }

  let processed = 0;
  for (const url of filingUrls) {
    if (processed > 0) await new Promise(r => setTimeout(r, 150));
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) {
        const text = await res.text();
        if (text.includes('<ownershipDocument') || text.includes('<nonDerivativeTransaction')) {
          allTrades.push(...parseForm4Transactions(text));
        } else {
          // Might be HTML index page, try to find XML
          const xmlMatch = text.match(/href="([^"]*\.xml)"/i);
          if (xmlMatch) {
            let xmlUrl = xmlMatch[1];
            if (!xmlUrl.startsWith('http')) {
              const parts = url.split('/'); parts.pop();
              xmlUrl = parts.join('/') + '/' + xmlUrl;
            }
            const xmlRes = await fetch(xmlUrl, { headers: HEADERS });
            if (xmlRes.ok) {
              const xmlText = await xmlRes.text();
              allTrades.push(...parseForm4Transactions(xmlText));
            }
          }
        }
      }
    } catch {}
    processed++;
    process.stderr.write(`\r  Processing filing ${processed}/${filingUrls.length}...`);
  }
  process.stderr.write('\r' + ' '.repeat(50) + '\r');

  if (allTrades.length === 0) {
    console.log('  No non-derivative buy/sell transactions found in recent filings.');
    return;
  }

  allTrades.sort((a, b) => new Date(b.date) - new Date(a.date));
  table(allTrades, COLUMNS);

  const clusters = detectClusters(allTrades);
  if (clusters.length > 0) {
    console.log('\n  🔥 CLUSTER BUYS DETECTED:');
    for (const c of clusters) {
      console.log(`  ► ${c.ticker}: ${c.count} insiders bought within 7 days (${c.insiders.join(', ')})`);
    }
  }
  console.log();
}

// ── Run ──

async function main() {
  const opts = parseArgs();
  try {
    if (opts.mode === 'ticker') await lookupTicker(opts.ticker);
    else await lookupRecent(opts.days);
  } catch (err) {
    console.error(`\n  Error: ${err.message}\n`);
    process.exit(1);
  }
}

main();
