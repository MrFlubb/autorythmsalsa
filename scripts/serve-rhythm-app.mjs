import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Port 3000 is required by the container environment to display the app in the preview iframe.
const PORT = process.env.PORT || 3000;

// Path to the rhythm-app directory
const rhythmAppPath = path.join(__dirname, '../rhythm-app');

// 1. YouTube Audio Downloader Proxy API
app.get('/api/download-youtube-audio', async (req, res) => {
  const ytUrl = req.query.url;
  if (!ytUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // List of public Cobalt APIs to try in order of preference
  const cobaltEndpoints = [
    'https://cobalt.canine.tools',
    'https://cobalt.meowing.de',
    'https://cobalt.esb.is',
    'https://api.cobalt.tools',
    'https://cobalt.api.red'
  ];

  let lastError = null;

  for (const endpoint of cobaltEndpoints) {
    try {
      console.log(`[YouTube Proxy] Attempting Cobalt endpoint: ${endpoint} for URL: ${ytUrl}`);

      // Call public Cobalt instance
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        body: JSON.stringify({
          url: ytUrl,
          downloadMode: 'audio',
          audioFormat: 'mp3',
          audioQuality: '128', // ensure fast download (v7)
          audioBitrate: '128', // ensure fast download (v10)
          isAudioOnly: true
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(`[YouTube Proxy] Endpoint ${endpoint} returned non-ok status: ${response.status}. Response: ${errorText}`);
        lastError = `Statut ${response.status} de la passerelle.`;
        continue; // Try next endpoint
      }

      const data = await response.json();
      console.log(`[YouTube Proxy] Successful response from ${endpoint}:`, data);

      if (data.status === 'error' || data.type === 'error' || data.error) {
        const errMsg = data.text || (data.error && data.error.message) || data.message || "Erreur de téléchargement.";
        console.warn(`[YouTube Proxy] Endpoint ${endpoint} returned error payload:`, errMsg);
        lastError = errMsg;
        continue; // Try next endpoint
      }

      const audioUrl = data.url || (data.picker && data.picker[0] && data.picker[0].url) || (data.picker && data.picker[0] && data.picker[0].audio);

      if (!audioUrl) {
        console.warn(`[YouTube Proxy] Endpoint ${endpoint} did not return a valid audio stream URL in the payload.`);
        lastError = "Aucun lien de flux audio direct trouvé dans la réponse.";
        continue;
      }

      console.log(`[YouTube Proxy] Fetching audio from direct stream URL: ${audioUrl}`);
      
      // Fetch the binary audio stream and proxy it back to client
      const audioStreamResponse = await fetch(audioUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      
      if (!audioStreamResponse.ok) {
        console.warn(`[YouTube Proxy] Failed to fetch direct audio stream from ${audioUrl}. Status: ${audioStreamResponse.status}`);
        lastError = `Échec de récupération du fichier audio d'origine (Statut: ${audioStreamResponse.status}).`;
        continue;
      }

      // Proxy back content headers
      res.setHeader('Content-Type', audioStreamResponse.headers.get('Content-Type') || 'audio/mpeg');
      res.setHeader('Content-Disposition', 'inline; filename="youtube_audio.mp3"');

      const buffer = await audioStreamResponse.arrayBuffer();
      console.log(`[YouTube Proxy] Successfully piped ${buffer.byteLength} bytes to client from ${endpoint}`);
      return res.send(Buffer.from(buffer));

    } catch (err) {
      console.error(`[YouTube Proxy] Error during attempt with ${endpoint}:`, err);
      lastError = err.message || err;
    }
  }

  // If we reach here, all endpoints failed
  console.error('[YouTube Proxy] All Cobalt endpoints exhausted.');
  return res.status(502).json({ 
    error: `Impossible d'extraire la musique du lien YouTube. Détail de l'erreur : ${lastError}. Vous pouvez toujours glisser-déposer un fichier audio local.` 
  });
});

app.use(express.static(rhythmAppPath));

app.get('*', (req, res) => {
  res.sendFile(path.join(rhythmAppPath, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('==================================================');
  console.log(`Salsa Rhythm Sync server running on Port ${PORT}`);
  console.log(`Access your application at http://localhost:${PORT}`);
  console.log('==================================================');
});
