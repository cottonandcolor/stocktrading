"""Persistent SQLite paper-broker engine for the local trading dashboard."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, Optional
from zoneinfo import ZoneInfo


ET = ZoneInfo("America/New_York")
DEFAULT_DB = Path(__file__).with_name("paper_platform.db")


@dataclass(frozen=True)
class Fill:
    instrument: str
    side: str
    quantity: float
    price: float
    realized_pnl: float
    timestamp: str


class PaperBroker:
    """Small paper brokerage with cash, positions, fills, and realized P&L."""

    def __init__(self, path: Path = DEFAULT_DB, initial_cash: float = 25_000):
        self.path = Path(path)
        self.initial_cash = float(initial_cash)
        self._create_schema()
        self._initialize_account()

    def connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        return db

    def _create_schema(self) -> None:
        with self.connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS account (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    initial_cash REAL NOT NULL,
                    cash REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS positions (
                    instrument TEXT PRIMARY KEY,
                    asset_type TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    quantity REAL NOT NULL,
                    avg_price REAL NOT NULL,
                    stop_price REAL,
                    target_price REAL,
                    metadata TEXT NOT NULL DEFAULT '{}',
                    opened_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS orders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    instrument TEXT NOT NULL,
                    asset_type TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    side TEXT NOT NULL,
                    quantity REAL NOT NULL,
                    price REAL NOT NULL,
                    notional REAL NOT NULL,
                    realized_pnl REAL NOT NULL DEFAULT 0,
                    strategy TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'FILLED',
                    notes TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS equity_history (
                    timestamp TEXT PRIMARY KEY,
                    equity REAL NOT NULL,
                    cash REAL NOT NULL
                );
                """
            )

    def _initialize_account(self) -> None:
        with self.connect() as db:
            db.execute(
                "INSERT OR IGNORE INTO account(id, initial_cash, cash) VALUES(1, ?, ?)",
                (self.initial_cash, self.initial_cash),
            )

    @staticmethod
    def now() -> str:
        return datetime.now(ET).isoformat(timespec="seconds")

    def reset(self, initial_cash: Optional[float] = None) -> None:
        cash = float(initial_cash or self.initial_cash)
        with self.connect() as db:
            db.execute("DELETE FROM orders")
            db.execute("DELETE FROM positions")
            db.execute("DELETE FROM equity_history")
            db.execute(
                "UPDATE account SET initial_cash = ?, cash = ? WHERE id = 1",
                (cash, cash),
            )

    def account(self) -> Dict[str, float]:
        with self.connect() as db:
            row = db.execute("SELECT initial_cash, cash FROM account WHERE id = 1").fetchone()
        return {"initial_cash": float(row["initial_cash"]), "cash": float(row["cash"])}

    def positions(self) -> list:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM positions ORDER BY asset_type, symbol").fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["metadata"] = json.loads(item["metadata"])
            result.append(item)
        return result

    def orders(self, limit: int = 200) -> list:
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM orders ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(row) for row in rows]

    def realized_pnl(self, date: Optional[str] = None, strategy: Optional[str] = None) -> float:
        query = "SELECT COALESCE(SUM(realized_pnl), 0) value FROM orders WHERE 1=1"
        params = []
        if date:
            query += " AND substr(timestamp, 1, 10) = ?"
            params.append(date)
        if strategy:
            query += " AND strategy = ?"
            params.append(strategy)
        with self.connect() as db:
            row = db.execute(query, params).fetchone()
        return float(row["value"])

    def opening_trades(self, date: str, strategy: str = "day") -> int:
        with self.connect() as db:
            row = db.execute(
                """
                SELECT COUNT(*) value FROM orders
                WHERE substr(timestamp, 1, 10) = ?
                  AND strategy = ?
                  AND notes LIKE 'OPEN%'
                """,
                (date, strategy),
            ).fetchone()
        return int(row["value"])

    def _insert_order(
        self,
        db: sqlite3.Connection,
        *,
        timestamp: str,
        instrument: str,
        asset_type: str,
        symbol: str,
        side: str,
        quantity: float,
        price: float,
        realized_pnl: float,
        strategy: str,
        notes: str,
    ) -> None:
        multiplier = 100 if asset_type == "spread" else 1
        db.execute(
            """
            INSERT INTO orders(
                timestamp, instrument, asset_type, symbol, side, quantity,
                price, notional, realized_pnl, strategy, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                timestamp,
                instrument,
                asset_type,
                symbol,
                side,
                quantity,
                price,
                abs(quantity * price * multiplier),
                realized_pnl,
                strategy,
                notes,
            ),
        )

    def execute_stock(
        self,
        symbol: str,
        side: str,
        quantity: int,
        price: float,
        *,
        stop_price: Optional[float] = None,
        target_price: Optional[float] = None,
        strategy: str = "day",
        notes: str = "",
    ) -> Fill:
        symbol = symbol.upper().strip()
        side = side.upper()
        if side not in {"BUY", "SELL"}:
            raise ValueError("stock side must be BUY or SELL")
        if quantity <= 0 or price <= 0:
            raise ValueError("quantity and price must be positive")

        delta = float(quantity if side == "BUY" else -quantity)
        timestamp = self.now()
        instrument = symbol
        with self.connect() as db:
            row = db.execute(
                "SELECT * FROM positions WHERE instrument = ?", (instrument,)
            ).fetchone()
            old_qty = float(row["quantity"]) if row else 0.0
            old_avg = float(row["avg_price"]) if row else 0.0
            new_qty = old_qty + delta
            realized = 0.0

            if old_qty and old_qty * delta < 0:
                closed = min(abs(old_qty), abs(delta))
                realized = closed * (price - old_avg) * (1 if old_qty > 0 else -1)

            cash_change = -delta * price
            cash = float(
                db.execute("SELECT cash FROM account WHERE id = 1").fetchone()["cash"]
            )
            if cash + cash_change < -0.01:
                raise ValueError("insufficient paper cash")
            db.execute("UPDATE account SET cash = cash + ? WHERE id = 1", (cash_change,))

            if abs(new_qty) < 1e-9:
                db.execute("DELETE FROM positions WHERE instrument = ?", (instrument,))
                action = "CLOSE"
            else:
                if old_qty == 0 or old_qty * delta > 0:
                    new_avg = (
                        abs(old_qty) * old_avg + abs(delta) * price
                    ) / (abs(old_qty) + abs(delta))
                    action = "OPEN" if old_qty == 0 else "ADD"
                elif old_qty * new_qty > 0:
                    new_avg = old_avg
                    action = "REDUCE"
                else:
                    new_avg = price
                    action = "FLIP"
                metadata = "{}"
                effective_stop = (
                    stop_price if stop_price is not None else (row["stop_price"] if row else None)
                )
                effective_target = (
                    target_price
                    if target_price is not None
                    else (row["target_price"] if row else None)
                )
                db.execute(
                    """
                    INSERT INTO positions(
                        instrument, asset_type, symbol, quantity, avg_price,
                        stop_price, target_price, metadata, opened_at, updated_at
                    ) VALUES (?, 'stock', ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(instrument) DO UPDATE SET
                        quantity=excluded.quantity,
                        avg_price=excluded.avg_price,
                        stop_price=excluded.stop_price,
                        target_price=excluded.target_price,
                        updated_at=excluded.updated_at
                    """,
                    (
                        instrument,
                        symbol,
                        new_qty,
                        new_avg,
                        effective_stop,
                        effective_target,
                        metadata,
                        row["opened_at"] if row else timestamp,
                        timestamp,
                    ),
                )

            self._insert_order(
                db,
                timestamp=timestamp,
                instrument=instrument,
                asset_type="stock",
                symbol=symbol,
                side=side,
                quantity=quantity,
                price=price,
                realized_pnl=realized,
                strategy=strategy,
                notes=f"{action} {notes}".strip(),
            )
        return Fill(instrument, side, quantity, price, realized, timestamp)

    @staticmethod
    def spread_key(
        symbol: str,
        expiry: str,
        option_type: str,
        long_strike: float,
        short_strike: float,
    ) -> str:
        return (
            f"{symbol.upper()} {expiry} {option_type.upper()} "
            f"{long_strike:g}/{short_strike:g}"
        )

    def open_debit_spread(
        self,
        symbol: str,
        expiry: str,
        option_type: str,
        long_strike: float,
        short_strike: float,
        contracts: int,
        debit: float,
        *,
        strategy: str = "weekly",
        notes: str = "",
    ) -> Fill:
        option_type = option_type.upper()
        if option_type not in {"CALL", "PUT"}:
            raise ValueError("option type must be CALL or PUT")
        if contracts <= 0 or debit <= 0:
            raise ValueError("contracts and debit must be positive")
        width = abs(long_strike - short_strike)
        if width <= 0 or debit >= width:
            raise ValueError("debit must be below spread width")
        key = self.spread_key(symbol, expiry, option_type, long_strike, short_strike)
        timestamp = self.now()
        metadata = {
            "expiry": expiry,
            "option_type": option_type,
            "long_strike": float(long_strike),
            "short_strike": float(short_strike),
            "width": width,
        }
        cost = contracts * debit * 100
        with self.connect() as db:
            cash = float(
                db.execute("SELECT cash FROM account WHERE id = 1").fetchone()["cash"]
            )
            if cost > cash:
                raise ValueError("insufficient paper cash")
            row = db.execute(
                "SELECT * FROM positions WHERE instrument = ?", (key,)
            ).fetchone()
            old_qty = float(row["quantity"]) if row else 0
            old_avg = float(row["avg_price"]) if row else 0
            new_qty = old_qty + contracts
            avg = (old_qty * old_avg + contracts * debit) / new_qty
            db.execute("UPDATE account SET cash = cash - ? WHERE id = 1", (cost,))
            db.execute(
                """
                INSERT INTO positions(
                    instrument, asset_type, symbol, quantity, avg_price,
                    metadata, opened_at, updated_at
                ) VALUES (?, 'spread', ?, ?, ?, ?, ?, ?)
                ON CONFLICT(instrument) DO UPDATE SET
                    quantity=excluded.quantity,
                    avg_price=excluded.avg_price,
                    metadata=excluded.metadata,
                    updated_at=excluded.updated_at
                """,
                (
                    key,
                    symbol.upper(),
                    new_qty,
                    avg,
                    json.dumps(metadata),
                    row["opened_at"] if row else timestamp,
                    timestamp,
                ),
            )
            self._insert_order(
                db,
                timestamp=timestamp,
                instrument=key,
                asset_type="spread",
                symbol=symbol.upper(),
                side="BUY",
                quantity=contracts,
                price=debit,
                realized_pnl=0,
                strategy=strategy,
                notes=f"OPEN {notes}".strip(),
            )
        return Fill(key, "BUY", contracts, debit, 0, timestamp)

    def close_debit_spread(
        self,
        instrument: str,
        contracts: int,
        credit: float,
        *,
        notes: str = "",
    ) -> Fill:
        if contracts <= 0 or credit < 0:
            raise ValueError("invalid contracts or credit")
        timestamp = self.now()
        with self.connect() as db:
            row = db.execute(
                "SELECT * FROM positions WHERE instrument = ? AND asset_type = 'spread'",
                (instrument,),
            ).fetchone()
            if not row or contracts > row["quantity"]:
                raise ValueError("spread position not found or quantity too large")
            metadata = json.loads(row["metadata"])
            credit = min(float(credit), float(metadata["width"]))
            remaining = float(row["quantity"]) - contracts
            realized = (credit - float(row["avg_price"])) * contracts * 100
            db.execute(
                "UPDATE account SET cash = cash + ? WHERE id = 1",
                (contracts * credit * 100,),
            )
            if remaining == 0:
                db.execute("DELETE FROM positions WHERE instrument = ?", (instrument,))
            else:
                db.execute(
                    "UPDATE positions SET quantity = ?, updated_at = ? WHERE instrument = ?",
                    (remaining, timestamp, instrument),
                )
            self._insert_order(
                db,
                timestamp=timestamp,
                instrument=instrument,
                asset_type="spread",
                symbol=row["symbol"],
                side="SELL",
                quantity=contracts,
                price=credit,
                realized_pnl=realized,
                strategy="weekly",
                notes=f"CLOSE {notes}".strip(),
            )
        return Fill(instrument, "SELL", contracts, credit, realized, timestamp)

    def mark_account(self, marks: Dict[str, float]) -> Dict[str, float]:
        account = self.account()
        market_value = 0.0
        unrealized = 0.0
        for position in self.positions():
            mark = marks.get(position["instrument"], position["avg_price"])
            multiplier = 100 if position["asset_type"] == "spread" else 1
            value = position["quantity"] * mark * multiplier
            cost = position["quantity"] * position["avg_price"] * multiplier
            market_value += value
            unrealized += value - cost
        equity = account["cash"] + market_value
        with self.connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO equity_history(timestamp, equity, cash) VALUES(?, ?, ?)",
                (self.now(), equity, account["cash"]),
            )
        return {
            **account,
            "market_value": market_value,
            "equity": equity,
            "unrealized_pnl": unrealized,
            "total_pnl": equity - account["initial_cash"],
        }

    def equity_history(self) -> list:
        with self.connect() as db:
            rows = db.execute(
                "SELECT timestamp, equity, cash FROM equity_history ORDER BY timestamp"
            ).fetchall()
        return [dict(row) for row in rows]
