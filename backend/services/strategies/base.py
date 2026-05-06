"""
Strategy contract.

Two interfaces in one class:
  - on_candle(candle, state) -> Signal | None     # LIVE, stateful
  - vectorized(df) -> pd.DataFrame                # BACKTEST, batch

Each strategy declares a PARAM_SCHEMA list of ParamSpec entries. The schema
is rendered as a form on the frontend so users can edit any param and
re-run. Defaults are recoverable. The strategy reads from self.p only.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class ParamType(str, Enum):
    INT = "int"
    FLOAT = "float"
    BOOL = "bool"
    SESSIONS = "sessions"   # multi-checkbox: tokyo / london / ny_am / ny_pm
    SIDES = "sides"         # multi-checkbox: long / short


@dataclass
class ParamSpec:
    name: str
    type: ParamType
    default: Any
    min: Optional[float] = None
    max: Optional[float] = None
    step: Optional[float] = None
    group: str = "General"
    description: str = ""

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "type": self.type.value,
            "default": self.default,
            "min": self.min,
            "max": self.max,
            "step": self.step,
            "group": self.group,
            "description": self.description,
        }


@dataclass
class StrategyMeta:
    id: str
    name: str
    description: str
    schema: list[ParamSpec] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "schema": [s.to_dict() for s in self.schema],
        }


@dataclass
class Signal:
    """Emitted by strategies for chart markers + trade tracking."""
    side: str           # "long" | "short" | "flat"
    kind: str           # "entry" | "exit"
    price: float
    time: int           # epoch seconds
    reason: str = ""    # e.g. "z_revert" / "atr_stop"


@dataclass
class OverlaySpec:
    """Declares a chart overlay produced by the strategy.
    `from_column` must match a column name in the DataFrame returned by
    vectorized(). Rendered as a line series on the candle chart."""
    key: str            # stable id, e.g. "vwma"
    label: str          # legend, e.g. "VWMA(30)"
    from_column: str    # column in vectorized() output
    color: str = "#fbbf24"
    line_width: int = 1
    line_style: str = "solid"   # "solid" | "dashed"

    def to_dict(self):
        return {
            "key": self.key, "label": self.label,
            "color": self.color, "line_width": self.line_width,
            "line_style": self.line_style,
        }


class Strategy(ABC):
    META: StrategyMeta
    PARAM_SCHEMA: list[ParamSpec] = []
    OVERLAYS: list[OverlaySpec] = []

    def __init__(self, params: Optional[dict] = None):
        self.p = self._merge_with_defaults(params or {})

    @classmethod
    def _merge_with_defaults(cls, overrides: dict) -> dict:
        out = {}
        for spec in cls.PARAM_SCHEMA:
            if spec.name in overrides and overrides[spec.name] is not None:
                v = overrides[spec.name]
                # Coerce numeric types so JSON ints don't become floats etc.
                if spec.type == ParamType.INT:
                    v = int(v)
                elif spec.type == ParamType.FLOAT:
                    v = float(v)
                elif spec.type == ParamType.BOOL:
                    v = bool(v)
                elif spec.type == ParamType.SIDES:
                    merged = dict(spec.default)
                    merged.update({k: bool(val) for k, val in (v or {}).items()})
                    v = merged
                elif spec.type == ParamType.SESSIONS:
                    # Each session value is a dict {enabled, start, end}; merge
                    # per-session so the user can override any subset.
                    merged = {}
                    for name, default_cfg in spec.default.items():
                        cfg = dict(default_cfg)  # {enabled, start, end}
                        override = (v or {}).get(name) or {}
                        if "enabled" in override:
                            cfg["enabled"] = bool(override["enabled"])
                        if "start" in override and override["start"]:
                            cfg["start"] = str(override["start"])
                        if "end" in override and override["end"]:
                            cfg["end"] = str(override["end"])
                        merged[name] = cfg
                    v = merged
                out[spec.name] = v
            else:
                out[spec.name] = spec.default
        return out

    # ---- abstract interfaces ------------------------------------------
    @abstractmethod
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        """Per-candle stateful execution for LIVE mode.

        `state` is a mutable dict the runner persists across calls. Return
        a Signal for entries/exits, or None for no action.
        """

    @abstractmethod
    def vectorized(self, df):
        """Batch execution for BACKTEST mode.

        Input: pandas DataFrame indexed by integer position with columns
          time, open, high, low, close, volume.
        Output: same DataFrame with these columns appended:
          entry_long, entry_short, exit_long, exit_short  (bool arrays)
          stop_price                                       (float, NaN where N/A)
        """
