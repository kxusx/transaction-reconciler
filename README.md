# Transaction Reconciler

This project reconciles a transaction ledger against daily bank balances.

The main idea is:

```text
expected balance for a date = opening balance + all transactions up to that date
```

For each calendar date, the code compares that expected balance to the bank's stated balance. A date is marked:

- `matched` when the balances are exactly equal
- `mismatch` when the bank balance exists but does not match
- `missing_statement` when there is no bank balance for that date

## Why Date By Date

The reconciler processes one date at a time instead of only producing one final answer. After each matched date, progress can be checkpointed:

```text
verified_through = last date known to be correct
expected_balance = balance at that verified date
reconciled_dates = map of verified date -> reconciliation row
```

If processing stops halfway through, the next run can resume after `verified_through`. If a mismatch is found, processing stops because later balances depend on the unresolved date.

## Browser Demo

Open:

```text
web/index.html
```

Upload:

```text
examples/transactions.csv
examples/balances.csv
```

Or use the larger demo files:

```text
examples/two_year_transactions.csv
examples/two_year_balances.csv
```

The browser app verifies each date and shows:

- transaction total for the current date
- transaction total through that date
- expected balance
- stated bank balance
- difference
- status

The browser stores progress in `localStorage`, so refreshing the page can resume from the last matched date.

## Input Format

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

Dates use `YYYY-MM-DD`. Money is handled as cents in the browser and as `Decimal` in Python to avoid floating point errors.
