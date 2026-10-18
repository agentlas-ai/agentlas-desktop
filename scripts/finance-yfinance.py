#!/usr/bin/env python3
"""Owned read-only Finance adapter. JSON in/out only; no install or persistent cache."""
import contextlib
import io
import json
import logging
import math
import re
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor


def main():
    raw = sys.stdin.buffer.read(16385)
    if len(raw) > 16384:
        raise ValueError("finance_world_input_invalid")
    request = json.loads(raw)
    if not isinstance(request, dict):
        raise ValueError("finance_world_input_invalid")
    symbols = request.get("symbols")
    if set(request) != {"symbols"} or not isinstance(symbols, list) or not 1 <= len(symbols) <= 30 or any(not isinstance(s, str) or not re.fullmatch(r"[A-Za-z0-9^=._-]{1,40}", s) for s in symbols) or len(set(symbols)) != len(symbols):
        raise ValueError("finance_world_input_invalid")
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            import yfinance as yf
    except ImportError:
        return {"engine": "yfinance", "observations": [], "errorCode": "finance_yfinance_missing"}
    except Exception:
        return {"engine": "yfinance", "observations": [], "errorCode": "finance_yfinance_runtime_incompatible"}
    logging.getLogger("yfinance").disabled = True
    with tempfile.TemporaryDirectory(prefix="agentlas-finance-yfinance-") as cache:
        # yfinance cookie/timezone databases are transient and removed at process exit.
        yf.set_tz_cache_location(cache)

        def observe(symbol):
            try:
                ticker = yf.Ticker(symbol)
                history = ticker.history(period="5d", interval="1d", auto_adjust=False, back_adjust=False, actions=False, repair=False, timeout=6)
                closes = history["Close"].dropna()
                if len(closes) == 0:
                    return None
                value = float(closes.iloc[-1])
                previous = float(closes.iloc[-2]) if len(closes) > 1 else None
                if not math.isfinite(value) or value < 0:
                    return None
                metadata = ticker.history_metadata
                if metadata.get("symbol") != symbol:
                    return None
                currency = metadata.get("currency")
                return {"symbol": symbol, "value": value, "changePercent": (value / previous - 1) * 100 if previous is not None and math.isfinite(previous) and previous > 0 else None,
                        "currency": currency if isinstance(currency, str) and currency != "XXX" and re.fullmatch(r"[A-Z]{3}", currency) else None,
                        "asOf": closes.index[-1].date().isoformat()}
            except Exception:
                return None
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            with ThreadPoolExecutor(max_workers=5) as executor:
                observations = [row for row in executor.map(observe, symbols) if row is not None]
    return {"engine": "yfinance", "libraryVersion": str(yf.__version__), "observations": observations}


if __name__ == "__main__":
    try:
        result = main()
    except (ValueError, TypeError):
        result = {"engine": "yfinance", "observations": [], "errorCode": "finance_world_input_invalid"}
    except Exception:
        result = {"engine": "yfinance", "observations": [], "errorCode": "finance_world_source_failed"}
    sys.stdout.write(json.dumps(result, ensure_ascii=True, allow_nan=False, separators=(",", ":")))
