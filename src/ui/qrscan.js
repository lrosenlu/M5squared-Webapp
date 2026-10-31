// QR key scanner: native BarcodeDetector when available, vendored jsQR otherwise.
import { parseKeyInput } from '../crypto.js';
import { app, wheels, render } from '../state.js';
import { $ } from './dom.js';

let jsqrPromise = null;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  jsqrPromise ??= new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/jsQR.js'; s.onload = () => res(window.jsQR); s.onerror = () => rej(new Error('QR decoder failed to load')); document.head.append(s); });
  return jsqrPromise;
}

export async function scanKey(side) {
  const dlg = $('#scanDlg'), video = $('#scanVideo'), msg = $('#scanMsg');
  if (!navigator.mediaDevices?.getUserMedia) { wheels[side].error = 'This browser cannot open the camera. Type the QR text instead.'; return render(); }
  let stream, stop = false;
  const cleanup = () => { stop = true; try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ } video.srcObject = null; };
  dlg.addEventListener('close', cleanup, { once: true });
  msg.textContent = 'Starting camera...'; dlg.showModal();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = stream; await video.play();
    msg.textContent = 'Point the camera at the QR code on the wheel label.';
    const detector = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
    const jsQR = detector ? null : await loadJsQR();
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    while (!stop) {
      await new Promise((r) => setTimeout(r, 150));
      if (!video.videoWidth) continue;
      let text = null;
      if (detector) { const f = await detector.detect(video).catch(() => []); text = f[0]?.rawValue ?? null; }
      else { canvas.width = video.videoWidth; canvas.height = video.videoHeight; ctx.drawImage(video, 0, 0); const img = ctx.getImageData(0, 0, canvas.width, canvas.height); text = jsQR(img.data, img.width, img.height)?.data ?? null; }
      if (!text) continue;
      try { parseKeyInput(text.trim()); } catch { msg.textContent = 'That QR code is not a wheel key. Keep scanning...'; continue; }
      app.keyDraft[side] = text.trim(); dlg.close(); wheels[side].error = ''; render(); return;
    }
  } catch (e) { dlg.close(); wheels[side].error = 'Camera error: ' + (e.message || e); render(); }
}
