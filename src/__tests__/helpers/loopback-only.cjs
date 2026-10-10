// Test-only preload (NODE_OPTIONS=--require): any socket connect to a host that is not loopback throws, so a
// child process under test can never reach the real network, whatever it tries. Inherited by grandchildren.
const net = require('node:net');
const real = net.Socket.prototype.connect;
const loopback = (h) => h === undefined || h === null || h === 'localhost' || h === '::1' || h === '127.0.0.1' || /^127\./.test(String(h));
net.Socket.prototype.connect = function (...args) {
  const a = args[0];
  const host = a && typeof a === 'object' && !Array.isArray(a) ? a.host : undefined;
  if (a && typeof a === 'object' && a.path) return real.apply(this, args);
  if (!loopback(host)) throw new Error(`loopback-only preload: refused a connection to ${String(host)}`);
  return real.apply(this, args);
};
