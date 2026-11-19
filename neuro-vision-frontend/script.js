/* =========================================================
   NEURO VISION — FRONTEND APPLICATION (core)
   Login, assessment flow, webcam eye tracking, calibration, speech reading
   and the connection to the FastAPI / MySQL backend.
   Reports, analytics, history and the dashboard are in report.js.
   Pure feature-extraction maths is in reading-analysis.js (window.NVAnalysis).
   ========================================================= */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

// FastAPI address. When the page is opened from the backend itself (http://127.0.0.1:8000)
// the same origin is used; otherwise the usual local addresses are tried in turn.
const API_CANDIDATES = (() => {
    const list = [];
    if (location.port === "8000") list.push("");
    ["http://127.0.0.1:8000", "http://localhost:8000"].forEach((u) => { if (!list.includes(u)) list.push(u); });
    return list;
})();
let API_BASE_URL = API_CANDIDATES[0];

async function apiFetch(path, options) {
    let lastError = null;
    const order = [API_BASE_URL, ...API_CANDIDATES.filter((u) => u !== API_BASE_URL)];
    for (const base of order) {
        try {
            const response = await fetch(`${base}${path}`, options);
            API_BASE_URL = base;
            return response;
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error("network error");
}

const MODEL_FEATURE_NAMES = NVAnalysis.FEATURE_NAMES;

function hasAllModelFeatures(features) {
    return Boolean(features) && MODEL_FEATURE_NAMES.every((name) => {
        const value = features[name];
        if (value === null || value === undefined || value === "") return false;
        return Number.isFinite(Number(value));
    });
}

/* Sends the finished session to FastAPI: validate -> predict -> save to MySQL.
   Resolves with the backend response (prediction + saved flag). */
async function postAssessmentToBackend(payload, attempts = 3) {
    let response = null;
    for (let i = 0; i < attempts && !response; i += 1) {
        try {
            response = await apiFetch("/api/assessments", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
            });
        } catch (error) {
            if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1200));
        }
    }
    if (!response) throw new Error("The analysis service is not running. Start the Neuro Vision backend (start_neuro_vision.bat) and try again.");

    let result;
    try { result = await response.json(); } catch { throw new Error("The backend returned an invalid response."); }
    if (!response.ok) {
        const detail = result && result.detail;
        if (detail && typeof detail === "object") {
            const extra = detail.invalid_features ? " " + JSON.stringify(detail.invalid_features)
                : detail.missing_features ? " Missing: " + detail.missing_features.join(", ") : "";
            throw new Error((detail.message || "Backend rejected the features.") + extra);
        }
        throw new Error(typeof detail === "string" ? detail : `Backend request failed (${response.status}).`);
    }
    return result;
}

async function fetchBackendJson(path) {
    const response = await apiFetch(path);
    if (!response.ok) throw new Error(`Backend request failed (${response.status}).`);
    return response.json();
}

window.neuroVisionEyeFeatures = null;


const authView = $("#authView");
const appView = $("#appView");
const loginForm = $("#loginForm");
const registerForm = $("#registerForm");
const authTitle = $("#authTitle");
const authSubtitle = $("#authSubtitle");
const authSwitchText = $("#authSwitchText");
const authSwitchButton = $("#authSwitchButton");

let currentUser = "";
let currentEmail = "";
let assessmentRecords = loadAssessmentRecords();
let selectedReportId = null;
let readingDurationSeconds = 0;
let currentStep = 1;
let cameraStream = null;
let faceMesh = null;
let faceMeshTrackingActive = false;
let faceMeshFrameRequest = null;
let lastFaceMeshVideoTime = -1;
let faceMeshInitialization = null;
let microphoneStream = null;
let audioContext = null;
let audioAnalyser = null;
let audioAnimation = null;
let speechRecognition = null;
let speechTranscript = "";
let readingStartedAt = null;
let readingTimerInterval = null;
let calibrationTimer = null;
let chartInstances = [];
let participant = {
    name: "",
    age: null,
    gender: ""
};


/* ---------- Extra state (navigation, reading session, calibration overlay) ---------- */
let currentPage = "dashboard";
let pageHistory = [];
let assessmentFlowState = "idle";      // idle | in_progress | completed
let currentPassageText = "";
let readingSessionActive = false;
let readingCaptureOrigin = 0;
let readingDurationMs = 0;
let speechStopRequested = false;
let speechEndWaiters = [];
let readingWordRects = [];
let readingRectTimer = null;
let calibrationOverlayOpen = false;
let backendRecords = [];
let backendOnline = null;
const WORD_SNAP_PX = 70;               // gaze within this distance of a word is assigned to it

const passages = {
    young: "Mia has a little red kite. She runs across the green grass. The wind lifts the kite into the sky. Mia smiles and waves to her friend.",
    middle: "A small bird built its nest in a quiet tree near the garden. Each morning, it searched for food and returned to care for its young. The children watched from a distance and learned to respect the bird's home.",
    older: "The school garden changed throughout the seasons. Students recorded the growth of plants, compared their observations and discussed how sunlight and water affected each living thing. Their careful notes helped them understand the natural world."
};


/* ---------- Small interface helpers ---------- */

function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");

    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
        toast.classList.remove("show");
    }, 2800);
}

function speakText(text) {
    if (!("speechSynthesis" in window)) {
        showToast("Spoken instructions are not supported in this browser.");
        return;
    }

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.92;
    utterance.pitch = 1;
    utterance.lang = "en-IN";

    window.speechSynthesis.speak(utterance);
}

function updateUserLabels(name) {
    const initials = name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase();

    $("#sidebarUser").textContent = name;
    $("#userAvatar").textContent = initials || "NV";
    $("#topbarAvatar").textContent = initials || "NV";
}

function readStoredAccounts() {
    try {
        return JSON.parse(localStorage.getItem("neuroVisionAccounts") || "[]");
    } catch (error) {
        console.error("Could not read account records:", error);
        return [];
    }
}

async function hashPassword(password) {
    const encodedPassword = new TextEncoder().encode(password);
    const digest = await crypto.subtle.digest("SHA-256", encodedPassword);
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

function assessmentStorageKey() {
    const accountKey = currentEmail ? encodeURIComponent(currentEmail) : "unassigned";
    return `neuroVisionAssessments_${accountKey}`;
}

function loadAssessmentRecords() {
    try {
        return JSON.parse(localStorage.getItem(assessmentStorageKey()) || "[]");
    } catch (error) {
        console.error("Could not read assessment history:", error);
        return [];
    }
}

function saveAssessmentRecords() {
    // localStorage holds ~5 MB. Raw gaze samples are the largest part, so if the quota is hit
    // they are dropped from the OLDEST records first (their analysis and features are kept).
    for (let attempt = 0; attempt <= assessmentRecords.length; attempt += 1) {
        try {
            localStorage.setItem(assessmentStorageKey(), JSON.stringify(assessmentRecords));
            return true;
        } catch (error) {
            const target = [...assessmentRecords].reverse().find((r) => Array.isArray(r.gazeSamples) && r.gazeSamples.length);
            if (!target) break;
            target.gazeSamples = [];
            target.gazeSamplesTrimmed = true;
        }
    }
    showToast("Browser storage is full; this session could not be kept locally.");
    return false;
}

function openApp(name, email) {
    currentUser = name;
    currentEmail = email;
    assessmentRecords = loadAssessmentRecords();
    updateUserLabels(currentUser);
    authView.classList.add("hidden");
    appView.classList.remove("hidden");
    pageHistory = [];
    currentPage = "";
    assessmentFlowState = "idle";
    selectedReportId = null;
    navigateTo("dashboard");
    loadBackendRecords();
}

function showAuthMode(mode) {
    const isRegister = mode === "register";

    const isReset = mode === "reset";

    loginForm.classList.toggle("hidden", isRegister || isReset);
    registerForm.classList.toggle("hidden", !isRegister);
    $("#resetForm").classList.toggle("hidden", !isReset);

    authTitle.textContent = isReset ? "Reset your password" : isRegister ? "Create your account" : "Welcome back";
    authSubtitle.textContent = isReset
        ? "Enter your registered email and choose a new password."
        : isRegister
            ? "Register before accessing your workspace."
            : "Sign in with your registered email and password.";

    authSwitchText.textContent = isRegister || isReset
        ? "Already have an account?"
        : "New to Neuro Vision?";

    authSwitchButton.textContent = isRegister || isReset
        ? "Login"
        : "Create an account";
    $("#resetMessage").textContent = "";

    $("#loginMessage").textContent = "";
    $("#registerMessage").textContent = "";
}
authSwitchButton.addEventListener("click", () => {
    const onLogin = !loginForm.classList.contains("hidden");
    showAuthMode(onLogin ? "register" : "login");
});

$("#forgotPassword").addEventListener("click", () => {
    $("#resetEmail").value = $("#loginEmail").value.trim();
    showAuthMode("reset");
});

/* Password reset. Accounts are kept in this browser (there is no email service), so the reset
   is done here: the registered email must exist on this device. */
$("#resetForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("#resetEmail").value.trim().toLowerCase();
    const password = $("#resetPassword").value;
    const confirm = $("#resetConfirm").value;
    const message = $("#resetMessage");

    const accounts = readStoredAccounts();
    const account = accounts.find((item) => item.email === email);
    if (!account) { message.textContent = "No account exists for this email on this device. Please create an account."; return; }
    if (!/^(?=.*[A-Z])(?=.*[0-9])[A-Za-z0-9@$!%*?&]{6,}$/.test(password)) {
        message.textContent = "Use 6+ letters/numbers, including one uppercase letter and one number."; return;
    }
    if (password !== confirm) { message.textContent = "The passwords do not match."; return; }

    account.passwordHash = await hashPassword(password);
    localStorage.setItem("neuroVisionAccounts", JSON.stringify(accounts));
    $("#resetForm").reset();
    showAuthMode("login");
    $("#loginEmail").value = email;
    $("#loginMessage").textContent = "Password updated. Please log in with your new password.";
});

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email = $("#loginEmail").value.trim().toLowerCase();
    const password = $("#loginPassword").value;

    if (!email || !password) {
        $("#loginMessage").textContent = "Enter your registered email and password.";
        return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        $("#loginMessage").textContent = "Please enter a valid email address.";
        return;
    }

    const account = readStoredAccounts().find((item) => item.email === email);

    if (!account) {
        $("#loginMessage").textContent = "No account exists for this email. Please create an account first.";
        return;
    }

    const passwordHash = await hashPassword(password);

    if (passwordHash !== account.passwordHash) {
        $("#loginMessage").textContent = "The password is incorrect. Please try again.";
        return;
    }

    $("#loginMessage").textContent = "";
    loginForm.reset();
    openApp(account.name, account.email);
});

registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const name = $("#registerName").value.trim();
    const email = $("#registerEmail").value.trim().toLowerCase();
    const password = $("#registerPassword").value;
    const confirmPassword = $("#confirmPassword").value;
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    const passwordPattern = /^(?=.*[A-Z])(?=.*[0-9])[A-Za-z0-9@$!%*?&]{6,}$/;

    if (!name || !email || !password || !confirmPassword) {
        $("#registerMessage").textContent = "Please complete all fields.";
        return;
    }

    if (!emailPattern.test(email)) {
        $("#registerMessage").textContent = "Enter a valid email address.";
        return;
    }

    if (!passwordPattern.test(password)) {
        $("#registerMessage").textContent =
            "Use 6+ letters/numbers, including one uppercase letter and one number.";
        return;
    }

    if (password !== confirmPassword) {
        $("#registerMessage").textContent = "The passwords do not match.";
        return;
    }

    const accounts = readStoredAccounts();
    const accountExists = accounts.some((account) => account.email === email);

    if (accountExists) {
        $("#registerMessage").textContent = "An account with this email already exists. Please log in.";
        return;
    }

    const account = {
        name,
        email,
        passwordHash: await hashPassword(password),
        createdAt: new Date().toISOString()
    };

    accounts.push(account);
    localStorage.setItem("neuroVisionAccounts", JSON.stringify(accounts));

    $("#registerMessage").textContent = "";
    registerForm.reset();
    showToast("Account created. You can now log in.");
    showAuthMode("login");
    $("#loginEmail").value = email;
});

/* ---------- Navigation and sidebar ---------- */

const PAGE_NAMES = {
    dashboard: "Dashboard",
    assessment: "New Assessment",
    history: "Assessment History",
    analytics: "Reading Analytics",
    reports: "Reports",
    settings: "Settings",
    help: "Help & Support"
};

function isAssessmentInProgress() {
    return assessmentFlowState === "in_progress";
}

/* options.fresh : the person asked to START a new assessment (not just open the page)
   options.back  : navigation caused by a Back button (do not add to history)          */
function navigateTo(pageName, options = {}) {
    if (!PAGE_NAMES[pageName]) pageName = "dashboard";

    if (pageName === "assessment" && options.fresh && isAssessmentInProgress()) {
        if (!window.confirm("An assessment is in progress. Discard it and start a new one?")) return;
    }

    // Leaving the assessment page while reading: stop the reading session cleanly.
    if (currentPage === "assessment" && pageName !== "assessment" && readingSessionActive) {
        stopSpeechRecognition();
    }

    if (!options.back && currentPage && pageName !== currentPage) {
        pageHistory.push(currentPage);
        pageHistory = pageHistory.slice(-20);
    }
    currentPage = pageName;

    $$(".page-section").forEach((section) => {
        section.classList.toggle("active", section.id === `page-${pageName}`);
    });
    $$(".nav-link").forEach((link) => {
        link.classList.toggle("active", link.dataset.page === pageName);
    });
    $("#pageHeading").textContent = PAGE_NAMES[pageName];

    if (pageName === "assessment") {
        // Reset only when starting fresh or when no assessment exists yet.
        // A finished or in-progress assessment is RESUMED, so the person can come back to it.
        if (options.fresh || assessmentFlowState === "idle") resetAssessmentFlow();
        else setAssessmentStep(currentStep);
    }
    if (pageName === "dashboard") renderDashboard();
    if (pageName === "analytics") renderAnalytics();
    if (pageName === "history") renderHistory();
    if (pageName === "reports") refreshReportDetails();

    updateBackButtons();
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function goBack() {
    let target = pageHistory.pop();
    while (target === currentPage && pageHistory.length) target = pageHistory.pop();
    navigateTo(target && target !== currentPage ? target : "dashboard", { back: true });
}

function updateBackButtons() {
    $$("[data-back]").forEach((button) => {
        const previous = [...pageHistory].reverse().find((name) => name !== currentPage);
        button.querySelector(".back-target").textContent = previous ? PAGE_NAMES[previous] : "Dashboard";
    });
}

// Sidebar links: open the page. "New Assessment" resumes one in progress, or starts fresh after a finished one.
$$("[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
        const page = button.dataset.page;
        if (!page) return;
        navigateTo(page, { fresh: page === "assessment" && assessmentFlowState === "completed" });
    });
});

// Buttons inside pages. Anything that targets "assessment" means "start a new one".
$$("[data-go]").forEach((button) => {
    button.addEventListener("click", () => {
        const target = button.dataset.go;
        navigateTo(target, { fresh: target === "assessment" && button.dataset.resume === undefined });
    });
});

$$("[data-back]").forEach((button) => button.addEventListener("click", goBack));

$("#sidebarToggle").addEventListener("click", () => {
    $("#sidebar").classList.toggle("collapsed");
});

$("#logoutButton").addEventListener("click", () => {
    releaseAllDevices();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();

    appView.classList.add("hidden");
    authView.classList.remove("hidden");
    loginForm.reset();
    currentUser = "";
    currentEmail = "";
    pageHistory = [];
    assessmentFlowState = "idle";
    selectedReportId = null;
    backendRecords = [];
    showAuthMode("login");
});

/* ---------- Guided assessment steps ---------- */

function resetAssessmentFlow() {
    stopSpeechRecognition();
    stopCamera();
    stopMicrophone();
    closeCalibrationOverlay(true);

    stopCalibrationTimers();
    calibrationSamples = [];
    calibrationIndex = 0;
    stopGazeMappingTest();
    window.neuroVisionCalibration = null;
    $("#gazeTestButton").disabled = true;

    assessmentFlowState = "idle";
    currentStep = 1;
    // NOTE: selectedReportId is intentionally NOT cleared. Starting a new assessment must not
    // make the previous report disappear from the Reports page.
    speechTranscript = "";
    window.neuroVisionEyeFeatures = null;
    readingGazeCaptureActive = false;
    readingSessionActive = false;
    readingGazeSamples = [];
    window.neuroVisionGazeEstimate = null;
    readingStartedAt = null;
    readingDurationMs = 0;
    participant = { name: "", age: null, gender: "" };
    readingDurationSeconds = 0;

    $("#participantForm").reset();
    $("#readingTimer").textContent = "00:00";
    $("#transcriptText").textContent = "No recognised words yet.";
    $("#speechStatus").textContent = "Speech recognition not started";
    $("#calibrationCount").textContent = "0 / 9";
    $("#calibrationProgress").style.width = "0%";
    $("#calibrationMessage").textContent = "Press start when you are ready.";
    $("#calibrationButton").disabled = false;
    $("#calibrationButton").textContent = "Start calibration";
    $("#calibrationTarget").style.left = "50%";
    $("#calibrationTarget").style.top = "50%";
    updateGazeCaptureStatus();

    renderPassage(passages.middle);
    setAssessmentStep(1);
}

function setAssessmentStep(stepNumber) {
    currentStep = Math.max(1, Math.min(5, stepNumber));

    if (currentStep >= 2 && currentStep <= 4) assessmentFlowState = "in_progress";
    if (currentStep === 5) assessmentFlowState = "completed";

    $$(".assessment-step").forEach((step) => {
        step.classList.toggle("active", Number(step.dataset.step) === currentStep);
    });

    $$("#stepper .step").forEach((step, index) => {
        step.classList.toggle("active", index + 1 === currentStep);
        step.classList.toggle("done", index + 1 < currentStep);
    });

    if (currentStep === 4 && !readingSessionActive && !readingGazeSamples.length) loadPassage();
    if (currentStep === 4) updateGazeCaptureStatus();
    if (currentStep === 5) releaseAllDevices();
}

$("#participantForm").addEventListener("submit", (event) => {
    event.preventDefault();

    const name = $("#participantName").value.trim();
    const age = Number($("#participantAge").value);
    const gender = $("#participantGender").value;
    const consent = $("#guardianConsent").checked;

    if (!name || age < 5 || age > 12 || !gender || !consent) {
        showToast("Please complete the details and confirm guardian consent.");
        return;
    }

    participant = { name, age, gender };
    setAssessmentStep(2);
});

$$("[data-next]").forEach((button) => {
    button.addEventListener("click", () => setAssessmentStep(currentStep + 1));
});

$$("[data-prev]").forEach((button) => {
    button.addEventListener("click", () => setAssessmentStep(currentStep - 1));
});

$$("[data-speak]").forEach((button) => {
    button.addEventListener("click", () => speakText(button.dataset.speak));
});


/* ---------- Camera: actual browser permission and preview ---------- */

async function populateDeviceLists() {
    if (!navigator.mediaDevices?.enumerateDevices) return;

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cameras = devices.filter((device) => device.kind === "videoinput");
        const microphones = devices.filter((device) => device.kind === "audioinput");

        $("#cameraSelect").innerHTML = '<option value="">Default camera</option>';
        $("#micSelect").innerHTML = '<option value="">Default microphone</option>';
        $("#settingsCamera").innerHTML = '<option value="">Default camera</option>';
        $("#settingsMic").innerHTML = '<option value="">Default microphone</option>';

        cameras.forEach((device, index) => {
            const label = device.label || `Camera ${index + 1}`;
            addDeviceOption($("#cameraSelect"), device.deviceId, label);
            addDeviceOption($("#settingsCamera"), device.deviceId, label);
        });

        microphones.forEach((device, index) => {
            const label = device.label || `Microphone ${index + 1}`;
            addDeviceOption($("#micSelect"), device.deviceId, label);
            addDeviceOption($("#settingsMic"), device.deviceId, label);
        });
    } catch (error) {
        console.warn("Could not list devices:", error);
    }
}

function addDeviceOption(select, value, label) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
}

async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
        showToast("Camera access is not supported by this browser.");
        $("#cameraStatus").textContent = "Unsupported";
        return;
    }

    try {
        stopCamera();

        const selectedCamera = $("#cameraSelect").value;
        const videoConstraints = selectedCamera
            ? { deviceId: { exact: selectedCamera } }
            : true;

        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: videoConstraints,
            audio: false
        });

        const video = $("#cameraVideo");
        video.srcObject = cameraStream;
        await video.play();
        $("#cameraPlaceholder").classList.add("hidden");
        $("#cameraStatus").textContent = "Camera connected";
        $("#cameraStatus").classList.add("ready");
        $("#cameraButton").textContent = "Turn off camera";

        await populateDeviceLists();

        try {
            await initializeFaceMesh();
            startFaceMeshTracking();
        } catch (trackingError) {
            console.error("MediaPipe could not start:", trackingError);
            updateEyeTrackingStatus("Camera ready · eye landmark tracking unavailable");
            showToast("Camera is ready, but MediaPipe could not start. Check your internet connection and reload the page.");
            return;
        }

        showToast("Camera and eye-landmark tracking are ready.");
    } catch (error) {
        $("#cameraStatus").textContent = "Permission needed";
        showToast("Camera could not start. Check browser permissions.");
        console.error(error);
    }
}

function stopCamera() {
    readingGazeCaptureActive = false;
    stopFaceMeshTracking();

    if (cameraStream) {
        cameraStream.getTracks().forEach((track) => track.stop());
        cameraStream = null;
    }

    const video = $("#cameraVideo");
    if (video) video.srcObject = null;
    window.neuroVisionEyeLandmarkSample = null;
    updateEyeTrackingStatus("Eye landmark tracking is off.");

    if ($("#cameraPlaceholder")) $("#cameraPlaceholder").classList.remove("hidden");
    if ($("#cameraStatus")) {
        $("#cameraStatus").textContent = "Not started";
        $("#cameraStatus").classList.remove("ready");
    }
    if ($("#cameraButton")) $("#cameraButton").textContent = "Enable camera";
}

$("#cameraButton").addEventListener("click", () => {
    if (cameraStream) stopCamera();
    else startCamera();
});

$("#cameraSelect").addEventListener("change", () => {
    if (cameraStream) startCamera();
});

$("#settingsCamera").addEventListener("change", () => {
    $("#cameraSelect").value = $("#settingsCamera").value;
    if (cameraStream) startCamera();
});

/* ---------- Microphone: browser stream and simple activity meter ---------- */

async function startMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) {
        showToast("Microphone access is not supported by this browser.");
        return;
    }

    try {
        stopMicrophone();

        const selectedMic = $("#micSelect").value;
        const audioConstraints = selectedMic
            ? { deviceId: { exact: selectedMic } }
            : true;

        microphoneStream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
            video: false
        });

        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(microphoneStream);
        audioAnalyser = audioContext.createAnalyser();
        audioAnalyser.fftSize = 64;
        source.connect(audioAnalyser);

        $("#micStatus").textContent = "Connected";
        $("#micStatus").classList.add("ready");
        $("#micButton").textContent = "Turn off microphone";
        $("#micMessage").textContent = "Microphone is receiving audio input.";
        $("#audioBars").classList.add("active");

        animateAudioBars();
        await populateDeviceLists();
        showToast("Microphone is connected.");
    } catch (error) {
        $("#micStatus").textContent = "Permission needed";
        $("#micMessage").textContent = "Could not access microphone.";
        showToast("Microphone could not start. Check browser permissions.");
        console.error(error);
    }
}

function animateAudioBars() {
    if (!audioAnalyser) return;

    const data = new Uint8Array(audioAnalyser.frequencyBinCount);
    audioAnalyser.getByteFrequencyData(data);

    const bars = $$("#audioBars i");
    bars.forEach((bar, index) => {
        const amount = data[index] || 0;
        bar.style.height = `${7 + amount / 9}px`;
    });

    audioAnimation = requestAnimationFrame(animateAudioBars);
}

function stopMicrophone() {
    if (audioAnimation) cancelAnimationFrame(audioAnimation);
    if (microphoneStream) {
        microphoneStream.getTracks().forEach((track) => track.stop());
        microphoneStream = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }

    if ($("#micStatus")) {
        $("#micStatus").textContent = "Not started";
        $("#micStatus").classList.remove("ready");
    }
    if ($("#micButton")) $("#micButton").textContent = "Enable microphone";
    if ($("#micMessage")) $("#micMessage").textContent = "Enable microphone to check audio input.";
    if ($("#audioBars")) $("#audioBars").classList.remove("active");
}

$("#micButton").addEventListener("click", () => {
    if (microphoneStream) stopMicrophone();
    else startMicrophone();
});

$("#micSelect").addEventListener("change", () => {
    if (microphoneStream) startMicrophone();
});

$("#settingsMic").addEventListener("change", () => {
    $("#micSelect").value = $("#settingsMic").value;
    if (microphoneStream) startMicrophone();
});

/* ---------- MediaPipe face and iris landmark tracking ---------- */

function updateEyeTrackingStatus(message) {
    const status = $("#eyeTrackingStatus");
    if (status) status.textContent = message;
}

function averageLandmark(landmarks, indices) {
    const selected = indices.map((index) => landmarks[index]).filter(Boolean);
    if (selected.length !== indices.length) return null;

    return {
        x: selected.reduce((sum, point) => sum + point.x, 0) / selected.length,
        y: selected.reduce((sum, point) => sum + point.y, 0) / selected.length
    };
}

function getEyeRatio(landmarks, irisIndices, cornerAIndex, cornerBIndex, lidAIndex, lidBIndex) {
    const iris = averageLandmark(landmarks, irisIndices);
    const cornerA = landmarks[cornerAIndex];
    const cornerB = landmarks[cornerBIndex];
    const lidA = landmarks[lidAIndex];
    const lidB = landmarks[lidBIndex];

    if (!iris || !cornerA || !cornerB || !lidA || !lidB) return null;

    const minX = Math.min(cornerA.x, cornerB.x);
    const width = Math.abs(cornerB.x - cornerA.x);
    const minY = Math.min(lidA.y, lidB.y);
    const height = Math.abs(lidB.y - lidA.y);

    if (width < 0.0001 || height < 0.0001) return null;

    return {
        x: (iris.x - minX) / width,
        y: (iris.y - minY) / height
    };
}

function handleFaceMeshResults(results) {
    const landmarks = results.multiFaceLandmarks?.[0];

    if (!landmarks) {
        window.neuroVisionEyeLandmarkSample = null;
        updateEyeTrackingStatus("No face detected · look toward the camera");
        return;
    }

    // Refined FaceMesh provides iris landmarks 468–477.
    if (landmarks.length < 478) {
        updateEyeTrackingStatus("Face detected · iris landmarks are unavailable");
        return;
    }

    const leftEye = getEyeRatio(landmarks, [468, 469, 470, 471, 472], 33, 133, 159, 145);
    const rightEye = getEyeRatio(landmarks, [473, 474, 475, 476, 477], 362, 263, 386, 374);

    if (!leftEye || !rightEye) {
        updateEyeTrackingStatus("Face detected · adjusting eye landmarks");
        return;
    }

    // Vertical iris offset measured against the eye-corner line in eye-width units
    // (steadier than the eyelid gap, which changes with every blink).
    const offsetY = (iris, a, b) => {
        const w = Math.hypot(b.x - a.x, b.y - a.y) || 1e-6;
        return (iris.y - (a.y + b.y) / 2) / w;
    };
    const irisL = averageLandmark(landmarks, [468, 469, 470, 471, 472]);
    const irisR = averageLandmark(landmarks, [473, 474, 475, 476, 477]);
    const nose = landmarks[1];
    const forehead = landmarks[10];
    const chin = landmarks[152];
    const faceHeight = Math.hypot(chin.x - forehead.x, chin.y - forehead.y) || 1e-6;

    // Normalised iris positions inside each eye + head position. These are not screen coordinates.
    window.neuroVisionEyeLandmarkSample = {
        leftEye,
        rightEye,
        normalizedIrisX: (leftEye.x + rightEye.x) / 2,
        normalizedIrisY: (leftEye.y + rightEye.y) / 2,
        irisOffsetY: (offsetY(irisL, landmarks[33], landmarks[133]) + offsetY(irisR, landmarks[362], landmarks[263])) / 2,
        headX: nose.x,
        headY: nose.y,
        faceScale: faceHeight,
        capturedAt: Date.now()
    };

    updateEyeTrackingStatus("Face detected · iris landmarks captured");
    updateGazeMappingTest(window.neuroVisionEyeLandmarkSample);
}

async function initializeFaceMesh() {
    if (faceMesh) return faceMesh;
    if (faceMeshInitialization) return faceMeshInitialization;

    faceMeshInitialization = (async () => {
        if (typeof window.FaceMesh !== "function") {
            throw new Error("MediaPipe FaceMesh library is not available.");
        }

        const tracker = new window.FaceMesh({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
        });

        tracker.setOptions({
            maxNumFaces: 1,
            refineLandmarks: true,
            minDetectionConfidence: 0.6,
            minTrackingConfidence: 0.6
        });
        tracker.onResults(handleFaceMeshResults);
        await tracker.initialize();
        faceMesh = tracker;
        return faceMesh;
    })();

    try {
        return await faceMeshInitialization;
    } finally {
        faceMeshInitialization = null;
    }
}

function startFaceMeshTracking() {
    if (!faceMesh || faceMeshTrackingActive) return;
    faceMeshTrackingActive = true;
    lastFaceMeshVideoTime = -1;
    updateEyeTrackingStatus("Starting face and iris landmark detection…");
    processFaceMeshFrame();
}

async function processFaceMeshFrame() {
    if (!faceMeshTrackingActive) return;

    const video = $("#cameraVideo");
    if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime !== lastFaceMeshVideoTime) {
        lastFaceMeshVideoTime = video.currentTime;
        try {
            await faceMesh.send({ image: video });
        } catch (error) {
            console.error("MediaPipe frame processing failed:", error);
            updateEyeTrackingStatus("Eye landmark processing error");
        }
    }

    if (faceMeshTrackingActive) {
        faceMeshFrameRequest = requestAnimationFrame(processFaceMeshFrame);
    }
}

function stopFaceMeshTracking() {
    faceMeshTrackingActive = false;
    if (faceMeshFrameRequest !== null) {
        cancelAnimationFrame(faceMeshFrameRequest);
        faceMeshFrameRequest = null;
    }
}

function checkVisionLibraries() {
    const mediapipeAvailable = typeof window.FaceMesh !== "undefined";
    const opencvAvailable = typeof window.cv !== "undefined";

    console.info("MediaPipe FaceMesh library loaded:", mediapipeAvailable);
    console.info("OpenCV.js library loaded:", opencvAvailable);
    updateEyeTrackingStatus(mediapipeAvailable
        ? "MediaPipe loaded · enable the camera to begin landmark detection"
        : "Waiting for MediaPipe library…");
}

/* ---------- Nine-point eye-to-screen calibration ----------
   The calibration runs in a FULL-WINDOW overlay and every target is placed at a
   percentage of the browser window. The mapping therefore produces gaze
   positions as fractions of the window - the same frame used later to find the
   word under the gaze. (Previously the dots were inside a small box while the
   reading analysis assumed the whole window, so gaze and words never lined up.)
------------------------------------------------------------------------- */

const calibrationPoints = [
    [9, 12], [50, 12], [91, 12],
    [9, 50], [50, 50], [91, 50],
    [9, 88], [50, 88], [91, 88]
];
const CALIBRATION_SETTLE_MS = 650;     // time for the eyes to reach the new dot
const CALIBRATION_CAPTURE_MS = 1100;   // time over which iris samples are collected

let calibrationIndex = 0;
let calibrationSamples = [];
let calibrationCaptureTimer = null;
let calibrationPhaseTimer = null;
let gazeMappingTestActive = false;
let gazeEstimateHistory = [];
let smoothedGazeEstimate = null;
let lastGazeSampleAt = 0;
let readingGazeCaptureActive = false;
let readingGazeSamples = [];

let calibrationHome = null;

function openCalibrationOverlay(message) {
    const screen = $("#calibrationScreen");
    // Move the box to <body> so that it covers exactly the browser window. Inside the page layout
    // an ancestor can clip or offset a fixed element, which hid the right-hand dots.
    if (!calibrationHome) {
        calibrationHome = { parent: screen.parentNode, next: screen.nextSibling };
        document.body.appendChild(screen);
    }
    screen.classList.add("fullscreen");
    document.body.classList.add("calibration-open");
    calibrationOverlayOpen = true;
    $("#calibrationOverlayUi").classList.remove("hidden");
    setCalibrationOverlayText(message);
}

function closeCalibrationOverlay(silent) {
    const screen = $("#calibrationScreen");
    if (!screen) return;
    screen.classList.remove("fullscreen");
    if (calibrationHome) {
        calibrationHome.parent.insertBefore(screen, calibrationHome.next);
        calibrationHome = null;
    }
    document.body.classList.remove("calibration-open");
    calibrationOverlayOpen = false;
    $("#calibrationOverlayUi").classList.add("hidden");
    if (!silent) window.scrollTo({ top: 0 });
}

function setCalibrationOverlayText(text) {
    const el = $("#calibrationOverlayText");
    if (el) el.textContent = text;
}

function cancelCalibrationOrTest() {
    if (!calibrationOverlayOpen) return;
    const wasTesting = gazeMappingTestActive;
    stopCalibrationTimers();
    stopGazeMappingTest();
    closeCalibrationOverlay();
    $("#calibrationButton").disabled = false;
    if (wasTesting) {
        $("#calibrationMessage").textContent = "Gaze test closed. Continue to the reading step when you are ready.";
    } else {
        $("#calibrationButton").textContent = "Start calibration";
        $("#calibrationMessage").textContent = "Calibration was cancelled. Press start to try again.";
    }
}

$("#calibrationOverlayClose").addEventListener("click", cancelCalibrationOrTest);
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") cancelCalibrationOrTest();
});

/* Features used by the gaze mapping:
   [iris x in eye, iris vertical offset (eye-width units), head x, head y].
   The head position terms let the mapping tolerate small head movements. */
function getCalibrationFeatures(sample) {
    return [sample.normalizedIrisX, sample.irisOffsetY, sample.headX, sample.headY];
}

function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/* ----- Word positions (used to tag every gaze sample with the word under the gaze) ----- */

function refreshWordRects() {
    readingWordRects = $$(".reading-word").map((element, position) => {
        const rect = element.getBoundingClientRect();
        const index = Number(element.dataset.index);
        return {
            index: Number.isFinite(index) ? index : position,
            left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom
        };
    });
}

function wordIndexAtGaze(normX, normY) {
    if (!readingWordRects.length) return -1;
    const px = normX * window.innerWidth;
    const py = normY * window.innerHeight;
    let best = -1;
    let bestDistance = Infinity;
    for (const rect of readingWordRects) {
        const dx = Math.max(rect.left - px, 0, px - rect.right);
        const dy = Math.max(rect.top - py, 0, py - rect.bottom);
        const distance = Math.hypot(dx, dy);
        if (distance < bestDistance) { bestDistance = distance; best = rect.index; }
    }
    // Webcam gaze is imprecise, so the nearest word within a tolerance is used.
    return bestDistance <= WORD_SNAP_PX ? best : -1;
}

window.addEventListener("scroll", () => { if (readingGazeCaptureActive) refreshWordRects(); }, { passive: true });
window.addEventListener("resize", () => { if (readingGazeCaptureActive) refreshWordRects(); });

function updateGazeCaptureStatus() {
    const el = $("#gazeCaptureStatus");
    if (!el) return;
    const ready = Boolean(window.neuroVisionCalibration && cameraStream && faceMeshTrackingActive);
    el.classList.toggle("ok", ready);
    if (readingSessionActive && readingGazeCaptureActive) {
        el.textContent = `Eye tracking: recording · ${readingGazeSamples.length} gaze samples`;
    } else if (ready) {
        el.textContent = "Eye tracking: calibrated and ready";
    } else if (!cameraStream) {
        el.textContent = "Eye tracking: camera is off (go back to step 2)";
    } else if (!window.neuroVisionCalibration) {
        el.textContent = "Eye tracking: not calibrated (go back to step 3)";
    } else {
        el.textContent = "Eye tracking: waiting for face detection";
    }
}

function updateGazeMappingTest(sample) {
    const cursor = $("#gazeCursor");

    // Gaze is calculated whenever a calibration and a valid sample exist.
    if (!window.neuroVisionCalibration || !sample) return;

    const mapping = window.neuroVisionCalibration;
    const raw4 = getCalibrationFeatures(sample);
    if (!raw4.every(Number.isFinite)) return;
    const z = raw4.map((v, i) => (v - mapping.mean[i]) / mapping.scale[i]);
    const estimateX = mapping.x0 + mapping.x.reduce((sum, c, i) => sum + c * z[i], 0);
    const estimateY = mapping.y0 + mapping.y.reduce((sum, c, i) => sum + c * z[i], 0);

    const raw = {
        x: Math.max(0, Math.min(1, estimateX)),
        y: Math.max(0, Math.min(1, estimateY))
    };

    const sampleTime = Number(sample.capturedAt) || Date.now();

    // Reset smoothing history if tracking was interrupted.
    if (lastGazeSampleAt && sampleTime - lastGazeSampleAt > 500) {
        gazeEstimateHistory = [];
        smoothedGazeEstimate = null;
    }
    lastGazeSampleAt = sampleTime;

    // 7-frame median filter against landmark jumps.
    gazeEstimateHistory.push(raw);
    if (gazeEstimateHistory.length > 7) gazeEstimateHistory.shift();

    const robust = {
        x: median(gazeEstimateHistory.map((p) => p.x)),
        y: median(gazeEstimateHistory.map((p) => p.y))
    };

    // Adaptive smoothing: strong for tiny jitter, light for real eye movements.
    const deadZone = 0.003;
    if (!smoothedGazeEstimate) {
        smoothedGazeEstimate = { ...robust };
    } else {
        const deltaX = robust.x - smoothedGazeEstimate.x;
        const deltaY = robust.y - smoothedGazeEstimate.y;
        const movement = Math.hypot(deltaX, deltaY);
        const factor = movement > 0.06 ? 0.55 : movement > 0.025 ? 0.35 : 0.18;
        smoothedGazeEstimate = {
            x: Math.abs(deltaX) < deadZone ? smoothedGazeEstimate.x : smoothedGazeEstimate.x + factor * deltaX,
            y: Math.abs(deltaY) < deadZone ? smoothedGazeEstimate.y : smoothedGazeEstimate.y + factor * deltaY
        };
    }

    // Green cursor during the gaze-mapping test.
    if (gazeMappingTestActive && cursor) {
        cursor.style.left = `${smoothedGazeEstimate.x * 100}%`;
        cursor.style.top = `${smoothedGazeEstimate.y * 100}%`;
        cursor.style.opacity = "1";
    }

    window.neuroVisionGazeEstimate = {
        x: smoothedGazeEstimate.x, y: smoothedGazeEstimate.y, capturedAt: sampleTime, experimental: true
    };

    // Collect samples only while a reading session is active.
    // Sample = [ms since reading start, x, y, word index under gaze (-1 = none)]
    if (readingGazeCaptureActive) {
        readingGazeSamples.push([
            sampleTime - readingCaptureOrigin,
            Number(smoothedGazeEstimate.x.toFixed(4)),
            Number(smoothedGazeEstimate.y.toFixed(4)),
            wordIndexAtGaze(smoothedGazeEstimate.x, smoothedGazeEstimate.y)
        ]);
        if (readingGazeSamples.length > 40000) readingGazeSamples.shift();
    }
}

function stopGazeMappingTest() {
    gazeMappingTestActive = false;
    const cursor = $("#gazeCursor");
    const button = $("#gazeTestButton");
    if (cursor) cursor.style.opacity = "0";
    if (button) button.textContent = "Test gaze mapping";
    gazeEstimateHistory = [];
    smoothedGazeEstimate = null;
    lastGazeSampleAt = 0;
}

function moveCalibrationTarget() {
    const target = $("#calibrationTarget");
    const point = calibrationPoints[calibrationIndex];
    target.style.left = `${point[0]}%`;
    target.style.top = `${point[1]}%`;
    $("#calibrationCount").textContent = `${calibrationIndex + 1} / 9`;
    $("#calibrationProgress").style.width = `${(calibrationIndex / calibrationPoints.length) * 100}%`;
    setCalibrationOverlayText(`Look at the dot · point ${calibrationIndex + 1} of 9`);
}

function solveLinearSystem(matrix, vector) {
    const size = vector.length;
    const rows = matrix.map((row, index) => [...row, vector[index]]);

    for (let column = 0; column < size; column += 1) {
        let pivot = column;
        for (let row = column + 1; row < size; row += 1) {
            if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
        }
        if (Math.abs(rows[pivot][column]) < 1e-10) {
            throw new Error("Calibration samples do not provide enough variation. Please try again.");
        }
        [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
        const divisor = rows[column][column];
        for (let j = column; j <= size; j += 1) rows[column][j] /= divisor;
        for (let row = 0; row < size; row += 1) {
            if (row === column) continue;
            const factor = rows[row][column];
            for (let j = column; j <= size; j += 1) rows[row][j] -= factor * rows[column][j];
        }
    }
    return rows.map((row) => row[size]);
}

function fitCalibration(samples) {
    // samples: one entry per captured frame: {f:[4 features], screenX, screenY, point}
    const points = new Set(samples.map((x) => x.point));
    if (points.size < 9 || samples.length < 45) throw new Error("Not enough calibration points were captured.");

    const n = samples.length;
    const mean = [0, 1, 2, 3].map((k) => samples.reduce((a, x) => a + x.f[k], 0) / n);
    const scale = [0, 1, 2, 3].map((k) => Math.sqrt(samples.reduce((a, x) => a + (x.f[k] - mean[k]) ** 2, 0) / n) || 1e-6);

    const irisXRange = Math.max(...samples.map((x) => x.f[0])) - Math.min(...samples.map((x) => x.f[0]));
    const irisYRange = Math.max(...samples.map((x) => x.f[1])) - Math.min(...samples.map((x) => x.f[1]));
    if (irisXRange < 0.02) throw new Error("Horizontal eye movement was too small to calibrate. Look directly at each dot and try again.");
    if (irisYRange < 0.004) throw new Error("Vertical eye movement was too small to calibrate. Look directly at each dot and try again.");

    const x0 = samples.reduce((a, x) => a + x.screenX, 0) / n;
    const y0 = samples.reduce((a, x) => a + x.screenY, 0) / n;
    const K = 4;
    const normal = Array.from({ length: K }, () => Array(K).fill(0));
    const tx = Array(K).fill(0);
    const ty = Array(K).fill(0);
    samples.forEach((smp) => {
        const z = smp.f.map((v, i) => (v - mean[i]) / scale[i]);
        for (let i = 0; i < K; i += 1) {
            tx[i] += z[i] * (smp.screenX - x0);
            ty[i] += z[i] * (smp.screenY - y0);
            for (let j = 0; j < K; j += 1) normal[i][j] += z[i] * z[j];
        }
    });
    // Ridge penalty: larger on the head-position terms so they only correct, never dominate.
    const ridge = [0.02 * n, 0.02 * n, 0.5 * n, 0.5 * n];
    for (let i = 0; i < K; i += 1) normal[i][i] += ridge[i];
    const x = solveLinearSystem(normal, tx);
    const y = solveLinearSystem(normal, ty);

    let err = 0;
    samples.forEach((smp) => {
        const z = smp.f.map((v, i) => (v - mean[i]) / scale[i]);
        const px = x0 + x.reduce((a, c, i) => a + c * z[i], 0);
        const py = y0 + y.reduce((a, c, i) => a + c * z[i], 0);
        err += Math.hypot(px - smp.screenX, py - smp.screenY);
    });

    return {
        x, y, x0, y0, mean, scale,
        pointCount: points.size,
        sampleCount: n,
        model: "ridge-affine-4",
        frame: "browser window (fraction of width/height)",
        meanCalibrationError: err / n,
        calibratedAt: new Date().toISOString()
    };
}

function stopCalibrationTimers() {
    if (calibrationCaptureTimer) clearInterval(calibrationCaptureTimer);
    if (calibrationPhaseTimer) clearTimeout(calibrationPhaseTimer);
    calibrationCaptureTimer = null;
    calibrationPhaseTimer = null;
    if (calibrationTimer) clearInterval(calibrationTimer);
    calibrationTimer = null;
}

function finishCalibration() {
    stopCalibrationTimers();
    try {
        window.neuroVisionCalibration = fitCalibration(calibrationSamples);
        $("#calibrationCount").textContent = "9 / 9";
        $("#calibrationProgress").style.width = "100%";
        const fitError = window.neuroVisionCalibration.meanCalibrationError;
        const quality = fitError < 0.08 ? "good" : fitError < 0.15 ? "acceptable" : "poor - consider calibrating again";
        $("#calibrationMessage").textContent =
            `Calibration complete from 9 points. Fit error: ${(fitError * 100).toFixed(1)}% of the window (${quality}). ` +
            `Use “Test gaze mapping” to check the corners and centre, then continue.`;
        $("#calibrationButton").disabled = false;
        $("#calibrationButton").textContent = "Calibrate again";
        $("#gazeTestButton").disabled = false;
        showToast("Calibration captured. Test the gaze mapping before reading.");
        console.info("Neuro Vision calibration mapping:", window.neuroVisionCalibration);
    } catch (error) {
        window.neuroVisionCalibration = null;
        $("#gazeTestButton").disabled = true;
        stopGazeMappingTest();
        $("#calibrationMessage").textContent = `${error.message} Please run calibration again with your face centred.`;
        $("#calibrationButton").disabled = false;
        $("#calibrationButton").textContent = "Try calibration again";
    }
    closeCalibrationOverlay();
    updateGazeCaptureStatus();
}

function failCalibration(message) {
    stopCalibrationTimers();
    closeCalibrationOverlay();
    $("#calibrationMessage").textContent = message;
    $("#calibrationButton").disabled = false;
    $("#calibrationButton").textContent = "Try calibration again";
}

function captureCalibrationPoint() {
    const frames = [];
    const captureStart = Date.now();
    $("#calibrationMessage").textContent = `Point ${calibrationIndex + 1} of 9: keep looking at the dot…`;

    calibrationCaptureTimer = setInterval(() => {
        const elapsed = Date.now() - captureStart;
        const sample = window.neuroVisionEyeLandmarkSample;
        // Ignore the first moments: the eyes are still travelling to the new dot.
        if (elapsed >= CALIBRATION_SETTLE_MS && sample && Date.now() - sample.capturedAt < 350) {
            const f = getCalibrationFeatures(sample);
            if (f.every(Number.isFinite)) frames.push(f);
        }
        if (elapsed >= CALIBRATION_SETTLE_MS + CALIBRATION_CAPTURE_MS) {
            clearInterval(calibrationCaptureTimer);
            calibrationCaptureTimer = null;
            if (frames.length < 6) {
                failCalibration("Eye landmarks were not stable enough to capture this point. Check lighting and keep your whole face in view, then try again.");
                return;
            }
            // The dot's REAL on-screen centre is measured, so mapping is correct whatever the layout.
            const rect = $("#calibrationTarget").getBoundingClientRect();
            const screenX = (rect.left + rect.width / 2) / window.innerWidth;
            const screenY = (rect.top + rect.height / 2) / window.innerHeight;
            // Drop frames far from the median (blinks, landmark jumps).
            const med = [0, 1, 2, 3].map((k) => median(frames.map((fr) => fr[k])));
            const mad = [0, 1, 2, 3].map((k) => median(frames.map((fr) => Math.abs(fr[k] - med[k]))) || 1e-6);
            frames.filter((fr) => fr.every((v, k) => Math.abs(v - med[k]) <= 4 * mad[k] + 1e-6))
                  .forEach((fr) => calibrationSamples.push({ f: fr, screenX, screenY, point: calibrationIndex }));
            calibrationIndex += 1;
            $("#calibrationProgress").style.width = `${(calibrationIndex / calibrationPoints.length) * 100}%`;
            if (calibrationIndex >= calibrationPoints.length) {
                finishCalibration();
            } else {
                moveCalibrationTarget();
                calibrationPhaseTimer = setTimeout(captureCalibrationPoint, 50);
            }
        }
    }, 50);
}

function startCalibration() {
    stopCalibrationTimers();
    if (!cameraStream || !faceMeshTrackingActive) {
        $("#calibrationMessage").textContent = "Please turn on the camera (step 2) and wait until iris landmarks are detected before starting.";
        showToast("Enable the camera before calibration.");
        return;
    }
    if (!window.neuroVisionEyeLandmarkSample || Date.now() - window.neuroVisionEyeLandmarkSample.capturedAt > 500) {
        $("#calibrationMessage").textContent = "Waiting for a fresh eye-landmark sample. Keep your face visible to the camera.";
        return;
    }

    calibrationIndex = 0;
    calibrationSamples = [];
    stopGazeMappingTest();
    $("#gazeTestButton").disabled = true;
    window.neuroVisionCalibration = null;
    $("#calibrationButton").disabled = true;
    $("#calibrationButton").textContent = "Calibrating…";
    $("#calibrationMessage").textContent = "Look at each dot as it appears. Keep your head comfortably still and blink normally.";
    openCalibrationOverlay("Get ready · look at each dot");
    moveCalibrationTarget();
    calibrationPhaseTimer = setTimeout(captureCalibrationPoint, 600);
}

$("#calibrationButton").addEventListener("click", startCalibration);
$("#gazeTestButton").addEventListener("click", () => {
    if (!window.neuroVisionCalibration) {
        showToast("Complete nine-point calibration first.");
        return;
    }
    if (gazeMappingTestActive) {
        cancelCalibrationOrTest();
        return;
    }
    gazeMappingTestActive = true;
    $("#gazeTestButton").textContent = "Stop gaze test";
    openCalibrationOverlay("Gaze test · the green marker shows where you are looking");
    $("#calibrationTarget").style.left = "50%";
    $("#calibrationTarget").style.top = "50%";
    updateGazeMappingTest(window.neuroVisionEyeLandmarkSample);
});


/* ---------- Age-based reading passage and speech-to-text ---------- */

function loadPassage() {
    let passage = passages.middle;
    let level = "AGE 8–10 · MODERATE";

    if (participant.age <= 7) {
        passage = passages.young;
        level = "AGE 5–7 · SIMPLE";
    } else if (participant.age >= 11) {
        passage = passages.older;
        level = "AGE 11–12 · ADVANCED";
    }

    $("#passageLevel").textContent = level;
    renderPassage(passage);
}

function renderPassage(text) {
    currentPassageText = text;
    const words = text.split(/\s+/);

    $("#readingPassage").innerHTML = words.map((word, index) => {
        const safeWord = escapeHTML(word);
        return `<span class="reading-word unmatched" data-index="${index}" data-word="${safeWord.toLowerCase().replace(/[.,!?;:]/g, "")}">${safeWord}</span>`;
    }).join(" ");
}

function getPassageWords() {
    return $$(".reading-word").map((el) => el.textContent);
}

/* Order-aware matching of the transcript against the passage:
   green = matched, yellow = close match (needs review), red = not matched. */
function updateWordMatches(transcript) {
    const spoken = NVAnalysis.tokenize(transcript);
    const passageWords = $$(".reading-word");
    const status = NVAnalysis.alignSpeech(spoken, passageWords.map((el) => NVAnalysis.normalizeWord(el.textContent)));

    passageWords.forEach((element, index) => {
        element.classList.remove("matched", "unmatched", "review");
        element.classList.add(status[index] === "matched" ? "matched" : status[index] === "near" ? "review" : "unmatched");
    });

    $("#transcriptText").textContent = transcript || "No recognised words yet.";
}

function resolveSpeechEndWaiters() {
    const waiters = speechEndWaiters;
    speechEndWaiters = [];
    waiters.forEach((resolve) => resolve());
}

/* A reading session = timer + gaze capture + (when supported) speech recognition. */
function beginReadingSession() {
    speechTranscript = "";
    readingGazeSamples = [];
    readingDurationMs = 0;
    readingDurationSeconds = 0;
    renderPassage(currentPassageText || passages.middle);
    $("#transcriptText").textContent = "No recognised words yet.";

    readingSessionActive = true;
    readingStartedAt = Date.now();
    readingCaptureOrigin = readingStartedAt;

    // Gaze capture needs calibration, camera, active FaceMesh tracking and a fresh iris sample.
    const eyeSample = window.neuroVisionEyeLandmarkSample;
    const fresh = Boolean(eyeSample && Date.now() - eyeSample.capturedAt < 500);
    readingGazeCaptureActive = Boolean(window.neuroVisionCalibration && cameraStream && faceMeshTrackingActive && fresh);
    if (!readingGazeCaptureActive) {
        showToast("Eye-movement capture is OFF: it needs the camera, a completed calibration and a visible face.");
    }

    $("#readingPassage").scrollIntoView({ block: "center", behavior: "auto" });
    refreshWordRects();
    clearInterval(readingRectTimer);
    readingRectTimer = setInterval(() => { if (readingGazeCaptureActive) { refreshWordRects(); updateGazeCaptureStatus(); } }, 1000);

    $("#startSpeech").disabled = true;
    $("#stopSpeech").disabled = false;
    startReadingTimer();
    updateGazeCaptureStatus();
}

function endReadingSession() {
    if (readingStartedAt) {
        readingDurationMs += Math.max(0, Date.now() - readingStartedAt);
        readingDurationSeconds = Math.round(readingDurationMs / 100) / 10;
        readingStartedAt = null;
    }
    readingSessionActive = false;
    readingGazeCaptureActive = false;
    clearInterval(readingRectTimer);
    readingRectTimer = null;
    stopReadingTimer();
    $("#startSpeech").disabled = false;
    $("#stopSpeech").disabled = true;
    updateGazeCaptureStatus();
}

function launchSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    speechRecognition = recognition;
    recognition.lang = "en-IN";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => {
        $("#speechStatus").textContent = "Listening…";
    };

    recognition.onresult = (event) => {
        let finalText = "";
        let interimText = "";
        for (let index = event.resultIndex; index < event.results.length; index++) {
            const result = event.results[index];
            if (result.isFinal) finalText += result[0].transcript + " ";
            else interimText += result[0].transcript;
        }
        speechTranscript += finalText;
        updateWordMatches(`${speechTranscript} ${interimText}`.trim());
    };

    recognition.onerror = (event) => {
        if (event.error === "no-speech" || event.error === "aborted") return;   // normal pauses
        $("#speechStatus").textContent = `Recognition issue: ${event.error}`;
    };

    recognition.onend = () => {
        if (speechRecognition === recognition) speechRecognition = null;
        // Browsers end recognition after a silence. While the reader has not pressed
        // "Stop reading", listen again so reading time and gaze capture are not cut short.
        if (readingSessionActive && !speechStopRequested) {
            setTimeout(() => {
                if (readingSessionActive && !speechStopRequested && !speechRecognition) {
                    try { launchSpeechRecognition(); } catch (error) { console.warn("Could not restart recognition:", error); }
                }
            }, 150);
            return;
        }
        resolveSpeechEndWaiters();
    };

    recognition.start();
}

function startSpeechRecognition() {
    if (readingSessionActive) return;
    speechStopRequested = false;
    beginReadingSession();

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        $("#speechStatus").textContent = "Speech recognition is not supported in this browser — recording eye movements only.";
        showToast("Speech recognition needs a browser such as Chrome. Skipped words will be judged from gaze only.");
        return;
    }

    try {
        launchSpeechRecognition();
    } catch (error) {
        console.error(error);
        $("#speechStatus").textContent = "Speech recognition could not start — recording eye movements only.";
    }
}

function stopSpeechRecognition() {
    speechStopRequested = true;
    if (readingSessionActive) endReadingSession();

    if (speechRecognition) {
        const active = speechRecognition;
        speechRecognition = null;
        try { active.stop(); } catch (error) { /* already stopped */ }
    } else {
        resolveSpeechEndWaiters();
    }
    if ($("#speechStatus") && $("#speechStatus").textContent.startsWith("Listening")) {
        $("#speechStatus").textContent = "Reading stopped.";
    }
}

/* Stop and wait (max 1.5 s) for the browser to deliver the last recognised words. */
function stopSpeechAndWait() {
    const waiting = new Promise((resolve) => {
        speechEndWaiters.push(resolve);
        setTimeout(resolve, 1500);
    });
    const hadRecognition = Boolean(speechRecognition);
    stopSpeechRecognition();
    return hadRecognition ? waiting : Promise.resolve();
}

function startReadingTimer() {
    stopReadingTimer();
    readingTimerInterval = setInterval(() => {
        if (!readingStartedAt) return;
        const seconds = Math.floor((Date.now() - readingStartedAt) / 1000);
        const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
        const remainder = String(seconds % 60).padStart(2, "0");
        $("#readingTimer").textContent = `${minutes}:${remainder}`;
    }, 500);
}

function stopReadingTimer() {
    clearInterval(readingTimerInterval);
    readingTimerInterval = null;
}

$("#startSpeech").addEventListener("click", startSpeechRecognition);
$("#stopSpeech").addEventListener("click", stopSpeechRecognition);

function formatDuration(totalSeconds) {
    const whole = Math.round(Number(totalSeconds) || 0);
    const minutes = String(Math.floor(whole / 60)).padStart(2, "0");
    const seconds = String(whole % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
}

function countWords(text) {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/* ---------- Finish: analyse -> FastAPI (predict + MySQL) -> local record ---------- */

function buildCompactAnalysis(analysis) {
    return {
        wordsSkipped: analysis.wordsSkipped,
        skipBasis: analysis.skipBasis,
        crossCheck: analysis.crossCheck,
        wordStats: analysis.wordStats.map((w) => ({
            i: w.index, w: w.word, n: w.fixations, t: Math.round(w.totalMs), f: Math.round(w.firstPassMs),
            p: Math.round(w.pathMs), s: w.speechStatus, c: w.category
        })),
        fixations: analysis.fixations.map((f) => ({ o: f.order, w: f.word, d: Math.round(f.duration), s: Math.round(f.start) })),
        forwardSaccades: analysis.forwardSaccades,
        backwardSaccades: analysis.backwardSaccades,
        quality: analysis.quality
    };
}

async function saveCompletedAssessment() {
    if (!participant.name || !participant.age || !participant.gender) {
        showToast("Complete participant details before finishing the assessment.");
        setAssessmentStep(1);
        return null;
    }

    const passageWords = getPassageWords();
    const samples = readingGazeSamples.slice();
    const transcript = speechTranscript.trim();
    const levelLabel = $("#passageLevel").textContent;

    const session = {
        id: `NV-${Date.now()}`,
        participantName: participant.name,
        age: participant.age,
        gender: participant.gender,
        date: new Date().toISOString(),
        readingDurationSeconds,
        transcript,
        wordCount: NVAnalysis.tokenize(transcript).length,
        passageText: currentPassageText,
        passageLevel: levelLabel,
        calibrationError: window.neuroVisionCalibration ? window.neuroVisionCalibration.meanCalibrationError : null,
        gazeSamples: samples,
        features: null,
        analysis: null,
        modelPrediction: null,
        modelPredictionStatus: "no_data",
        dbSaved: false,
        dbIds: null,
        dbError: null
    };

    try {
        const analysis = NVAnalysis.analyse({
            samples,
            passageWords,
            transcript,
            viewport: { width: window.innerWidth, height: window.innerHeight }
        });
        session.features = analysis.features;
        session.analysis = buildCompactAnalysis(analysis);
        window.neuroVisionEyeFeatures = analysis.features;
        console.table(analysis.features);

        if (!hasAllModelFeatures(analysis.features)) throw new Error("Feature extraction did not produce all 12 numeric values.");

        const response = await postAssessmentToBackend(buildBackendPayload(session));

        session.modelPrediction = {
            predicted_label: response.predicted_label,
            risk_probability: response.risk_probability,
            risk_percentage: response.risk_percentage,
            risk_level: response.risk_level,
            tree_votes_dyslexic: response.tree_votes_dyslexic,
            tree_count: response.tree_count,
            svm_prediction: response.svm_prediction,
            feature_analysis: response.feature_analysis,
            features_outside_training_range: response.features_outside_training_range
        };
        session.modelPredictionStatus = "completed";
        session.dbSaved = Boolean(response.saved);
        session.dbIds = response.db_ids;
        session.dbError = response.db_error;
        backendOnline = true;
    } catch (error) {
        console.error("Neuro Vision analysis/prediction error:", error);
        session.modelPredictionStatus = session.features ? "api_error" : "analysis_error";
        session.modelPredictionError = error.message;
        if (/reach the backend/i.test(error.message)) backendOnline = false;
    }

    assessmentRecords = loadAssessmentRecords();
    assessmentRecords.unshift(session);
    saveAssessmentRecords();
    selectedReportId = session.id;
    lastCompletedSessionId = session.id;
    window.neuroVisionEyeFeatures = null;     // never reuse features for the next participant
    return session;
}

let lastCompletedSessionId = null;

/* One place that builds the request for POST /api/assessments (used when finishing and when retrying). */
function buildBackendPayload(session) {
    const cross = (session.analysis && session.analysis.crossCheck) || { read: 0, spoken: 0, gazed: 0, skipped: 0 };
    const totalWords = (session.passageText || "").split(/\s+/).filter(Boolean).length;
    return {
        session_id: session.id,
        account_email: currentEmail,
        participant: { name: session.participantName, age: session.age, gender: session.gender, guardian_consent: true },
        assessment: {
            assessed_at: session.date,
            reading_duration_seconds: session.readingDurationSeconds,
            transcript: session.transcript,
            passage_level: session.passageLevel,
            passage_text: session.passageText,
            total_words: totalWords,
            words_spoken_matched: cross.read + cross.spoken,
            words_skipped: session.analysis ? session.analysis.wordsSkipped : null,
            word_count: session.wordCount,
            gaze_sample_count: (session.gazeSamples || []).length,
            fixation_total: session.analysis ? session.analysis.quality.fixationsOnWords : null,
            calibration_error: session.calibrationError
        },
        features: Object.fromEntries(MODEL_FEATURE_NAMES.map((n) => [n, Number(session.features[n])])),
        gaze_samples: session.gazeSamples || []
    };
}

function releaseAllDevices() {
    stopSpeechRecognition();
    stopCamera();
    stopMicrophone();
    closeCalibrationOverlay(true);
    stopGazeMappingTest();
}

$("#finishAssessment").addEventListener("click", async () => {
    await stopSpeechAndWait();
    // Camera and microphone are no longer needed once reading has stopped. The captured data is
    // already in memory, so switch both OFF right now (before the analysis/saving starts).
    const snapshotSamples = readingGazeSamples.slice();
    releaseAllDevices();
    readingGazeSamples = snapshotSamples;

    const finishButton = $("#finishAssessment");
    finishButton.disabled = true;
    const originalText = finishButton.textContent;
    finishButton.textContent = "Analysing & saving…";

    try {
        const session = await saveCompletedAssessment();
        if (!session) return;
        setAssessmentStep(5);
        loadBackendRecords();    // refresh history/dashboard from MySQL

        if (session.modelPredictionStatus !== "completed") showToast("Your session was recorded. The result will appear in the report as soon as the analysis service responds.");
    } finally {
        finishButton.disabled = false;
        finishButton.textContent = originalText;
    }
});

