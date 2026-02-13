# insider-pulse

Track SEC Form 4 insider trades from the command line.

## Install

```bash
npm link
```

## Usage

```bash
# Look up insider trades for a specific ticker
insider-pulse AAPL

# Show recent insider trades from the last N days
insider-pulse --recent 7
```

## What it does

- Fetches Form 4 filings from SEC EDGAR
- Parses actual XML filings for transaction details
- Shows: insider name, title, transaction type (buy/sell), shares, value, date
- **Filters out** routine option exercises, grants, and other derivative transactions
- **Flags cluster buys** — multiple insiders buying the same stock within 7 days (a potentially bullish signal)
- Clean ASCII table output

## Requirements

- Node.js 18+ (uses built-in `fetch`)

## Notes

- SEC EDGAR rate limit: ~10 requests/second. The tool adds small delays between requests.
- Only non-derivative buy (P) and sell (S) transactions are shown.
- Data comes directly from SEC EDGAR — no API keys needed.
