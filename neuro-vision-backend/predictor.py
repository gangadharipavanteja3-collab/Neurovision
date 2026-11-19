"""
Neuro Vision - model loading and prediction logic (no web or database code).

Kept separate from main.py so it can be tested on its own:
    python predictor.py
"""
from __future__ import annotations

import math
import pickle
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

BASE_DIR = Path(__file__).resolve().parent

MODEL_PATH = BASE_DIR / "neuro_vision_best_model.pkl"      # saved by Dyslexia.ipynb (Random Forest)
FEATURES_PATH = BASE_DIR / "neuro_vision_features.pkl"     # saved by Dyslexia.ipynb (12 feature names)
SCALER_PATH = BASE_DIR / "neuro_vision_scaler.pkl"         # only exists if SVM was the best model
SVM_PATH = BASE_DIR / "svm_model.pkl"                      # OPTIONAL - see README to export it

# --------------------------------------------------------------------------
# Risk bands - copied from get_risk_level() in Dyslexia.ipynb
# --------------------------------------------------------------------------
LOW_RISK_BELOW = 35.0
HIGH_RISK_FROM = 65.0


def risk_level_from_score(score_percent: float) -> str:
    if score_percent < LOW_RISK_BELOW:
        return "NO RISK"
    if score_percent < HIGH_RISK_FROM:
        return "MODERATE RISK"
    return "HIGH RISK"


# --------------------------------------------------------------------------
# Evaluation metrics - copied from the comparison table printed in
# Dyslexia.ipynb (test split: 59 participants, 45 Normal / 14 Dyslexia).
# --------------------------------------------------------------------------
MODEL_COMPARISON = {
    "title": "SVM vs RANDOM FOREST COMPARISON",
    "source": "Dyslexia.ipynb - 80/20 stratified split, random_state=42, 59 test participants",
    "unit": "%",
    "metrics": ["Accuracy", "Precision", "Recall", "F1 Score"],
    "SVM": [89.83, 78.57, 78.57, 78.57],
    "Random Forest": [91.53, 84.62, 78.57, 81.48],
    "selected_model": "Random Forest",
    "selection_rule": "Highest test accuracy (91.53 % vs 89.83 %)",
}

# --------------------------------------------------------------------------
# Training-dataset summary (df.describe() output in Dyslexia.ipynb).
# Used to check that webcam-derived values are on the same scale.
# --------------------------------------------------------------------------
FEATURE_STATS: dict[str, dict[str, float]] = {
    "FIXATION_COUNT":               dict(mean=3.0519, std=1.5210, min=0.7753,  q25=2.0330,  median=2.7203,  q75=3.5160,  max=9.9119),
    "TOTAL_READING_TIME":           dict(mean=832.61,  std=540.41, min=159.44, q25=476.56,  median=686.91,  q75=1044.08, max=3681.26),
    "FIXATION_DURATION":            dict(mean=274.09,  std=84.07,  min=89.14,  q25=224.42,  median=266.24,  q75=312.94,  max=677.44),
    "FIXATION_X":                   dict(mean=600.71,  std=24.97,  min=414.06, q25=587.60,  median=600.27,  q75=609.35,  max=739.09),
    "FIXATION_Y":                   dict(mean=533.32,  std=14.18,  min=486.94, q25=524.74,  median=532.74,  q75=541.47,  max=576.32),
    "FIRST_RUN_TOTAL_READING_TIME": dict(mean=647.49,  std=391.40, min=194.79, q25=371.67,  median=520.84,  q75=809.48,  max=2343.10),
    "SACCADE_AMPLITUDE":            dict(mean=2.2125,  std=0.8403, min=0.6819, q25=1.7070,  median=2.0687,  q75=2.5612,  max=6.1318),
    "REGRESSION_IN":                dict(mean=0.1760,  std=0.0766, min=0.0413, q25=0.1198,  median=0.1679,  q75=0.2165,  max=0.5317),
    "REGRESSION_OUT":               dict(mean=0.2112,  std=0.0675, min=0.0435, q25=0.1691,  median=0.2126,  q75=0.2533,  max=0.4183),
    "REGRESSION_OUT_FULL":          dict(mean=0.2619,  std=0.0926, min=0.0435, q25=0.2005,  median=0.2544,  q75=0.3129,  max=0.5610),
    "REGRESSION_PATH_DURATION":     dict(mean=1060.13, std=674.74, min=322.04, q25=656.20,  median=859.21,  q75=1213.71, max=4969.33),
    "SKIP":                         dict(mean=0.3469,  std=0.4768, min=0.0,    q25=0.0,     median=0.0,     q75=1.0,     max=1.0),
}


class FeatureValidationError(ValueError):
    """Raised when the incoming features cannot be sent to the model."""

    def __init__(self, message: str, details: dict | None = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------
def _load_pickle(path: Path):
    with open(path, "rb") as handle:
        return pickle.load(handle)


class NeuroVisionModel:
    def __init__(self) -> None:
        if not MODEL_PATH.exists() or not FEATURES_PATH.exists():
            raise RuntimeError(
                "Model files not found. Expected neuro_vision_best_model.pkl and "
                "neuro_vision_features.pkl in the backend folder (created by Dyslexia.ipynb)."
            )
        self.model = _load_pickle(MODEL_PATH)
        self.feature_columns: list[str] = list(_load_pickle(FEATURES_PATH))
        self.model_name = type(self.model).__name__

        if not hasattr(self.model, "predict_proba"):
            raise RuntimeError("The saved model does not support predict_proba().")
        if list(getattr(self.model, "feature_names_in_", self.feature_columns)) != self.feature_columns:
            raise RuntimeError("Feature order inside the model differs from neuro_vision_features.pkl.")
        if int(getattr(self.model, "n_features_in_", len(self.feature_columns))) != len(self.feature_columns):
            raise RuntimeError("Model expects a different number of features than the feature list.")

        # Optional SVM (needs scaler). Not required for the Random Forest result.
        self.svm_model: Any = None
        self.scaler: Any = None
        if SVM_PATH.exists() and SCALER_PATH.exists():
            try:
                self.svm_model = _load_pickle(SVM_PATH)
                self.scaler = _load_pickle(SCALER_PATH)
            except Exception:  # pragma: no cover - optional artefact
                self.svm_model = None
                self.scaler = None

        self.classes = [int(c) for c in self.model.classes_]
        if 1 not in self.classes:
            raise RuntimeError("Model has no class 1 (dyslexia).")
        self.n_trees = len(getattr(self.model, "estimators_", []))

    # ------------------------------------------------------------------
    def validate(self, features: dict[str, Any]) -> dict[str, float]:
        missing = [name for name in self.feature_columns if name not in features]
        extra = [name for name in features if name not in self.feature_columns]
        if missing:
            raise FeatureValidationError("Missing required features", {"missing_features": missing})
        if extra:
            raise FeatureValidationError("Unexpected features received", {"extra_features": extra})

        clean: dict[str, float] = {}
        bad: dict[str, str] = {}
        for name in self.feature_columns:
            value = features[name]
            try:
                number = float(value)
            except (TypeError, ValueError):
                bad[name] = "not a number"
                continue
            if not math.isfinite(number):
                bad[name] = "not finite"
                continue
            clean[name] = number
        if bad:
            raise FeatureValidationError("Invalid feature values", {"invalid_features": bad})

        # Hard physical limits (a value outside these can never be a real measurement)
        for name in ("REGRESSION_IN", "REGRESSION_OUT", "REGRESSION_OUT_FULL"):
            if not 0.0 <= clean[name] <= 1.0:
                bad[name] = "must be a proportion between 0 and 1"
        if clean["SKIP"] not in (0.0, 1.0):
            bad["SKIP"] = "must be 0 or 1 (the training data encodes SKIP as a binary flag)"
        for name in ("FIXATION_COUNT", "TOTAL_READING_TIME", "FIXATION_DURATION",
                     "FIRST_RUN_TOTAL_READING_TIME", "SACCADE_AMPLITUDE",
                     "REGRESSION_PATH_DURATION", "FIXATION_X", "FIXATION_Y"):
            if clean[name] <= 0:
                bad[name] = "must be greater than 0"
        if bad:
            raise FeatureValidationError("Feature values outside valid limits", {"invalid_features": bad})
        return clean

    # ------------------------------------------------------------------
    @staticmethod
    def feature_analysis(clean: dict[str, float]) -> list[dict[str, Any]]:
        """Compare every value with the training dataset (min / quartiles / max)."""
        rows = []
        for name, value in clean.items():
            s = FEATURE_STATS[name]
            if value < s["min"] or value > s["max"]:
                status = "outside training range"
            elif value < s["q25"]:
                status = "below typical range"
            elif value > s["q75"]:
                status = "above typical range"
            else:
                status = "within typical range"
            z = (value - s["mean"]) / s["std"] if s["std"] else 0.0
            rows.append({
                "feature": name,
                "value": round(value, 4),
                "training_min": s["min"], "training_q25": s["q25"],
                "training_median": s["median"], "training_q75": s["q75"],
                "training_max": s["max"], "training_mean": s["mean"],
                "z_score": round(z, 3),
                "status": status,
            })
        return rows

    # ------------------------------------------------------------------
    def predict(self, features: dict[str, Any]) -> dict[str, Any]:
        clean = self.validate(features)
        frame = pd.DataFrame([clean], columns=self.feature_columns)

        probabilities = self.model.predict_proba(frame)[0]
        p_dyslexia = float(probabilities[self.classes.index(1)])
        predicted_class = int(self.model.predict(frame)[0])

        # How many individual trees vote "dyslexia" (explains the probability formula)
        row = frame.to_numpy(dtype=float)
        votes = 0
        for tree in getattr(self.model, "estimators_", []):
            votes += int(round(float(tree.predict(row)[0]))) == 1 and 1 or 0

        risk_percent = round(p_dyslexia * 100.0, 2)
        analysis = self.feature_analysis(clean)
        outside = [r["feature"] for r in analysis if r["status"] == "outside training range"]

        svm_label = None
        if self.svm_model is not None and self.scaler is not None:
            scaled = self.scaler.transform(frame)
            svm_label = "Dyslexic" if int(self.svm_model.predict(scaled)[0]) == 1 else "Normal"

        return {
            "model": "Random Forest",
            "predicted_label": "Dyslexic" if predicted_class == 1 else "Normal",
            "risk_probability": round(p_dyslexia, 4),
            "risk_percentage": risk_percent,
            "risk_level": risk_level_from_score(risk_percent),
            "tree_votes_dyslexic": votes,
            "tree_count": self.n_trees,
            "svm_prediction": svm_label,
            "feature_analysis": analysis,
            "features_outside_training_range": outside,
            "formula": "Risk % = P(Dyslexic | features) x 100, where P = (1/T) x SUM over the T trees of "
                       "each tree's dyslexic-class proportion in the leaf reached by the features",
            "risk_bands": {"low_below": LOW_RISK_BELOW, "high_from": HIGH_RISK_FROM},
            "message": "Experimental screening result. This is not a clinical diagnosis.",
        }


if __name__ == "__main__":  # quick self-test
    nv = NeuroVisionModel()
    print("Model:", nv.model_name, "| trees:", nv.n_trees, "| features:", len(nv.feature_columns))
    typical = {k: v["median"] for k, v in FEATURE_STATS.items()}
    result = nv.predict(typical)
    print({k: result[k] for k in ("predicted_label", "risk_percentage", "risk_level", "tree_votes_dyslexic")})
