'use strict';

(() => {
  let operation = null;
  let busy = false;
  const notify = (text, error = false) => typeof showToast === 'function' ? showToast(text, error) : toast(text, error);
  const buttons = ['clearFilesButton', 'clearHistoryButton', 'maintenanceSubmit', 'maintenanceCancel'];
  function setBusy(value) { busy = value; for (const id of buttons) $(id).disabled = value; }
  async function openMaintenance(reset) {
    if (busy) return;
    try {
      const saved = await window.repoDrive.getSettings();
      if (!saved.repository) throw new Error('请先保存仓库连接设置。');
      operation = { reset, repository: saved.repository };
      $('maintenanceTitle').textContent = reset ? '清除历史（force push）' : '清空全部文件';
      $('maintenanceScope').textContent = `分支：${saved.branch}。` + (reset
        ? '影响整个分支，不受根目录限制。保留文件；旧历史与原上传时间将丢失。其他分支、标签、PR 可能保留旧对象，空间不会立即释放。请暂停其他人的推送。'
        : `删除范围：${saved.rootPath || '整个分支'} 内全部文件和子目录。保留范围外文件及旧历史。`);
      $('maintenanceRepo').textContent = saved.repository;
      $('maintenanceInput').value = '';
      $('maintenanceDialog').showModal(); $('maintenanceInput').focus();
    } catch (error) { notify(error.message, true); }
  }
  $('clearFilesButton').onclick = () => openMaintenance(false);
  $('clearHistoryButton').onclick = () => openMaintenance(true);
  $('maintenanceCancel').onclick = () => $('maintenanceDialog').close();
  $('maintenanceDialog').addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  $('maintenanceForm').onsubmit = async (event) => {
    event.preventDefault(); if (busy || !operation) return;
    if ($('maintenanceInput').value.trim() !== operation.repository) { notify('代码仓名称不匹配。', true); return; }
    setBusy(true);
    try {
      const result = await window.repoDrive[operation.reset ? 'clearHistory' : 'clearFiles'](operation.repository);
      if (result.canceled) return;
      $('maintenanceDialog').close();
      state.expanded.clear(); state.selectedItems?.clear();
      if ('selectedPath' in state) { state.selectedPath = ''; renderLocation(); }
      await refreshTree();
      notify(operation.reset ? '历史已清除，当前文件保持不变' : result.unchanged ? '文件盘已经为空' : '文件已清空，旧历史仍保留');
    } catch (error) { notify(String(error.message).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, ''), true); }
    finally { setBusy(false); }
  };
})();
