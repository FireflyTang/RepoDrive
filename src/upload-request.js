'use strict';

function uploadError(message, code, status = 0) {
  return Object.assign(new Error(message), { name: 'UploadRequestError', code, status });
}

function uploadCanceledError() {
  return Object.assign(new Error('上传已取消；已发出的提交请求可能已生效，请核对代码仓'), {
    name: 'AbortError', code: 'UPLOAD_CANCELED'
  });
}

function httpErrorMessage(status, detail) {
  const hints = { 401: 'Token 无效或已过期', 403: '没有权限或已触发 GitHub 限制', 404: '找不到代码仓、分支或路径', 409: '代码仓为空或文件冲突', 422: '提交内容不符合 GitHub 要求' };
  let data = detail;
  if (typeof detail === 'string') {
    try { data = JSON.parse(detail); } catch { /* Keep non-JSON server details. */ }
  }
  const explanation = data && typeof data === 'object'
    ? [data.message, data.errors ? `errors: ${JSON.stringify(data.errors)}` : ''].filter(Boolean).join('; ')
    : String(data || '');
  return `${hints[status] || 'GitHub 请求失败'} (HTTP ${status})${explanation ? `：${explanation}` : ''}`;
}

// Abort/error events can arrive after the writable stream's early close. This
// guard captures no upload state and lives only as long as the transport object.
function ignoreLateError() {}

// Uses the caller's Electron session, including its configured proxy. Never retries
// a write, including redirects which could otherwise replay the request body.
function uploadRequest(net, url, { body, headers, session, onUploadProgress, signal }) {
  return new Promise((resolve, reject) => {
    let request;
    let responseEnded = false;
    let settled = false;
    let poll;
    let chunks = [];
    const listeners = [];
    const listen = (target, event, handler) => {
      target.on(event, handler);
      listeners.push({ target, event, handler });
    };
    const detach = () => {
      for (let i = listeners.length - 1; i >= 0; i -= 1) {
        const { target, event, handler } = listeners[i];
        target.removeListener(event, handler);
        if (event === 'error') target.on('error', ignoreLateError);
      }
      listeners.length = 0;
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      signal?.removeEventListener('abort', cancel);
      chunks = [];
      detach();
      if (error) {
        try { if (!responseEnded) request?.abort(); } catch { /* Preserve the original failure. */ }
        reject(error);
      } else resolve(value);
    };
    const cancel = () => finish(uploadCanceledError());
    const networkError = (error) => finish(uploadError(
      `GitHub 上传网络错误：${error.message || '连接中断'}，请检查系统网络或代理设置`, 'ENETWORK'));
    let lastSent = -1;
    let lastTotal = -1;
    const report = (sent, total) => {
      if (settled || !Number.isFinite(sent) || !Number.isFinite(total) || total <= 0 || sent < 0 || sent > total) return;
      if (sent < lastSent || (sent === lastSent && total === lastTotal)) return;
      lastSent = sent;
      lastTotal = total;
      try { onUploadProgress?.({ sent, total }); }
      catch { finish(uploadError('GitHub 上传进度回调失败', 'EPROGRESS')); }
    };
    const readProgress = () => {
      if (settled || !request.getUploadProgress) return;
      try {
        const progress = request.getUploadProgress();
        if (progress.active && progress.started) report(progress.current, progress.total);
      } catch (error) { networkError(error); }
    };
    try {
      if (signal?.aborted) {
        cancel();
        return;
      }
      request = net.request({ url, method: 'POST', session, cache: 'no-store', redirect: 'error' });
      listen(request, 'error', networkError);
      listen(request, 'abort', () => finish(uploadError('GitHub 上传已中止', 'EABORTED')));
      // Electron 38's writable close can precede response headers. Only the
      // response end/error/aborted/close events describe response completion.
      listen(request, 'upload-progress', (_event, sent, total) => report(sent, total));
      listen(request, 'response', (response) => {
        listen(response, 'error', networkError);
        listen(response, 'aborted', () => finish(uploadError('GitHub 上传响应已中止', 'EABORTED')));
        listen(response, 'close', () => finish(uploadError('GitHub 上传响应提前关闭', 'ECONNCLOSED')));
        listen(response, 'end', () => {
          responseEnded = true;
          const text = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode;
          if (status < 200 || status >= 300) {
            finish(uploadError(httpErrorMessage(status, text), 'EHTTP', status));
            return;
          }
          try { finish(null, status === 204 ? null : JSON.parse(text)); }
          catch { finish(uploadError('GitHub 上传返回了无效的 JSON 响应', 'ERESPONSE', status)); }
        });
        listen(response, 'data', (chunk) => { chunks.push(Buffer.from(chunk)); });
        readProgress();
      });
      for (const [name, value] of Object.entries(headers || {})) request.setHeader(name, value);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) {
        cancel();
        return;
      }
      // Electron 38 exposes getUploadProgress(), not an upload-progress event.
      // finish/write callbacks only mean buffered, and must never count as sent.
      poll = setInterval(readProgress, 200);
      request.end(body);
    } catch (error) {
      networkError(error);
      if (!request) detach();
    }
  });
}

module.exports = { uploadRequest, uploadCanceledError, httpErrorMessage };
