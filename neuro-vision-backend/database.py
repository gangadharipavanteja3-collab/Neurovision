"""
Neuro Vision - MySQL access layer.

Why this file looks "schema aware":
The four tables (participants, assessments, eye_movement_features, predictions)
already exist in the `neuro_vision` database. Instead of guessing their column
names, every insert first reads the REAL columns from INFORMATION_SCHEMA and
maps our logical fields onto them (several accepted spellings per field).
  * a logical field with no matching column is skipped and reported,
  * a NOT NULL column we cannot fill raises a clear error that names it,
  * foreign keys are discovered from INFORMATION_SCHEMA.KEY_COLUMN_USAGE.
Run `python check_database.py` to see exactly what was found.
"""
from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable

import mysql.connector
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")
log = logging.getLogger("neuro_vision.db")

FEATURE_NAMES = [
    "FIXATION_COUNT", "TOTAL_READING_TIME", "FIXATION_DURATION", "FIXATION_X", "FIXATION_Y",
    "FIRST_RUN_TOTAL_READING_TIME", "SACCADE_AMPLITUDE", "REGRESSION_IN", "REGRESSION_OUT",
    "REGRESSION_OUT_FULL", "REGRESSION_PATH_DURATION", "SKIP",
]

# logical field -> accepted column names (compared case-insensitively)
ALIASES: dict[str, dict[str, list[str]]] = {
    "participants": {
        "full_name": ["full_name", "participant_name", "name", "fullname"],
        "age": ["age", "participant_age"],
        "gender": ["gender", "sex"],
        "guardian_consent": ["guardian_consent", "consent", "consent_given"],
        "account_email": ["account_email", "user_email", "created_by_email", "email"],
        "created_at": ["created_at", "registered_at", "created_on"],
    },
    "assessments": {
        "session_id": ["session_id", "assessment_code", "session_code", "assessment_uid"],
        "assessed_at": ["assessed_at", "assessment_date", "created_at", "date", "started_at"],
        "reading_duration_seconds": ["reading_duration_seconds", "reading_duration", "duration_seconds", "reading_time_seconds"],
        "transcript": ["transcript", "speech_transcript", "recognised_text", "recognized_text"],
        "passage_level": ["passage_level", "reading_level"],
        "passage_text": ["passage_text", "passage"],
        "total_words": ["total_words", "passage_word_count"],
        "words_spoken_matched": ["words_spoken_matched", "words_matched", "matched_words"],
        "words_skipped": ["words_skipped", "skipped_words", "skip_count"],
        "gaze_sample_count": ["gaze_sample_count", "gaze_samples_count"],
        "fixation_total": ["fixation_total", "total_fixations"],
        "calibration_error": ["calibration_error", "calibration_fit_error"],
        "word_count": ["word_count", "recognised_word_count"],
    },
    "eye_movement_features": {n: [n, n.lower()] for n in FEATURE_NAMES},
    "predictions": {
        "model_name": ["model_name", "model", "algorithm"],
        "predicted_label": ["predicted_label", "prediction", "label", "predicted_class", "risk_label"],
        "risk_probability": ["risk_probability", "dyslexia_probability", "probability"],
        "risk_percentage": ["risk_percentage", "risk_score", "risk_percent"],
        "risk_level": ["risk_level", "risk_category"],
        "tree_votes_dyslexic": ["tree_votes_dyslexic", "tree_votes"],
        "svm_prediction": ["svm_prediction", "svm_label"],
        "predicted_at": ["predicted_at", "created_at", "prediction_date"],
    },
    "gaze_samples": {
        "sample_index": ["sample_index", "idx", "seq"],
        "t_ms": ["t_ms", "captured_ms", "time_ms"],
        "x_norm": ["x_norm", "x", "gaze_x"],
        "y_norm": ["y_norm", "y", "gaze_y"],
        "word_index": ["word_index", "word_idx"],
    },
}
PARENT_OF = {"assessments": "participants", "eye_movement_features": "assessments",
             "predictions": "assessments", "gaze_samples": "assessments"}


class DatabaseSchemaError(RuntimeError):
    """The live table does not match what we need (message says what to fix)."""


def get_db_connection():
    return mysql.connector.connect(
        host=os.getenv("DB_HOST", "localhost"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
        database=os.getenv("DB_NAME"),
        port=int(os.getenv("DB_PORT", 3306)),
        connection_timeout=5,
    )


@contextmanager
def transaction():
    """One connection, one transaction: commit on success, rollback on ANY error."""
    connection = get_db_connection()
    try:
        connection.start_transaction()
        cursor = connection.cursor(dictionary=True)
        yield cursor
        connection.commit()
    except Exception:
        try:
            connection.rollback()
        finally:
            raise
    finally:
        connection.close()


# ----------------------------------------------------------------------
# Schema introspection
# ----------------------------------------------------------------------
_schema_cache: dict[str, dict[str, Any]] = {}


def clear_schema_cache() -> None:
    _schema_cache.clear()


def _lower_keys(row: dict) -> dict:
    return {str(k).lower(): v for k, v in row.items()}


def table_info(cursor, table: str) -> dict[str, Any] | None:
    """Columns, primary key and parent foreign key of a table (None if it does not exist)."""
    if table in _schema_cache:
        return _schema_cache[table]
    schema = os.getenv("DB_NAME")
    cursor.execute(
        "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_KEY "
        "FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s "
        "ORDER BY ORDINAL_POSITION", (schema, table))
    cols = [_lower_keys(r) for r in cursor.fetchall()]
    if not cols:
        return None
    info: dict[str, Any] = {
        "columns": {c["column_name"].lower(): c for c in cols},
        "actual_names": {c["column_name"].lower(): c["column_name"] for c in cols},
        "primary_key": next((c["column_name"] for c in cols if c["column_key"] == "PRI"), None),
        "foreign_keys": {},
    }
    cursor.execute(
        "SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME "
        "FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s "
        "AND REFERENCED_TABLE_NAME IS NOT NULL", (schema, table))
    for r in map(_lower_keys, cursor.fetchall()):
        info["foreign_keys"][r["referenced_table_name"].lower()] = r["column_name"]
    _schema_cache[table] = info
    return info


def resolve_column(info: dict, table: str, logical: str) -> str | None:
    for candidate in ALIASES.get(table, {}).get(logical, [logical]):
        if candidate.lower() in info["actual_names"]:
            return info["actual_names"][candidate.lower()]
    return None


def parent_link_column(cursor, table: str) -> str:
    """Name of the foreign-key column in `table` that points to its parent table."""
    info = table_info(cursor, table)
    parent = PARENT_OF[table]
    if parent in info["foreign_keys"]:
        return info["foreign_keys"][parent]
    parent_info = table_info(cursor, parent)
    guesses = [parent_info["primary_key"] if parent_info else None, f"{parent[:-1]}_id", f"{parent}_id"]
    for guess in guesses:
        if guess and guess.lower() in info["actual_names"]:
            return info["actual_names"][guess.lower()]
    raise DatabaseSchemaError(
        f"Table `{table}` has no column that links to `{parent}` (expected a foreign key such as "
        f"`{parent[:-1]}_id`). Run check_database.py.")


def insert_row(cursor, table: str, logical_values: dict[str, Any], link_value: Any = None) -> int:
    info = table_info(cursor, table)
    if info is None:
        raise DatabaseSchemaError(f"Table `{table}` does not exist in database `{os.getenv('DB_NAME')}`. "
                                  f"Run schema.sql or check_database.py.")
    row: dict[str, Any] = {}
    skipped: list[str] = []
    for logical, value in logical_values.items():
        column = resolve_column(info, table, logical)
        if column is None:
            skipped.append(logical)
            continue
        row[column] = value
    if link_value is not None:
        row[parent_link_column(cursor, table)] = link_value

    # NOT NULL columns we did not fill and that have no default -> tell the user which
    missing = []
    for lower, meta in info["columns"].items():
        actual = info["actual_names"][lower]
        if actual in row:
            continue
        auto = "auto_increment" in str(meta.get("extra") or "").lower()
        generated = "generated" in str(meta.get("extra") or "").lower()
        if meta["is_nullable"] == "NO" and meta["column_default"] is None and not auto and not generated:
            missing.append(actual)
    if missing:
        raise DatabaseSchemaError(
            f"Table `{table}` has required column(s) {missing} that Neuro Vision does not fill. "
            f"Give them a DEFAULT or make them nullable (see check_database.py).")
    if skipped:
        log.info("Table %s: no column for %s - skipped", table, skipped)

    columns = ", ".join(f"`{c}`" for c in row)
    placeholders = ", ".join(["%s"] * len(row))
    cursor.execute(f"INSERT INTO `{table}` ({columns}) VALUES ({placeholders})", list(row.values()))
    return cursor.lastrowid


def insert_many(cursor, table: str, logical_rows: Iterable[dict[str, Any]], link_value: Any) -> int:
    rows = list(logical_rows)
    if not rows:
        return 0
    info = table_info(cursor, table)
    if info is None:
        return 0
    link = parent_link_column(cursor, table)
    columns = [(logical, resolve_column(info, table, logical)) for logical in rows[0]]
    columns = [(lg, c) for lg, c in columns if c]
    if not columns:
        return 0
    names = ", ".join([f"`{link}`"] + [f"`{c}`" for _, c in columns])
    marks = ", ".join(["%s"] * (len(columns) + 1))
    data = [[link_value] + [r[lg] for lg, _ in columns] for r in rows]
    cursor.executemany(f"INSERT INTO `{table}` ({names}) VALUES ({marks})", data)
    return len(data)


# ----------------------------------------------------------------------
# High level operations used by main.py
# ----------------------------------------------------------------------
def save_assessment(payload: dict[str, Any], prediction: dict[str, Any]) -> dict[str, Any]:
    """Insert participant -> assessment -> features -> prediction (-> gaze samples) atomically."""
    participant = payload["participant"]
    assessment = payload["assessment"]
    with transaction() as cursor:
        participant_id = insert_row(cursor, "participants", {
            "full_name": participant["name"],
            "age": participant["age"],
            "gender": participant["gender"],
            "guardian_consent": 1 if participant.get("guardian_consent", True) else 0,
            "account_email": (payload.get("account_email") or "")[:255] or None,
        })
        assessment_id = insert_row(cursor, "assessments", {
            "session_id": payload["session_id"],
            "assessed_at": assessment.get("assessed_at"),
            "reading_duration_seconds": assessment.get("reading_duration_seconds"),
            "transcript": assessment.get("transcript", ""),
            "passage_level": assessment.get("passage_level"),
            "passage_text": assessment.get("passage_text"),
            "total_words": assessment.get("total_words"),
            "words_spoken_matched": assessment.get("words_spoken_matched"),
            "words_skipped": assessment.get("words_skipped"),
            "gaze_sample_count": assessment.get("gaze_sample_count"),
            "fixation_total": assessment.get("fixation_total"),
            "calibration_error": assessment.get("calibration_error"),
            "word_count": assessment.get("word_count"),
        }, link_value=participant_id)

        features = {name: payload["features"][name] for name in FEATURE_NAMES}
        features_id = insert_row(cursor, "eye_movement_features", features, link_value=assessment_id)

        prediction_id = insert_row(cursor, "predictions", {
            "model_name": prediction["model"],
            "predicted_label": prediction["predicted_label"],
            "risk_probability": prediction["risk_probability"],
            "risk_percentage": prediction["risk_percentage"],
            "risk_level": prediction["risk_level"],
            "tree_votes_dyslexic": prediction["tree_votes_dyslexic"],
            "svm_prediction": prediction.get("svm_prediction"),
        }, link_value=assessment_id)

        gaze_saved = 0
        samples = payload.get("gaze_samples") or []
        if samples and table_info(cursor, "gaze_samples") is not None:
            gaze_saved = insert_many(cursor, "gaze_samples", (
                {"sample_index": i, "t_ms": s[0], "x_norm": s[1], "y_norm": s[2], "word_index": s[3]}
                for i, s in enumerate(samples)), assessment_id)
    return {"participant_id": participant_id, "assessment_id": assessment_id,
            "features_id": features_id, "prediction_id": prediction_id, "gaze_samples_saved": gaze_saved}


def _logical(info: dict, table: str, row: dict) -> dict[str, Any]:
    """Translate a DB row (real column names) into logical field names."""
    lowered = {k.lower(): v for k, v in row.items()}
    out = {}
    for logical in ALIASES[table]:
        column = resolve_column(info, table, logical)
        if column is not None:
            out[logical] = lowered.get(column.lower())
    return out


def fetch_assessments(account_email: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
    """Saved assessments with participant, features and prediction, newest first."""
    connection = get_db_connection()
    try:
        cursor = connection.cursor(dictionary=True)
        a_info = table_info(cursor, "assessments")
        p_info = table_info(cursor, "participants")
        f_info = table_info(cursor, "eye_movement_features")
        r_info = table_info(cursor, "predictions")
        if not all([a_info, p_info, f_info, r_info]):
            raise DatabaseSchemaError("One or more Neuro Vision tables are missing. Run check_database.py.")

        a_pk, p_pk = a_info["primary_key"], p_info["primary_key"]
        a_to_p = parent_link_column(cursor, "assessments")
        f_to_a = parent_link_column(cursor, "eye_movement_features")
        r_to_a = parent_link_column(cursor, "predictions")

        cursor.execute(f"SELECT * FROM `assessments` ORDER BY `{a_pk}` DESC LIMIT %s", (int(limit),))
        assessments = cursor.fetchall()
        if not assessments:
            return []
        a_ids = [a[a_pk] for a in assessments]
        p_ids = list({a[a_to_p] for a in assessments})

        def in_clause(values):
            return ", ".join(["%s"] * len(values))

        cursor.execute(f"SELECT * FROM `participants` WHERE `{p_pk}` IN ({in_clause(p_ids)})", p_ids)
        participants = {r[p_pk]: r for r in cursor.fetchall()}
        cursor.execute(f"SELECT * FROM `eye_movement_features` WHERE `{f_to_a}` IN ({in_clause(a_ids)})", a_ids)
        features = {r[f_to_a]: r for r in cursor.fetchall()}
        cursor.execute(f"SELECT * FROM `predictions` WHERE `{r_to_a}` IN ({in_clause(a_ids)}) "
                       f"ORDER BY `{r_info['primary_key']}` ASC", a_ids)
        predictions = {r[r_to_a]: r for r in cursor.fetchall()}   # latest wins

        result = []
        for a in assessments:
            part_row = participants.get(a[a_to_p], {})
            part = _logical(p_info, "participants", part_row)
            if account_email and part.get("account_email") and part["account_email"].lower() != account_email.lower():
                continue
            item = {
                "assessment_id": a[a_pk],
                "participant_id": a[a_to_p],
                "participant": part,
                "assessment": _logical(a_info, "assessments", a),
                "features": {n: (_logical(f_info, "eye_movement_features", features[a[a_pk]]).get(n)
                                if a[a_pk] in features else None) for n in FEATURE_NAMES},
                "prediction": _logical(r_info, "predictions", predictions[a[a_pk]]) if a[a_pk] in predictions else None,
            }
            result.append(_json_safe(item))
        return result
    finally:
        connection.close()


def fetch_gaze_samples(assessment_id: int) -> list[list[float]]:
    connection = get_db_connection()
    try:
        cursor = connection.cursor(dictionary=True)
        info = table_info(cursor, "gaze_samples")
        if info is None:
            return []
        link = parent_link_column(cursor, "gaze_samples")
        cols = {lg: resolve_column(info, "gaze_samples", lg) for lg in ("sample_index", "t_ms", "x_norm", "y_norm", "word_index")}
        order = cols["sample_index"] or cols["t_ms"]
        cursor.execute(f"SELECT * FROM `gaze_samples` WHERE `{link}`=%s ORDER BY `{order}` ASC", (assessment_id,))
        rows = cursor.fetchall()
        return [[float(r[cols["t_ms"]]), float(r[cols["x_norm"]]), float(r[cols["y_norm"]]),
                 int(r[cols["word_index"]])] for r in rows]
    finally:
        connection.close()


def database_status() -> dict[str, Any]:
    """Used by /api/health and /api/db-status."""
    connection = get_db_connection()
    try:
        cursor = connection.cursor(dictionary=True)
        clear_schema_cache()
        report: dict[str, Any] = {"connected": True, "database": os.getenv("DB_NAME"), "tables": {}}
        for table in ("participants", "assessments", "eye_movement_features", "predictions", "gaze_samples"):
            info = table_info(cursor, table)
            if info is None:
                report["tables"][table] = {"exists": False, "optional": table == "gaze_samples"}
                continue
            mapped = {lg: resolve_column(info, table, lg) for lg in ALIASES[table]}
            report["tables"][table] = {
                "exists": True,
                "columns": list(info["actual_names"].values()),
                "primary_key": info["primary_key"],
                "link_to_parent": (parent_link_column(cursor, table) if table in PARENT_OF else None),
                "unmapped_logical_fields": [lg for lg, c in mapped.items() if c is None],
            }
        return report
    finally:
        connection.close()


def _json_safe(value: Any) -> Any:
    import datetime
    import decimal
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value
