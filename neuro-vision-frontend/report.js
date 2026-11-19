/* =========================================================
   NEURO VISION — RESULTS LAYER
   Saved records (MySQL + this browser), dashboard, history, reading analytics,
   report preview and the PDF report.
   Depends on script.js and reading-analysis.js.
   ========================================================= */

/* ---------- Small helpers ---------- */

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[character]);
}

function fmtNumber(value, decimals = 2) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(decimals) : "—";
}

function riskClass(level) {
    return level === "HIGH RISK" ? "high" : level === "MODERATE RISK" ? "moderate" : "low";
}

/* Old records and the database may still say "LOW RISK"; the product wording is "NO RISK". */
function levelText(level) {
    return level === "LOW RISK" ? "NO RISK" : (level || "");
}

/* Diagnosis wording follows the risk level: MODERATE or HIGH risk = Dyslexia; NO risk = Normal. */
function diagnosisText(p) {
    return p && (p.risk_level === "MODERATE RISK" || p.risk_level === "HIGH RISK") ? "Dyslexia" : "Normal";
}

const REPORT_CONTACT = { phone: "+91 98765 43210", email: "support@neurovision.ai", web: "www.neurovision.ai" };

function featureDef(name) {
    return NVAnalysis.FEATURE_DEFS.find((d) => d.name === name);
}

function asciiPdf(text) {
    return String(text ?? "")
        .replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
        .replace(/[·•]/g, "|").replace(/≥/g, ">=").replace(/≤/g, "<=").replace(/×/g, "x")
        .replace(/[^\x20-\x7E]/g, "");
}

/* ---------- Records: this browser + MySQL ---------- */

function recordFromBackend(item) {
    const a = item.assessment || {};
    const p = item.participant || {};
    const pr = item.prediction || null;
    let date = a.assessed_at || null;
    if (date && !/[zZ]|[+-]\d\d:?\d\d$/.test(date)) date += "Z";      // stored as UTC
    const hasFeatures = NVAnalysis.FEATURE_NAMES.every((n) => Number.isFinite(Number(item.features[n])));
    return {
        id: a.session_id || `DB-${item.assessment_id}`,
        participantName: p.full_name || "—",
        age: p.age,
        gender: p.gender || "—",
        date: date || new Date().toISOString(),
        readingDurationSeconds: Number(a.reading_duration_seconds) || 0,
        transcript: a.transcript || "",
        wordCount: Number(a.word_count) || 0,
        passageText: a.passage_text || "",
        passageLevel: a.passage_level || "",
        calibrationError: a.calibration_error,
        features: hasFeatures ? Object.fromEntries(NVAnalysis.FEATURE_NAMES.map((n) => [n, Number(item.features[n])])) : null,
        analysis: null,
        modelPrediction: pr ? {
            predicted_label: pr.predicted_label,
            risk_probability: Number(pr.risk_probability),
            risk_percentage: Number(pr.risk_percentage),
            risk_level: pr.risk_level,
            tree_votes_dyslexic: pr.tree_votes_dyslexic,
            tree_count: 100,
            feature_analysis: item.feature_analysis || null
        } : null,
        modelPredictionStatus: pr ? "completed" : "no_data",
        dbSaved: true,
        fromDatabase: true,
        dbAssessmentId: item.assessment_id,
        dbWordsSkipped: a.words_skipped,
        dbWordsMatched: a.words_spoken_matched
    };
}

/* Local sessions + MySQL sessions, one entry per session id, newest first. */
function getAllRecords() {
    const local = loadAssessmentRecords();
    const byId = new Map(local.map((r) => [r.id, r]));
    backendRecords.forEach((item) => {
        const record = recordFromBackend(item);
        const existing = byId.get(record.id);
        if (existing) {
            if (existing.modelPredictionStatus === "completed") existing.dbSaved = existing.dbSaved || true;
            existing.dbAssessmentId = existing.dbAssessmentId || record.dbAssessmentId;
        } else {
            byId.set(record.id, record);
        }
    });
    return [...byId.values()].sort((a, b) => new Date(b.date) - new Date(a.date));
}

function recordPrediction(record) {
    const p = record && record.modelPrediction;
    if (!p || !p.predicted_label) return null;                  // legacy / failed sessions
    return p;
}

async function loadBackendRecords() {
    if (!currentEmail) return;
    try {
        const data = await fetchBackendJson(`/api/assessments?account_email=${encodeURIComponent(currentEmail)}`);
        backendRecords = data.assessments || [];
        backendOnline = true;
    } catch (error) {
        backendOnline = false;
        console.warn("Could not load MySQL records:", error.message);
    }
    if (currentPage === "dashboard") renderDashboard();
    if (currentPage === "history") renderHistory();
}

function sourceBadge(record) {
    if (record.dbSaved) return '<span class="source-badge db">MySQL</span>';
    return '<span class="source-badge local">This browser only</span>';
}

function resultBadge(record) {
    const p = recordPrediction(record);
    if (!p) return '<span class="result-badge none">No result</span>';
    return `<span class="result-badge ${riskClass(p.risk_level)}">${escapeHTML(diagnosisText(p))} · ${escapeHTML(levelText(p.risk_level))}</span>`;
}

function openReportFor(id) {
    selectedReportId = id;
    navigateTo("reports");
}

/* ---------- Dashboard: saved results ---------- */

function renderDashboard() { /* the dashboard no longer lists saved results */ }

/* ---------- Assessment history ---------- */

function renderHistory() {
    const searchTerm = ($("#historySearch").value || "").trim().toLowerCase();
    const filtered = getAllRecords().filter((record) =>
        record.participantName.toLowerCase().includes(searchTerm) || record.id.toLowerCase().includes(searchTerm));

    $("#historyBody").innerHTML = filtered.map((record) => `
        <tr>
            <td><strong>${escapeHTML(record.id)}</strong></td>
            <td>${escapeHTML(record.participantName)}</td>
            <td>${new Date(record.date).toLocaleDateString("en-IN")}</td>
            <td>${formatDuration(record.readingDurationSeconds || 0)}</td>
            <td>${resultBadge(record)}</td>
            <td><button class="table-open" data-history-open="${escapeHTML(record.id)}">View report</button></td>
        </tr>`).join("");

    if (!filtered.length) {
        $("#historyBody").innerHTML = `<tr><td colspan="6" class="history-empty-cell">No completed assessment sessions are available yet.</td></tr>`;
    }
    $$("[data-history-open]").forEach((button) => button.addEventListener("click", () => openReportFor(button.dataset.historyOpen)));
}

$("#historySearch").addEventListener("input", renderHistory);

/* ---------- Background (silent) retry of prediction + saving ---------- */

const retryingSessions = new Set();

async function retryBackendSave(sessionId, silent) {
    if (retryingSessions.has(sessionId)) return false;
    const records = loadAssessmentRecords();
    const record = records.find((r) => r.id === sessionId);
    if (!record || !record.features) return false;
    retryingSessions.add(sessionId);
    try {
        const response = await postAssessmentToBackend(buildBackendPayload(record), 2);
        record.modelPrediction = {
            predicted_label: response.predicted_label, risk_probability: response.risk_probability,
            risk_percentage: response.risk_percentage, risk_level: response.risk_level,
            tree_votes_dyslexic: response.tree_votes_dyslexic, tree_count: response.tree_count,
            svm_prediction: response.svm_prediction, feature_analysis: response.feature_analysis,
            features_outside_training_range: response.features_outside_training_range
        };
        record.modelPredictionStatus = "completed";
        record.modelPredictionError = null;
        record.dbSaved = Boolean(response.saved);
        record.dbIds = response.db_ids;
        record.dbError = response.db_error;
        assessmentRecords = records;
        saveAssessmentRecords();
        backendOnline = true;
        return true;
    } catch (error) {
        console.warn("Retry failed:", error.message);
        return false;
    } finally {
        retryingSessions.delete(sessionId);
    }
}

/* ---------- Shared builders: model comparison table, observations ---------- */

function modelComparisonHTML() {
    const m = NVAnalysis.MODEL_COMPARISON;
    const rows = m.metrics.map((name, i) => `
        <tr><td>${escapeHTML(name)}</td>
            <td class="${m.SVM[i] > m.RandomForest[i] ? "best" : ""}">${m.SVM[i].toFixed(2)}</td>
            <td class="${m.RandomForest[i] >= m.SVM[i] ? "best" : ""}">${m.RandomForest[i].toFixed(2)}</td></tr>`).join("");
    return `
        <div class="model-compare">
            <table class="data-table">
                <thead><tr><th>Metric</th><th>SVM (%)</th><th>Random Forest (%)</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
</div>`;
}

function featureRows(record) {
    const p = recordPrediction(record);
    if (p && p.feature_analysis && p.feature_analysis.length) return p.feature_analysis;
    return record.features ? NVAnalysis.compareToTraining(record.features) : [];
}

function formatFeatureValue(name, value) {
    return fmtNumber(value, featureDef(name).decimals);
}

function typicalRangeText(row) {
    const d = featureDef(row.feature).decimals;
    return `${fmtNumber(row.training_q25, d)} – ${fmtNumber(row.training_q75, d)}`;
}

function statusClass(status) {
    return status === "within typical range" ? "typ" : status === "outside training range" ? "out" : "dev";
}

/* Plain-language findings derived from this participant's own eye-movement values. */
function buildObservations(record) {
    const items = [];
    const p = recordPrediction(record);
    const rows = featureRows(record);
    const a = record.analysis;
    const phrase = {
        FIXATION_DURATION: ["Fixations were", "ms long"],
        TOTAL_READING_TIME: ["Time spent per word was", "ms"],
        FIRST_RUN_TOTAL_READING_TIME: ["First-pass time per word was", "ms"],
        FIXATION_COUNT: ["The eyes paused", "times per word"],
        SACCADE_AMPLITUDE: ["Average eye jump was", "degrees"],
        REGRESSION_IN: ["Words re-entered from the right:", "of words"],
        REGRESSION_OUT: ["First-pass backward moves:", "of words"],
        REGRESSION_OUT_FULL: ["Backward moves on any visit:", "of words"],
        REGRESSION_PATH_DURATION: ["Regression path time was", "ms per word"]
    };
    rows.filter((r) => r.status !== "within typical range" && phrase[r.feature]).forEach((r) => {
        const d = featureDef(r.feature).decimals;
        const dir = r.status === "below typical range" ? "below" : r.status === "above typical range" ? "above" : "outside";
        const scale = r.feature.startsWith("REGRESSION_") && !r.feature.endsWith("DURATION") ? fmtNumber(r.value * 100, 1) + "%" : fmtNumber(r.value, d);
        items.push(`${phrase[r.feature][0]} ${scale} ${r.feature.startsWith("REGRESSION_") && !r.feature.endsWith("DURATION") ? "" : phrase[r.feature][1]} — ${dir} the typical training range (${typicalRangeText(r)}).`.replace(/\s+—/, " —"));
    });
    if (a) {
        const total = a.crossCheck.read + a.crossCheck.spoken + a.crossCheck.gazed + a.crossCheck.skipped;
        const sac = a.forwardSaccades + a.backwardSaccades;
        items.push(`${total - a.crossCheck.skipped} of ${total} passage words were confirmed by speech or gaze; ${a.wordsSkipped} word(s) were skipped (${a.skipBasis === "speech_and_gaze" ? "no speech match and no fixation" : "no fixation - speech unavailable"}).`);
        if (sac) items.push(`${a.backwardSaccades} of ${sac} eye movements (${fmtNumber(100 * a.backwardSaccades / sac, 0)}%) moved backward to earlier words.`);
    }
    if (p) {
        items.push(`The Random Forest placed ${p.tree_votes_dyslexic} of ${p.tree_count} decision trees on "Dyslexic", giving an estimated risk of ${fmtNumber(p.risk_percentage, 1)}% (${levelText(p.risk_level)}).`);
    }
    if (!items.length) items.push("All measured eye-movement values lie within the typical range of the training dataset.");
    return items;
}

async function ensureAnalysis(record) {
    if (record.analysis || !record.dbAssessmentId || !record.passageText) return record.analysis;
    try {
        const data = await fetchBackendJson(`/api/assessments/${record.dbAssessmentId}/gaze`);
        if (!data.samples || data.samples.length < 20) return null;
        const words = record.passageText.split(/\s+/).filter(Boolean);
        const full = NVAnalysis.analyse({ samples: data.samples, passageWords: words, transcript: record.transcript,
            viewport: { width: window.innerWidth, height: window.innerHeight } });
        record.analysis = buildCompactAnalysis(full);
    } catch (error) {
        console.warn("Could not rebuild analytics from stored gaze samples:", error.message);
    }
    return record.analysis;
}

/* ---------- Scanpath drawing (screen canvas and PDF image share this) ---------- */

const CATEGORY_STYLE = {
    read:    { fill: "#d9eee8", stroke: "#2b8075", label: "Read (spoken + gaze)" },
    spoken:  { fill: "#dff3fb", stroke: "#67c9ed", label: "Spoken, no gaze" },
    gazed:   { fill: "#fde4dc", stroke: "#e98e83", label: "Gaze, not recognised" },
    skipped: { fill: "#ffffff", stroke: "#c96861", label: "Skipped" }
};

function drawScanpath(canvas, analysis, cssWidth, dpr) {
    const words = analysis.wordStats;
    const ctx = canvas.getContext("2d");
    const font = '600 15px "DM Sans", Arial, sans-serif';
    ctx.font = font;
    const lineHeight = 52;
    const boxes = [];
    let x = 18, line = 0;
    words.forEach((w) => {
        const width = Math.ceil(ctx.measureText(w.w).width) + 18;
        if (x + width > cssWidth - 18) { x = 18; line += 1; }
        boxes.push({ x, y: 18 + line * lineHeight, w: width, h: 30 });
        x += width + 8;
    });
    const height = 18 + (line + 1) * lineHeight + 10;

    canvas.width = cssWidth * dpr;
    canvas.height = height * dpr;
    canvas.style.width = cssWidth + "px";
    canvas.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#fffaf5";
    ctx.fillRect(0, 0, cssWidth, height);
    ctx.font = font;
    ctx.textBaseline = "middle";

    words.forEach((w, i) => {
        const b = boxes[i];
        const style = CATEGORY_STYLE[w.c] || CATEGORY_STYLE.read;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(b.x, b.y, b.w, b.h, 8) : ctx.rect(b.x, b.y, b.w, b.h);
        ctx.fillStyle = style.fill; ctx.fill();
        ctx.lineWidth = 1.2; ctx.strokeStyle = style.stroke;
        ctx.setLineDash(w.c === "skipped" ? [4, 3] : []); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = "#263c3a";
        ctx.fillText(w.w, b.x + 9, b.y + b.h / 2 + 1);
    });

    const centre = (wi, k) => ({ x: boxes[wi].x + boxes[wi].w / 2 + ((k % 3) - 1) * 7, y: boxes[wi].y + boxes[wi].h + 7 });
    const points = analysis.fixations.map((f, k) => ({ ...centre(f.w, k), d: f.d, w: f.w }));
    for (let k = 1; k < points.length; k += 1) {
        const backward = points[k].w < points[k - 1].w;
        ctx.beginPath();
        ctx.moveTo(points[k - 1].x, points[k - 1].y);
        ctx.lineTo(points[k].x, points[k].y);
        ctx.strokeStyle = backward ? "rgba(201,104,97,.85)" : "rgba(32,100,93,.45)";
        ctx.lineWidth = backward ? 2 : 1.3;
        ctx.stroke();
    }
    points.forEach((p, k) => {
        const r = 4 + Math.min(8, Math.sqrt(p.d) / 3);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(32,100,93,.78)";
        ctx.fill();
        if (r >= 8 && points.length <= 80) {
            ctx.fillStyle = "#fff"; ctx.font = '700 8px Arial'; ctx.textAlign = "center";
            ctx.fillText(String(k + 1), p.x, p.y + 0.5); ctx.textAlign = "left"; ctx.font = font;
        }
    });
}

/* ---------- Reading analytics ---------- */

const CHART_COLORS = { teal: "#2b8075", tealDark: "#20645d", tealLight: "#62b6a8", salmon: "#e98e83", salmonDark: "#c96861", sand: "#f5b7aa", blue: "#67c9ed" };

function makeChart(canvasId, config) {
    const canvas = typeof canvasId === "string" ? document.getElementById(canvasId) : canvasId;
    const chart = new Chart(canvas, config);
    chartInstances.push(chart);
    return chart;
}

function progressionConfig(analysis, animate) {
    const fx = analysis.fixations;
    return {
        type: "line",
        data: {
            labels: fx.map((f, i) => i + 1),
            datasets: [{
                label: "Word position",
                data: fx.map((f) => f.w + 1),
                borderColor: CHART_COLORS.teal, backgroundColor: CHART_COLORS.teal, borderWidth: 2, tension: 0.15,
                pointRadius: 4,
                pointBackgroundColor: fx.map((f, i) => (i > 0 && f.w < fx[i - 1].w ? CHART_COLORS.salmonDark : CHART_COLORS.teal)),
                pointBorderColor: "#fff"
            }]
        },
        options: {
            responsive: !!animate, animation: animate ? undefined : false, maintainAspectRatio: false,
            plugins: { legend: { display: false },
                tooltip: { callbacks: { label: (c) => { const f = fx[c.dataIndex]; const w = analysis.wordStats[f.w]; return `"${w.w}" (word ${f.w + 1}) · ${f.d} ms`; } } } },
            scales: { x: { title: { display: true, text: "Fixation order" } },
                      y: { title: { display: true, text: "Word position in passage" }, min: 0, ticks: { precision: 0 } } }
        }
    };
}

function dwellConfig(analysis, animate) {
    const ws = analysis.wordStats;
    return {
        type: "bar",
        data: {
            labels: ws.map((w) => w.w),
            datasets: [
                { label: "First pass (ms)", data: ws.map((w) => w.f), backgroundColor: CHART_COLORS.teal, stack: "t" },
                { label: "Re-reading (ms)", data: ws.map((w) => Math.max(0, w.t - w.f)), backgroundColor: CHART_COLORS.salmon, stack: "t" }
            ]
        },
        options: {
            responsive: !!animate, animation: animate ? undefined : false, maintainAspectRatio: false,
            plugins: { legend: { position: "bottom", labels: { boxWidth: 12 } } },
            scales: { x: { stacked: true, ticks: { maxRotation: 90, minRotation: 60, font: { size: 9 } } },
                      y: { stacked: true, title: { display: true, text: "Milliseconds" } } }
        }
    };
}

async function renderAnalytics() {
    chartInstances.forEach((c) => c.destroy());
    chartInstances = [];

    const records = getAllRecords();
    const empty = $("#analyticsEmpty");
    const results = $("#analyticsResults");
    if (!records.length) {
        empty.classList.remove("hidden");
        results.classList.add("hidden");
        return;
    }
    empty.classList.add("hidden");
    results.classList.remove("hidden");

    const record = records.find((r) => r.id === selectedReportId) || records[0];
    selectedReportId = record.id;

    const select = $("#analyticsSessionSelect");
    select.innerHTML = records.map((r) => `<option value="${escapeHTML(r.id)}"${r.id === record.id ? " selected" : ""}>${escapeHTML(r.participantName)} · ${new Date(r.date).toLocaleDateString("en-IN")} · ${escapeHTML(r.id)}</option>`).join("");

    const p = recordPrediction(record);
    await ensureAnalysis(record);
    const a = record.analysis;

    $("#analyticsBannerTitle").textContent = `${record.participantName} · age ${record.age}`;
    $("#analyticsBannerSub").textContent = p
        ? `Diagnosed: ${diagnosisText(p)} · Risk: ${levelText(p.risk_level)} (${fmtNumber(p.risk_percentage, 1)}%)`
        : "No model result is available for this session.";

    const notice = $("#analyticsNotice");
    if (!a) {
        notice.classList.remove("hidden");
        notice.textContent = record.modelPredictionError
            ? `Eye-movement analytics could not be produced: ${record.modelPredictionError}`
            : "Detailed per-word analytics are only available for sessions recorded in this browser or with stored gaze samples (run schema.sql to enable the gaze_samples table).";
    } else {
        notice.classList.add("hidden");
    }

    const f = record.features || {};
    const total = a ? a.crossCheck.read + a.crossCheck.spoken + a.crossCheck.gazed + a.crossCheck.skipped : (record.passageText || "").split(/\s+/).filter(Boolean).length;
    const sacc = a ? a.forwardSaccades + a.backwardSaccades : 0;
    const cards = [
        ["Reading duration", formatDuration(record.readingDurationSeconds || 0), "", "Start to stop of reading"],
        ["Words in passage", String(total || "—"), "", `${record.wordCount || 0} words recognised from speech`],
        ["Fixations on words", a ? String(a.quality.fixationsOnWords) : "—", "", a ? `${a.quality.wordsFixated} different words fixated` : "Needs gaze data"],
        ["Fixation duration", f.FIXATION_DURATION !== undefined ? fmtNumber(f.FIXATION_DURATION, 0) : "—", "ms", "Average per fixation"],
        ["Backward movements", a ? String(a.backwardSaccades) : "—", sacc ? `of ${sacc}` : "", sacc ? `${fmtNumber(100 * a.backwardSaccades / sacc, 0)}% of eye movements` : ""],
        ["Regression path", f.REGRESSION_PATH_DURATION !== undefined ? fmtNumber(f.REGRESSION_PATH_DURATION, 0) : "—", "ms/word", "Time until moving past a word"],
        ["Words skipped", a ? String(a.wordsSkipped) : (record.dbWordsSkipped ?? "—"), "", a ? (a.skipBasis === "speech_and_gaze" ? "No speech and no gaze" : "No gaze (speech unavailable)") : ""],
        ["Estimated risk", p ? fmtNumber(p.risk_percentage, 1) : "—", p ? "%" : "", p ? levelText(p.risk_level) : ""]
    ];
    $("#analyticsMetrics").innerHTML = cards.map(([label, value, unit, note]) =>
        `<article class="metric-card"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}${unit ? `<span>${escapeHTML(unit)}</span>` : ""}</strong><small>${escapeHTML(note)}</small></article>`).join("");

    $$("#analyticsResults .needs-analysis").forEach((el) => el.classList.toggle("hidden", !a));
    if (a) {
        makeChart("chartProgress", progressionConfig(a, true));
        makeChart("chartDwell", dwellConfig(a, true));
        drawScanpath($("#scanpathCanvas"), a, Math.max(320, Math.min(980, $("#scanpathWrap").clientWidth || 900)), window.devicePixelRatio || 1);
        const c = a.crossCheck;
        makeChart("chartCross", {
            type: "doughnut",
            data: { labels: ["Read (speech + gaze)", "Spoken, no gaze", "Gaze, not recognised", "Skipped"],
                    datasets: [{ data: [c.read, c.spoken, c.gazed, c.skipped],
                                 backgroundColor: [CHART_COLORS.teal, CHART_COLORS.blue, CHART_COLORS.sand, CHART_COLORS.salmonDark], borderWidth: 2, borderColor: "#fffaf5" }] },
            options: { maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { boxWidth: 12 } } }, cutout: "58%" }
        });
    }

    const rows = featureRows(record);
    $$("#analyticsResults .needs-features").forEach((el) => el.classList.toggle("hidden", !rows.length));
    if (rows.length) {
        const clip = (z) => Math.max(-4, Math.min(4, z));
        makeChart("chartZ", {
            type: "bar",
            data: { labels: rows.map((r) => featureDef(r.feature).label),
                    datasets: [{ label: "Standard deviations from training mean", data: rows.map((r) => Number(clip(r.z_score).toFixed(2))),
                                 backgroundColor: rows.map((r) => Math.abs(r.z_score) <= 1 ? CHART_COLORS.teal : Math.abs(r.z_score) <= 2 ? CHART_COLORS.salmon : CHART_COLORS.salmonDark) }] },
            options: { indexAxis: "y", maintainAspectRatio: false, plugins: { legend: { display: false },
                       tooltip: { callbacks: { label: (c) => `${fmtNumber(rows[c.dataIndex].z_score, 2)} SD from training mean` } } },
                       scales: { x: { min: -4, max: 4, title: { display: true, text: "Standard deviations from the training-data mean" } } } }
        });
        $("#analyticsFeatureBody").innerHTML = rows.map((r, i) => {
            const def = featureDef(r.feature);
            return `<tr><td>${i + 1}</td><td><strong>${escapeHTML(r.feature)}</strong><small>${escapeHTML(def.meaning)}</small></td>
                <td>${formatFeatureValue(r.feature, r.value)}</td><td>${escapeHTML(def.unit)}</td><td>${typicalRangeText(r)}</td>
                <td><span class="status-pill ${statusClass(r.status)}">${escapeHTML(r.status)}</span></td></tr>`;
        }).join("");
    }

    $("#analyticsFindings").innerHTML = buildObservations(record).map((t) => `<li>${escapeHTML(t)}</li>`).join("");
    $("#analyticsModelTable").innerHTML = modelComparisonHTML();
    updateBackButtons();
}

$("#analyticsSessionSelect").addEventListener("change", (event) => {
    selectedReportId = event.target.value;
    renderAnalytics();
});

/* ---------- Report preview ---------- */

function getSelectedReport() {
    const records = getAllRecords();
    if (selectedReportId) {
        const match = records.find((r) => r.id === selectedReportId);
        if (match) return match;
    }
    return records[0] || null;
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function interpretLevel(p) {
    if (!p) return null;
    const lv = levelText(p.risk_level);
    return { text: lv, cls: riskClass(p.risk_level) };
}

/* The six rows of the report table, derived from this participant's own measurements. */
function reportMetrics(record) {
    const p = recordPrediction(record);
    const a = record.analysis;
    const rows = featureRows(record);
    const total = a ? a.crossCheck.read + a.crossCheck.spoken + a.crossCheck.gazed + a.crossCheck.skipped
                    : (record.passageText || "").split(/\s+/).filter(Boolean).length;
    const matched = a ? a.crossCheck.read + a.crossCheck.spoken
                      : (Number.isFinite(Number(record.dbWordsMatched)) ? Number(record.dbWordsMatched) : null);
    const accuracy = total && matched !== null ? 100 * matched / total : null;

    const sac = a ? a.forwardSaccades + a.backwardSaccades : 0;
    const regression = sac ? 100 * a.backwardSaccades / sac : (record.features ? 100 * record.features.REGRESSION_OUT_FULL : null);
    const focus = a ? 100 * a.quality.onTextShare : null;
    // Only UNFAVOURABLE deviations count as anomalies: longer/more fixations and more regressions
    // (above typical), or shorter saccades (below typical). Position features and SKIP are excluded.
    const higherIsWorse = ["FIXATION_COUNT", "TOTAL_READING_TIME", "FIXATION_DURATION", "FIRST_RUN_TOTAL_READING_TIME",
        "REGRESSION_IN", "REGRESSION_OUT", "REGRESSION_OUT_FULL", "REGRESSION_PATH_DURATION"];
    const eyeRows = rows.filter((r) => r.feature !== "SKIP" && r.feature !== "FIXATION_X" && r.feature !== "FIXATION_Y");
    const deviating = eyeRows.filter((r) => higherIsWorse.includes(r.feature)
        ? r.value > r.training_q75
        : r.value < r.training_q25).length;

    const out = [];
    const lvl = interpretLevel(p);
    out.push(["Dyslexia Risk Score", p ? fmtNumber(p.risk_probability, 2) : "—", "0 – 1", lvl ? `<span class="nv-pill ${lvl.cls}">${lvl.text}</span>` : "—"]);
    out.push(["Diagnosed", p ? diagnosisText(p) : "—", "—", "—"]);
    out.push(["Reading Accuracy", accuracy === null ? "—" : fmtNumber(accuracy, 1) + "%", "0 – 100%",
        accuracy === null ? "—" : accuracy >= 85 ? "Good" : accuracy >= 70 ? "Average" : "Below Average"]);
    out.push(["Eye Movement Anomalies", eyeRows.length ? (deviating <= 2 ? "Low" : deviating <= 5 ? "Moderate" : "High") : "—", "—",
        eyeRows.length ? (deviating <= 2 ? "Within Normal Limits" : deviating <= 5 ? "Needs Attention" : "Needs Evaluation") : "—"]);
    out.push(["Focus Stability", focus === null ? "—" : fmtNumber(focus, 1) + "%", "0 – 100%",
        focus === null ? "—" : focus >= 80 ? "Stable" : focus >= 60 ? "Needs Improvement" : "Unstable"]);
    out.push(["Regression Rate", regression === null ? "—" : fmtNumber(regression, 1) + "%", "0 – 100%",
        regression === null ? "—" : regression < 20 ? "Typical" : regression <= 30 ? "Slightly Elevated" : "Elevated"]);
    return out;
}

function reportSummaryText(record) {
    const p = recordPrediction(record);
    if (!p) return "The risk score could not be calculated for this session. Please complete the assessment again.";
    const score = fmtNumber(p.risk_probability, 2);
    if (p.risk_level === "HIGH RISK") return `Your assessment indicates a Dyslexia Risk Score of ${score}, which suggests a higher risk of developmental dyslexia. We recommend further evaluation and appropriate learning support.`;
    if (p.risk_level === "MODERATE RISK") return `Your assessment indicates a Dyslexia Risk Score of ${score}, which suggests a moderate risk. We recommend keeping track of reading progress and considering a follow-up assessment.`;
    return `Your assessment indicates a Dyslexia Risk Score of ${score}, which shows no significant signs of dyslexia in the reading and eye-movement patterns recorded. Keep up regular reading practice.`;
}

async function refreshReportDetails() {
    const report = getSelectedReport();
    const emptyState = $("#reportEmpty");
    const reportContent = $("#reportContent");

    if (!report) {
        emptyState.classList.remove("hidden");
        reportContent.classList.add("hidden");
        return;
    }
    emptyState.classList.add("hidden");
    reportContent.classList.remove("hidden");
    selectedReportId = report.id;
    await ensureAnalysis(report);

    // A session recorded while the analysis service was off: ask again now, then redraw.
    if (report.features && !recordPrediction(report) && !report.fromDatabase) {
        retryBackendSave(report.id).then((ok) => { if (ok && currentPage === "reports") refreshReportDetails(); });
    }

    const records = getAllRecords();
    $("#reportSessionSelect").innerHTML = records.map((r) => `<option value="${escapeHTML(r.id)}"${r.id === report.id ? " selected" : ""}>${escapeHTML(r.participantName)} · ${new Date(r.date).toLocaleDateString("en-IN")}</option>`).join("");

    const dateShort = (d) => new Date(d).toLocaleDateString("en-GB").replace(/\//g, "-");
    setText("rptName", report.participantName);
    setText("rptAge", String(report.age));
    setText("rptGender", report.gender);
    setText("rptAssessDate", dateShort(report.date));
    setText("rptReportDate", dateShort(new Date()));
    setText("rptSessionId", report.id);

    $("#rptMetricBody").innerHTML = reportMetrics(report).map(([m, r, range, interp]) =>
        `<tr><td>${m}</td><td>${r}</td><td>${range}</td><td>${interp}</td></tr>`).join("");
    setText("rptSummary", reportSummaryText(report));
    const rp = recordPrediction(report);
    setText("rptDiagnosis", rp ? diagnosisText(rp) : "—");
    setText("rptRisk", rp ? levelText(rp.risk_level) : "—");
    $("#rptDiagnosisBox").className = "nv-label-box " + (rp ? riskClass(rp.risk_level) : "none");
    $("#rptRiskBox").className = "nv-label-box " + (rp ? riskClass(rp.risk_level) : "none");
    updateBackButtons();
}

$("#reportSessionSelect").addEventListener("change", (event) => {
    selectedReportId = event.target.value;
    refreshReportDetails();
});

/* ---------- PDF report (jsPDF) ---------- */

const PDF = {
    navy: [23, 23, 45], violet: [81, 65, 126], pink: [255, 108, 174], ink: [38, 49, 74], grey: [105, 111, 132],
    line: [221, 224, 235], tint: [242, 240, 250], paper: [250, 248, 253],
    low: [43, 128, 117], moderate: [233, 142, 131], high: [184, 80, 74]
};

function offscreenChartImage(config, width, height) {
    try {
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        config.options = { ...(config.options || {}), responsive: false, animation: false, devicePixelRatio: 1 };
        config.plugins = [{ id: "whiteBg", beforeDraw(chart) { const c = chart.ctx; c.save(); c.fillStyle = "#fff"; c.fillRect(0, 0, chart.width, chart.height); c.restore(); } }];
        const chart = new Chart(canvas, config);
        const url = canvas.toDataURL("image/png");
        chart.destroy();
        return url;
    } catch (error) {
        console.warn("Chart image for PDF failed:", error);
        return null;
    }
}

function pdfSectionTitle(doc, st, title) {
    if (st.y + 16 > st.bottom) st.newPage();
    doc.setFillColor(...PDF.tint);
    doc.roundedRect(st.margin, st.y - 5, st.width, 8.5, 1.5, 1.5, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(...PDF.violet);
    doc.text(asciiPdf(title.toUpperCase()), st.margin + 3, st.y + 0.8);
    st.y += 9;
}

function pdfParagraph(doc, st, text, size = 8.5, color = PDF.grey, bold = false) {
    doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(size); doc.setTextColor(...color);
    const lines = doc.splitTextToSize(asciiPdf(text), st.width);
    const h = lines.length * (size * 0.42 + 1);
    if (st.y + h > st.bottom) st.newPage();
    doc.text(lines, st.margin, st.y);
    st.y += h + 2;
}

/* cols: [{title, w (mm), align?, bold?}] ; rows: arrays of strings */
function pdfTable(doc, st, cols, rows, opt = {}) {
    const fs = opt.fontSize || 8;
    const lh = fs * 0.42 + 1;
    const pad = 1.8;
    const drawHeader = () => {
        doc.setFillColor(...PDF.violet);
        doc.rect(st.margin, st.y - 4.5, st.width, 7.5, "F");
        doc.setFont("helvetica", "bold"); doc.setFontSize(fs); doc.setTextColor(255, 255, 255);
        let x = st.margin;
        cols.forEach((c) => { doc.text(asciiPdf(c.title), c.align === "right" ? x + c.w - pad : x + pad, st.y + 0.3, { align: c.align === "right" ? "right" : "left" }); x += c.w; });
        st.y += 5.5;
    };
    drawHeader();
    rows.forEach((row, ri) => {
        doc.setFont("helvetica", "normal"); doc.setFontSize(fs);
        const cells = row.map((cell, ci) => doc.splitTextToSize(asciiPdf(cell), cols[ci].w - pad * 2));
        const height = Math.max(...cells.map((c) => c.length)) * lh + pad * 1.4;
        if (st.y + height > st.bottom) { st.newPage(); drawHeader(); }
        if (ri % 2 === 0) { doc.setFillColor(...PDF.paper); doc.rect(st.margin, st.y - 3.4, st.width, height, "F"); }
        let x = st.margin;
        cells.forEach((lines, ci) => {
            const c = cols[ci];
            doc.setFont("helvetica", c.bold ? "bold" : "normal"); doc.setTextColor(...(c.color || PDF.ink));
            doc.text(lines, c.align === "right" ? x + c.w - pad : x + pad, st.y, { align: c.align === "right" ? "right" : "left" });
            x += c.w;
        });
        doc.setDrawColor(...PDF.line); doc.setLineWidth(0.15);
        doc.line(st.margin, st.y - 3.4 + height, st.margin + st.width, st.y - 3.4 + height);
        st.y += height;
    });
    st.y += 3;
}

function pdfInfoBox(doc, x, y, w, h, title, lines) {
    doc.setDrawColor(...PDF.line); doc.setLineWidth(0.3); doc.setFillColor(255, 255, 255);
    doc.roundedRect(x, y, w, h, 1.5, 1.5, "FD");
    doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(...PDF.violet);
    doc.text(asciiPdf(title.toUpperCase()), x + 3, y + 5);
    doc.setDrawColor(...PDF.line); doc.line(x + 3, y + 6.5, x + w - 3, y + 6.5);
    let ly = y + 11.5;
    lines.forEach(([label, value, bold]) => {
        doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(...PDF.grey);
        doc.text(asciiPdf(label), x + 3, ly);
        doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(...PDF.ink);
        doc.text(doc.splitTextToSize(asciiPdf(value), w - 6)[0], x + 3, ly + 3.8);
        ly += 8.6;
    });
}

async function downloadAssessmentPdf() {
    const report = getSelectedReport();
    if (!report) { showToast("Complete an assessment before downloading a report."); return; }
    if (!window.jspdf?.jsPDF) { showToast("The PDF library is unavailable. Check your internet connection."); return; }
    const p = recordPrediction(report);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const T = {
        dark: [15, 95, 87], deeper: [11, 74, 68], mint: [143, 224, 207], pale: [211, 240, 232], band: [203, 238, 228],
        bg: [245, 251, 249], ink: [23, 63, 58], navy: [16, 37, 63], pillHigh: [243, 180, 171], pillMod: [253, 224, 200], pillLow: [185, 236, 223]
    };
    const dateShort = (d) => new Date(d).toLocaleDateString("en-GB").replace(/\//g, "-");
    const clean = asciiPdf;

    doc.setFillColor(...T.bg); doc.rect(0, 0, 210, 297, "F");

    /* header band */
    doc.setFillColor(...T.dark); doc.roundedRect(8, 6, 194, 46, 9, 9, "F");
    doc.setFillColor(217, 243, 236); doc.roundedRect(15, 16, 26, 26, 6, 6, "F");
    doc.setFillColor(255, 255, 255); doc.setDrawColor(...T.dark); doc.setLineWidth(0.6); doc.ellipse(28, 29, 10, 6, "FD");
    doc.setFillColor(233, 142, 131); doc.circle(28, 29, 4, "FD"); doc.setFillColor(...T.ink); doc.circle(28, 29, 1.7, "F");
    doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(19); doc.text("Neuro Vision", 47, 28);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(184, 236, 224); doc.text("I N S I G H T S   W I T H I N", 47, 35);
    doc.setDrawColor(255, 255, 255); doc.setLineWidth(0.4); doc.line(96, 15, 96, 43);
    doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.text("ASSESSMENT", 102, 24); doc.text("REPORT:", 102, 32);
    doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(...T.mint); doc.text("Developmental Dyslexia", 102, 40);
    doc.setDrawColor(...T.mint); doc.setLineWidth(0.7); doc.circle(185, 29, 13, "S");
    doc.line(185, 19, 185, 39); doc.circle(179, 26, 4, "S"); doc.circle(191, 26, 4, "S"); doc.circle(179, 33, 4, "S"); doc.circle(191, 33, 4, "S");

    /* participant row */
    doc.setFont("helvetica", "bold"); doc.setFontSize(11.5); doc.setTextColor(...T.dark); doc.text("PARTICIPANT :", 14, 66);
    doc.setFontSize(16); doc.setTextColor(...T.navy); doc.text(clean(report.participantName), 52, 66);
    doc.setFillColor(63, 191, 168); doc.circle(20, 74, 1.6, "F"); doc.circle(20, 81, 1.6, "F");
    doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(...T.ink);
    doc.text(clean(`Age: ${report.age}  |  Gender: ${report.gender}`), 26, 75);
    doc.text(clean(`Assessment Date: ${dateShort(report.date)}`), 26, 82);
    doc.setDrawColor(...T.ink); doc.setLineWidth(0.5); doc.line(128, 59, 128, 84);
    doc.text(clean(`Report ID: ${report.id}`), 133, 66); doc.text(`Analysis Date: ${dateShort(new Date())}`, 133, 73); doc.text("Model Version: RF v1.0", 133, 80);
    doc.setDrawColor(143, 214, 199); doc.setLineWidth(0.5); doc.line(14, 88, 196, 88);
    /* labels: Diagnosed + Risk */
    const lvlP = p ? interpretLevel(p) : null;
    const pillCol = lvlP ? (lvlP.cls === "high" ? T.pillHigh : lvlP.cls === "moderate" ? T.pillMod : T.pillLow) : [225, 230, 228];
    [["DIAGNOSED:", p ? diagnosisText(p) : "-", 14], ["RISK:", p ? lvlP.text : "-", 108]].forEach(([k, v, lx]) => {
        doc.setFillColor(...pillCol); doc.roundedRect(lx, 92, 88, 10, 4, 4, "F");
        doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(...T.dark); doc.text(k, lx + 5, 98.6);
        doc.setFontSize(11.5); doc.setTextColor(...T.navy); doc.text(clean(v), lx + 84, 98.7, { align: "right" });
    });

    /* left panel */
    doc.setFillColor(...T.pale); doc.roundedRect(8, 107, 58, 141, 7, 7, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(...T.dark); doc.text(["ASSESSMENT", "DETAILS"], 13, 117);
    const sideItems = ["Eye-Tracking Analysis (Webcam)", "Features Extracted: Fixations, Saccades, Regressions", "Classification Method: Random Forest"];
    let sy = 135;
    sideItems.forEach((t) => {
        doc.setFillColor(255, 255, 255); doc.circle(15.5, sy - 1, 3.2, "F");
        doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(...T.ink);
        const lines = doc.splitTextToSize(clean(t), 38); doc.text(lines, 22, sy);
        sy += Math.max(16, lines.length * 4.6 + 6);
    });
    doc.setDrawColor(143, 214, 199); doc.line(13, sy + 1, 61, sy + 1);
    doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor(...T.dark); doc.text("ABOUT THIS REPORT", 13, sy + 9);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(...T.ink);
    doc.text(doc.splitTextToSize("This report presents the results of your eye-tracking assessment based on eye-movement patterns and reading behavior.", 48), 13, sy + 16);
    doc.line(13, sy + 44, 61, sy + 44);
    doc.setFont("helvetica", "italic"); doc.text(doc.splitTextToSize("Early detection can help you get the right support and guidance.", 44), 37, sy + 52, { align: "center" });

    /* metrics table */
    const X = 72, W = 130; const cols = [40, 22, 22, 46];
    doc.setFillColor(...T.band); doc.roundedRect(X, 107, W, 11, 4, 4, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(...T.dark);
    let cx = X; ["METRIC", "RESULT", "RANGE", "INTERPRETATION"].forEach((h, i) => {
        doc.text(h, i === 0 ? cx + 4 : cx + cols[i] / 2, 113.8, { align: i === 0 ? "left" : "center" }); cx += cols[i]; });
    let ty = 119;
    reportMetrics(report).forEach(([m, r, range, interp], ri) => {
        const rowH = 12; const mid = ty + rowH / 2 + 1.2;
        doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(...T.ink); doc.text(clean(m), X + 2, mid);
        doc.setFont("helvetica", "bold"); doc.text(clean(String(r)), X + cols[0] + cols[1] / 2, mid, { align: "center" });
        doc.setFont("helvetica", "normal"); doc.text(clean(range), X + cols[0] + cols[1] + cols[2] / 2, mid, { align: "center" });
        const ix = X + cols[0] + cols[1] + cols[2] + cols[3] / 2;
        if (ri === 0 && p) {
            const lvl = interpretLevel(p); const label = lvl.text;
            doc.setFillColor(...(lvl.cls === "high" ? T.pillHigh : lvl.cls === "moderate" ? T.pillMod : T.pillLow));
            doc.roundedRect(ix - 19, ty + 2, 38, 9, 3, 3, "F");
            doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.text(label, ix, mid, { align: "center" });
        } else {
            doc.setFontSize(9); doc.text(clean(interp.replace(/<[^>]+>/g, "")), ix, mid, { align: "center" });
        }
        doc.setDrawColor(207, 227, 222); doc.setLineWidth(0.3); doc.line(X, ty + rowH, X + W, ty + rowH);
        ty += rowH;
    });

    /* summary */
    const sumY = ty + 6;
    doc.setFillColor(207, 238, 229); doc.roundedRect(X, sumY, W, 36, 7, 7, "F");
    doc.setDrawColor(...T.ink); doc.setLineWidth(0.5); doc.line(X + 22, sumY + 6, X + 22, sumY + 30);
    doc.setFillColor(...T.dark); doc.circle(X + 11, sumY + 15, 5, "F"); doc.setFillColor(255, 255, 255); doc.circle(X + 11, sumY + 15, 2.2, "F");
    doc.setFillColor(...T.dark); doc.rect(X + 9, sumY + 21, 4, 3, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(...T.dark); doc.text("SUMMARY", X + 27, sumY + 9);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...T.ink);
    doc.text(doc.splitTextToSize(clean(reportSummaryText(report)), W - 34), X + 27, sumY + 15);

    /* regards */
    const rx = X + W / 2; const ry = sumY + 45;
    doc.setFont("helvetica", "normal"); doc.setFontSize(10.5); doc.setTextColor(...T.ink); doc.text("Warm Regards,", rx, ry, { align: "center" });
    doc.setFont("helvetica", "italic"); doc.setFontSize(22); doc.text("Neuro Vision", rx, ry + 12, { align: "center" });
    doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.text("Neuro Vision Team", rx, ry + 21, { align: "center" });

    /* footer band */
    doc.setFillColor(...T.dark); doc.roundedRect(8, 263, 194, 28, 9, 9, "F");
    doc.setFont("helvetica", "normal"); doc.setFontSize(10.5); doc.setTextColor(255, 255, 255);
    doc.text(clean("Tel: " + REPORT_CONTACT.phone), 40, 272); doc.text(clean("Email: " + REPORT_CONTACT.email), 40, 278); doc.text(clean("Web: " + REPORT_CONTACT.web), 40, 284);
    doc.setDrawColor(255, 255, 255); doc.setLineWidth(0.3); doc.line(112, 268, 112, 286);
    doc.setFont("helvetica", "italic"); doc.setFontSize(11); doc.setTextColor(214, 245, 238);
    doc.text(["Together for a", "Brighter Reading Future"], 120, 275);

    doc.save(`Neuro-Vision-Report-${report.id}.pdf`);
    $("#downloadMessage").textContent = "Your assessment report has been generated.";
}

$("#downloadReport").addEventListener("click", () => {
    downloadAssessmentPdf().catch((error) => { console.error(error); showToast("The PDF could not be generated: " + error.message); });
});
$("#printReport").addEventListener("click", () => window.print());

/* ---------- Settings ---------- */

$("#showTips").addEventListener("change", (event) => {
    $$(".instruction-strip").forEach((strip) => strip.classList.toggle("hidden", !event.target.checked));
});

/* ---------- Startup ---------- */

document.addEventListener("DOMContentLoaded", () => {
    checkVisionLibraries();
    assessmentRecords = loadAssessmentRecords();
    populateDeviceLists();
});

window.addEventListener("beforeunload", () => {
    stopCamera();
    stopMicrophone();
    stopSpeechRecognition();
});
