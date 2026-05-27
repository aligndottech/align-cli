export class AuthExpiredError extends Error {
  constructor(public readonly source: string) {
    super(`${source} token expired or revoked. Run: align setup to reconnect.`);
    this.name = 'AuthExpiredError';
  }
}
