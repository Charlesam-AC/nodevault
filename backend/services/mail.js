const nodemailer = require('nodemailer');

async function sendClosingSheet({ to, cc, subject, text }) {
  const mode = process.env.MAIL_MODE || 'stub';
  if (mode === 'stub') {
    console.log(JSON.stringify({ event: 'closing_email', to, cc, subject }));
    return { mode: 'stub' };
  }
  if (mode === 'smtp') {
    if (!process.env.SMTP_HOST) {
      throw new Error('SMTP_HOST is required when MAIL_MODE=smtp');
    }
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' }
        : undefined,
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || 'nodevault@localhost',
      to,
      cc,
      subject,
      text,
    });
    return { mode: 'smtp' };
  }
  throw new Error(`Unknown MAIL_MODE ${mode}`);
}

module.exports = { sendClosingSheet };
