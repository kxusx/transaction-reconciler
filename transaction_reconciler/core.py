from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
import csv
import json


MONEY_QUANT = Decimal("0.01")


@dataclass(frozen=True)
class Transaction:
    date: date
    amount: Decimal


@dataclass(frozen=True)
class Balance:
    date: date
    balance: Decimal


@dataclass(frozen=True)
class ReconciliationRow:
    date: date
    transaction_count: int
    transaction_total: Decimal
    expected_balance: Decimal
    actual_balance: Decimal | None
    difference: Decimal | None
    status: str


@dataclass(frozen=True)
class ReconciliationSummary:
    rows: list[ReconciliationRow]
    total_transaction_amount: Decimal
    final_expected_balance: Decimal
    final_actual_balance: Decimal | None
    mismatch_count: int
    missing_statement_count: int
    is_reconciled: bool


@dataclass(frozen=True)
class ReconciliationCheckpoint:
    verified_through: date | None
    expected_balance: Decimal
    reconciled_dates: dict[date, ReconciliationRow]


def parse_money(raw: str, field_name: str) -> Decimal:
    try:
        value = Decimal(raw.strip())
    except (InvalidOperation, AttributeError) as exc:
        raise ValueError(f"Invalid {field_name}: {raw!r}") from exc
    return value.quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)


def parse_date(raw: str) -> date:
    try:
        return date.fromisoformat(raw.strip())
    except (ValueError, AttributeError) as exc:
        raise ValueError(f"Invalid date: {raw!r}; expected YYYY-MM-DD") from exc


def load_transactions(path: str | Path) -> list[Transaction]:
    with Path(path).open(newline="", encoding="utf-8") as csv_file:
        reader = csv.DictReader(csv_file)
        required_columns = {"date", "amount"}
        if not required_columns.issubset(reader.fieldnames or set()):
            raise ValueError("Transactions CSV must contain date and amount columns")

        transactions: list[Transaction] = []
        for line_number, row in enumerate(reader, start=2):
            try:
                transactions.append(
                    Transaction(
                        date=parse_date(row["date"]),
                        amount=parse_money(row["amount"], "amount"),
                    )
                )
            except ValueError as exc:
                raise ValueError(f"{path}:{line_number}: {exc}") from exc
        return transactions


def load_balances(path: str | Path) -> list[Balance]:
    with Path(path).open(newline="", encoding="utf-8") as csv_file:
        reader = csv.DictReader(csv_file)
        required_columns = {"date", "balance"}
        if not required_columns.issubset(reader.fieldnames or set()):
            raise ValueError("Balances CSV must contain date and balance columns")

        balances: list[Balance] = []
        seen_dates: set[date] = set()
        for line_number, row in enumerate(reader, start=2):
            try:
                balance_date = parse_date(row["date"])
                if balance_date in seen_dates:
                    raise ValueError(f"Duplicate bank balance date: {balance_date}")
                seen_dates.add(balance_date)
                balances.append(
                    Balance(
                        date=balance_date,
                        balance=parse_money(row["balance"], "balance"),
                    )
                )
            except ValueError as exc:
                raise ValueError(f"{path}:{line_number}: {exc}") from exc
        return balances


def load_checkpoint(path: str | Path, opening_balance: Decimal = Decimal("0.00")) -> ReconciliationCheckpoint:
    checkpoint_path = Path(path)
    if not checkpoint_path.exists():
        return ReconciliationCheckpoint(
            verified_through=None,
            expected_balance=opening_balance.quantize(MONEY_QUANT),
            reconciled_dates={},
        )

    raw = json.loads(checkpoint_path.read_text(encoding="utf-8"))
    reconciled_dates = {
        parse_date(row_date): ReconciliationRow(
            date=parse_date(row["date"]),
            transaction_count=int(row["transaction_count"]),
            transaction_total=parse_money(row["transaction_total"], "transaction total"),
            expected_balance=parse_money(row["expected_balance"], "expected balance"),
            actual_balance=parse_money(row["actual_balance"], "actual balance")
            if row.get("actual_balance") not in (None, "")
            else None,
            difference=parse_money(row["difference"], "difference")
            if row.get("difference") not in (None, "")
            else None,
            status=row["status"],
        )
        for row_date, row in raw.get("reconciled_dates", {}).items()
    }
    verified_through = raw.get("verified_through")
    return ReconciliationCheckpoint(
        verified_through=parse_date(verified_through) if verified_through else None,
        expected_balance=parse_money(raw["expected_balance"], "expected balance"),
        reconciled_dates=reconciled_dates,
    )


def save_checkpoint(path: str | Path, checkpoint: ReconciliationCheckpoint) -> None:
    checkpoint_path = Path(path)
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "verified_through": checkpoint.verified_through.isoformat()
        if checkpoint.verified_through
        else None,
        "expected_balance": _format_money(checkpoint.expected_balance),
        "reconciled_dates": {
            row_date.isoformat(): _row_to_json(row)
            for row_date, row in checkpoint.reconciled_dates.items()
        },
    }
    checkpoint_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def reconcile_with_checkpoint(
    transactions: list[Transaction],
    balances: list[Balance],
    checkpoint_path: str | Path,
    opening_balance: Decimal = Decimal("0.00"),
) -> ReconciliationSummary:
    opening_balance = opening_balance.quantize(MONEY_QUANT)
    checkpoint = load_checkpoint(checkpoint_path, opening_balance)
    rows = list(checkpoint.reconciled_dates.values())

    current_balance = checkpoint.expected_balance
    previous_date = checkpoint.verified_through
    for row in iter_reconciliation_rows(
        transactions=transactions,
        balances=balances,
    ):
        rows.append(row)
        if row.status != "matched":
            break

        checkpoint = ReconciliationCheckpoint(
            verified_through=row.date,
            expected_balance=row.expected_balance,
            reconciled_dates={**checkpoint.reconciled_dates, row.date: row},
        )
        save_checkpoint(checkpoint_path, checkpoint)

    return _summary_from_rows(rows, transactions, opening_balance)


def iter_reconciliation_rows(
    transactions: list[Transaction],
    balances: list[Balance],

):
    sorted_transactions = sorted(transactions, key=lambda transaction: transaction.date)
    sorted_balances = sorted(balances, key=lambda balance: balance.date)
    transaction_index = 0
    balance_index = 0
    current_balance = 0
    all_dates = [item.date for item in sorted_transactions] + [item.date for item in sorted_balances]
    if not all_dates:
        return

    current_date = min(all_dates)
    end_date = max(all_dates)

    while current_date <= end_date:
        transaction_count = 0
        transaction_total = Decimal("0.00")
        while (
            transaction_index < len(sorted_transactions)
            and sorted_transactions[transaction_index].date == current_date
        ):
            transaction_count += 1
            transaction_total += sorted_transactions[transaction_index].amount
            transaction_index += 1

        actual_balance = None
        if balance_index < len(sorted_balances) and sorted_balances[balance_index].date == current_date:
            actual_balance = sorted_balances[balance_index].balance
            balance_index += 1

        transaction_total = transaction_total.quantize(MONEY_QUANT)
        current_balance = (current_balance + transaction_total).quantize(MONEY_QUANT)
        if actual_balance is None:
            difference = None
            status = "missing_statement"
        else:
            difference = (actual_balance - current_balance).quantize(MONEY_QUANT)
            status = "matched" if difference == Decimal("0.00") else "mismatch"

        yield ReconciliationRow(
            date=current_date,
            transaction_count=transaction_count,
            transaction_total=transaction_total,
            expected_balance=current_balance,
            actual_balance=actual_balance,
            difference=difference,
            status=status,
        )
        current_date += timedelta(days=1)


def _summary_from_rows(
    rows: list[ReconciliationRow],
    transactions: list[Transaction],
    opening_balance: Decimal,
) -> ReconciliationSummary:
    if not rows:
        return ReconciliationSummary(
            rows=[],
            total_transaction_amount=Decimal("0.00"),
            final_expected_balance=opening_balance,
            final_actual_balance=None,
            mismatch_count=0,
            missing_statement_count=0,
            is_reconciled=True,
        )

    mismatch_count = sum(1 for row in rows if row.status == "mismatch")
    missing_statement_count = sum(1 for row in rows if row.status == "missing_statement")
    total_transaction_amount = sum(
        (transaction.amount for transaction in transactions), Decimal("0.00")
    ).quantize(MONEY_QUANT)
    final_actual_rows = [row for row in rows if row.actual_balance is not None]
    final_actual_balance = final_actual_rows[-1].actual_balance if final_actual_rows else None

    return ReconciliationSummary(
        rows=rows,
        total_transaction_amount=total_transaction_amount,
        final_expected_balance=rows[-1].expected_balance,
        final_actual_balance=final_actual_balance,
        mismatch_count=mismatch_count,
        missing_statement_count=missing_statement_count,
        is_reconciled=mismatch_count == 0 and missing_statement_count == 0,
    )


def _row_to_json(row: ReconciliationRow) -> dict[str, str | int | None]:
    return {
        "date": row.date.isoformat(),
        "transaction_count": row.transaction_count,
        "transaction_total": _format_money(row.transaction_total),
        "expected_balance": _format_money(row.expected_balance),
        "actual_balance": _format_money(row.actual_balance),
        "difference": _format_money(row.difference),
        "status": row.status,
    }


def _format_money(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return f"{value:.2f}"
