import crypto from 'crypto';

export type ExtractResult = {
  pages: Array<{
    number: number;
    text_blocks: string[];
    tables: string[][][]; // tables[tableIndex][row][col]
  }>;
};

export async function sha256(buffer: ArrayBuffer): Promise<string> {
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from(buffer));
  return hash.digest('hex');
}

export async function extractWithPython(pdfBuffer: ArrayBuffer, fileName: string): Promise<ExtractResult> {
  const raw = process.env.PDF_EXTRACTOR_URL;
  let url = raw;
  if (raw) {
    const trimmed = raw.trim();
    // If user provided base URL without path, append /extract automatically
    url = /\/?extract\/?$/.test(trimmed) ? trimmed.replace(/\/?$/, '') : `${trimmed.replace(/\/?$/, '')}/extract`;
  }
  if (!url) throw new Error('Missing PDF_EXTRACTOR_URL');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(fileName) },
    body: Buffer.from(pdfBuffer),
    // 60s timeout by platform
  });
  if (!res.ok) throw new Error(`Extractor failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data as ExtractResult;
}
