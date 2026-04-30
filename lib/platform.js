// Platform abstraction layer.
// Each module exports the same surface; main.js picks one based on
// process.platform and the rest of the codebase stays platform-agnostic.

const { platform } = require('process');

let impl;
if (platform === 'win32')      impl = require('./platform-win32');
else if (platform === 'darwin') impl = require('./platform-darwin');
else                            impl = require('./platform-linux');

module.exports = impl;
module.exports.id = platform;
