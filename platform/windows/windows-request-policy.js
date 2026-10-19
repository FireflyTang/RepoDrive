'use strict';

// Windows has no content upload endpoint. Maintenance may only delete tree
// entries, create commits referring to trees, and update the configured branch.
function assertWindowsRequest(apiPath, options, config) {
  const method = options.method || 'GET';
  const prefix = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  const branch = config.branch.split('/').map(encodeURIComponent).join('/');
  const body = options.body || {};
  const only = (keys) => Object.keys(body).every((key) => keys.includes(key));
  if (method === 'GET') return;
  if (method === 'DELETE' && apiPath.startsWith(`${prefix}/contents/`) && body.branch === config.branch && typeof body.sha === 'string' && only(['message', 'sha', 'branch'])) return;
  if (method === 'POST' && apiPath === `${prefix}/git/trees` && only(['base_tree', 'tree']) && typeof body.base_tree === 'string' && Array.isArray(body.tree) && body.tree.length && body.tree.every((entry) => entry.sha === null && typeof entry.path === 'string' && Object.keys(entry).every((key) => ['path', 'mode', 'type', 'sha'].includes(key)))) return;
  if (method === 'POST' && apiPath === `${prefix}/git/commits` && only(['message', 'tree', 'parents']) && typeof body.tree === 'string' && Array.isArray(body.parents) && body.parents.length <= 1 && body.parents.every((sha) => typeof sha === 'string')) return;
  if (method === 'PATCH' && apiPath === `${prefix}/git/refs/heads/${branch}` && only(['sha', 'force']) && typeof body.sha === 'string' && typeof body.force === 'boolean') return;
  throw new Error('Windows 禁止上传、重命名及非清理用途的写入请求。');
}
module.exports = { assertWindowsRequest };
