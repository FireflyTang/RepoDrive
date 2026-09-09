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

function assertCredentialPolicy(permissions = {}, platform = process.platform) {
  if (platform === 'win32' && permissions.push) {
    const error = new Error('Windows 只读版拒绝使用有写权限的 Token。请创建 Contents: Read-only 的细粒度 Token。');
    error.code = 'WINDOWS_TOKEN_NOT_READONLY';
    throw error;
  }
}

module.exports = { canUpload, assertUploadAllowed, assertCredentialPolicy };
