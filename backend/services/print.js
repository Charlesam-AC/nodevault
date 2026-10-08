// Silent A4 print from the API process. No browser dialog and no websocket agent.
// stub writes the PDF to disk. raw sends it to host:9100. ipp sends an IPP Print-Job.
const fs = require('fs');
const net = require('net');
const path = require('path');

function pdfBuffer(job) {
  if (job.pdf_base64) return Buffer.from(job.pdf_base64, 'base64');
  if (Buffer.isBuffer(job.pdf)) return job.pdf;
  return null;
}

function assertTarget(target) {
  if (!target || !String(target).trim()) {
    throw new Error('branch printer_target is not set');
  }
  const trimmed = String(target).trim();
  if (trimmed === 'Vault_Master_Printer_01') {
    throw new Error('a single global printer name is not used');
  }
  return trimmed;
}

function parseTarget(target) {
  const trimmed = assertTarget(target);
  if (/^ipp:\/\//i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    return { transport: 'ipp', url: trimmed };
  }
  const match = /^([^:\s/]+):(\d{1,5})$/.exec(trimmed) || /^([^:\s/]+)$/.exec(trimmed);
  if (!match) throw new Error('printer_target must be host, host:port, or an IPP URL');
  const port = match[2] ? Number(match[2]) : 9100;
  if (port < 1 || port > 65535) throw new Error('printer port is out of range');
  return { transport: 'raw', host: match[1], port };
}

function writeStub(job, pdf) {
  const dir = process.env.PRINT_STUB_DIR || '/tmp/nodevault-prints';
  fs.mkdirSync(dir, { recursive: true });
  const kind = String(job.documentKind || 'job').replace(/[^A-Za-z0-9_]/g, '') || 'job';
  const file = path.join(dir, `${Date.now()}-${kind}-${job.branchId || 'branch'}.pdf`);
  fs.writeFileSync(file, pdf);
  return file;
}

function ippAttribute(tag, name, value) {
  const nameBuf = Buffer.from(name);
  const valueBuf = Buffer.from(value);
  const out = Buffer.alloc(1 + 2 + nameBuf.length + 2 + valueBuf.length);
  out[0] = tag;
  out.writeUInt16BE(nameBuf.length, 1);
  nameBuf.copy(out, 3);
  out.writeUInt16BE(valueBuf.length, 3 + nameBuf.length);
  valueBuf.copy(out, 5 + nameBuf.length);
  return out;
}

function ippPrintJob(url, pdf) {
  const operation = Buffer.from([
    0x01, 0x01,
    0x00, 0x02,
    0x00, 0x00, 0x00, 0x01,
    0x01,
  ]);
  const attributes = Buffer.concat([
    ippAttribute(0x47, 'attributes-charset', 'utf-8'),
    ippAttribute(0x48, 'attributes-natural-language', 'en-us'),
    ippAttribute(0x45, 'printer-uri', url),
    ippAttribute(0x49, 'document-format', 'application/pdf'),
  ]);
  return Buffer.concat([operation, attributes, Buffer.from([0x03]), pdf]);
}

function sendRaw(host, port, pdf) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => {
      socket.end(pdf);
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`printer ${host}:${port} did not accept the job`));
    }, 8000);
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('finish', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function sendIpp(url, pdf) {
  const body = ippPrintJob(url, pdf);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/ipp' },
    body,
  });
  if (!response.ok) throw new Error(`printer rejected the job (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length >= 4) {
    const status = bytes.readUInt16BE(2);
    if (status >= 0x0400) throw new Error(`printer rejected the job (IPP ${status})`);
  }
  return bytes.length;
}

async function triggerSilentPrinter(job) {
  const mode = process.env.PRINTER_MODE || 'stub';
  const pdf = pdfBuffer(job);
  if (!pdf || !pdf.length || !pdf.slice(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new Error('print job has no PDF');
  }
  if (mode === 'stub') {
    const file = writeStub(job, pdf);
    const target = job.printerTarget ? assertTarget(job.printerTarget) : null;
    if (!target) throw new Error('branch printer_target is not set');
    return { mode: 'stub', printerTarget: target, file, bytes: pdf.length };
  }
  const target = parseTarget(job.printerTarget);
  if (mode === 'raw' || (mode !== 'ipp' && mode !== 'network' && target.transport === 'raw')) {
    if (target.transport !== 'raw') throw new Error('raw printing needs a host or host:port');
    await sendRaw(target.host, target.port, pdf);
    return { mode: 'raw', printerTarget: job.printerTarget, bytes: pdf.length };
  }
  if (mode === 'ipp' || target.transport === 'ipp') {
    if (target.transport !== 'ipp') throw new Error('IPP printing needs an ipp or http URL');
    await sendIpp(target.url, pdf);
    return { mode: 'ipp', printerTarget: target.url, bytes: pdf.length };
  }
  if (mode === 'network') {
    const url = process.env.PRINTER_URL;
    if (!url) throw new Error('PRINTER_URL is required when PRINTER_MODE=network');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: pdf,
    });
    if (!response.ok) throw new Error(`printer rejected the job (${response.status})`);
    return { mode: 'network', printerTarget: assertTarget(job.printerTarget) };
  }
  throw new Error(`Unknown PRINTER_MODE ${mode}`);
}

module.exports = {
  triggerSilentPrinter,
  parseTarget,
  ippPrintJob,
};
