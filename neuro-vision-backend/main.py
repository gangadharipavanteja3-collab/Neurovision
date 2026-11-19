"""
Neuro Vision - FastAPI backend.

Run:  py -m uvicorn main:app --reload
Docs: http://127.0.0.1:8000/docs
"""
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import database
from predictor import (FEATURE_STATS, HIGH_RISK_FROM, LOW_RISK_BELOW, MODEL_COMPARISON,
                       FeatureValidationError, NeuroVisionModel)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("neuro_vision")

app = FastAPI(
    title="Neuro Vision API",
    description="Prediction + MySQL persistence for the Neuro Vision experimental screening prototype. "
                "Speech recognition runs in the browser.",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # local prototype: any local page may call the API
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

try:
    nv = NeuroVisionModel()
    log.info("Model loaded: %s (%d trees, %d features)", nv.model_name, nv.n_trees, len(nv.feature_columns))
except Exception as error:  # fail loudly at start-up, not on the first request
    raise RuntimeError(f"Error loading trained model: {error}")


# ---------------------------------------------------------------- schemas
class PredictionRequest(BaseModel):
    session_id: str
    features: dict[str, float]


class ParticipantIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    age: int = Field(ge=3, le=18)
    gender: str = Field(min_length=1, max_length=30)
    guardian_consent: bool = True


class AssessmentIn(BaseModel):
    assessed_at: Optional[str] = None
    reading_duration_seconds: Optional[float] = None
    transcript: str = ""
    passage_level: Optional[str] = None
    passage_text: Optional[str] = None
    total_words: Optional[int] = None
    words_spoken_matched: Optional[int] = None
    words_skipped: Optional[int] = None
    word_count: Optional[int] = None
    gaze_sample_count: Optional[int] = None
    fixation_total: Optional[int] = None
    calibration_error: Optional[float] = None


class SaveAssessmentRequest(BaseModel):
    session_id: str = Field(min_length=3, max_length=40)
    account_email: Optional[str] = None
    participant: ParticipantIn
    assessment: AssessmentIn
    features: dict[str, float]
    gaze_samples: list[list[float]] = Field(default_factory=list, max_length=40000)


def _mysql_datetime(value: Optional[str]) -> Optional[str]:
    """ISO-8601 from the browser -> 'YYYY-MM-DD HH:MM:SS' (UTC) for MySQL."""
    if not value:
        return None
    from datetime import datetime, timezone
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo:
            parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
        return parsed.strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def _predict_or_422(features: dict) -> dict:
    try:
        return nv.predict(features)
    except FeatureValidationError as error:
        raise HTTPException(status_code=422, detail={"message": error.message, **error.details})


# ---------------------------------------------------------------- routes
@app.get("/api/health")
def health_check():
    try:
        db = database.database_status()
        db_ok = all(t["exists"] for name, t in db["tables"].items() if name != "gaze_samples")
        db_msg = "connected" if db_ok else "connected, but required tables are missing"
    except Exception as error:
        db_ok, db_msg = False, f"unavailable: {error}"
    return {"status": "ok", "models_loaded": True, "model": nv.model_name,
            "database_ready": db_ok, "database": db_msg}


@app.get("/api/db-status")
def db_status():
    try:
        return database.database_status()
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"Database unavailable: {error}")


@app.get("/api/model-info")
def model_information():
    return {
        "project": "Neuro Vision",
        "selected_model": "Random Forest Classifier",
        "tree_count": nv.n_trees,
        "number_of_features": len(nv.feature_columns),
        "features": nv.feature_columns,
        "training_feature_stats": FEATURE_STATS,
        "risk_bands": {"low_below": LOW_RISK_BELOW, "high_from": HIGH_RISK_FROM},
        "svm_live_prediction_available": nv.svm_model is not None,
        "model_comparison": MODEL_COMPARISON,
    }


@app.get("/api/model-comparison")
def model_comparison():
    return MODEL_COMPARISON


@app.post("/api/predict")
def predict(request: PredictionRequest):
    """Stateless prediction (nothing is written to MySQL)."""
    result = _predict_or_422(request.features)
    return {"session_id": request.session_id, **result}


@app.post("/api/assessments")
def save_assessment(request: SaveAssessmentRequest):
    """Validate -> predict -> save participant, assessment, features, prediction in ONE transaction.
    The prediction is returned even if MySQL is down (saved=false + db_error)."""
    prediction = _predict_or_422(request.features)
    payload = request.model_dump()
    payload["assessment"]["assessed_at"] = _mysql_datetime(request.assessment.assessed_at)
    payload["features"] = {k: float(v) for k, v in request.features.items()}

    saved, ids, db_error = False, None, None
    try:
        ids = database.save_assessment(payload, prediction)
        saved = True
    except database.DatabaseSchemaError as error:
        db_error = str(error)
        log.error("Schema problem: %s", error)
    except Exception as error:  # connection refused, duplicate session id, etc.
        db_error = f"{type(error).__name__}: {error}"
        log.error("MySQL save failed: %s", db_error)

    return {"session_id": request.session_id, "saved": saved, "db_ids": ids, "db_error": db_error, **prediction}


@app.get("/api/assessments")
def list_assessments(account_email: Optional[str] = Query(None), limit: int = Query(200, ge=1, le=1000)):
    try:
        rows = database.fetch_assessments(account_email=account_email, limit=limit)
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"Could not read from MySQL: {error}")
    for row in rows:
        if row["prediction"] and all(row["features"].get(n) is not None for n in nv.feature_columns):
            try:
                full = nv.predict(row["features"])
                row["feature_analysis"] = full["feature_analysis"]
            except FeatureValidationError:
                row["feature_analysis"] = []
    return {"count": len(rows), "assessments": rows}


@app.get("/api/assessments/{assessment_id}/gaze")
def assessment_gaze(assessment_id: int):
    try:
        return {"assessment_id": assessment_id, "samples": database.fetch_gaze_samples(assessment_id)}
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"Could not read gaze samples: {error}")


# ---------------------------------------------------------------- serve the web app too
# Opening http://127.0.0.1:8000 shows the application from the same address as the API,
# so there is nothing else to start and no cross-origin problem.
from pathlib import Path as _Path
from fastapi.staticfiles import StaticFiles

_FRONTEND = _Path(__file__).resolve().parent.parent / "neuro-vision-frontend"
if _FRONTEND.exists():
    app.mount("/", StaticFiles(directory=str(_FRONTEND), html=True), name="frontend")
