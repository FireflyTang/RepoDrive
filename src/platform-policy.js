'use strict';

function canUpload(platform = process.platform) {
  return platform === 'darwin' || platform === 'linux';
}

function assertUploadAllowed(platform = process.platform) {
  if (!canUpload(platform)) {
    const error = new Error('此平台为只读模式：Windows 不允许上传。');
    error.code = 'UPLOAD_PLATFORM_BLOCKED';
    throw error;
  }
}

function assertCredentialPolicy() {}

module.exports = { canUpload, assertUploadAllowed, assertCredentialPolicy };
