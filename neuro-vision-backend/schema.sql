-- Neuro Vision database schema.
-- Safe to run on your existing database: every statement is CREATE TABLE IF NOT EXISTS,
-- so tables you already created are NOT touched. Run `python check_database.py` first to
-- see what your existing tables contain.
--
--   mysql -u neuro_app -p neuro_vision < schema.sql

CREATE DATABASE IF NOT EXISTS neuro_vision CHARACTER SET utf8mb4;
USE neuro_vision;

CREATE TABLE IF NOT EXISTS participants (
    participant_id   INT AUTO_INCREMENT PRIMARY KEY,
    full_name        VARCHAR(120) NOT NULL,
    age              TINYINT UNSIGNED NOT NULL,
    gender           VARCHAR(30)  NOT NULL,
    guardian_consent TINYINT(1)   NOT NULL DEFAULT 1,
    account_email    VARCHAR(255) NULL,
    created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS assessments (
    assessment_id            INT AUTO_INCREMENT PRIMARY KEY,
    participant_id           INT NOT NULL,
    session_id               VARCHAR(40) NOT NULL UNIQUE,
    assessed_at              DATETIME NULL,
    reading_duration_seconds DECIMAL(8,2) NULL,
    transcript               TEXT NULL,
    passage_level            VARCHAR(40) NULL,
    passage_text             TEXT NULL,
    total_words              INT NULL,
    words_spoken_matched     INT NULL,
    words_skipped            INT NULL,
    word_count               INT NULL,
    gaze_sample_count        INT NULL,
    fixation_total           INT NULL,
    calibration_error        DOUBLE NULL,
    created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_assessment_participant FOREIGN KEY (participant_id)
        REFERENCES participants (participant_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS eye_movement_features (
    feature_id                   INT AUTO_INCREMENT PRIMARY KEY,
    assessment_id                INT NOT NULL,
    FIXATION_COUNT               DOUBLE NOT NULL,
    TOTAL_READING_TIME           DOUBLE NOT NULL,
    FIXATION_DURATION            DOUBLE NOT NULL,
    FIXATION_X                   DOUBLE NOT NULL,
    FIXATION_Y                   DOUBLE NOT NULL,
    FIRST_RUN_TOTAL_READING_TIME DOUBLE NOT NULL,
    SACCADE_AMPLITUDE            DOUBLE NOT NULL,
    REGRESSION_IN                DOUBLE NOT NULL,
    REGRESSION_OUT               DOUBLE NOT NULL,
    REGRESSION_OUT_FULL          DOUBLE NOT NULL,
    REGRESSION_PATH_DURATION     DOUBLE NOT NULL,
    SKIP                         TINYINT NOT NULL,
    CONSTRAINT fk_features_assessment FOREIGN KEY (assessment_id)
        REFERENCES assessments (assessment_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS predictions (
    prediction_id       INT AUTO_INCREMENT PRIMARY KEY,
    assessment_id       INT NOT NULL,
    model_name          VARCHAR(60) NOT NULL,
    predicted_label     VARCHAR(20) NOT NULL,
    risk_probability    DOUBLE NOT NULL,
    risk_percentage     DOUBLE NOT NULL,
    risk_level          VARCHAR(20) NOT NULL,
    tree_votes_dyslexic INT NULL,
    svm_prediction      VARCHAR(20) NULL,
    predicted_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_prediction_assessment FOREIGN KEY (assessment_id)
        REFERENCES assessments (assessment_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- OPTIONAL: lets the raw gaze samples be stored (requirement "gaze sample persistence")
-- and the reading analytics be rebuilt later. Each row: time (ms from reading start),
-- normalised x/y (0-1 of the browser window) and the passage word index (-1 = off text).
CREATE TABLE IF NOT EXISTS gaze_samples (
    gaze_sample_id INT AUTO_INCREMENT PRIMARY KEY,
    assessment_id  INT NOT NULL,
    sample_index   INT NOT NULL,
    t_ms           DOUBLE NOT NULL,
    x_norm         DOUBLE NOT NULL,
    y_norm         DOUBLE NOT NULL,
    word_index     INT NOT NULL,
    KEY idx_gaze_assessment (assessment_id, sample_index),
    CONSTRAINT fk_gaze_assessment FOREIGN KEY (assessment_id)
        REFERENCES assessments (assessment_id) ON DELETE CASCADE
) ENGINE=InnoDB;
