// jsdom runs tests in its own realm, but Buffer comes from node.js.
// So "buffer instanceof Uint8Array" is false inside tests, and node-forge silently
// hashes and signs empty data. Use the node.js typed arrays to make crypto work as in a browser.
global.Uint8Array = Object.getPrototypeOf(Buffer.prototype).constructor;
global.ArrayBuffer = Buffer.alloc(1).buffer.constructor;
