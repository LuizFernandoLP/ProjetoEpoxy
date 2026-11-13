
const video = document.querySelector("#camera");
const canvas = document.querySelector("#overlay");
const ctx = canvas.getContext("2d");
const startBtn = document.querySelector("#startCamera");
const autoBtn = document.querySelector("#autoDetect");
const stopBtn = document.querySelector("#stopTracking");
const setBtn = document.querySelector("#setFloor");
const clearBtn = document.querySelector("#clearFloor");
const statusEl = document.querySelector("#status");
const emptyEl = document.querySelector("#empty");
const counter = document.querySelector("#counter");
const presetSelect = document.querySelector("#preset");
const fileInput = document.querySelector("#textureFile");
const strength = document.querySelector("#strength");
const gloss = document.querySelector("#gloss");
const scale = document.querySelector("#scale");

let stream = null;
let selecting = false;
let corners = [];

let texture = makeTexture("silver");
let textureName = "silver";
let textureTile = null;
let textureTileScale = null;
let textureTileSource = null;

let segmenter = null;
let segmenterPromise = null;
let modelLoading = false;

let trackingEnabled = false;
let inferenceBusy = false;
let trackingTimer = null;
let trackingGeneration = 0;

let inferenceCanvas = document.createElement("canvas");
let inferenceCtx = inferenceCanvas.getContext("2d", {
  willReadFrequently: true
});

let autoQuad = null;
let floorMaskCanvas = null;
let lastDetection = 0;

function setStatus(message) {
  statusEl.textContent = message;
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (trackingEnabled && floorMaskCanvas) {
    render();
  }
}

function makeTexture(kind) {
  const c = document.createElement("canvas");
  c.width = 900;
  c.height = 900;

  const g = c.getContext("2d");

  const palettes = {
    silver: ["#202831", "#aab5c0", "#e6edf2", "#4b5967"],
    black: ["#05070b", "#202a37", "#798493", "#111722"],
    ocean: ["#061d36", "#087b9e", "#5bc4d0", "#102c57"],
    flake: ["#343a42", "#727d87", "#c4cbd0", "#181d24"],
    white: ["#f7f8f8", "#c5d0d8", "#ffffff", "#8b9aa7"]
  };

  const p = palettes[kind] || palettes.silver;

  const grad = g.createLinearGradient(0, 0, 900, 900);

  p.forEach((color, i) => {
    grad.addColorStop(i / (p.length - 1), color);
  });

  g.fillStyle = grad;
  g.fillRect(0, 0, 900, 900);

  for (let i = 0; i < 85; i++) {
    const x = Math.random() * 900;
    const y = Math.random() * 900;

    g.beginPath();
    g.moveTo(x, y);

    g.bezierCurveTo(
      x - 120 + Math.random() * 240,
      y + Math.random() * 180,
      x + Math.random() * 260 - 130,
      y + Math.random() * 280 - 140,
      x + Math.random() * 300 - 150,
      y + Math.random() * 360 - 180
    );

    g.strokeStyle = p[Math.floor(Math.random() * p.length)];
    g.globalAlpha = 0.08 + Math.random() * 0.2;
    g.lineWidth = 2 + Math.random() * 18;
    g.stroke();
  }

  if (kind === "flake") {
    for (let i = 0; i < 5000; i++) {
      g.fillStyle = p[Math.floor(Math.random() * p.length)];
      g.globalAlpha = 0.35 + Math.random() * 0.55;

      const x = Math.random() * 900;
      const y = Math.random() * 900;

      g.fillRect(x, y, 1 + Math.random() * 5, 1 + Math.random() * 3);
    }
  }

  g.globalAlpha = 1;

  return c;
}

function setTexture(kind) {
  texture = makeTexture(kind);
  textureName = kind;

  textureTileSource = null;

  document.querySelectorAll(".swatch").forEach(b => {
    b.classList.toggle("selected", b.dataset.preset === kind);
  });

  render();
}

function getTextureTile(s) {
  const tileSize = Math.max(900, Math.round(900 * s));

  if (
    !textureTile ||
    textureTile.width !== tileSize ||
    textureTileSource !== texture ||
    textureTileScale !== s
  ) {
    textureTile = document.createElement("canvas");
    textureTile.width = tileSize;
    textureTile.height = tileSize;

    const tileContext = textureTile.getContext("2d");

    tileContext.clearRect(0, 0, tileSize, tileSize);

    for (let y = 0; y < tileSize; y += texture.height * s) {
      for (let x = 0; x < tileSize; x += texture.width * s) {
        tileContext.drawImage(
          texture,
          x,
          y,
          texture.width * s,
          texture.height * s
        );
      }
    }

    textureTileSource = texture;
    textureTileScale = s;
  }

  return textureTile;
}

function affineTriangle(image, src, dst) {
  const [s0, s1, s2] = src;
  const [d0, d1, d2] = dst;

  const den =
    s0.x * (s1.y - s2.y) +
    s1.x * (s2.y - s0.y) +
    s2.x * (s0.y - s1.y);

  if (Math.abs(den) < 0.001) return;

  const a =
    (d0.x * (s1.y - s2.y) +
      d1.x * (s2.y - s0.y) +
      d2.x * (s0.y - s1.y)) / den;

  const c =
    (d0.x * (s2.x - s1.x) +
      d1.x * (s0.x - s2.x) +
      d2.x * (s1.x - s0.x)) / den;

  const e =
    (d0.x * (s1.x * s2.y - s2.x * s1.y) +
      d1.x * (s2.x * s0.y - s0.x * s2.y) +
      d2.x * (s0.x * s1.y - s1.x * s0.y)) / den;

  const b =
    (d0.y * (s1.y - s2.y) +
      d1.y * (s2.y - s0.y) +
      d2.y * (s0.y - s1.y)) / den;

  const d =
    (d0.y * (s2.x - s1.x) +
      d1.y * (s0.x - s2.x) +
      d2.y * (s1.x - s0.x)) / den;

  const f =
    (d0.y * (s1.x * s2.y - s2.x * s1.y) +
      d1.y * (s2.x * s0.y - s0.x * s2.y) +
      d2.y * (s0.x * s1.y - s1.x * s0.y)) / den;

  ctx.save();

  ctx.beginPath();
  ctx.moveTo(d0.x, d0.y);
  ctx.lineTo(d1.x, d1.y);
  ctx.lineTo(d2.x, d2.y);
  ctx.closePath();
  ctx.clip();

  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(image, 0, 0);

  ctx.restore();
}

// FIXED: The mask is used only to clip the epoxy texture.
// It is never painted white over the camera image.
function drawTextureInQuad(quad, w, h, maskCanvas = null) {
  const strengthValue = Number(strength.value) / 100;
  const s = Number(scale.value) / 100;
  const tile = getTextureTile(s);

  ctx.save();
  ctx.globalAlpha = strengthValue;

  affineTriangle(
    tile,
    [
      { x: 0, y: 0 },
      { x: tile.width, y: 0 },
      { x: tile.width, y: tile.height }
    ],
    [quad[0], quad[1], quad[2]]
  );

  affineTriangle(
    tile,
    [
      { x: 0, y: 0 },
      { x: tile.width, y: tile.height },
      { x: 0, y: tile.height }
    ],
    [quad[0], quad[2], quad[3]]
  );

  ctx.restore();

  if (maskCanvas) {
    ctx.save();
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(maskCanvas, 0, 0, w, h);
    ctx.restore();
  }

  const g = Number(gloss.value) / 100;

  if (g > 0) {
    ctx.save();

    // Only add gloss where the texture already exists.
    ctx.globalCompositeOperation = "source-atop";

    const sheen = ctx.createLinearGradient(0, 0, w, h);

    sheen.addColorStop(0, `rgba(255,255,255,${g * 0.18})`);
    sheen.addColorStop(0.45, "rgba(255,255,255,0)");
    sheen.addColorStop(1, `rgba(255,255,255,${g * 0.28})`);

    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, w, h);

    ctx.restore();
  }
}

function render() {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;

  ctx.clearRect(0, 0, w, h);

  if (trackingEnabled && autoQuad && floorMaskCanvas) {
    drawTextureInQuad(autoQuad, w, h, floorMaskCanvas);
  } else if (corners.length === 4) {
    drawTextureInQuad(corners, w, h);
  }

  if (selecting) {
    ctx.save();

    ctx.strokeStyle = "#8fb0ff";
    ctx.fillStyle = "#8fb0ff";
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);

    if (corners.length) {
      ctx.beginPath();

      corners.forEach((p, i) => {
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      });

      ctx.stroke();
    }

    corners.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#101a2d";
      ctx.font = "12px sans-serif";
      ctx.fillText(String(i + 1), p.x - 3, p.y + 4);

      ctx.fillStyle = "#8fb0ff";
    });

    ctx.restore();
  }

  counter.textContent = trackingEnabled
    ? (lastDetection
        ? `Auto tracking · ${Math.max(0, Math.round((Date.now() - lastDetection) / 1000))}s ago`
        : "Finding floor…")
    : `${corners.length} / 4 corners`;
}

function makeMaskAndQuad(mask) {
  const mw = mask.width;
  const mh = mask.height;
  const data = mask.data;

  if (!mw || !mh || !data || data.length % (mw * mh) !== 0) {
    throw new Error("The segmentation model returned an invalid mask.");
  }

  const channels = data.length / (mw * mh);

  let maxValue = 0;

  for (let i = 0; i < data.length; i++) {
    maxValue = Math.max(maxValue, data[i]);
  }

  const threshold = maxValue <= 1 ? 0.5 : 80;

  const binary = new Uint8ClampedArray(mw * mh * 4);

  let minX = mw;
  let minY = mh;
  let maxX = 0;
  let maxY = 0;
  let count = 0;

  const rowLeft = new Int32Array(mh).fill(mw);
  const rowRight = new Int32Array(mh).fill(-1);
  const rowCount = new Int32Array(mh);

  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const idx = (y * mw + x) * channels;

      const value = channels >= 3
        ? Math.max(data[idx], data[idx + 1], data[idx + 2])
        : data[idx];

      if (value > threshold) {
        const p = (y * mw + x) * 4;

        binary[p] = 255;
        binary[p + 1] = 255;
        binary[p + 2] = 255;
        binary[p + 3] = 255;

        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);

        count++;

        rowLeft[y] = Math.min(rowLeft[y], x);
        rowRight[y] = Math.max(rowRight[y], x);
        rowCount[y]++;
      }
    }
  }

  const ratio = count / (mw * mh);

  if (ratio < 0.035 || maxY - minY < mh * 0.12) {
    return null;
  }

  const rows = [];

  for (let y = minY; y <= maxY; y++) {
    if (rowCount[y] > mw * 0.025) {
      rows.push(y);
    }
  }

  if (rows.length < 4) return null;

  const top = rows[Math.floor(rows.length * 0.08)];
  const bottom = rows[Math.floor(rows.length * 0.92)];

  const leftAt = y => rowLeft[y];
  const rightAt = y => rowRight[y];

  const src = document.createElement("canvas");
  src.width = mw;
  src.height = mh;

  src.getContext("2d").putImageData(
    new ImageData(binary, mw, mh),
    0,
    0
  );

  const rect = canvas.getBoundingClientRect();
  const cw = rect.width;
  const ch = rect.height;

  const scaleCover = Math.max(cw / mw, ch / mh);

  const drawW = mw * scaleCover;
  const drawH = mh * scaleCover;

  const offsetX = (cw - drawW) / 2;
  const offsetY = (ch - drawH) / 2;

  const map = (x, y) => ({
    x: x * scaleCover + offsetX,
    y: y * scaleCover + offsetY
  });

  const q = [
    map(leftAt(top), top),
    map(rightAt(top), top),
    map(rightAt(bottom), bottom),
    map(leftAt(bottom), bottom)
  ];

  const maskCanvas = document.createElement("canvas");

  maskCanvas.width = Math.round(cw);
  maskCanvas.height = Math.round(ch);

  const mctx = maskCanvas.getContext("2d");

  mctx.imageSmoothingEnabled = false;

  mctx.drawImage(
    src,
    0,
    0,
    mw,
    mh,
    offsetX,
    offsetY,
    drawW,
    drawH
  );

  return {
    quad: q,
    maskCanvas
  };
}

// Mobile-friendly model configuration.
async function loadFloorModel() {
  if (segmenter) return segmenter;

  if (modelLoading) {
    throw new Error("The floor model is already loading.");
  }

  modelLoading = true;

  try {
    if (!segmenterPromise) {
      setStatus("Loading lightweight floor detection model...");

      segmenterPromise = (async () => {
        const { pipeline, env } = await import(
          "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2"
        );

        env.allowLocalModels = false;
        env.useBrowserCache = true;

        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;

        return await pipeline(
          "image-segmentation",
          "Xenova/segformer-b0-finetuned-ade-512-512",
          {
            device: "wasm",
            dtype: "q8"
          }
        );
      })();
    }

    segmenter = await segmenterPromise;

    return segmenter;

  } catch (err) {
    segmenterPromise = null;
    segmenter = null;
    throw err;

  } finally {
    modelLoading = false;
  }
}

async function detectFloor(generation) {
  if (
    !trackingEnabled ||
    generation !== trackingGeneration ||
    !segmenter
  ) {
    return;
  }

  if (video.readyState < 2) {
    trackingTimer = setTimeout(
      () => detectFloor(generation),
      500
    );
    return;
  }

  if (inferenceBusy) return;

  inferenceBusy = true;

  try {
    // Keep inference frames small to reduce mobile memory usage.
    const frameScale = Math.min(
      1,
      384 / Math.max(video.videoWidth, video.videoHeight)
    );

    const frameWidth = Math.max(
      1,
      Math.round(video.videoWidth * frameScale)
    );

    const frameHeight = Math.max(
      1,
      Math.round(video.videoHeight * frameScale)
    );

    if (
      inferenceCanvas.width !== frameWidth ||
      inferenceCanvas.height !== frameHeight
    ) {
      inferenceCanvas.width = frameWidth;
      inferenceCanvas.height = frameHeight;
    }

    inferenceCtx.drawImage(
      video,
      0,
      0,
      frameWidth,
      frameHeight
    );

    const results = await segmenter(inferenceCanvas);

    if (
      !trackingEnabled ||
      generation !== trackingGeneration
    ) {
      return;
    }

    const floor = results.find(item =>
      /\bfloor\b|flooring/i.test(item.label || "")
    );

    if (!floor) {
      setStatus("No floor detected. Aim at a larger, well-lit floor area.");
      return;
    }

    const result = makeMaskAndQuad(floor.mask);

    if (!result) {
      setStatus("Weak floor detection. Move back and keep the camera steady.");
      return;
    }

    autoQuad = result.quad;
    floorMaskCanvas = result.maskCanvas;
    lastDetection = Date.now();

    setStatus(
      `Floor detected (${Math.round((floor.score || 0) * 100)}% confidence).`
    );

    render();

  } catch (err) {
    console.error("Floor detection error:", err);

    if (
      trackingEnabled &&
      generation === trackingGeneration
    ) {
      setStatus(`Detection stopped: ${err.message}`);
      stopTracking();
    }

  } finally {
    inferenceBusy = false;

    if (
      trackingEnabled &&
      generation === trackingGeneration
    ) {
      trackingTimer = setTimeout(
        () => detectFloor(generation),
        3000
      );
    }
  }
}

async function startTracking() {
  if (!stream) {
    setStatus("Start the camera first.");
    return;
  }

  if (trackingEnabled || modelLoading || inferenceBusy) {
    return;
  }

  trackingEnabled = true;

  selecting = false;
  corners = [];

  autoQuad = null;
  floorMaskCanvas = null;
  lastDetection = 0;

  const generation = ++trackingGeneration;

  autoBtn.disabled = true;
  stopBtn.disabled = false;
  setBtn.disabled = true;
  clearBtn.disabled = false;

  try {
    await loadFloorModel();

    if (
      !trackingEnabled ||
      generation !== trackingGeneration
    ) {
      return;
    }

    setStatus("AI ready. Looking for the floor...");

    await detectFloor(generation);

  } catch (err) {
    console.error(err);

    setStatus(
      `Could not load floor detection: ${err.message}. Use manual corners instead.`
    );

    stopTracking();
  }
}

function stopTracking() {
  trackingEnabled = false;
  trackingGeneration++;

  if (trackingTimer) {
    clearTimeout(trackingTimer);
    trackingTimer = null;
  }

  autoBtn.disabled = false;
  stopBtn.disabled = true;
  setBtn.disabled = !stream;

  render();
}

async function startCamera() {
  if (stream) return;

  startBtn.disabled = true;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        frameRate: { ideal: 24, max: 30 }
      },
      audio: false
    });

    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;

    await video.play();

    emptyEl.style.display = "none";

    startBtn.textContent = "Camera running";
    startBtn.disabled = true;

    setBtn.disabled = false;
    clearBtn.disabled = false;
    autoBtn.disabled = false;

    resizeCanvas();

    setStatus("Camera ready. Choose automatic detection or manual corners.");

  } catch (err) {
    stream?.getTracks().forEach(track => track.stop());

    stream = null;
    video.srcObject = null;

    startBtn.disabled = false;

    setStatus(
      `Could not start camera: ${err.message}. Check permissions and HTTPS.`
    );
  }
}

// Event listeners

startBtn.addEventListener("click", startCamera);

autoBtn.addEventListener("click", startTracking);

stopBtn.addEventListener("click", () => {
  stopTracking();
  setStatus("Automatic tracking stopped.");
});

setBtn.addEventListener("click", () => {
  stopTracking();

  selecting = true;
  corners = [];

  setStatus("Tap the four floor corners clockwise.");

  render();
});

clearBtn.addEventListener("click", () => {
  stopTracking();

  corners = [];
  autoQuad = null;
  floorMaskCanvas = null;
  selecting = false;

  render();

  setStatus("Floor area cleared.");
});

canvas.addEventListener("click", e => {
  if (!selecting || corners.length >= 4) return;

  const r = canvas.getBoundingClientRect();

  corners.push({
    x: e.clientX - r.left,
    y: e.clientY - r.top
  });

  if (corners.length === 4) {
    selecting = false;
    setStatus("Manual floor area set.");
  }

  render();
});

presetSelect.addEventListener("change", () => {
  setTexture(presetSelect.value);
});

document.querySelectorAll(".swatch").forEach(b => {
  b.addEventListener("click", () => {
    presetSelect.value = b.dataset.preset;
    setTexture(b.dataset.preset);
  });
});

fileInput.addEventListener("change", e => {
  const file = e.target.files?.[0];

  if (!file) return;

  const url = URL.createObjectURL(file);
  const img = new Image();

  img.onload = () => {
    texture = img;
    textureName = "custom";
    textureTileSource = null;

    render();

    setStatus(`Loaded ${file.name}.`);

    URL.revokeObjectURL(url);
  };

  img.onerror = () => {
    setStatus("That image could not be loaded.");
    URL.revokeObjectURL(url);
  };

  img.src = url;
});

[strength, gloss, scale].forEach(el => {
  el.addEventListener("input", () => {
    document.querySelector("#strengthValue").value =
      `${strength.value}%`;

    document.querySelector("#glossValue").value =
      `${gloss.value}%`;

    document.querySelector("#scaleValue").value =
      `${(Number(scale.value) / 100).toFixed(1)}×`;

    render();
  });
});

window.addEventListener("resize", () => {
  resizeCanvas();
  render();
});

window.addEventListener("pagehide", () => {
  stopTracking();

  stream?.getTracks().forEach(track => track.stop());

  stream = null;
});

if (!navigator.mediaDevices?.getUserMedia) {
  setStatus(
    "This browser does not support camera access. Use HTTPS and a modern browser."
  );
}

resizeCanvas();
