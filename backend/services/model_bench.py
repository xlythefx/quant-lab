"""
Model Bench — train a real LSTM (PyTorch) to predict the next move, with the
train-vs-test honesty front and center.

Runs as a background job (one at a time, daemon thread) exactly like
walkforward.py, emitting `mb_*` progress events via event_bus, because LSTM
training takes seconds-to-minutes and must not block the request thread.

Honesty invariants:
  - Features are the SAME causal builder used by Feature Importance
    (market_lab._build_features) — a value at bar i uses only bars <= i.
  - Time-ordered train / validation / test split (NO shuffle). The scaler is
    fit on TRAIN only. Early stopping watches validation loss.
  - We report train / val / test accuracy + test AUC + the overfit gap
    (train − test) and a LogisticRegression baseline, so a model that merely
    memorizes the training set is exposed rather than celebrated.

torch is imported lazily inside the job so the app boots even when torch isn't
installed; the job then fails with a clear "pip install torch" message.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from typing import Optional

import numpy as np

from services import event_bus, market_lab

log = logging.getLogger(__name__)

_lock = threading.Lock()
_current_job: Optional["ModelBenchJob"] = None
_last_result: Optional[dict] = None


def get_status() -> dict:
    with _lock:
        job = _current_job
    if job is None:
        return {"state": "idle", "result": _last_result}
    return job.snapshot()


def get_last_result() -> Optional[dict]:
    return _last_result


def cancel_current() -> bool:
    with _lock:
        job = _current_job
    if job is None or job.state not in ("running", "starting"):
        return False
    job.request_cancel()
    return True


def start(spec: dict) -> str:
    global _current_job
    with _lock:
        prev = _current_job
    if prev is not None and prev.state in ("running", "starting"):
        prev.request_cancel()
        prev.join(timeout=5.0)
    job = ModelBenchJob(spec)
    with _lock:
        _current_job = job
    job.start()
    return job.job_id


def _normalize_spec(spec: dict) -> dict:
    out = {
        "symbol": str(spec["symbol"]).strip(),
        "timeframe": str(spec["timeframe"]).strip(),
        "start_time": int(spec["start_time"]) if spec.get("start_time") is not None else None,
        "end_time": int(spec["end_time"]) if spec.get("end_time") is not None else None,
        "seq_len": max(4, int(spec.get("seq_len") or 24)),
        "fwd_horizon": max(1, int(spec.get("fwd_horizon") or 5)),
        "hidden": max(4, min(128, int(spec.get("hidden") or 32))),
        "epochs": max(1, min(200, int(spec.get("epochs") or 30))),
        "max_samples": max(1000, int(spec.get("max_samples") or 15000)),
        "seed": int(spec.get("seed") or 0),
    }
    if not out["symbol"]:
        raise ValueError("symbol is required")
    return out


class ModelBenchJob:
    def __init__(self, spec: dict):
        self.spec = _normalize_spec(spec)
        self.job_id = uuid.uuid4().hex[:12]
        self.state = "starting"
        self.cancel_flag = False
        self.started_at = time.time()
        self.error: Optional[str] = None
        self.epoch = 0
        self.total_epochs = self.spec["epochs"]
        self.train_loss: Optional[float] = None
        self.val_loss: Optional[float] = None
        self._thread = threading.Thread(target=self._run, name=f"mb-{self.job_id}", daemon=True)

    def start(self):
        self._thread.start()

    def join(self, timeout=None):
        self._thread.join(timeout=timeout)

    def request_cancel(self):
        self.cancel_flag = True

    def snapshot(self) -> dict:
        elapsed = time.time() - self.started_at
        eta = None
        if self.state == "running" and self.epoch > 0:
            per = elapsed / self.epoch
            eta = max(0.0, per * (self.total_epochs - self.epoch))
        return {
            "state": self.state,
            "job_id": self.job_id,
            "spec": {k: self.spec[k] for k in ("symbol", "timeframe", "seq_len", "fwd_horizon", "hidden", "epochs")},
            "epoch": self.epoch,
            "total_epochs": self.total_epochs,
            "train_loss": self.train_loss,
            "val_loss": self.val_loss,
            "elapsed_seconds": elapsed,
            "eta_seconds": eta,
            "error": self.error,
        }

    def _emit(self, event: str, payload: dict):
        event_bus.emit(event, {"job_id": self.job_id, **payload})

    def _run(self):
        global _last_result
        try:
            self.state = "running"
            result = self._do_run()
            if self.cancel_flag:
                self.state = "cancelled"
                self._emit("mb_cancelled", {})
            else:
                _last_result = result
                self.state = "done"
                self._emit("mb_complete", {"result": result})
        except Exception as e:
            log.exception("model-bench job failed")
            self.error = str(e)
            self.state = "error"
            self._emit("mb_error", {"message": str(e)})

    def _do_run(self) -> dict:
        try:
            import torch
            import torch.nn as nn
        except Exception:
            raise ValueError(
                "PyTorch is not installed. Run `pip install torch` in the backend "
                "environment to enable the LSTM Model Bench."
            )
        from sklearn.preprocessing import StandardScaler
        from sklearn.linear_model import LogisticRegression
        from sklearn.metrics import roc_auc_score

        s = self.spec
        torch.manual_seed(s["seed"]); np.random.seed(s["seed"])

        df = market_lab._load_window(s["symbol"], s["timeframe"], s["start_time"], s["end_time"])
        X, names = market_lab._build_features(df, {})
        close = df["close"].to_numpy(dtype=float)
        n = len(df)
        h = s["fwd_horizon"]
        seq_len = s["seq_len"]

        fwd = np.full(n, np.nan)
        fwd[: n - h] = close[h:] / close[: n - h] - 1.0
        y_all = (fwd > 0).astype(float)
        Xa = X.to_numpy(dtype=float)
        row_ok = np.all(np.isfinite(Xa), axis=1) & np.isfinite(fwd)

        # Build sequences ending at bar i (causal), label = next-h direction.
        seqs, labels, ends = [], [], []
        for i in range(seq_len - 1, n):
            if i + h >= n:
                break
            if not row_ok[i - seq_len + 1: i + 1].all():
                continue
            seqs.append(Xa[i - seq_len + 1: i + 1])
            labels.append(y_all[i])
            ends.append(i)
        if len(seqs) < 500:
            raise ValueError("insufficient data after feature warm-up to train a sequence model")

        seqs = np.asarray(seqs, dtype=np.float32)          # (N, seq_len, k)
        labels = np.asarray(labels, dtype=np.float32)
        if len(seqs) > s["max_samples"]:                   # keep the most recent
            seqs, labels = seqs[-s["max_samples"]:], labels[-s["max_samples"]:]
        N, _, k = seqs.shape

        # Time-ordered split (no shuffle).
        i_tr, i_va = int(N * 0.70), int(N * 0.85)
        # Scale per-feature on TRAIN rows only.
        scaler = StandardScaler().fit(seqs[:i_tr].reshape(-1, k))
        seqs = scaler.transform(seqs.reshape(-1, k)).reshape(N, seq_len, k).astype(np.float32)
        Xtr, Xva, Xte = seqs[:i_tr], seqs[i_tr:i_va], seqs[i_va:]
        ytr, yva, yte = labels[:i_tr], labels[i_tr:i_va], labels[i_va:]
        baseline = float(max(yte.mean(), 1 - yte.mean())) if yte.size else None

        class LSTMClf(nn.Module):
            def __init__(self, n_feat, hidden):
                super().__init__()
                self.lstm = nn.LSTM(n_feat, hidden, batch_first=True)
                self.head = nn.Linear(hidden, 1)

            def forward(self, x):
                out, _ = self.lstm(x)
                return self.head(out[:, -1, :]).squeeze(-1)

        device = torch.device("cpu")
        model = LSTMClf(k, s["hidden"]).to(device)
        opt = torch.optim.Adam(model.parameters(), lr=1e-3)
        lossf = nn.BCEWithLogitsLoss()

        tXtr = torch.from_numpy(Xtr); tytr = torch.from_numpy(ytr)
        tXva = torch.from_numpy(Xva); tyva = torch.from_numpy(yva)
        tXte = torch.from_numpy(Xte)
        batch = 256
        best_val = float("inf"); best_state = None; patience, bad = 6, 0

        for ep in range(s["epochs"]):
            if self.cancel_flag:
                break
            model.train()
            perm = torch.randperm(tXtr.shape[0])
            tl = 0.0
            for b in range(0, tXtr.shape[0], batch):
                idx = perm[b: b + batch]
                opt.zero_grad()
                logits = model(tXtr[idx])
                loss = lossf(logits, tytr[idx])
                loss.backward(); opt.step()
                tl += float(loss.detach()) * len(idx)
            tl /= max(1, tXtr.shape[0])
            model.eval()
            with torch.no_grad():
                vl = float(lossf(model(tXva), tyva)) if tXva.shape[0] else float("nan")
            self.epoch = ep + 1; self.train_loss = tl; self.val_loss = vl
            self._emit("mb_progress", {"epoch": ep + 1, "total_epochs": s["epochs"],
                                       "train_loss": tl, "val_loss": vl})
            if np.isfinite(vl) and vl < best_val - 1e-4:
                best_val = vl; bad = 0
                best_state = {kk: v.clone() for kk, v in model.state_dict().items()}
            else:
                bad += 1
                if bad >= patience:
                    break

        if best_state is not None:
            model.load_state_dict(best_state)

        def acc(Xt, yt):
            if not len(yt):
                return None, None
            model.eval()
            with torch.no_grad():
                p = torch.sigmoid(model(torch.from_numpy(Xt))).numpy()
            a = float(((p > 0.5).astype(float) == yt).mean())
            try:
                auc = float(roc_auc_score(yt, p)) if len(np.unique(yt)) > 1 else None
            except Exception:
                auc = None
            return a, auc

        tr_acc, _ = acc(Xtr, ytr)
        va_acc, _ = acc(Xva, yva)
        te_acc, te_auc = acc(Xte, yte)

        # Logistic baseline on the LAST-bar features (no sequence) — the LSTM
        # must beat this to justify its complexity.
        last_tr, last_te = Xtr[:, -1, :], Xte[:, -1, :]
        base_auc = None; base_acc = None
        try:
            lr = LogisticRegression(max_iter=1000).fit(last_tr, ytr)
            base_acc = float(lr.score(last_te, yte))
            bp = lr.predict_proba(last_te)[:, 1]
            base_auc = float(roc_auc_score(yte, bp)) if len(np.unique(yte)) > 1 else None
        except Exception:
            pass

        models = [
            {"name": "LSTM", "train_accuracy": _s(tr_acc), "val_accuracy": _s(va_acc),
             "test_accuracy": _s(te_acc), "test_auc": _s(te_auc),
             "overfit_gap": _s(tr_acc - te_acc) if (tr_acc is not None and te_acc is not None) else None},
            {"name": "LogisticRegression (last bar)", "train_accuracy": None, "val_accuracy": None,
             "test_accuracy": _s(base_acc), "test_auc": _s(base_auc), "overfit_gap": None},
        ]
        return {
            "models": models,
            "baseline_accuracy": _s(baseline),
            "n_train": int(Xtr.shape[0]), "n_val": int(Xva.shape[0]), "n_test": int(Xte.shape[0]),
            "features": names,
            "spec": {k2: s[k2] for k2 in ("symbol", "timeframe", "seq_len", "fwd_horizon", "hidden", "epochs")},
            "caveat": ("A true LSTM on causal features with a time-ordered train/val/test split. "
                       "What matters: TEST accuracy vs baseline, and the train−test gap. A large gap "
                       "means the LSTM is memorizing noise, not finding an edge. If it can't beat the "
                       "logistic baseline, the sequence model adds nothing."),
        }


def _s(v):
    """JSON-safe float."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if np.isfinite(f) else None
