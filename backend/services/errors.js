class VaultError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
    this.status = status;
  }
}

module.exports = { VaultError };
