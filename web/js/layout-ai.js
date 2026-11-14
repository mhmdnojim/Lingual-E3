// Optional paid layout analysis. API keys and models are managed in Admin → API.
export async function requestAILayout(book, page, refresh, progress) {
  const response = await fetch(`/api/books/${book}/layout-ai/${page}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ progress: true, refresh }),
  }).catch(() => null);
  if (!response) throw new Error('The app server could not be reached. Your current outlines are kept.');
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `AI layout request failed (${response.status}).`);
  }
  if (!(response.headers.get('Content-Type') || '').includes('application/x-ndjson')) return response.json();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', result;
  const accept = (line) => {
    if (!line.trim()) return;
    const data = JSON.parse(line);
    if (data.error) throw new Error(data.error);
    if (Number.isInteger(data.at)) progress(data.at, data.message || 'Analyzing…');
    if (data.result) result = data.result;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        accept(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      }
    }
    buffer += decoder.decode();
    accept(buffer);
  } finally { reader.releaseLock(); }
  if (!result) throw new Error('The AI connection ended before a result arrived. Your current outlines are kept. Reopening a completed cached suggestion does not call OpenAI again.');
  return result;
}
