// Silent network print. Nothing is drawn in the browser.
// stub logs the job. network POSTs the raw closing sheet to PRINTER_URL.

async function triggerSilentPrinter({ branchId, printerTarget, document }) {
  const mode = process.env.PRINTER_MODE || 'stub';
  const target = printerTarget || process.env.PRINTER_TARGET || 'Vault_Master_Printer_01';
  if (mode === 'stub') {
    console.log(JSON.stringify({
      event: 'silent_print',
      branchId,
      printerTarget: target,
      bytes: Buffer.byteLength(document),
    }));
    return { mode: 'stub', printerTarget: target };
  }
  if (mode === 'network') {
    const url = process.env.PRINTER_URL;
    if (!url) {
      throw new Error('PRINTER_URL is required when PRINTER_MODE=network');
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: document,
    });
    if (!response.ok) {
      throw new Error(`printer rejected the job (${response.status})`);
    }
    return { mode: 'network', printerTarget: target };
  }
  throw new Error(`Unknown PRINTER_MODE ${mode}`);
}

module.exports = { triggerSilentPrinter };
