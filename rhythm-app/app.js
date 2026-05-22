/* Salsa Rhythm Sync - Core JavaScript Engine */

// Master Audio Constants & State
let audioCtx = null;
let audioBuffer = null;
let audioSource = null;
let gainNode = null;
let recDest = null;

let isPlaying = false;
let startTime = 0;      // absolute context time of current playback segment start
let pauseOffset = 0;    // accumulated elapsed playback time within song (seconds)
let volume = 0.8;       // standard volume [0..1]

// Grid Calibration Variables
let bpm = 180;
let offset = 0.0;
let placedDownbeats = []; // stores clicked playbackTimes of temps 1 for calibration

// Analysis Outputs
let timelinePeaks = null; // precomputed downsampled peaks for visual rendering
let noveltyCurve = null;  // novelty curve downsampled values
let noveltyFps = 1;       // resolution of novelty curve array
let activeFilename = "";

// Animation Modes & Interactive Configurations
let currentMode = "salsa"; // salsa, tous, clave
const countNotesCount = 8;
let lastImpactTimes = new Float32Array(9); // records last time cannas counted 1-8 impacted

// Helper to determine the interval (in seconds) of a single Salsa count.
// For slow tempos (BPM < 110), each count is an eighth-note (30 / bpm).
// For fast/standard tempos (BPM >= 110), each count is a quarter-note beat (60 / bpm).
function getCountDuration() {
  return (bpm < 110) ? (30 / bpm) : (60 / bpm);
}

// Timeline View
let zoomLevel = 45; // visible duration in seconds

// Video Canvas and WebGL or Canvas2D References
let videoCanvas = null;
let videoCtx = null;
let timelineCanvas = null;
let timelineCtx = null;

// MediaRecorder (Exporter) State
let mediaRecorder = null;
let recordedChunks = [];
let isExporting = false;
let exportStartTime = 0;

// Setup on window load
window.addEventListener('load', () => {
  initDOMElements();
  initCanvas();
  requestAnimationFrame(mainRenderLoop);
});

// Setup DOM elements reference and bindings
function initDOMElements() {
  const fileInput = document.getElementById('audio-upload');
  const dropZone = document.getElementById('drop-zone');
  const btnPlay = document.getElementById('btn-audio-play');
  const btnStop = document.getElementById('btn-audio-prev');
  const volumeSlider = document.getElementById('volume-slider');
  const volumeValLabel = document.getElementById('volume-val');
  
  const inputBpm = document.getElementById('input-bpm');
  const inputOffset = document.getElementById('input-offset');
  const btnTapBpm = document.getElementById('btn-tap-bpm');
  const btnPlace1 = document.getElementById('btn-place-1');
  
  const zoomSlider = document.getElementById('zoom-slider');
  const btnExport = document.getElementById('btn-export');
  const btnCancelExport = document.getElementById('btn-cancel-export');

  // Offset micro buttons
  document.getElementById('adj-sub-010').addEventListener('click', () => adjustOffset(-0.10));
  document.getElementById('adj-sub-001').addEventListener('click', () => adjustOffset(-0.01));
  document.getElementById('adj-add-001').addEventListener('click', () => adjustOffset(0.01));
  document.getElementById('adj-add-010').addEventListener('click', () => adjustOffset(0.10));

  const btnShiftPhrase = document.getElementById('btn-shift-phrase');
  if (btnShiftPhrase) {
    btnShiftPhrase.addEventListener('click', () => {
      // Shift phase exactly by 4 counts (half of the 8-count Salsa cycle)
      const countDurationSec = getCountDuration();
      const shiftSec = 4 * countDurationSec;
      
      // Shift forward by 4 counts and clamp to positive within the 8-count phrase duration
      offset += shiftSec;
      const cycleSec = 8 * countDurationSec;
      offset = ((offset % cycleSec) + cycleSec) % cycleSec;
      offset = Math.round(offset * 1000) / 1000;
      
      // Update the offset display input
      document.getElementById('input-offset').value = offset;
    });
  }

  // File and YouTube Upload Handlers
  fileInput.addEventListener('change', (e) => {
    initAudioContext(); // Initialize audio context directly on user click gesture
    if (e.target.files.length > 0) handleSelectedFile(e.target.files[0]);
  });

  const inputYtUrl = document.getElementById('input-yt-url');
  const btnYtImport = document.getElementById('btn-yt-import');

  btnYtImport.addEventListener('click', () => {
    const url = inputYtUrl.value.trim();
    if (!url) {
      alert("Veuillez saisir un lien YouTube valide.");
      return;
    }
    initAudioContext(); // Initialize audio context directly on user click gesture
    handleYoutubeImport(url);
  });

  inputYtUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const url = inputYtUrl.value.trim();
      if (!url) return;
      initAudioContext(); // Initialize audio context directly on user enter gesture
      handleYoutubeImport(url);
    }
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    initAudioContext(); // Initialize audio context directly on user drop gesture
    if (e.dataTransfer.files.length > 0) {
      handleSelectedFile(e.dataTransfer.files[0]);
    }
  });

  dropZone.addEventListener('click', () => {
    fileInput.click();
  });

  // Playback Control Handlers
  btnPlay.addEventListener('click', () => {
    if (!audioBuffer) return;
    initAudioContext();
    if (isPlaying) {
      pauseAudio();
    } else {
      playAudio(pauseOffset);
    }
  });

  btnStop.addEventListener('click', () => {
    if (!audioBuffer) return;
    stopAudio();
  });

  // Volume slider
  volumeSlider.addEventListener('input', (e) => {
    volume = parseFloat(e.target.value) / 100;
    volumeValLabel.textContent = e.target.value + '%';
    if (gainNode) {
      gainNode.gain.setValueAtTime(volume, audioCtx.currentTime);
    }
  });

  // Grid adjustment fields
  inputBpm.addEventListener('input', (e) => {
    const parsed = parseFloat(e.target.value);
    if (!isNaN(parsed) && parsed > 10) {
      bpm = parsed;
    }
  });

  const btnBpmDiv2 = document.getElementById('btn-bpm-div2');
  const btnBpmMul2 = document.getElementById('btn-bpm-mul2');

  if (btnBpmDiv2) {
    btnBpmDiv2.addEventListener('click', () => {
      bpm = Math.round((bpm / 2) * 100) / 100;
      inputBpm.value = bpm;
    });
  }

  if (btnBpmMul2) {
    btnBpmMul2.addEventListener('click', () => {
      bpm = Math.round((bpm * 2) * 100) / 100;
      inputBpm.value = bpm;
    });
  }

  inputOffset.addEventListener('input', (e) => {
    const parsed = parseFloat(e.target.value);
    if (!isNaN(parsed)) {
      offset = parsed;
    }
  });

  // Tap BPM setup
  let tapTimestamps = [];
  btnTapBpm.addEventListener('click', () => {
    const now = Date.now();
    tapTimestamps.push(now);
    if (tapTimestamps.length > 8) tapTimestamps.shift();
    
    if (tapTimestamps.length >= 2) {
      let sumInterval = 0;
      for (let i = 1; i < tapTimestamps.length; i++) {
        sumInterval += (tapTimestamps[i] - tapTimestamps[i - 1]);
      }
      const avgIntervalMs = sumInterval / (tapTimestamps.length - 1);
      const tappedBpm = Math.round((60000 / avgIntervalMs) * 100) / 100;
      if (tappedBpm >= 40 && tappedBpm <= 300) {
        bpm = tappedBpm;
        inputBpm.value = bpm;
      }
    }
  });

  // Placer 1 setup (Salsa Downbeat synchronization)
  btnPlace1.addEventListener('click', () => {
    if (!audioBuffer) return;
    const curTime = getPlaybackTime();
    placedDownbeats.push(curTime);
    // Keep last 12 downbeats for stability
    if (placedDownbeats.length > 12) placedDownbeats.shift();

    if (placedDownbeats.length === 1) {
      // First click: align start time direct to click
      offset = Math.round(curTime * 1000) / 1000;
      inputOffset.value = offset;
    } else {
      // Multiple downbeats placed: calculate tempo and average phase
      // One salsa cycle (8 counts) lasts 240 / BPM.
      // We will perform linear-best fit alignment on clicks to filter out trigger jitter
      let currentBarSec = 240 / bpm;
      let firstTime = placedDownbeats[0];
      
      // Map each clicked time to a bar offset number
      let relativePairs = placedDownbeats.map(t => {
        let diff = t - firstTime;
        let barNum = Math.round(diff / currentBarSec);
        return { x: barNum, y: t };
      });

      // Linear Regression: y = a + b * x
      // where y is click offset time, x is number of bars, b is the average bar duration
      let n = relativePairs.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
      for (let pair of relativePairs) {
        sumX += pair.x;
        sumY += pair.y;
        sumXY += pair.x * pair.y;
        sumXX += pair.x * pair.x;
      }

      let denominator = (n * sumXX - sumX * sumX);
      if (denominator !== 0) {
        let b = (n * sumXY - sumX * sumY) / denominator; // bar duration
        let a = (sumY - b * sumX) / n;                 // t0 offset
        
        let calculatedBpm = Math.round((240 / b) * 100) / 100;
        if (calculatedBpm >= 40 && calculatedBpm <= 300) {
          bpm = calculatedBpm;
          inputBpm.value = bpm;
          
          // wrap first beat offset to stay within local window [0, beatInterval * 8]
          let cycleDuration = b;
          let positiveA = a;
          while (positiveA < 0) positiveA += cycleDuration;
          offset = Math.round((positiveA % cycleDuration) * 1000) / 1000;
          inputOffset.value = offset;
        }
      } else {
        // Fallback: simple average delta between consecutive clicks
        let deltasSum = 0;
        let intervals = 0;
        for (let i = 1; i < placedDownbeats.length; i++) {
          let delta = placedDownbeats[i] - placedDownbeats[i - 1];
          let bars = Math.round(delta / currentBarSec);
          if (bars < 1) bars = 1;
          deltasSum += delta / bars;
          intervals++;
        }
        let avgBarDuration = deltasSum / intervals;
        let calculatedBpm = Math.round((240 / avgBarDuration) * 10) / 10;
        if (calculatedBpm >= 40 && calculatedBpm <= 300) {
          bpm = calculatedBpm;
          inputBpm.value = bpm;
        }
      }
    }
  });

  // Setup Timeline Zoom slider
  zoomSlider.addEventListener('input', (e) => {
    zoomLevel = parseFloat(e.target.value);
  });

  // Export flows setup
  btnExport.addEventListener('click', startVideoExport);
  btnCancelExport.addEventListener('click', cancelVideoExport);
}

// Micro adjustment step for offset time
function adjustOffset(value) {
  offset = Math.round((offset + value) * 1000) / 1000;
  document.getElementById('input-offset').value = offset;
}

// Setup canvasses
function initCanvas() {
  videoCanvas = document.getElementById('video-canvas');
  videoCtx = videoCanvas.getContext('2d');
  
  timelineCanvas = document.getElementById('timeline-canvas');
  timelineCtx = timelineCanvas.getContext('2d');

  // Trigger resize listener on timeline canvas size
  const resizeTimeline = () => {
    const parent = timelineCanvas.parentElement;
    timelineCanvas.width = parent.clientWidth * window.devicePixelRatio;
    timelineCanvas.height = parent.clientHeight * window.devicePixelRatio;
  };

  resizeTimeline();
  window.addEventListener('resize', resizeTimeline);

  // Timeline Canvas interactivity (click and scrub)
  let isSeeking = false;

  const handleTimelineScrub = (event) => {
    if (!audioBuffer) return;
    const rect = timelineCanvas.getBoundingClientRect();
    const clientX = (event.clientX || (event.touches && event.touches[0].clientX)) - rect.left;
    const relativeX = clientX / rect.width;
    
    // Convert to relative position in visible timeline window
    const duration = audioBuffer.duration;
    const viewWidth = Math.min(duration, zoomLevel);
    let viewStart = getPlaybackTime() - viewWidth / 2;
    if (viewStart < 0) viewStart = 0;
    if (viewStart + viewWidth > duration) viewStart = Math.max(0, duration - viewWidth);

    const seekTime = viewStart + relativeX * viewWidth;
    seekTo(seekTime);
  };

  timelineCanvas.addEventListener('mousedown', (e) => {
    isSeeking = true;
    handleTimelineScrub(e);
  });

  window.addEventListener('mousemove', (e) => {
    if (isSeeking) handleTimelineScrub(e);
  });

  window.addEventListener('mouseup', () => {
    isSeeking = false;
  });

  // Touch triggers
  timelineCanvas.addEventListener('touchstart', (e) => {
    isSeeking = true;
    handleTimelineScrub(e);
  }, { passive: true });

  timelineCanvas.addEventListener('touchmove', (e) => {
    if (isSeeking) handleTimelineScrub(e);
  }, { passive: true });

  timelineCanvas.addEventListener('touchend', () => {
    isSeeking = false;
  });
}

// Parse imported audio files
function handleSelectedFile(file) {
  activeFilename = file.name;
  placedDownbeats = []; // clear placements on new song upload
  
  // Update view label
  document.getElementById('active-filename').textContent = file.name;

  // Update customizable video title input
  const titleInput = document.getElementById('input-video-title');
  if (titleInput) {
    titleInput.value = file.name.replace(/\.[^/.]+$/, "");
  }
  
  // Expose Loading overlay
  document.getElementById('loading-overlay').classList.remove('hidden');
  document.getElementById('drop-zone').classList.add('hidden');

  const reader = new FileReader();
  reader.onload = function(event) {
    const arrayBuffer = event.target.result;
    initAudioContext();
    
    let decoded = false;
    const onDecodeSuccess = (decodedBuffer) => {
      if (decoded) return;
      decoded = true;
      audioBuffer = decodedBuffer;
      
      // Perform fast, local DSP beat estimation
      analyseAudioBuffer();
      
      // Complete overlays removal
      document.getElementById('loading-overlay').classList.add('hidden');
      document.getElementById('btn-export').removeAttribute('disabled');
      
      // Reset play state
      stopAudio();
    };

    const onDecodeError = (error) => {
      if (decoded) return;
      decoded = true;
      console.error("Error decoding audio buffer: ", error);
      alert("Erreur lors du décodage du fichier audio. Essayez un autre fichier de musique.");
      document.getElementById('loading-overlay').classList.add('hidden');
      document.getElementById('drop-zone').classList.remove('hidden');
    };

    try {
      const decodePromise = audioCtx.decodeAudioData(arrayBuffer, onDecodeSuccess, onDecodeError);
      if (decodePromise && typeof decodePromise.then === 'function') {
        decodePromise.then(onDecodeSuccess).catch(onDecodeError);
      }
    } catch (e) {
      // Direct synchronous error
      onDecodeError(e);
    }
  };
  reader.readAsArrayBuffer(file);
}

// Direct frontend fallback for download-youtube-audio when running as a static site (e.g., GitHub Pages)
async function fetchYoutubeAudioDirectly(youtubeUrl) {
  const cobaltEndpoints = [
    'https://api.dl.woof.monster',
    'https://cobaltapi.kittycat.boo',
    'https://fox.kittycat.boo',
    'https://dog.kittycat.boo',
    'https://cobaltapi.cjs.nz',
    'https://cobaltapi.squair.xyz',
    'https://api.cobalt.blackcat.sweeux.org',
    'https://api.cobalt.liubquanti.click'
  ];

  let lastError = null;

  for (const endpoint of cobaltEndpoints) {
    try {
      console.log(`[Frontend Fallback] Trying Cobalt endpoint: ${endpoint}`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4500);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url: youtubeUrl,
          downloadMode: 'audio',
          audioFormat: 'mp3',
          audioBitrate: '128'
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        lastError = `Status ${response.status} from ${endpoint}`;
        continue;
      }

      const data = await response.json();
      if (data.status === 'error' || data.type === 'error' || data.error) {
        lastError = data.text || (data.error && data.error.message) || data.message || "Extraction error";
        continue;
      }

      const audioUrl = data.url || (data.picker && data.picker[0] && data.picker[0].url) || (data.picker && data.picker[0] && data.picker[0].audio);
      if (!audioUrl) {
        lastError = "No stream URL in Cobalt response";
        continue;
      }

      console.log(`[Frontend Fallback] Found direct stream URL: ${audioUrl}. Fetching audio data...`);
      const streamController = new AbortController();
      const streamTimeout = setTimeout(() => streamController.abort(), 10000);

      const audioResponse = await fetch(audioUrl, {
        signal: streamController.signal
      });
      clearTimeout(streamTimeout);

      if (!audioResponse.ok) {
        lastError = `Failed to get audio stream: ${audioResponse.status}`;
        continue;
      }

      const arrayBuffer = await audioResponse.arrayBuffer();
      if (arrayBuffer.byteLength < 10000) {
        lastError = "Downloaded audio file was too small or corrupted.";
        continue;
      }

      console.log(`[Frontend Fallback] Successfully fetched ${arrayBuffer.byteLength} bytes of audio directly from ${endpoint}`);
      return arrayBuffer;
    } catch (err) {
      console.warn(`[Frontend Fallback] Endpoint ${endpoint} failed:`, err);
      lastError = err.message || err;
    }
  }

  throw new Error(`Tous les serveurs d'extraction ont échoué. Détail : ${lastError}`);
}

// Fetch and decode audio via YouTube Link Extractor Proxy API
function handleYoutubeImport(youtubeUrl) {
  // Show UI Loading states
  document.getElementById('loading-overlay').classList.remove('hidden');
  document.getElementById('drop-zone').classList.add('hidden');

  const loadingTitle = document.querySelector('#loading-overlay h3');
  const loadingDesc = document.querySelector('#loading-overlay p');
  
  const originalTitleText = loadingTitle ? loadingTitle.textContent : "Décodage et analyse en cours...";
  const originalDescText = loadingDesc ? loadingDesc.textContent : "Notre algorithme calcule l'enveloppe d'attaque et estime le BPM optimal.";
  
  if (loadingTitle) loadingTitle.textContent = "Téléchargement audio YouTube...";
  if (loadingDesc) loadingDesc.textContent = "Le serveur extrait la piste sonore de la vidéo. Cela peut prendre 10 à 20 secondes.";

  fetch(`/api/download-youtube-audio?url=${encodeURIComponent(youtubeUrl)}`)
    .then(response => {
      if (response.status === 404) {
        console.log("[YouTube Import] API endpoint returned 404. Falling back to direct client-side Cobalt querying...");
        return fetchYoutubeAudioDirectly(youtubeUrl);
      }
      if (!response.ok) {
        return response.json().then(err => {
          throw new Error(err.error || "Le serveur de téléchargement a renvoyé une erreur.");
        }).catch(() => {
          throw new Error(`Erreur du proxy (${response.status}). Essai de l'extraction directe...`);
        });
      }
      return response.arrayBuffer();
    })
    .catch(error => {
      // Catch network transitions, like if the server is off, or if we explicitly threw direct fallback notice
      if (error.message && (error.message.includes("Essai") || error.message.includes("Failed to fetch") || error.message.includes("fetch"))) {
        console.log("[YouTube Import] Server unavailable or proxy error. Trying direct browser extraction...");
        return fetchYoutubeAudioDirectly(youtubeUrl);
      }
      throw error;
    })
    .then(arrayBuffer => {
      let videoTitle = "Musique YouTube";
      try {
        const urlObj = new URL(youtubeUrl);
        if (urlObj.searchParams.has('v')) {
          videoTitle = `YouTube (${urlObj.searchParams.get('v')})`;
        } else {
          const parts = urlObj.pathname.split('/');
          const lastPart = parts[parts.length - 1];
          if (lastPart && lastPart !== "watch") {
            videoTitle = `YouTube (${lastPart})`;
          }
        }
      } catch (e) {}

      activeFilename = videoTitle;
      placedDownbeats = [];
      document.getElementById('active-filename').textContent = activeFilename;

      // Update customizable video title input
      const titleInput = document.getElementById('input-video-title');
      if (titleInput) {
        titleInput.value = videoTitle;
      }

      if (loadingTitle) loadingTitle.textContent = "Décodage de la piste audio...";
      if (loadingDesc) loadingDesc.textContent = "Analyse spectrale et synchronisation tempo salsa...";

      // Reset Audio Context and decode Audio Buffer
      initAudioContext();
      
      let decoded = false;
      const onDecodeSuccess = (decodedBuffer) => {
        if (decoded) return;
        decoded = true;
        
        audioBuffer = decodedBuffer;
        analyseAudioBuffer();
        
        // Restore labels
        if (loadingTitle) loadingTitle.textContent = originalTitleText;
        if (loadingDesc) loadingDesc.textContent = originalDescText;

        document.getElementById('loading-overlay').classList.add('hidden');
        document.getElementById('btn-export').removeAttribute('disabled');
        stopAudio();
      };

      const onDecodeError = (error) => {
        if (decoded) return;
        decoded = true;
        
        console.error("Error decoding YouTube audio data: ", error);
        alert("Erreur lors du décodage de l'audio téléchargé depuis YouTube. Essayez un autre lien.");
        
        if (loadingTitle) loadingTitle.textContent = originalTitleText;
        if (loadingDesc) loadingDesc.textContent = originalDescText;
        
        document.getElementById('loading-overlay').classList.add('hidden');
        document.getElementById('drop-zone').classList.remove('hidden');
      };

      try {
        const decodePromise = audioCtx.decodeAudioData(arrayBuffer, onDecodeSuccess, onDecodeError);
        if (decodePromise && typeof decodePromise.then === 'function') {
          decodePromise.then(onDecodeSuccess).catch(onDecodeError);
        }
      } catch (e) {
        onDecodeError(e);
      }
    })
    .catch(error => {
      console.error("YouTube Import Error:", error);
      alert(`Erreur d'importation YouTube: ${error.message || "Impossible de récupérer l'audio de ce lien."}`);
      
      if (loadingTitle) loadingTitle.textContent = originalTitleText;
      if (loadingDesc) loadingDesc.textContent = originalDescText;
      
      document.getElementById('loading-overlay').classList.add('hidden');
      document.getElementById('drop-zone').classList.remove('hidden');
    });
}

// Master Audio Context initialization (Safe user gestures trigger)
function initAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(volume, audioCtx.currentTime);
    gainNode.connect(audioCtx.destination);

    // Create a media stream recorder node
    recDest = audioCtx.createMediaStreamDestination();
    gainNode.connect(recDest);
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

// DSP Analysis: Novelty curve extraction with High-Pass transient filter, Autocorrelation, and smart Salsa 8-count phase detection
function analyseAudioBuffer() {
  if (!audioBuffer) return;
  const channelData = audioBuffer.getChannelData(0); // Left channel
  const sampleRate = audioBuffer.sampleRate;
  
  // Downsample buffers to speed up local loops processing
  const hopSize = 1024;
  const frameCount = Math.floor(channelData.length / hopSize);
  
  // High-pass filter (first-order difference) to focus on bright percussive sounds: claves, conga slaps, bongos, cowbells
  const hpData = new Float32Array(channelData.length);
  for (let i = 1; i < channelData.length; i++) {
    hpData[i] = channelData[i] - channelData[i - 1];
  }
  
  // Calculate RMS energies on high-passed audio
  const energies = new Float32Array(frameCount);
  let maxEnergy = 0;
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    const offsetIdx = i * hopSize;
    for (let j = 0; j < hopSize && (offsetIdx + j) < hpData.length; j++) {
      const val = hpData[offsetIdx + j];
      sum += val * val;
    }
    const rms = Math.sqrt(sum / hopSize);
    energies[i] = rms;
    if (rms > maxEnergy) maxEnergy = rms;
  }

  // Compute positive difference novelties (half-wave rectified difference)
  const novelty = new Float32Array(frameCount);
  let maxNovelty = 0;
  for (let i = 1; i < frameCount; i++) {
    novelty[i] = Math.max(0, energies[i] - energies[i-1]);
    if (novelty[i] > maxNovelty) maxNovelty = novelty[i];
  }

  // Normalize novelty array to [0..1]
  if (maxNovelty > 0) {
    for (let i = 0; i < frameCount; i++) {
      novelty[i] /= maxNovelty;
    }
  }

  noveltyCurve = novelty;
  noveltyFps = sampleRate / hopSize;

  // Auto-correlation estimator for BPM supporting slow and fast tempos [60 - 220]
  // fps = frame rate of analysis
  const fps = noveltyFps;
  const minBpm = 60;
  const maxBpm = 220;
  const startLag = Math.floor(fps * 60 / maxBpm);
  const endLag = Math.ceil(fps * 60 / minBpm);

  let bestLag = 0;
  let maxCorrelation = -Infinity;

  for (let lag = startLag; lag <= endLag; lag++) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < frameCount - lag; i++) {
      sum += novelty[i] * novelty[i + lag];
      count++;
    }
    const val = count > 0 ? sum / count : 0;
    if (val > maxCorrelation) {
      maxCorrelation = val;
      bestLag = lag;
    }
  }

  let estimatedBpm = 180;
  if (bestLag > 0) {
    const beatIntervalRaw = bestLag / fps;
    estimatedBpm = 60 / beatIntervalRaw;
  }

  // Refine and lock bpm in Salsa range safety (60 to 240)
  if (estimatedBpm < 60) estimatedBpm *= 2;
  if (estimatedBpm > 240) estimatedBpm /= 2;

  // Let's optimize for the visual grids rate (which is double BPM for slow tempos < 110)
  const analysisBpm = (estimatedBpm < 110) ? (estimatedBpm * 2) : estimatedBpm;
  const duration = audioBuffer.duration;

  let bestRefinedBpm = analysisBpm;
  let bestRefinedOffset = 0.0;
  let maxRefinedScore = -Infinity;

  // Stage 1: Grid Search over a BPM range of +/- 6.0 and Offset range
  const sweepRange = 6.0;
  const stepBpm1 = 0.1;       // 0.1 BPM step
  const stepOffset1 = 0.01;   // 10ms offset step

  // We sample beats spread across the entire duration of the audio buffer (up to 200 points)
  // this severely penalizes any slightly wrong BPM candidate that starts drifting at the end
  const totalBeatsSampleLimit = 200;

  for (let b = analysisBpm - sweepRange; b <= analysisBpm + sweepRange; b += stepBpm1) {
    if (b < 40 || b > 300) continue;
    const bInterval = 60 / b;
    const estTotalBeats = Math.floor(duration / bInterval);
    const kStep = Math.max(1, Math.floor(estTotalBeats / totalBeatsSampleLimit));

    for (let o = 0.0; o < bInterval; o += stepOffset1) {
      let score = 0;
      let count = 0;
      for (let k = 0; k < estTotalBeats; k += kStep) {
        const beatTime = o + k * bInterval;
        if (beatTime >= duration) break;
        const centerIdx = Math.floor(beatTime * fps);

        // Window check of [-1..1] frame (~ +/- 23ms) to accept close peak alignment
        let maxLocal = 0;
        for (let w = -1; w <= 1; w++) {
          const idx = centerIdx + w;
          if (idx >= 0 && idx < frameCount) {
            if (novelty[idx] > maxLocal) maxLocal = novelty[idx];
          }
        }
        score += maxLocal;
        count++;
      }
      const avgScore = count > 0 ? score / count : 0;
      if (avgScore > maxRefinedScore) {
        maxRefinedScore = avgScore;
        bestRefinedBpm = b;
        bestRefinedOffset = o;
      }
    }
  }

  // Stage 2: Fine-Tuning Sweep around the best combo to hit sub-0.01 BPM and 1ms precision!
  let ultraBpm = bestRefinedBpm;
  let ultraOffset = bestRefinedOffset;
  let maxUltraScore = -Infinity;

  const stepBpm2 = 0.01;       // High-precision 0.01 BPM step
  const stepOffset2 = 0.001;   // High-precision 1ms offset step

  for (let b = bestRefinedBpm - 0.12; b <= bestRefinedBpm + 0.12; b += stepBpm2) {
    const bInterval = 60 / b;
    const estTotalBeats = Math.floor(duration / bInterval);
    const kStep = Math.max(1, Math.floor(estTotalBeats / totalBeatsSampleLimit));

    for (let oOffset = -0.012; oOffset <= 0.012; oOffset += stepOffset2) {
      let o = (bestRefinedOffset + oOffset) % bInterval;
      if (o < 0) o += bInterval;

      let score = 0;
      let count = 0;
      for (let k = 0; k < estTotalBeats; k += kStep) {
        const beatTime = o + k * bInterval;
        if (beatTime >= duration) break;
        const centerIdx = Math.floor(beatTime * fps);

        let maxLocal = 0;
        for (let w = -1; w <= 1; w++) {
          const idx = centerIdx + w;
          if (idx >= 0 && idx < frameCount) {
            if (novelty[idx] > maxLocal) maxLocal = novelty[idx];
          }
        }
        score += maxLocal;
        count++;
      }
      const avgScore = count > 0 ? score / count : 0;
      if (avgScore > maxUltraScore) {
        maxUltraScore = avgScore;
        ultraBpm = b;
        ultraOffset = o;
      }
    }
  }

  // De-normalize back based on requested octave
  if (estimatedBpm < 110) {
    estimatedBpm = ultraBpm / 2;
  } else {
    estimatedBpm = ultraBpm;
  }
  let bestOffset = ultraOffset;
  const beatInterval = 60 / ultraBpm;

  // --- START OF SMART SALSA PHASE ALIGNMENT ---
  // Identify which of the 8 beats is the true musical "1" by scoring candidate shifts (0 to 7).
  // Under shift 's', raw phase 's' is Salsa count 1, 's+1' is 2, ..., 's+7' is 8.
  const totalBeats = Math.floor((audioBuffer.duration - bestOffset) / beatInterval);
  const rawBeatAverages = new Float32Array(8);
  const rawOffbeatAverages = new Float32Array(8);

  const beatBins = Array.from({ length: 8 }, () => []);
  const offbeatBins = Array.from({ length: 8 }, () => []);
  
  // Analyze a substantial section of the audio (~3 minutes / 400 beats)
  const maxBeatsToAnalyze = Math.min(totalBeats, 400);

  for (let i = 0; i < maxBeatsToAnalyze; i++) {
    const rawPhase = i % 8;
    const tBeat = bestOffset + i * beatInterval;
    const tOffbeat = tBeat + 0.5 * beatInterval; // midway to the next beat

    const frameBeat = Math.floor(tBeat * fps);
    const frameOffbeat = Math.floor(tOffbeat * fps);

    // Narrow search window for percussion hits (+/- 35ms)
    const windowFrames = Math.round(0.035 * fps);

    let maxBeatVal = 0;
    for (let w = -windowFrames; w <= windowFrames; w++) {
      const idx = frameBeat + w;
      if (idx >= 0 && idx < frameCount) {
        if (novelty[idx] > maxBeatVal) maxBeatVal = novelty[idx];
      }
    }
    beatBins[rawPhase].push(maxBeatVal);

    if (tOffbeat < audioBuffer.duration) {
      let maxOffbeatVal = 0;
      for (let w = -windowFrames; w <= windowFrames; w++) {
        const idx = frameOffbeat + w;
        if (idx >= 0 && idx < frameCount) {
          if (novelty[idx] > maxOffbeatVal) maxOffbeatVal = novelty[idx];
        }
      }
      offbeatBins[rawPhase].push(maxOffbeatVal);
    }
  }

  // Calculate averages per raw phase
  for (let p = 0; p < 8; p++) {
    if (beatBins[p].length > 0) {
      rawBeatAverages[p] = beatBins[p].reduce((sum, v) => sum + v, 0) / beatBins[p].length;
    }
    if (offbeatBins[p].length > 0) {
      rawOffbeatAverages[p] = offbeatBins[p].reduce((sum, v) => sum + v, 0) / offbeatBins[p].length;
    }
  }

  let bestShift = 0;
  let maxPhaseScore = -Infinity;

  for (let shift = 0; shift < 8; shift++) {
    const c1 = rawBeatAverages[shift];
    const c2 = rawBeatAverages[(shift + 1) % 8];
    const c3 = rawBeatAverages[(shift + 2) % 8];
    const c4 = rawBeatAverages[(shift + 3) % 8]; // Congas/Bongos slap
    const c5 = rawBeatAverages[(shift + 4) % 8];
    const c6 = rawBeatAverages[(shift + 5) % 8];
    const c7 = rawBeatAverages[(shift + 6) % 8];
    const c8 = rawBeatAverages[(shift + 7) % 8]; // Congas/Bongos slap + Orchestrational accent

    const c6_and = rawOffbeatAverages[(shift + 5) % 8]; // Clave offbeat 6&

    // Weighted matching based on salsa metrics:
    // - Count 8 is highly dynamic, heavily marked by congas, bongos, clave, and full melody resolution.
    // - Count 4 has a strong accent from conga/bongo slaps.
    // - Count 1 represents the resolving downbeat of the verse/brass.
    // - Counts 2, 3, 5, and offbeat 6& represent the standard 2:3 Clave pattern accents.
    const score = (
      c8 * 2.2 +                      // Instrument + Conga major accent on 8
      c4 * 1.6 +                      // Conga/Bongo slap on 4
      c1 * 1.3 +                      // Strong resolution on 1
      c2 * 0.8 +                      // Clave on 2
      c3 * 0.8 +                      // Clave on 3
      c5 * 0.8 +                      // Clave on 5
      c6_and * 1.0                    // Clave on 6& (contre-temps)
    );

    if (score > maxPhaseScore) {
      maxPhaseScore = score;
      bestShift = shift;
    }
  }

  // Align block to absolute "1"
  let finalOffset = bestOffset + bestShift * beatInterval;
  const cycleDuration = 8 * beatInterval;
  
  // Wrap to a positive value within first 8-beat cycle
  finalOffset = ((finalOffset % cycleDuration) + cycleDuration) % cycleDuration;
  
  // Set calibrated states
  bpm = Math.round(estimatedBpm * 100) / 100;
  offset = Math.round(finalOffset * 1000) / 1000;
  // --- END OF SMART SALSA PHASE ALIGNMENT ---

  // Update input fields
  document.getElementById('input-bpm').value = bpm;
  document.getElementById('input-offset').value = offset;

  // Precompute waveform peaks for fast zooming timeline render
  const wavePointsCount = 1500;
  const samplesPerBlock = Math.floor(channelData.length / wavePointsCount);
  timelinePeaks = new Float32Array(wavePointsCount);

  for (let i = 0; i < wavePointsCount; i++) {
    let maxVal = 0;
    const startIdx = i * samplesPerBlock;
    for (let j = 0; j < samplesPerBlock && (startIdx + j) < channelData.length; j++) {
      const val = Math.abs(channelData[startIdx + j]);
      if (val > maxVal) maxVal = val;
    }
    timelinePeaks[i] = maxVal;
  }
}

// Play Audio at a given offset timeline time
function playAudio(startOffsetSeconds) {
  if (!audioBuffer) return;
  initAudioContext();
  
  if (isPlaying) {
    audioSource.stop();
  }

  isPlaying = true;
  document.getElementById('btn-audio-play').textContent = '||';

  audioSource = audioCtx.createBufferSource();
  audioSource.buffer = audioBuffer;
  
  // Link Source -> GainNode
  audioSource.connect(gainNode);

  audioSource.onended = () => {
    // Stop recording trigger if reached end while recording
    if (isExporting && (getPlaybackTime() >= audioBuffer.duration - 0.2)) {
      completeVideoExport();
    }
    // If not recording, but playback naturally ended
    if (isPlaying && getPlaybackTime() >= audioBuffer.duration - 0.05) {
      isPlaying = false;
      document.getElementById('btn-audio-play').textContent = '▶';
      pauseOffset = 0;
    }
  };

  startTime = audioCtx.currentTime;
  pauseOffset = startOffsetSeconds;
  
  // play target snippet
  audioSource.start(0, startOffsetSeconds);
}

// Pause Audio
function pauseAudio() {
  if (!isPlaying) return;
  isPlaying = false;
  document.getElementById('btn-audio-play').textContent = '▶';
  
  // compute elapsed time
  pauseOffset = getPlaybackTime();
  if (audioSource) {
    audioSource.stop();
  }
}

// Stop Audio
function stopAudio() {
  isPlaying = false;
  document.getElementById('btn-audio-play').textContent = '▶';
  pauseOffset = 0;
  if (audioSource) {
    audioSource.stop();
  }
}

// Seek position
function seekTo(seconds) {
  if (!audioBuffer) return;
  const isPlayingNow = isPlaying;
  
  if (isPlayingNow) {
    playAudio(seconds);
  } else {
    pauseOffset = Math.max(0, Math.min(audioBuffer.duration, seconds));
  }
}

// Master current playback time
function getPlaybackTime() {
  if (!audioBuffer) return 0;
  if (!isPlaying) return pauseOffset;
  
  const elapsed = audioCtx.currentTime - startTime;
  const current = pauseOffset + elapsed;
  return Math.min(audioBuffer.duration, current);
}

// Direct Format helper for MM:SS.CC
function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const hundredths = Math.floor((sec % 1) * 100);
  return `${m}:${s < 10 ? '0' : ''}${s}.${hundredths < 10 ? '0' : ''}${hundredths}`;
}

// Complete Master Render Loop
function mainRenderLoop() {
  const curTime = getPlaybackTime();
  
  drawVideoFrame(curTime);
  drawTimeline(curTime);

  requestAnimationFrame(mainRenderLoop);
}

// Draw a letter-spaced typography block onto canvas context
function drawLetterSpacedText(ctx, text, x, y, spacing) {
  let totalWidth = 0;
  ctx.save();
  ctx.textAlign = 'left';
  for (let i = 0; i < text.length; i++) {
    totalWidth += ctx.measureText(text[i]).width + spacing;
  }
  let currentX = x - totalWidth / 2;
  for (let i = 0; i < text.length; i++) {
    ctx.fillText(text[i], currentX, y);
    currentX += ctx.measureText(text[i]).width + spacing;
  }
  ctx.restore();
}

// Draw the master 1080x1920 logical frame
function drawVideoFrame(playbackTime) {
  if (!videoCtx || !videoCanvas) return;

  const width = videoCanvas.width;
  const height = videoCanvas.height;

  // 1. White Background
  videoCtx.fillStyle = '#FFFFFF';
  videoCtx.fillRect(0, 0, width, height);

  // 2. Head Title Drawing (Filenames without extension or custom user text)
  videoCtx.save();
  videoCtx.fillStyle = '#1A1A1A';
  videoCtx.textAlign = 'center';
  
  let cleanTitle = "Salsa Rhythm Sync";
  const customTitleInput = document.getElementById('input-video-title');
  if (customTitleInput && customTitleInput.value.trim() !== "") {
    cleanTitle = customTitleInput.value.trim();
  } else if (activeFilename) {
    // Remove directory path and extension
    cleanTitle = activeFilename.replace(/\.[^/.]+$/, "");
  }

  // Adjust font size dynamically to avoid canvas overflow
  let fontSize = 48;
  videoCtx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;
  let textWidth = videoCtx.measureText(cleanTitle).width;
  const maxTitleWidth = width - 120; // 120px padding
  if (textWidth > maxTitleWidth) {
    fontSize = Math.floor(48 * (maxTitleWidth / textWidth));
    if (fontSize < 24) fontSize = 24; // floor limits
    videoCtx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;
    textWidth = videoCtx.measureText(cleanTitle).width;
    // If still too long, truncate with ellipsis
    if (textWidth > maxTitleWidth) {
      let tempTitle = cleanTitle;
      while (tempTitle.length > 0 && videoCtx.measureText(tempTitle + "...").width > maxTitleWidth) {
        tempTitle = tempTitle.slice(0, -1);
      }
      cleanTitle = tempTitle + "...";
    }
  }

  videoCtx.globalAlpha = 0.55;
  videoCtx.fillText(cleanTitle, width / 2, 260);
  videoCtx.restore();

  // 3. Display current BPM
  videoCtx.save();
  videoCtx.fillStyle = '#1A1A1A';
  videoCtx.textAlign = 'center';
  videoCtx.font = '800 130px Inter, system-ui, sans-serif';
  videoCtx.textBaseline = 'middle';
  videoCtx.fillText(Math.round(bpm).toString(), width / 2, 450);

  videoCtx.font = '600 30px Inter, system-ui, sans-serif';
  videoCtx.fillStyle = '#888888';
  videoCtx.fillText('BPM', width / 2, 545);
  videoCtx.restore();

  // 4. Calculate Master Beat counts
  // Visual movement cycle:
  // Duration of one count (eighth note for slow bpm < 110, quarter note for fast bpm >= 110)
  const countDuration = getCountDuration(); 
  const phraseDuration = countDuration * countNotesCount; // 8 visual counts cycle
  
  // Calculate relative time position inside current 8-beat boundary
  const elapsed = playbackTime - offset;
  const countFraction = elapsed / countDuration;
  let countInteger = Math.floor(countFraction);
  let countProgress = countFraction - countInteger; // phase loop [0..1]
  
  // Normalize count index: 1-based index 1-8 loop
  let currentCountIdx = (countInteger % countNotesCount);
  if (currentCountIdx < 0) currentCountIdx += countNotesCount;
  currentCountIdx += 1; // [1..8]

  // Detect impacts (trigger pops)
  const animTime = performance.now() / 1000;
  if (audioBuffer && isPlaying) {
    const lastIntegerVal = videoCanvas.dataset.lastIntVal ? parseInt(videoCanvas.dataset.lastIntVal) : -1;
    if (countInteger !== lastIntegerVal) {
      // Impact target: the start of this count represents landing of previous transition
      lastImpactTimes[currentCountIdx] = animTime;
      videoCanvas.dataset.lastIntVal = countInteger;
    }

    // Custom sub-beat impact for the 6& key clave accent (when countInteger is 5 (count 6) and progress crosses 0.5)
    if (currentMode === "clave" && (countInteger % countNotesCount) === 5) {
      const lastHalfVal = videoCanvas.dataset.lastHalfVal ? parseFloat(videoCanvas.dataset.lastHalfVal) : -1;
      const progressOver05 = countProgress >= 0.5 ? 1 : 0;
      if (progressOver05 !== lastHalfVal) {
        if (progressOver05 === 1) {
          // This represents the 6& offbeat hit! Flash/pop the number 6 with style.
          lastImpactTimes[6] = animTime;
        }
        videoCanvas.dataset.lastHalfVal = progressOver05;
      }
    } else {
      videoCanvas.dataset.lastHalfVal = -1;
    }
  }

  // 5. Salsa Rhythm configuration & numbers setup
  const leftMargin = 140;
  const rightMargin = width - leftMargin;
  const baselineY = 1100;
  const numSpacing = (rightMargin - leftMargin) / (countNotesCount - 1);

  // Spacial X coords of layout numbers 1-8
  const numberPositionsX = [];
  for (let i = 0; i < countNotesCount; i++) {
    numberPositionsX.push(leftMargin + i * numSpacing);
  }

  // Draw Horizontal track line
  videoCtx.save();
  videoCtx.strokeStyle = '#EDEDED';
  videoCtx.lineWidth = 10;
  videoCtx.lineCap = 'round';
  videoCtx.beginPath();
  videoCtx.moveTo(leftMargin - 20, baselineY + 60);
  videoCtx.lineTo(rightMargin + 20, baselineY + 60);
  videoCtx.stroke();
  videoCtx.restore();

  // Active definition function
  const isActiveNumber = (num) => {
    if (currentMode === "salsa") {
      return (num !== 4 && num !== 8);
    } else if (currentMode === "tous") {
      return true;
    } else if (currentMode === "clave") {
      // Clave 2:3 hits on: 2, 3, 5, 8. Note: 6& is offbeat and handled via a double-bounce transition!
      return (num === 2 || num === 3 || num === 5 || num === 8);
    }
    return true;
  };

  // Check bounce transition rule
  const shouldTransitionBounce = (fromNum) => {
    const nextNum = (fromNum % countNotesCount) + 1;
    if (currentMode === "clave") {
      // Transition from 6 to 7 contains 6&, meaning we want to trigger a bounce (the double-bounce)
      if (fromNum === 6) return true;
    }
    return isActiveNumber(nextNum);
  };

  // Draw numbers
  for (let i = 1; i <= countNotesCount; i++) {
    const x = numberPositionsX[i - 1];
    const y = baselineY + 120; // text positioned below timeline line
    
    const isAct = isActiveNumber(i);
    // Pop scaling on landing event
    const impactTime = lastImpactTimes[i];
    const elapsedImpactSec = animTime - impactTime;
    let popScale = 1.0;
    if (elapsedImpactSec > 0 && elapsedImpactSec < 0.6) {
      popScale += 0.35 * Math.exp(-9 * elapsedImpactSec);
    }

    videoCtx.save();
    videoCtx.textAlign = 'center';
    videoCtx.textBaseline = 'middle';
    
    if (isAct) {
      videoCtx.fillStyle = '#1A1A1A';
      videoCtx.font = '800 68px Inter, sans-serif';
    } else {
      videoCtx.fillStyle = '#CCCCCC';
      videoCtx.font = '600 58px Inter, sans-serif';
    }

    // Apply transform pop matrix
    videoCtx.translate(x, y);
    videoCtx.scale(popScale, popScale);
    videoCtx.fillText(i.toString(), 0, 0);

    // If drawing "6" in clave mode, render an elegant "&" offbeat badge that pops on the 6& accent
    if (currentMode === "clave" && i === 6) {
      const ampTime = animTime - lastImpactTimes[6];
      const isLit6Half = ampTime > 0 && ampTime < 0.45;
      
      videoCtx.save();
      videoCtx.fillStyle = isLit6Half ? '#EF4444' : '#CCCCCC';
      // Sync scale with the impact pop animation of index 6
      videoCtx.font = '800 48px Inter, sans-serif';
      videoCtx.fillText('&', 45, -20);
      videoCtx.restore();
    }

    videoCtx.restore();
  }

  // 6. Draw Bouncing Ball
  const previousCellIdx = (countInteger % countNotesCount);
  const nextCellIdx = ((countInteger + 1) % countNotesCount);
  
  const idxFrom0 = previousCellIdx < 0 ? previousCellIdx + countNotesCount : previousCellIdx;
  const idxTo0 = nextCellIdx < 0 ? nextCellIdx + countNotesCount : nextCellIdx;
  
  const fromX = numberPositionsX[idxFrom0];
  const toX = numberPositionsX[idxTo0];

  // Path coordinates
  let ballX = fromX + (toX - fromX) * countProgress;
  let ballY = baselineY + 50; // default baseline offset

  let currentBounceHeight = 0;
  const maxBounceH = 280; // height of parabolic arc

  const fromCountLabelNum = idxFrom0 + 1;
  const isTransitionActive = shouldTransitionBounce(fromCountLabelNum);

  if (isTransitionActive) {
    if (currentMode === "clave" && fromCountLabelNum === 6) {
      // Double bounce for 6 -> 6& -> 7
      if (countProgress < 0.5) {
        const p = countProgress / 0.5; // normalized to [0..1]
        currentBounceHeight = maxBounceH * 0.7 * 4 * p * (1 - p);
      } else {
        const p = (countProgress - 0.5) / 0.5; // normalized to [0..1]
        currentBounceHeight = maxBounceH * 0.7 * 4 * p * (1 - p);
      }
    } else {
      // Parabolic arc bounce
      currentBounceHeight = maxBounceH * 4 * countProgress * (1 - countProgress);
    }
    ballY -= currentBounceHeight;
  } else {
    // Slide flat on baseline without bouncing
    currentBounceHeight = 0;
  }

  // Draw shadow on floor
  videoCtx.save();
  const shadowScaleFactor = 1 - (currentBounceHeight / maxBounceH);
  const shadowW = (50 + 40 * shadowScaleFactor);
  const shadowH = 14 * shadowScaleFactor;
  
  // Red shadow on salsa impacts, black on generic modes
  videoCtx.fillStyle = isTransitionActive ? 'rgba(239, 68, 68, 0.12)' : 'rgba(0,0,0,0.06)';
  
  videoCtx.beginPath();
  videoCtx.ellipse(ballX, baselineY + 60, shadowW, shadowH, 0, 0, 2 * Math.PI);
  videoCtx.fill();
  videoCtx.restore();

  // Draw ball (squash and stretch)
  videoCtx.save();
  videoCtx.fillStyle = '#EF4444'; // Salsa theme red
  
  let scaleX = 1.0;
  let scaleY = 1.0;

  if (isTransitionActive) {
    // Squash & stretch based on parabolic speed
    const velocityFactor = Math.cos(countProgress * Math.PI * 2); // 1 at start, -1 at peak, 1 at end
    if (velocityFactor > 0) {
      // Close to impact: squash
      scaleX = 1.0 + 0.22 * velocityFactor;
      scaleY = 1.0 - 0.22 * velocityFactor;
    } else {
      // In flight: stretch along Y
      scaleX = 1.0 + 0.1 * velocityFactor; // becomes smaller
      scaleY = 1.0 - 0.1 * velocityFactor; // becomes larger
    }
  }

  videoCtx.translate(ballX, ballY);
  videoCtx.scale(scaleX, scaleY);

  // Solid circular path
  videoCtx.beginPath();
  videoCtx.arc(0, 0, 48, 0, 2 * Math.PI);
  videoCtx.fill();

  // Add a nice sleek minimalist reflection highlight dot to make it premium
  videoCtx.fillStyle = '#FFFFFF';
  videoCtx.globalAlpha = 0.35;
  videoCtx.beginPath();
  videoCtx.arc(-14, -14, 10, 0, 2 * Math.PI);
  videoCtx.fill();

  videoCtx.restore();

  // 7. Wide letter-spaced Footer text
  videoCtx.save();
  videoCtx.fillStyle = '#A0AEC0';
  videoCtx.font = '800 24px Inter, system-ui, sans-serif';
  videoCtx.textAlign = 'center';
  
  let labelFooter = "@salsaflubb";

  drawLetterSpacedText(videoCtx, labelFooter, width / 2, 1720, 10);
  videoCtx.restore();
}

// Draw the bottom analytical waveform and grid timeline
function drawTimeline(playbackTime) {
  if (!timelineCtx || !timelineCanvas) return;

  const w = timelineCanvas.width;
  const h = timelineCanvas.height;

  // Clear timeline canvas
  timelineCtx.fillStyle = '#FFFFFF';
  timelineCtx.fillRect(0, 0, w, h);

  if (!audioBuffer) return;

  const totalDuration = audioBuffer.duration;
  
  // Calculate visible window width inside the timeline
  const viewWidth = Math.min(totalDuration, zoomLevel);
  let viewStart = playbackTime - viewWidth / 2;
  
  // Boundary clamp
  if (viewStart < 0) viewStart = 0;
  if (viewStart + viewWidth > totalDuration) viewStart = Math.max(0, totalDuration - viewWidth);
  const viewEnd = viewStart + viewWidth;

  const mapTimeToX = (t) => {
    return ((t - viewStart) / viewWidth) * w;
  };

  const mapXToTime = (x) => {
    return viewStart + (x / w) * viewWidth;
  };

  // 1. Draw Waveform Peaks
  if (timelinePeaks) {
    timelineCtx.save();
    timelineCtx.fillStyle = '#E2E8F0';
    const totalPeaks = timelinePeaks.length;

    // Draw bars inside our window boundaries
    for (let i = 0; i < totalPeaks; i++) {
      const peakTime = (i / totalPeaks) * totalDuration;
      if (peakTime >= viewStart && peakTime <= viewEnd) {
        const x = mapTimeToX(peakTime);
        const peakHeight = timelinePeaks[i] * (h * 0.7);
        const yTop = (h - peakHeight) / 2;
        
        timelineCtx.fillRect(x, yTop, 2.5, peakHeight);
      }
    }
    timelineCtx.restore();
  }

  // 2. Overlay Onset Novelty Curve underneath
  if (noveltyCurve) {
    timelineCtx.save();
    timelineCtx.strokeStyle = 'rgba(239, 68, 68, 0.16)';
    timelineCtx.fillStyle = 'rgba(239, 68, 68, 0.05)';
    timelineCtx.lineWidth = 1.5;
    timelineCtx.beginPath();

    let started = false;
    const len = noveltyCurve.length;
    for (let i = 0; i < len; i++) {
      const t = i / noveltyFps;
      if (t >= viewStart && t <= viewEnd) {
        const x = mapTimeToX(t);
        const y = h - (noveltyCurve[i] * (h * 0.4)) - 10;
        
        if (!started) {
          timelineCtx.moveTo(x, h);
          timelineCtx.lineTo(x, y);
          started = true;
        } else {
          timelineCtx.lineTo(x, y);
        }
      }
    }
    if (started) {
      timelineCtx.lineTo(mapTimeToX(Math.min(viewEnd, len / noveltyFps)), h);
      timelineCtx.closePath();
      timelineCtx.fill();
      timelineCtx.stroke();
    }
    timelineCtx.restore();
  }

  // 3. Draw Grid Lines Loop (Salsa 1-8 beat cycles marker)
  const countDurationSec = getCountDuration();
  // Calculate index boundary of beats visible in window
  const startBeatIdx = Math.floor((viewStart - offset) / countDurationSec);
  const endBeatIdx = Math.ceil((viewEnd - offset) / countDurationSec);

  timelineCtx.save();
  for (let idx = startBeatIdx; idx <= endBeatIdx; idx++) {
    const beatTime = offset + idx * countDurationSec;
    if (beatTime < 0 || beatTime > totalDuration) continue;

    const x = mapTimeToX(beatTime);
    let relativeCount = (idx % countNotesCount);
    if (relativeCount < 0) relativeCount += countNotesCount;
    relativeCount += 1; // [1..8]

    if (relativeCount === 1) {
      // Red Downbeat grid marker
      timelineCtx.strokeStyle = 'rgba(239, 68, 68, 0.7)';
      timelineCtx.lineWidth = 2.5;

      timelineCtx.beginPath();
      timelineCtx.moveTo(x, 0);
      timelineCtx.lineTo(x, h);
      timelineCtx.stroke();

      // Top badge icon circle
      timelineCtx.fillStyle = '#EF4444';
      timelineCtx.beginPath();
      timelineCtx.arc(x, 15, 10, 0, 2 * Math.PI);
      timelineCtx.fill();

      timelineCtx.fillStyle = '#FFFFFF';
      timelineCtx.font = 'bold 11px Inter, sans-serif';
      timelineCtx.textAlign = 'center';
      timelineCtx.textBaseline = 'middle';
      timelineCtx.fillText('1', x, 15);
    } else {
      // Normal beat dividers
      const isActiveNormal = (relativeCount !== 4 && relativeCount !== 8);
      
      timelineCtx.strokeStyle = isActiveNormal ? 'rgba(74, 85, 104, 0.35)' : 'rgba(160, 174, 192, 0.25)';
      timelineCtx.lineWidth = 1;
      timelineCtx.setLineDash([4, 4]);

      timelineCtx.beginPath();
      timelineCtx.moveTo(x, 20);
      timelineCtx.lineTo(x, h);
      timelineCtx.stroke();
      timelineCtx.setLineDash([]); // reset

      // Draw faint counter text
      timelineCtx.fillStyle = isActiveNormal ? '#4A5568' : '#A0AEC0';
      timelineCtx.font = '500 10px Inter, sans-serif';
      timelineCtx.textAlign = 'center';
      timelineCtx.fillText(relativeCount.toString(), x, 15);
    }
  }
  timelineCtx.restore();

  // 4. Paint Playhead line
  const playheadX = mapTimeToX(playbackTime);
  timelineCtx.save();
  timelineCtx.strokeStyle = '#1A1A1A';
  timelineCtx.lineWidth = 2.5;
  timelineCtx.beginPath();
  timelineCtx.moveTo(playheadX, 0);
  timelineCtx.lineTo(playheadX, h);
  timelineCtx.stroke();

  // Draw circular slider pin at top of playhead
  timelineCtx.fillStyle = '#1A1A1A';
  timelineCtx.beginPath();
  timelineCtx.arc(playheadX, 3, 5, 0, 2 * Math.PI);
  timelineCtx.fill();
  timelineCtx.restore();

  // 5. Live playback count sync inside panel
  document.getElementById('cur-playback-time').textContent = `${formatTime(playbackTime)} / ${formatTime(totalDuration)}`;
}

// ==========================================
// MediaRecorder Canvas Video Exporter Engine
// ==========================================
function startVideoExport() {
  if (!audioBuffer || isExporting) return;
  initAudioContext();

  const exportModal = document.getElementById('export-modal');
  const exportProgressBar = document.getElementById('export-progress-bar');
  const exportPercent = document.getElementById('export-percent');
  const exportStatus = document.getElementById('export-status');

  // Activate Modal State
  exportModal.classList.remove('hidden');
  exportProgressBar.style.width = '0%';
  exportPercent.textContent = '0%';
  exportStatus.textContent = "Préparation de l'enregistrement...";

  // 1. Setup media capture stream on logical high-DPI canvas
  const stream = videoCanvas.captureStream(30); // 30 FPS high definition

  // 2. Bind the Web Audio recorder output node stream
  const micTracks = recDest.stream.getAudioTracks();
  if (micTracks.length > 0) {
    stream.addTrack(micTracks[0]);
  } else {
    console.warn("No Web Audio trace tracks available on recDest node. Check node routing!");
  }

  // Choose codec support safely
  let supportedMime = 'video/webm;codecs=vp9,opus';
  if (!MediaRecorder.isTypeSupported(supportedMime)) {
    supportedMime = 'video/webm;codecs=vp8,opus';
  }
  if (!MediaRecorder.isTypeSupported(supportedMime)) {
    supportedMime = 'video/webm';
  }
  if (!MediaRecorder.isTypeSupported(supportedMime)) {
    supportedMime = 'video/mp4;codecs=h264'; // fallback for Safari/iOS contexts
  }

  // Setup options
  const options = {
    mimeType: supportedMime,
    videoBitsPerSecond: 3000000 // 3.0 Mbps for sharp high definition canvas renders
  };

  try {
    recordedChunks = [];
    isExporting = true;
    
    mediaRecorder = new MediaRecorder(stream, options);
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = saveExportedBlob;

    // Reset loop context to absolute beginning to record entire file
    stopAudio();
    
    // Smooth delay before starting playback recording
    setTimeout(() => {
      if (!isExporting) return;
      exportStatus.textContent = "Enregistrement en temps réel...";
      
      // Start recording triggers
      mediaRecorder.start();
      exportStartTime = audioCtx.currentTime;
      playAudio(0);

      // Begin checking recording intervals
      checkExportProgress();
    }, 600);

  } catch (err) {
    console.error("Critical error setting up MediaRecorder: ", err);
    alert("Votre navigateur ne supporte pas l'enregistrement de flux Canvas directement. Essayez Firefox, Chrome ou Edge récent.");
    cancelVideoExport();
  }
}

// Periodically updates the export bar overlay
function checkExportProgress() {
  if (!isExporting) return;
  
  const currentPos = getPlaybackTime();
  const total = audioBuffer.duration;
  let percent = Math.min(100, Math.floor((currentPos / total) * 100));

  document.getElementById('export-progress-bar').style.width = percent + '%';
  document.getElementById('export-percent').textContent = percent + '%';

  if (percent < 100 && isPlaying) {
    setTimeout(checkExportProgress, 250);
  } else {
    // End recording automatically when completed
    setTimeout(() => {
      if (isExporting) completeVideoExport();
    }, 400);
  }
}

// Graceful save files blobs trigger
function completeVideoExport() {
  if (!isExporting) return;
  isExporting = false;
  
  stopAudio();
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function saveExportedBlob() {
  const exportStatus = document.getElementById('export-status');
  exportStatus.textContent = "Finalisation de la vidéo...";
  
  setTimeout(() => {
    try {
      // Gather recorded streams
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
      const downloadUrl = URL.createObjectURL(blob);
      
      // Compute responsive filename
      let saveFilename = "salsa_rhythm_sync_demonstration.webm";
      const customTitleInput = document.getElementById('input-video-title');
      const customTitle = customTitleInput ? customTitleInput.value.trim() : "";
      if (customTitle) {
        // Sanitize title for filename
        const safeTitle = customTitle.replace(/[^a-zA-Z0-9_\-\s]/g, "_").trim();
        saveFilename = `${safeTitle}_salsa_sync.webm`;
      } else if (activeFilename) {
        const titleBody = activeFilename.replace(/\.[^/.]+$/, "");
        saveFilename = `${titleBody}_salsa_sync.webm`;
      }

      // Check for MP4 fallback naming
      if (mediaRecorder.mimeType.includes("mp4")) {
        saveFilename = saveFilename.replace(".webm", ".mp4");
      }

      // Trigger automatic virtual link click download
      const downloader = document.createElement('a');
      downloader.href = downloadUrl;
      downloader.download = saveFilename;
      document.body.appendChild(downloader);
      downloader.click();
      document.body.removeChild(downloader);

      // Clear layout modal
      document.getElementById('export-modal').classList.add('hidden');
      alert(`Exportation réussie !\nLe fichier "${saveFilename}" a été enregistré dans vos Téléchargements.`);

    } catch (e) {
      console.error("Save stream extraction failed: ", e);
      alert("Erreur lors de la sauvegarde du fichier final.");
    }
  }, 500);
}

// Cancels ongoing rendering and cleans states
function cancelVideoExport() {
  isExporting = false;
  stopAudio();
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  document.getElementById('export-modal').classList.add('hidden');
}
