# Transaction Reconciler

Small Python solution for reconciling a transaction ledger against daily bank statement balances.

The expected balance for each day is:

```text
opening balance + cumulative transactions dated on or before that day
```

The tool produces:

- a terminal summary
- a CSV report with expected vs actual balances
- an HTML report that accountants can scan for mismatches and missing statement dates

## Requirements

- Python 3.10+
- No third-party dependencies

## Run the sample

```bash
python3 -m transaction_reconciler.cli \
  --transactions examples/transactions.csv \
  --balances examples/balances.csv
```

Reports are written to:

- `reports/reconciliation_report.csv`
- `reports/reconciliation_report.html`

The CLI exits with status `0` when everything reconciles and `1` when mismatches or missing statement days need review.

## Run the two-year demo data

The repo also includes larger sample files covering `2024-01-01` through `2025-12-31`:

- `examples/two_year_transactions.csv`
- `examples/two_year_balances.csv`

Each day has either 3 or 4 transactions, for 2,558 total transactions across 731 statement days.

```bash
python3 -m transaction_reconciler.cli \
  --transactions examples/two_year_transactions.csv \
  --balances examples/two_year_balances.csv \
  --out-csv reports/two_year_reconciliation_report.csv \
  --out-html reports/two_year_reconciliation_report.html
```

For the restartable path:

```bash
python3 -m transaction_reconciler.cli \
  --transactions examples/two_year_transactions.csv \
  --balances examples/two_year_balances.csv \
  --checkpoint reports/two_year_checkpoint.json \
  --out-csv reports/two_year_incremental_report.csv \
  --out-html reports/two_year_incremental_report.html
```

## Restartable date-by-date run

For a production-style job that can resume after a worker failure, pass a checkpoint path:

```bash
python3 -m transaction_reconciler.cli \
  --transactions examples/transactions.csv \
  --balances examples/balances.csv \
  --checkpoint reports/checkpoint.json \
  --out-csv reports/incremental_reconciliation_report.csv \
  --out-html reports/incremental_reconciliation_report.html
```

This mode processes dates in order and writes `reports/checkpoint.json` after each matched date. The checkpoint includes a `reconciled_dates` map and `verified_through`, so a later run skips dates that are already known-good. Processing stops at the first mismatch or missing statement date because later cumulative balances are not trustworthy until that break is reviewed.

## Browser upload UI

Open `web/index.html` in a browser, upload both CSV files, and click `Run` or `Verify Next Date`.

The browser UI:

- parses money as integer cents
- verifies one date at a time
- shows the transaction total through that date, the current date total, expected balance, stated bank balance, and difference
- stores progress in `localStorage` after each matched date
- resumes from the last verified date if the page is refreshed or the browser is closed
- stops at the first mismatch or missing statement date

## Run tests

```bash
python3 -m unittest discover
```

## Input format

Transactions CSV:

```csv
date,amount
2025-06-01,1000.00
2025-06-02,-50.00
```

Bank balances CSV:

```csv
date,balance
2025-06-01,1000.00
2025-06-02,950.00
```

Dates must be ISO formatted as `YYYY-MM-DD`. Amounts are parsed with Python `Decimal` and rounded to cents.

## Edge cases handled

- Multiple transactions on the same day
- Days with a bank balance but no transactions
- Transaction dates missing from the bank statement
- Duplicate bank statement dates
- Invalid dates or money values with line-numbered errors
- Optional opening balance with `--opening-balance`
- Restartable checkpointing for date-by-date processing

## Notes

I kept the reconciliation logic separate from report rendering so it can be tested directly and reused by a web app or batch job. The original batch reconciliation remains available, while the checkpointed path is better suited to long-running jobs where partial progress must survive process failures.
