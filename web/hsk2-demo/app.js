const PAGE_START = 21;
const PAGE_END = 29;
const tracksByPage = {
  22: [
    { id: '01-1', label: 'Text · In the school', file: 'hsk2-textbook-0101.mp3' },
    { id: '01-2', label: 'Looking at a picture', file: 'hsk2-textbook-0102.mp3' }
  ],
  23: [
    { id: '01-3', label: 'Text · At home', file: 'hsk2-textbook-0103.mp3' },
    { id: '01-4', label: 'Text · At home', file: 'hsk2-textbook-0104.mp3' }
  ],
  26: [
    { id: '01-5', label: 'Pronunciation · Stress in disyllabic words', file: 'hsk2-textbook-0105.mp3' }
  ]
};

const pageImage = document.querySelector('#book-page');
const pageInput = document.querySelector('#page-number');
const stage = document.querySelector('#page-stage');
const trackList = document.querySelector('#track-list');
let page = PAGE_START;
let zoom = 1;

function renderPage() {
  pageInput.value = page;
  pageImage.src = `assets/pages/pdf-${String(page).padStart(3, '0')}.jpg`;
  pageImage.alt = `Textbook PDF page ${page}, printed page ${page - 20}`;
  document.querySelector('#previous').disabled = page === PAGE_START;
  document.querySelector('#next').disabled = page === PAGE_END;
  document.querySelectorAll('.page-thumb').forEach(button => {
    if (Number(button.dataset.page) === page) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  });
  renderTracks();
  setZoom(1);
}

function renderTracks() {
  const tracks = tracksByPage[page] || [];
  if (!tracks.length) {
    trackList.innerHTML = '<div class="empty-audio">There is no linked recording on this page. Turn to a page with a numbered audio icon to listen.</div>';
    return;
  }
  trackList.innerHTML = tracks.map(track => `
    <div class="track">
      <div class="track-title">
        <span class="play-mark" aria-hidden="true">▶</span>
        <span><strong>${track.id}</strong><small>${track.label}</small></span>
      </div>
      <audio controls preload="none" aria-label="Play track ${track.id}">
        <source src="assets/audio/${track.file}" type="audio/mpeg">
      </audio>
    </div>`).join('');
}

function setPage(value) {
  const nextPage = Number(value);
  if (!Number.isInteger(nextPage) || nextPage < PAGE_START || nextPage > PAGE_END) {
    pageInput.value = page;
    return;
  }
  page = nextPage;
  renderPage();
}

function setZoom(value) {
  zoom = Math.max(0.65, Math.min(2.4, value));
  pageImage.style.width = `${Math.min(100, zoom * 100)}%`;
  if (zoom > 1) pageImage.style.maxWidth = 'none';
  else pageImage.style.maxWidth = '100%';
  document.querySelector('#fit').textContent = zoom === 1 ? 'Fit' : `${Math.round(zoom * 100)}%`;
}

for (let n = PAGE_START; n <= PAGE_END; n++) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'page-thumb';
  button.dataset.page = String(n);
  button.textContent = String(n);
  button.setAttribute('aria-label', `Go to PDF page ${n}`);
  button.addEventListener('click', () => setPage(n));
  document.querySelector('#page-strip').append(button);
}

document.querySelector('#previous').addEventListener('click', () => setPage(page - 1));
document.querySelector('#next').addEventListener('click', () => setPage(page + 1));
pageInput.addEventListener('change', () => setPage(pageInput.value));
document.querySelector('#zoom-in').addEventListener('click', () => setZoom(zoom + 0.15));
document.querySelector('#zoom-out').addEventListener('click', () => setZoom(zoom - 0.15));
document.querySelector('#fit').addEventListener('click', () => setZoom(1));
document.querySelector('#fullscreen').addEventListener('click', async () => {
  if (!document.fullscreenElement) await document.querySelector('.reader-main').requestFullscreen?.();
  else await document.exitFullscreen?.();
});
document.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLAudioElement) return;
  if (event.key === 'ArrowLeft') setPage(page - 1);
  if (event.key === 'ArrowRight') setPage(page + 1);
});

renderPage();
