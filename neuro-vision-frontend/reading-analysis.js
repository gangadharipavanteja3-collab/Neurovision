/* =========================================================
   NEURO VISION - READING ANALYSIS (pure functions, no DOM)

   Converts webcam gaze samples + the speech transcript into the 12 model
   features, using the SAME units and per-word definitions as the training
   dataset (Dyslexia.ipynb). Works in the browser (window.NVAnalysis) and
   in Node (module.exports) so it can be unit-tested.

   WHY PER-WORD AVERAGES
   The training table holds one row per participant with values such as
   TOTAL_READING_TIME ~ 833 ms, FIXATION_COUNT ~ 3.05, REGRESSION_IN ~ 0.18.
   TOTAL_READING_TIME / FIXATION_COUNT = 833 / 3.05 = 273 ms = FIXATION_DURATION,
   and the regression columns are proportions (0-1). They are therefore
   averages per word (interest area), in milliseconds, NOT whole-passage
   totals in seconds. Every feature below follows that convention.

   Sample format used everywhere: [t_ms, x, y, wordIndex]
     x, y   : gaze position as a fraction (0-1) of the browser window
     wordIdx: passage word under the gaze (-1 = not on the text)
   ========================================================= */
(function (root) {
    "use strict";

    const CONFIG = {
        // Fixation detection (dispersion based, in screen pixels)
        FIXATION_DISPERSION_PX: 60,
        FIXATION_MIN_MS: 100,
        MAX_SAMPLE_GAP_MS: 200,
        // Reference frame used to express FIXATION_X / FIXATION_Y.
        // Training means are (600.7, 533.3) -> centre of roughly a 1280 x 1024 stimulus screen.
        // ASSUMPTION: confirm the recording resolution of the original dataset.
        REFERENCE_WIDTH_PX: 1280,
        REFERENCE_HEIGHT_PX: 1024,
        // Saccade amplitude in degrees of visual angle (training mean 2.2 deg)
        VIEWING_DISTANCE_CM: 60,
        CSS_PIXEL_CM: 2.54 / 96,
        // Minimum evidence needed before features are trusted
        MIN_WORD_FIXATIONS: 5,
        MIN_DISTINCT_WORDS: 3
    };

    /* ---------- Feature catalogue: meaning, unit and calculation formula ---------- */
    const FEATURE_DEFS = [
        { name: "FIXATION_COUNT", label: "Fixation count", unit: "fixations / word", decimals: 2,
          meaning: "How many times the reader's eyes pause on a word during reading.",
          formula: "N_fix / |W|  (N_fix = fixations on words, W = words that received a fixation)" },
        { name: "TOTAL_READING_TIME", label: "Total reading time", unit: "ms / word", decimals: 1,
          meaning: "Total time spent processing a word, summed over every fixation on it.",
          formula: "SUM(d_i) / |W|  (d_i = duration of fixation i, ms)" },
        { name: "FIXATION_DURATION", label: "Fixation duration", unit: "ms", decimals: 1,
          meaning: "How long the eyes stay relatively stable during one fixation.",
          formula: "SUM(d_i) / N_fix" },
        { name: "FIXATION_X", label: "Fixation X", unit: "px (1280 x 1024 frame)", decimals: 1,
          meaning: "Average horizontal position of the gaze during fixations.",
          formula: "(SUM(x_i) / N_fix) x 1280  (x_i = gaze x as fraction of window width)" },
        { name: "FIXATION_Y", label: "Fixation Y", unit: "px (1280 x 1024 frame)", decimals: 1,
          meaning: "Average vertical position of the gaze during fixations.",
          formula: "(SUM(y_i) / N_fix) x 1024" },
        { name: "FIRST_RUN_TOTAL_READING_TIME", label: "First-run total reading time", unit: "ms / word", decimals: 1,
          meaning: "Time spent on a word during the first reading pass only (the first time the eyes go through the text; the participant reads the passage once).",
          formula: "SUM over words of [sum of d_i in the FIRST visit to the word] / |W|" },
        { name: "SACCADE_AMPLITUDE", label: "Saccade amplitude", unit: "degrees", decimals: 2,
          meaning: "Size of the rapid eye movement from one fixation to the next.",
          formula: "mean( 2 x atan( dist_px x 0.02646 / (2 x 60) ) ) in degrees, for consecutive fixations" },
        { name: "REGRESSION_IN", label: "Regression in", unit: "proportion of words", decimals: 3,
          meaning: "Share of words that the eyes moved back INTO from a later word.",
          formula: "|words entered from a later word| / |W|" },
        { name: "REGRESSION_OUT", label: "Regression out", unit: "proportion of words", decimals: 3,
          meaning: "Share of words from which the eyes moved backward to an earlier word, on the first visit (how far the reader moves back from the current location).",
          formula: "|words whose first visit ended with a backward move| / |W|" },
        { name: "REGRESSION_OUT_FULL", label: "Regression out (full)", unit: "proportion of words", decimals: 3,
          meaning: "Complete measure of outgoing backward movement: share of words left backwards on ANY visit.",
          formula: "|words with at least one backward exit, any visit| / |W|  (always >= REGRESSION_OUT)" },
        { name: "REGRESSION_PATH_DURATION", label: "Regression path duration", unit: "ms / word", decimals: 1,
          meaning: "Time from first arriving at a word until the eyes move to a word further right, including time spent re-reading earlier words.",
          formula: "SUM over words of [sum of d_i from first fixation on the word until a fixation on a later word] / |W|" },
        { name: "SKIP", label: "Skip", unit: "0 / 1 flag", decimals: 0,
          meaning: "Words skipped: a word counts as skipped when it was neither recognised in the speech transcript nor fixated by the gaze. The model receives 1 if at least one word was skipped, else 0 (the training data stores SKIP as a 0/1 flag).",
          formula: "skipped = words with no spoken match AND no fixation;  SKIP = 1 if skipped >= 1 else 0" }
    ];

    const FEATURE_NAMES = FEATURE_DEFS.map((d) => d.name);

    /* Training-dataset summary (df.describe() in Dyslexia.ipynb) - used when the backend's
       feature_analysis is not available, e.g. the API was offline. */
    const FEATURE_STATS = {
        FIXATION_COUNT: [0.7753, 2.0330, 2.7203, 3.5160, 9.9119, 3.0519, 1.5210],
        TOTAL_READING_TIME: [159.44, 476.56, 686.91, 1044.08, 3681.26, 832.61, 540.41],
        FIXATION_DURATION: [89.14, 224.42, 266.24, 312.94, 677.44, 274.09, 84.07],
        FIXATION_X: [414.06, 587.60, 600.27, 609.35, 739.09, 600.71, 24.97],
        FIXATION_Y: [486.94, 524.74, 532.74, 541.47, 576.32, 533.32, 14.18],
        FIRST_RUN_TOTAL_READING_TIME: [194.79, 371.67, 520.84, 809.48, 2343.10, 647.49, 391.40],
        SACCADE_AMPLITUDE: [0.6819, 1.7070, 2.0687, 2.5612, 6.1318, 2.2125, 0.8403],
        REGRESSION_IN: [0.0413, 0.1198, 0.1679, 0.2165, 0.5317, 0.1760, 0.0766],
        REGRESSION_OUT: [0.0435, 0.1691, 0.2126, 0.2533, 0.4183, 0.2112, 0.0675],
        REGRESSION_OUT_FULL: [0.0435, 0.2005, 0.2544, 0.3129, 0.5610, 0.2619, 0.0926],
        REGRESSION_PATH_DURATION: [322.04, 656.20, 859.21, 1213.71, 4969.33, 1060.13, 674.74],
        SKIP: [0, 0, 0, 1, 1, 0.3469, 0.4768]          // [min, q25, median, q75, max, mean, std]
    };

    function compareToTraining(features) {
        return FEATURE_NAMES.map((name) => {
            const [min, q25, median, q75, max, mean, std] = FEATURE_STATS[name];
            const value = Number(features[name]);
            let status = "within typical range";
            if (value < min || value > max) status = "outside training range";
            else if (value < q25) status = "below typical range";
            else if (value > q75) status = "above typical range";
            return { feature: name, value, training_min: min, training_q25: q25, training_median: median,
                     training_q75: q75, training_max: max, training_mean: mean,
                     z_score: std ? (value - mean) / std : 0, status };
        });
    }

    const MODEL_COMPARISON = {
        title: "SVM vs RANDOM FOREST COMPARISON",
        source: "Evaluated in Dyslexia.ipynb on the 20 % hold-out split (59 participants: 45 Normal, 14 Dyslexia)",
        metrics: ["Accuracy", "Precision", "Recall", "F1 Score"],
        SVM: [89.83, 78.57, 78.57, 78.57],
        RandomForest: [91.53, 84.62, 78.57, 81.48],
        selected: "Random Forest"
    };

    /* ---------- Words and speech alignment ---------- */
    function normalizeWord(word) {
        return String(word || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    }

    function tokenize(text) {
        return String(text || "").split(/\s+/).map(normalizeWord).filter(Boolean);
    }

    function editDistance(a, b) {
        if (a === b) return 0;
        const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
        for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
        for (let i = 1; i <= a.length; i += 1) {
            for (let j = 1; j <= b.length; j += 1) {
                dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
                    dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            }
        }
        return dp[a.length][b.length];
    }

    function wordRelation(passageWord, spokenWord) {
        if (passageWord === spokenWord) return "exact";
        if (Math.max(passageWord.length, spokenWord.length) >= 4 && editDistance(passageWord, spokenWord) <= 1) return "near";
        return "none";
    }

    /* Order-aware alignment (edit distance on words). Returns one status per
       passage word: "matched" | "near" | "missed". Repeated words such as "the"
       are matched in reading order, not just by presence. */
    function alignSpeech(spokenTokens, passageTokens) {
        const n = passageTokens.length;
        const m = spokenTokens.length;
        if (!m) return passageTokens.map(() => "missed");
        const cost = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
        const back = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(""));
        for (let i = 1; i <= n; i += 1) { cost[i][0] = i; back[i][0] = "D"; }
        for (let j = 1; j <= m; j += 1) { cost[0][j] = j * 0.8; back[0][j] = "I"; }
        for (let i = 1; i <= n; i += 1) {
            for (let j = 1; j <= m; j += 1) {
                const rel = wordRelation(passageTokens[i - 1], spokenTokens[j - 1]);
                const diag = cost[i - 1][j - 1] + (rel === "exact" ? 0 : rel === "near" ? 0.4 : 1);
                const del = cost[i - 1][j] + 1;      // passage word never spoken
                const ins = cost[i][j - 1] + 0.8;    // extra spoken word
                const best = Math.min(diag, del, ins);
                cost[i][j] = best;
                back[i][j] = best === diag ? "M" : best === del ? "D" : "I";
            }
        }
        const status = new Array(n).fill("missed");
        let i = n; let j = m;
        while (i > 0 || j > 0) {
            const step = back[i][j];
            if (step === "M") {
                const rel = wordRelation(passageTokens[i - 1], spokenTokens[j - 1]);
                status[i - 1] = rel === "exact" ? "matched" : rel === "near" ? "near" : "missed";
                i -= 1; j -= 1;
            } else if (step === "D") { i -= 1; } else { j -= 1; }
        }
        return status;
    }

    /* ---------- Fixation detection ---------- */
    function median(values) {
        if (!values.length) return 0;
        const s = [...values].sort((a, b) => a - b);
        const mid = Math.floor(s.length / 2);
        return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }

    function detectFixations(samples, viewport) {
        const W = Math.max(1, viewport.width);
        const H = Math.max(1, viewport.height);
        const ordered = samples
            .filter((s) => s.length >= 4 && [s[0], s[1], s[2]].every(Number.isFinite))
            .sort((a, b) => a[0] - b[0]);
        if (ordered.length < 2) return [];

        const gaps = [];
        for (let i = 1; i < ordered.length; i += 1) gaps.push(ordered[i][0] - ordered[i - 1][0]);
        const frame = Math.min(100, Math.max(15, median(gaps.filter((g) => g <= CONFIG.MAX_SAMPLE_GAP_MS))));

        const fixations = [];
        let cluster = [];
        const close = () => {
            if (cluster.length >= 2) {
                const start = cluster[0][0];
                const end = cluster[cluster.length - 1][0];
                const duration = end - start + frame;     // include the last frame's time
                if (duration >= CONFIG.FIXATION_MIN_MS) {
                    const counts = new Map();
                    cluster.forEach((s) => { if (s[3] >= 0) counts.set(s[3], (counts.get(s[3]) || 0) + 1); });
                    let word = -1; let top = 0;
                    counts.forEach((c, w) => { if (c > top) { top = c; word = w; } });
                    fixations.push({
                        x: cluster.reduce((a, s) => a + s[1], 0) / cluster.length,
                        y: cluster.reduce((a, s) => a + s[2], 0) / cluster.length,
                        start, end, duration, word
                    });
                }
            }
            cluster = [];
        };
        ordered.forEach((s) => {
            if (!cluster.length) { cluster.push(s); return; }
            const cx = cluster.reduce((a, p) => a + p[1], 0) / cluster.length;
            const cy = cluster.reduce((a, p) => a + p[2], 0) / cluster.length;
            const gap = s[0] - cluster[cluster.length - 1][0];
            const dist = Math.hypot((s[1] - cx) * W, (s[2] - cy) * H);
            if (gap <= CONFIG.MAX_SAMPLE_GAP_MS && dist <= CONFIG.FIXATION_DISPERSION_PX) cluster.push(s);
            else { close(); cluster.push(s); }
        });
        close();
        return fixations;
    }

    function degreesFromPixels(distancePx) {
        const cm = distancePx * CONFIG.CSS_PIXEL_CM;
        return (2 * Math.atan(cm / (2 * CONFIG.VIEWING_DISTANCE_CM)) * 180) / Math.PI;
    }

    /* ---------- Main analysis ---------- */
    function analyse(input) {
        const passageWords = input.passageWords || [];
        const viewport = input.viewport || { width: 1280, height: 1024 };
        const totalWords = passageWords.length;
        if (totalWords < 2) throw new Error("The reading passage is unavailable.");

        const samples = (input.samples || []);
        if (samples.length < 20) {
            throw new Error("Not enough gaze samples were captured (" + samples.length + "). Keep the camera tracking active and finish calibration before reading.");
        }

        const fixations = detectFixations(samples, viewport);
        const wordFix = fixations.filter((f) => f.word >= 0);
        const distinct = new Set(wordFix.map((f) => f.word));
        if (wordFix.length < CONFIG.MIN_WORD_FIXATIONS || distinct.size < CONFIG.MIN_DISTINCT_WORDS) {
            throw new Error("Too few fixations landed on the passage (" + wordFix.length + " fixations on " + distinct.size +
                " words). Re-run calibration, sit still, and read with the passage fully visible.");
        }

        /* visits = consecutive fixations on the same word */
        const visits = [];
        wordFix.forEach((f, order) => {
            const last = visits[visits.length - 1];
            if (last && last.word === f.word) { last.fix.push(order); last.dur += f.duration; }
            else visits.push({ word: f.word, fix: [order], dur: f.duration });
        });

        const words = Array.from(distinct).sort((a, b) => a - b);
        const wordStats = passageWords.map((text, index) => ({
            index, word: text, fixations: 0, totalMs: 0, firstPassMs: 0, pathMs: 0,
            regIn: false, regOut: false, regOutFull: false, gazed: false
        }));

        wordFix.forEach((f) => { const w = wordStats[f.word]; w.gazed = true; w.fixations += 1; w.totalMs += f.duration; });

        const firstVisitDone = new Set();
        visits.forEach((v, vi) => {
            const w = wordStats[v.word];
            const prev = visits[vi - 1];
            const next = visits[vi + 1];
            const isFirst = !firstVisitDone.has(v.word);
            if (isFirst) { w.firstPassMs = v.dur; firstVisitDone.add(v.word); }
            if (prev && prev.word > v.word) w.regIn = true;
            if (next && next.word < v.word) {
                w.regOutFull = true;
                if (isFirst) w.regOut = true;
            }
        });

        /* regression path duration: from first fixation on the word until a fixation on a later word */
        words.forEach((wi) => {
            const start = wordFix.findIndex((f) => f.word === wi);
            let sum = 0;
            for (let k = start; k < wordFix.length; k += 1) {
                if (wordFix[k].word > wi) break;
                sum += wordFix[k].duration;
            }
            wordStats[wi].pathMs = sum;
        });

        /* saccades between consecutive word fixations */
        const saccades = [];
        for (let i = 1; i < wordFix.length; i += 1) {
            const px = Math.hypot((wordFix[i].x - wordFix[i - 1].x) * viewport.width,
                                  (wordFix[i].y - wordFix[i - 1].y) * viewport.height);
            saccades.push({ from: wordFix[i - 1].word, to: wordFix[i].word, deg: degreesFromPixels(px),
                            backward: wordFix[i].word < wordFix[i - 1].word });
        }

        const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
        const nW = words.length;
        const durations = wordFix.map((f) => f.duration);

        /* speech x gaze cross-check */
        const spokenTokens = tokenize(input.transcript);
        const passageTokens = passageWords.map(normalizeWord);
        const hasSpeech = spokenTokens.length > 0;
        const speechStatus = hasSpeech ? alignSpeech(spokenTokens, passageTokens) : null;
        wordStats.forEach((w, i) => {
            w.spoken = hasSpeech ? speechStatus[i] !== "missed" : null;
            w.speechStatus = hasSpeech ? speechStatus[i] : "unavailable";
            if (hasSpeech) {
                w.category = w.spoken && w.gazed ? "read" : w.spoken ? "spoken" : w.gazed ? "gazed" : "skipped";
            } else {
                w.category = w.gazed ? "gazed" : "skipped";
            }
        });
        const counts = { read: 0, spoken: 0, gazed: 0, skipped: 0 };
        wordStats.forEach((w) => { counts[w.category] += 1; });

        const features = {
            FIXATION_COUNT: wordFix.length / nW,
            TOTAL_READING_TIME: durations.reduce((a, b) => a + b, 0) / nW,
            FIXATION_DURATION: mean(durations),
            FIXATION_X: mean(wordFix.map((f) => f.x)) * CONFIG.REFERENCE_WIDTH_PX,
            FIXATION_Y: mean(wordFix.map((f) => f.y)) * CONFIG.REFERENCE_HEIGHT_PX,
            FIRST_RUN_TOTAL_READING_TIME: mean(words.map((i) => wordStats[i].firstPassMs)),
            SACCADE_AMPLITUDE: mean(saccades.map((s) => s.deg)),
            REGRESSION_IN: words.filter((i) => wordStats[i].regIn).length / nW,
            REGRESSION_OUT: words.filter((i) => wordStats[i].regOut).length / nW,
            REGRESSION_OUT_FULL: words.filter((i) => wordStats[i].regOutFull).length / nW,
            REGRESSION_PATH_DURATION: mean(words.map((i) => wordStats[i].pathMs)),
            SKIP: counts.skipped >= 1 ? 1 : 0
        };

        FEATURE_NAMES.forEach((name) => {
            if (!Number.isFinite(features[name])) throw new Error("Feature " + name + " could not be calculated.");
        });

        return {
            features,
            wordsSkipped: counts.skipped,
            skipBasis: hasSpeech ? "speech_and_gaze" : "gaze_only",
            crossCheck: counts,
            wordStats,
            fixations: wordFix.map((f, order) => ({ order, word: f.word, x: f.x, y: f.y, duration: f.duration, start: f.start })),
            totalFixationsDetected: fixations.length,
            saccades,
            forwardSaccades: saccades.filter((s) => !s.backward).length,
            backwardSaccades: saccades.filter((s) => s.backward).length,
            quality: {
                gazeSamples: samples.length,
                fixationsDetected: fixations.length,
                fixationsOnWords: wordFix.length,
                wordsFixated: nW,
                totalWords,
                onTextShare: wordFix.length / Math.max(1, fixations.length),
                speechWordsHeard: spokenTokens.length
            }
        };
    }

    const api = { CONFIG, FEATURE_DEFS, FEATURE_NAMES, FEATURE_STATS, compareToTraining, MODEL_COMPARISON, normalizeWord, tokenize,
                  alignSpeech, detectFixations, degreesFromPixels, analyse };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else root.NVAnalysis = api;
})(typeof window !== "undefined" ? window : globalThis);
