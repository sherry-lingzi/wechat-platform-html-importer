(() => {
  'use strict';

  const APP_ID = 'codex-wechat-html-import';
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
  const HTML_EXT = /\.html?$/i;
  const MAX_LOG_LINES = 120;
  const UPLOAD_TIMEOUT_MS = 45000;
  const UPLOAD_RETRY_LIMIT = 1;
  const IMAGE_MAPPING_STORAGE_KEY = 'codexWechatHtmlImageMappingsV1';
  const UPLOAD_RESULT_SETTLE_MS = 900;
  let state = {
    files: [],
    htmlCandidates: [],
    htmlFile: null,
    html: '',
    bodyHtml: '',
    images: [],
    imageMap: new Map(),
    uploadedLocalPaths: new Set(),
    restoredImageCount: 0,
    metadata: null,
  };

  if (document.getElementById(`${APP_ID}-launcher`)) return;

  const launcher = document.createElement('button');
  launcher.id = `${APP_ID}-launcher`;
  launcher.type = 'button';
  launcher.textContent = '导入 HTML';
  launcher.title = '导入 Codex 生成的推文 HTML（自用版）';
  launcher.addEventListener('click', openDialog);
  document.documentElement.appendChild(launcher);

  function openDialog() {
    const old = document.getElementById(`${APP_ID}-dialog`);
    if (old) {
      old.__codexCloseDialog?.();
      return;
    }

    const restorePageScroll = lockPageScroll();
    const host = document.createElement('div');
    host.id = `${APP_ID}-dialog`;
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483001;overflow:hidden;background:rgba(0,0,0,.48);display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = dialogTemplate();
    document.documentElement.appendChild(host);
    const closeDialog = () => {
      restorePageScroll();
      host.remove();
    };
    host.__codexCloseDialog = closeDialog;

    const $ = (selector) => shadow.querySelector(selector);
    $('#close').addEventListener('click', closeDialog);
    $('#folder').addEventListener('change', (event) => readFolder(event.target.files, shadow));
    $('#html').addEventListener('change', (event) => readSingleHtml(event.target.files, shadow));
    $('#html-choice').addEventListener('change', (event) => {
      const file = state.htmlCandidates[Number(event.target.value)];
      if (file) void loadHtmlFile(file, shadow);
    });
    $('#clear').addEventListener('click', () => reset(shadow));
    $('#insert').addEventListener('click', () => {
      if (insertIntoEditor(shadow)) host.__codexCloseDialog?.();
    });
    $('#native-upload').addEventListener('click', () => uploadImagesNatively(shadow));
    $('#clear-image-mappings').addEventListener('click', () => clearStoredImageMappings(shadow));
    $('#apply-meta').addEventListener('click', () => applyArticleMetadata(shadow));
    $('#upload-cover-library').addEventListener('click', () => uploadCoverToLibrary(shadow));
    $('#copy').addEventListener('click', () => copyHtml(shadow));
    if (state.bodyHtml) restoreDialogState(shadow);
    else log(shadow, '提示：此扩展只在当前已登录的公众号后台页面运行，不读取账号密码，也不调用公众号开放 API。');
  }

  function dialogTemplate() {
    return `
      <style>
        :host { color: #222; font-family: -apple-system, BlinkMacSystemFont, "Microsoft YaHei", sans-serif; }
        * { box-sizing: border-box; }
        .panel { width: min(1120px, 100%); height:100%; overflow:hidden; display:flex; flex-direction:column; background: #fff; border-radius: 14px; box-shadow: 0 20px 70px rgba(0,0,0,.35); }
        header { display:flex; align-items:center; justify-content:space-between; padding:18px 22px; border-bottom:1px solid #e7e7e7; background:#fff; }
        h1 { margin:0; font-size:18px; }
        .close { border:0; background:transparent; font-size:28px; line-height:1; color:#777; cursor:pointer; }
        .body { flex:1; display:grid; grid-template-columns: 330px 1fr; gap:18px; min-height:0; padding:18px 22px; overflow:hidden; }
        .left { display:flex; flex-direction:column; gap:12px; min-height:0; overflow-x:hidden; overflow-y:auto; padding-right:6px; scrollbar-width:thin; scrollbar-color:#b8c0c5 transparent; }
        .left::-webkit-scrollbar { width:8px; }
        .left::-webkit-scrollbar-thumb { background:#b8c0c5; border:2px solid transparent; border-radius:99px; background-clip:content-box; }
        .left::-webkit-scrollbar-track { background:transparent; }
        .card { border:1px solid #e6e6e6; border-radius:10px; padding:14px; background:#fff; }
        .card h2 { margin:0 0 8px; font-size:14px; }
        .hint { margin:0; color:#777; font-size:12px; line-height:1.7; }
        label.file { display:block; margin:9px 0 0; padding:10px 12px; border:1px dashed #b8c0c5; border-radius:8px; color:#176c42; font-size:13px; cursor:pointer; }
        label.choice { display:block; margin:9px 0 0; color:#555; font-size:12px; line-height:1.6; }
        label.choice select { display:block; width:100%; margin-top:5px; padding:7px 8px; border:1px solid #cfd6d2; border-radius:6px; background:#fff; color:#333; font:12px inherit; }
        input[type=file] { display:none; }
        .actions { display:flex; flex-wrap:wrap; gap:8px; }
        button { border:1px solid #d8d8d8; border-radius:7px; padding:8px 10px; background:#fff; color:#333; font:13px/1.2 inherit; cursor:pointer; }
        button.primary { background:#07c160; border-color:#07c160; color:#fff; }
        button.warning { color:#9b5a00; }
        button:disabled { opacity:.45; cursor:not-allowed; }
        .status { min-height:46px; white-space:pre-wrap; color:#555; font-size:12px; line-height:1.65; }
        .preview-wrap { display:grid; grid-template-rows:auto minmax(0,1fr) auto; min-width:0; min-height:0; gap:8px; }
        .preview { width:100%; min-height:0; height:100%; overflow-x:hidden; overflow-y:auto; border:1px solid #e6e6e6; border-radius:10px; background:#f8f8f8; }
        .log { max-height:70px; overflow-x:hidden; overflow-y:scroll; margin:0; padding:10px; border-radius:8px; background:#202526; color:#d9e3e0; font:11px/1.6 ui-monospace, Consolas, monospace; white-space:pre-wrap; scrollbar-width:thin; scrollbar-color:#879a92 transparent; }
        .log::-webkit-scrollbar { width:8px; }
        .log::-webkit-scrollbar-thumb { background:#879a92; border:2px solid transparent; border-radius:99px; background-clip:content-box; }
        .log::-webkit-scrollbar-track { background:transparent; }
        .check { display:flex; gap:7px; align-items:flex-start; color:#555; font-size:12px; line-height:1.5; }
        .check input { margin-top:2px; }
        @media (max-width: 760px) { .body { grid-template-columns:1fr; } .panel { max-height:100%; } }
      </style>
      <section class="panel" role="dialog" aria-modal="true" aria-label="导入 HTML">
        <header><h1>导入 Codex 推文 HTML <small style="font-weight:400;color:#888">自用版</small></h1><button class="close" id="close" aria-label="关闭">×</button></header>
        <div class="body">
          <aside class="left">
            <section class="card">
              <h2>1. 选择文章文件</h2>
              <p class="hint">推荐选择完整的文章文件夹。扩展会同时读取其中的 <code>images</code>、<code>assets</code> 图片，并自动寻找 <code>_推文.html</code>。</p>
              <label class="file">选择文章文件夹<input id="folder" type="file" webkitdirectory multiple></label>
              <label class="file">或仅选择 HTML 文件<input id="html" type="file" accept=".html,.htm,text/html"></label>
              <label class="choice" id="html-choice-wrap" hidden>该文件夹包含多个 HTML，请选择要导入的文件<select id="html-choice"></select></label>
            </section>
            <section class="card">
              <h2>2. 文章资料</h2>
              <p class="hint" id="meta-status">选择完整文章文件夹后，可从 <code>_源稿.md</code> 读取标题、作者、推荐语和封面。</p>
              <div class="actions" style="margin-top:10px"><button id="apply-meta" disabled>写入标题、作者与推荐语</button><button id="upload-cover-library" class="warning" disabled>上传封面到当前图库</button></div>
            </section>
            <section class="card">
              <h2>3. 导入方式</h2>
              <label class="check"><input id="replace" type="checkbox" checked>替换当前正文。取消勾选时会在光标处插入。</label>
              <p class="hint" style="margin-top:8px">图片先用于预览。安全上传会复用已确认的图片 URL；新图片仅在后台结果可唯一确认时才回填，无法确认时会停止而不会猜测替换。</p>
              <div class="actions" style="margin-top:10px"><button id="native-upload" class="warning" disabled>安全上传本地图片</button><button id="clear-image-mappings" disabled>清除本篇图片映射</button><button id="copy" disabled>复制 HTML</button></div>
            </section>
            <section class="card">
              <h2>4. 插入正文</h2>
              <div class="actions"><button id="clear">清除</button><button id="insert" class="primary" disabled>插入当前正文</button></div>
            </section>
            <section class="card"><div class="status" id="status">尚未选择文件。</div></section>
          </aside>
          <main class="preview-wrap">
            <strong style="font-size:14px">预览（本机图片可见，不代表后台一定保留该样式）</strong>
            <div id="preview" class="preview"></div>
            <pre class="log" id="log"></pre>
          </main>
        </div>
      </section>`;
  }

  async function readFolder(files, shadow) {
    reset(shadow, false);
    state.files = [...files];
    state.htmlCandidates = state.files.filter((file) => HTML_EXT.test(file.name));
    const preferred = state.htmlCandidates.find((file) => /_推文\.html?$/i.test(file.name)) || state.htmlCandidates[0];
    if (!preferred) {
      setStatus(shadow, '所选文件夹中没有找到 .html 文件。请确认选择的是文章根文件夹。');
      log(shadow, '未找到 HTML。');
      return;
    }
    updateHtmlChoices(shadow, preferred);
    await loadHtmlFile(preferred, shadow);
  }

  async function readSingleHtml(files, shadow) {
    reset(shadow, false);
    state.files = [...files];
    if (!state.files[0]) return;
    state.htmlCandidates = [state.files[0]];
    updateHtmlChoices(shadow, state.files[0]);
    await loadHtmlFile(state.files[0], shadow);
  }

  function updateHtmlChoices(shadow, selectedFile) {
    const wrap = shadow.querySelector('#html-choice-wrap');
    const select = shadow.querySelector('#html-choice');
    const candidates = state.htmlCandidates;
    select.replaceChildren();
    candidates.forEach((file, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = file.webkitRelativePath || file.name;
      option.selected = file === selectedFile;
      select.appendChild(option);
    });
    wrap.hidden = candidates.length < 2;
  }

  async function loadHtmlFile(file, shadow) {
    try {
      state.htmlFile = file;
      state.html = await file.text();
      state.imageMap = buildImageMap(state.files);
      state.metadata = await readArticleMetadata(state.html, file, state.imageMap);
      state.bodyHtml = await prepareHtml(state.html, file, state.imageMap, shadow);
      state.images = findImages(state.bodyHtml);
      state.restoredImageCount = await restoreStoredImageMappings(shadow);
      if (state.restoredImageCount) state.images = findImages(state.bodyHtml);
      shadow.querySelector('#insert').disabled = !state.bodyHtml;
      shadow.querySelector('#copy').disabled = !state.bodyHtml;
      shadow.querySelector('#native-upload').disabled = !state.images.some((img) => img.localFile);
      shadow.querySelector('#clear-image-mappings').disabled = !state.htmlFile;
      shadow.querySelector('#apply-meta').disabled = !state.metadata;
      shadow.querySelector('#upload-cover-library').disabled = !state.metadata?.coverFile;
      updateMetadataStatus(shadow);
      const restored = state.restoredImageCount ? `；已复用 ${state.restoredImageCount} 张已确认图片` : '';
      setStatus(shadow, `已读取：${file.name}\n正文图片：${state.images.length} 张；本地图片：${state.images.filter((img) => img.localFile).length} 张${restored}。`);
      log(shadow, `已读取 HTML：${file.webkitRelativePath || file.name}`);
      log(shadow, `解析图片：${state.images.length} 张；可从文章文件夹匹配：${state.images.filter((img) => img.localFile).length} 张。`);
      if (state.restoredImageCount) log(shadow, `已从本机映射复用 ${state.restoredImageCount} 张后台图片 URL；本次不会重新上传这些文件。`);
      updatePreview(shadow);
    } catch (error) {
      setStatus(shadow, `读取失败：${error.message}`);
      log(shadow, `读取失败：${error.stack || error.message}`);
    }
  }

  function buildImageMap(files) {
    const map = new Map();
    for (const file of files.filter((item) => IMAGE_EXT.test(item.name))) {
      const relative = normalizePath(file.webkitRelativePath || file.name);
      map.set(relative, file);
      map.set(normalizePath(file.name), file);
    }
    return map;
  }

  async function readArticleMetadata(html, htmlFile, imageMap) {
    const sourceFile = state.files.find((file) => /_源稿\.md$/i.test(file.name))
      || state.files.find((file) => /源稿.*\.md$/i.test(file.name));
    const htmlDoc = new DOMParser().parseFromString(html, 'text/html');
    const fallbackTitle = (htmlDoc.querySelector('title')?.textContent || '').trim();
    if (!sourceFile) {
      return fallbackTitle ? { title: fallbackTitle, author: '', digest: '', coverFile: null, sourceFile: null } : null;
    }
    const frontmatter = parseFrontmatter(await sourceFile.text());
    const sourcePath = normalizePath(sourceFile.webkitRelativePath || sourceFile.name);
    const sourceDir = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1) : '';
    const coverPath = frontmatter.cover || '';
    return {
      title: frontmatter.title || fallbackTitle,
      // author 是公众号作者栏的短署名；byline 属于正文排版，不会自动拿来覆盖作者栏。
      author: frontmatter.wechat_author || frontmatter.author || '',
      digest: frontmatter.digest || frontmatter.summary || frontmatter.recommendation || '',
      coverFile: coverPath ? resolveLocalImage(coverPath, sourceDir, imageMap) : null,
      coverPath,
      sourceFile,
    };
  }

  function parseFrontmatter(markdown) {
    const matched = String(markdown || '').match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!matched) return {};
    const result = {};
    for (const line of matched[1].split(/\r?\n/)) {
      const item = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
      if (!item) continue;
      let value = item[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      result[item[1]] = value;
    }
    return result;
  }

  function updateMetadataStatus(shadow) {
    const target = shadow.querySelector('#meta-status');
    const metadata = state.metadata;
    if (!metadata) {
      target.textContent = '未找到源稿资料。请选择包含 _源稿.md 的完整文章文件夹。';
      return;
    }
    const fields = [
      metadata.title ? '标题' : '标题（未找到）',
      metadata.author ? '作者' : '作者（未填写）',
      metadata.digest ? '推荐语' : '推荐语（未填写）',
      metadata.coverFile ? '封面' : '封面（未找到）',
    ];
    target.textContent = `已读取：${fields.join('、')}。点击下方按钮写入公众号编辑页。`;
  }

  function restoreDialogState(shadow) {
    shadow.querySelector('#insert').disabled = false;
    shadow.querySelector('#copy').disabled = false;
    shadow.querySelector('#native-upload').disabled = !state.images.some((image) => image.localFile);
    shadow.querySelector('#clear-image-mappings').disabled = !state.htmlFile;
    shadow.querySelector('#apply-meta').disabled = !state.metadata;
    shadow.querySelector('#upload-cover-library').disabled = !state.metadata?.coverFile;
    updateMetadataStatus(shadow);
    setStatus(shadow, `已保留：${state.htmlFile?.name || '当前文章'}\n可继续上传、写入资料或插入正文。`);
    updatePreview(shadow);
    log(shadow, '已恢复本次已读取的文章。');
  }

  async function prepareHtml(html, htmlFile, imageMap, shadow) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    doc.querySelectorAll('script, iframe, object, embed, form, input, button, textarea, select, link[rel="import"]').forEach((node) => node.remove());
    doc.querySelectorAll('*').forEach((node) => {
      [...node.attributes].forEach((attribute) => {
        if (/^on/i.test(attribute.name) || attribute.name === 'srcdoc') node.removeAttribute(attribute.name);
      });
    });
    doc.querySelectorAll('[href], [src], [xlink\\:href]').forEach((node) => {
      for (const name of ['href', 'src', 'xlink:href']) {
        const value = node.getAttribute(name);
        if (value && /^\\s*javascript:/i.test(value)) node.removeAttribute(name);
      }
    });

    // 与既有译稿尾图卡片保持一致：阴影必须贴在裁切容器上，
    // 而不是受 inline-block 的基线空隙影响而悬在图片下方。
    doc.querySelectorAll('section').forEach((card) => {
      const image = card.querySelector(':scope > a > img');
      if (!image || card.style.borderRadius !== '6px' || card.style.overflow !== 'hidden') return;
      card.style.maxWidth = '100%';
      card.style.verticalAlign = 'middle';
      card.style.display = 'inline-block';
      card.style.lineHeight = '0';
      card.style.width = '80%';
      card.style.height = 'auto';
      const row = card.parentElement;
      if (row?.tagName === 'SECTION') {
        row.style.textAlign = 'center';
        row.style.margin = '10px 0';
        row.style.lineHeight = '0';
      }
    });

    const htmlPath = normalizePath(htmlFile.webkitRelativePath || htmlFile.name);
    const htmlDir = htmlPath.includes('/') ? htmlPath.slice(0, htmlPath.lastIndexOf('/') + 1) : '';
    for (const image of doc.querySelectorAll('img[src]')) {
      const source = image.getAttribute('src').trim();
      if (/^(https?:|data:|blob:)/i.test(source)) continue;
      const file = resolveLocalImage(source, htmlDir, imageMap);
      if (file) {
        image.dataset.codexLocalPath = file.webkitRelativePath || file.name;
        image.dataset.codexOriginalSrc = source;
        image.src = await asDataUrl(file);
      } else {
        image.dataset.codexMissingLocal = 'true';
        log(shadow, `未匹配本地图片：${source}`);
      }
    }

    // 标题底图等常以 background-image:url(...) 写在行内 style 中；它们并非 <img>，需要单独转为预览可读的数据图片。
    for (const node of doc.querySelectorAll('[style]')) {
      const style = node.getAttribute('style') || '';
      const localized = await localizeStyleImages(style, htmlDir, imageMap);
      if (!localized.paths.length) continue;
      node.setAttribute('style', localized.style);
      node.dataset.codexStyleLocalPaths = JSON.stringify(localized.paths);
    }

    // 公众号编辑器通常会过滤 <style>；正文以行内 style 为主，故移除全局 CSS 避免污染编辑器。
    doc.querySelectorAll('style, base, meta, title').forEach((node) => node.remove());
    return doc.body.innerHTML;
  }

  function resolveLocalImage(source, htmlDir, imageMap) {
    const candidates = [
      normalizePath(htmlDir + source),
      normalizePath(source.replace(/^\.\//, '')),
      normalizePath(source.split('/').pop()),
    ];
    return candidates.map((candidate) => imageMap.get(candidate)).find(Boolean) || null;
  }

  async function localizeStyleImages(style, htmlDir, imageMap) {
    const pattern = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
    const matches = [...style.matchAll(pattern)];
    if (!matches.length) return { style, paths: [] };
    let result = style;
    const paths = [];
    for (const match of matches) {
      const source = match[2].trim();
      if (!source || /^(https?:|data:|blob:|#)/i.test(source)) continue;
      const file = resolveLocalImage(source, htmlDir, imageMap);
      if (!file) continue;
      const dataUrl = await asDataUrl(file);
      result = result.replace(match[0], `url("${dataUrl}")`);
      paths.push(file.webkitRelativePath || file.name);
    }
    return { style: result, paths };
  }

  function findImages(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const inlineImages = [...doc.images].map((image) => ({
      kind: 'img',
      originalSrc: image.dataset.codexOriginalSrc || image.getAttribute('src'),
      localPath: image.dataset.codexLocalPath || '',
      localFile: image.dataset.codexLocalPath ? findLocalFile(image.dataset.codexLocalPath) : null,
      missing: image.dataset.codexMissingLocal === 'true',
    }));
    const styleImages = [];
    doc.querySelectorAll('[data-codex-style-local-paths]').forEach((node) => {
      for (const localPath of parseJsonArray(node.dataset.codexStyleLocalPaths)) {
        styleImages.push({ kind: 'style', originalSrc: localPath, localPath, localFile: findLocalFile(localPath), missing: false });
      }
    });
    return [...inlineImages, ...styleImages];
  }

  function parseJsonArray(value) {
    try { return Array.isArray(JSON.parse(value || '[]')) ? JSON.parse(value || '[]') : []; }
    catch (_) { return []; }
  }

  function findLocalFile(path) {
    return state.files.find((file) => (file.webkitRelativePath || file.name) === path) || null;
  }

  function articleMappingKey() {
    const path = normalizePath(state.htmlFile?.webkitRelativePath || state.htmlFile?.name || '');
    if (!path) return '';
    if (path.includes('/')) return `folder:${path.slice(0, path.lastIndexOf('/'))}`;
    return `file:${path.replace(HTML_EXT, '')}`;
  }

  function imageMappingId(localPath, file) {
    if (!file) return '';
    return `${normalizePath(localPath)}|${file.size}|${file.lastModified}`;
  }

  function storageGet(key) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(key, (result) => {
        const error = chrome.runtime?.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result?.[key] || {});
      });
    });
  }

  function storageSet(key, value) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [key]: value }, () => {
        const error = chrome.runtime?.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  async function restoreStoredImageMappings(shadow) {
    const articleKey = articleMappingKey();
    if (!articleKey) return 0;
    try {
      const allMappings = await storageGet(IMAGE_MAPPING_STORAGE_KEY);
      const mappings = allMappings[articleKey] || {};
      const seen = new Set();
      let restored = 0;
      for (const image of state.images) {
        if (!image.localFile || !image.localPath || seen.has(image.localPath)) continue;
        seen.add(image.localPath);
        const entry = mappings[imageMappingId(image.localPath, image.localFile)];
        if (!entry || !/^https?:/i.test(entry.url || '')) continue;
        replaceImageSource(image.localPath, entry.url);
        state.uploadedLocalPaths.add(image.localPath);
        restored += 1;
      }
      return restored;
    } catch (error) {
      log(shadow, `读取已确认图片映射失败：${error.message}`);
      return 0;
    }
  }

  async function saveStoredImageMapping(image, remoteUrl, shadow) {
    const articleKey = articleMappingKey();
    const mappingId = imageMappingId(image.localPath, image.localFile);
    if (!articleKey || !mappingId || !/^https?:/i.test(remoteUrl || '')) return;
    try {
      const allMappings = await storageGet(IMAGE_MAPPING_STORAGE_KEY);
      const mappings = allMappings[articleKey] || {};
      mappings[mappingId] = { url: remoteUrl, localPath: image.localPath, savedAt: Date.now() };
      allMappings[articleKey] = mappings;
      await storageSet(IMAGE_MAPPING_STORAGE_KEY, allMappings);
    } catch (error) {
      log(shadow, `保存图片映射失败：${error.message}`);
    }
  }

  async function clearStoredImageMappings(shadow) {
    const articleKey = articleMappingKey();
    if (!articleKey) return;
    if (!confirm('清除本篇文章已确认的图片 URL 映射？下次导入将需要重新安全上传图片。')) return;
    try {
      const allMappings = await storageGet(IMAGE_MAPPING_STORAGE_KEY);
      delete allMappings[articleKey];
      await storageSet(IMAGE_MAPPING_STORAGE_KEY, allMappings);
      setStatus(shadow, '已清除本篇图片映射，正在重新读取本地 HTML。');
      log(shadow, '已清除本篇图片映射。');
      await loadHtmlFile(state.htmlFile, shadow);
    } catch (error) {
      setStatus(shadow, `清除图片映射失败：${error.message}`);
      log(shadow, `清除图片映射失败：${error.message}`);
    }
  }

  function updatePreview(shadow) {
    const host = shadow.querySelector('#preview');
    const previewRoot = host.shadowRoot || host.attachShadow({ mode: 'open' });
    if (!state.bodyHtml) {
      previewRoot.innerHTML = '<style>:host{display:block;min-height:100%}.empty{display:grid;place-items:center;height:100%;min-height:450px;font-family:sans-serif;color:#999}</style><div class="empty">尚无预览内容</div>';
      return;
    }
    previewRoot.innerHTML = `<style>:host{display:block;min-height:100%;background:#f8f8f8}.article{margin:0 auto;padding:16px;max-width:709px;min-height:100%;background:#fff;box-sizing:border-box}.article img{max-width:100%;height:auto}</style><article class="article">${state.bodyHtml}</article>`;
  }

  async function asDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(reader.result));
      reader.addEventListener('error', () => reject(reader.error || new Error('图片读取失败')));
      reader.readAsDataURL(file);
    });
  }

  async function copyHtml(shadow) {
    try {
      await navigator.clipboard.writeText(state.bodyHtml);
      setStatus(shadow, '已复制处理后的正文 HTML。');
      log(shadow, '已复制 HTML。');
    } catch (error) {
      log(shadow, `复制失败：${error.message}`);
      setStatus(shadow, '浏览器拒绝复制，请手动在预览中检查。');
    }
  }

  async function applyArticleMetadata(shadow) {
    const metadata = state.metadata;
    if (!metadata) {
      setStatus(shadow, '没有可写入的文章资料。请选择包含 _源稿.md 的完整文章文件夹。');
      return;
    }
    const results = [];
    if (metadata.title) {
      const field = findArticleTextField(/标题/);
      results.push(field ? (writeNativeText(field, metadata.title), '标题已写入') : '未找到标题输入框');
    }
    if (metadata.author) {
      const field = findArticleTextField(/作者/);
      results.push(field ? (writeNativeText(field, metadata.author), '作者已写入') : '未找到作者输入框');
    }

    let digestField = metadata.digest ? findArticleTextField(/推荐语|摘要|描述|简介/) : null;
    // 推荐语与封面有时收在“文章设置”折叠区；仅在确有需要时尝试展开一次。
    if (metadata.digest && !digestField) {
      const opened = openArticleSettings();
      if (opened) {
        await wait(350);
        digestField ||= metadata.digest ? findArticleTextField(/推荐语|摘要|描述|简介/) : null;
      }
    }
    if (metadata.digest) {
      results.push(digestField ? (writeNativeText(digestField, metadata.digest), '推荐语已写入') : '未找到推荐语输入框（可先手动展开“文章设置”后重试）');
    }
    if (!metadata.author) results.push('作者未写入：请在源稿资料中添加 author');
    const message = results.join('；') || '源稿中没有可写入的文章资料。';
    setStatus(shadow, `${message}\n请在公众号编辑页确认封面缩略图与推荐语显示正常后保存。`);
    log(shadow, `文章资料：${message}`);
  }

  async function uploadCoverToLibrary(shadow) {
    const metadata = state.metadata;
    if (!metadata?.coverFile) {
      setStatus(shadow, '源稿中没有可上传的 cover 图片。');
      return;
    }
    const input = findMaterialLibraryInput();
    if (!input) {
      setStatus(shadow, '请先关闭扩展，在公众号封面菜单点击“从图片库选择”；打开图库窗口后重新打开扩展并选择文章文件夹，再点“上传封面到当前图库”。');
      return;
    }
    const button = shadow.querySelector('#upload-cover-library');
    button.disabled = true;
    try {
      log(shadow, `开始上传封面到当前图库：${metadata.coverFile.name}`);
      await uploadOneThroughPage(input, metadata.coverFile);
      setStatus(shadow, `封面已上传到当前图库：${metadata.coverFile.name}\n请关闭扩展，在图库中选中这张图片并确认使用。`);
      log(shadow, '封面已上传到当前图库。');
    } catch (error) {
      setStatus(shadow, `封面上传未确认成功：${error.message}\n请保持“从图片库选择”窗口打开后重试。`);
      log(shadow, `封面图库上传失败：${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  function findArticleTextField(keywords) {
    const candidates = [...document.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')]
      .filter((element) => isVisible(element) && isTextControl(element))
      .map((element) => ({ element, score: scoreTextControl(element, keywords) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.element || null;
  }

  function isTextControl(element) {
    if (element.matches('[contenteditable="true"], [contenteditable="plaintext-only"]')) return true;
    if (element.tagName === 'TEXTAREA') return true;
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    return !['hidden', 'file', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image'].includes(type);
  }

  function scoreTextControl(element, keywords) {
    const own = [
      element.placeholder,
      element.getAttribute('data-placeholder'),
      element.getAttribute('aria-label'),
      element.name,
      element.id,
      element.getAttribute('data-testid'),
      element.getAttribute('role'),
    ].filter(Boolean).join(' ');
    let score = keywords.test(own) ? 20 : 0;
    let ancestor = element.parentElement;
    for (let depth = 0; ancestor && depth < 4; depth += 1, ancestor = ancestor.parentElement) {
      const text = (ancestor.innerText || '').slice(0, 220);
      if (keywords.test(text)) score += 6 - depth;
    }
    return score;
  }

  function writeNativeText(element, value) {
    if (element.matches('[contenteditable="true"], [contenteditable="plaintext-only"]')) {
      element.focus();
      element.textContent = value;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('blur', { bubbles: true }));
      return;
    }
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function findMaterialLibraryInput() {
    return [...document.querySelectorAll('input[type="file"]')].find((input) => {
      if (!input.isConnected || input.disabled) return false;
      const own = [input.name, input.id, input.accept, input.getAttribute('aria-label')].filter(Boolean).join(' ');
      if (/material|library|素材|图库|本地上传|上传图片/i.test(own)) return true;
      let ancestor = input.parentElement;
      for (let depth = 0; ancestor && depth < 7; depth += 1, ancestor = ancestor.parentElement) {
        if (/图片库|素材库|本地上传|上传图片/.test((ancestor.innerText || '').slice(0, 320))) return true;
      }
      return false;
    }) || null;
  }

  function isMaterialLibraryOpen() {
    return [...document.querySelectorAll('body *')]
      .some((element) => isVisible(element) && /图片库|素材库/.test((element.innerText || '').trim()) && (element.innerText || '').trim().length < 120);
  }

  function openArticleSettings() {
    const controls = [...document.querySelectorAll('button, [role="button"], a, span, div')]
      .filter((element) => isVisible(element))
      .filter((element) => /文章设置/.test((element.innerText || '').trim()))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    const control = controls[0];
    if (!control) return false;
    control.click();
    return true;
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function editorCandidates() {
    const candidates = [];
    const inspect = (root, label) => {
      root.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"]').forEach((element) => {
        if (element.closest(`#${APP_ID}-dialog`)) return;
        const rect = element.getBoundingClientRect();
        const textLength = (element.innerText || '').trim().length;
        candidates.push({ element, root, label, score: rect.width * rect.height + textLength * 3 });
      });
    };
    inspect(document, '主页面');
    document.querySelectorAll('iframe').forEach((frame, index) => {
      try {
        if (frame.contentDocument) inspect(frame.contentDocument, `iframe ${index + 1}`);
      } catch (_) { /* 跨域 iframe 不可访问，跳过。 */ }
    });
    return candidates.sort((a, b) => b.score - a.score);
  }

  function makeInsertHtml({ convertDataImages = false } = {}) {
    const doc = new DOMParser().parseFromString(state.bodyHtml, 'text/html');
    if (convertDataImages) {
      doc.querySelectorAll('img[data-codex-remote-src]').forEach((image) => {
        image.src = image.dataset.codexRemoteSrc;
        image.removeAttribute('data-codex-remote-src');
      });
    }
    doc.querySelectorAll('[data-codex-local-path], [data-codex-original-src], [data-codex-missing-local]').forEach((node) => {
      node.removeAttribute('data-codex-local-path');
      node.removeAttribute('data-codex-original-src');
      node.removeAttribute('data-codex-missing-local');
    });
    doc.querySelectorAll('[data-codex-style-local-paths], [data-codex-style-remote-srcs]').forEach((node) => {
      node.removeAttribute('data-codex-style-local-paths');
      node.removeAttribute('data-codex-style-remote-srcs');
    });
    return doc.body.innerHTML;
  }

  function insertIntoEditor(shadow) {
    const target = editorCandidates()[0];
    if (!target) {
      setStatus(shadow, '没有找到可编辑的正文区域。请先打开公众号后台的图文编辑页，再重新点击“导入 HTML”。');
      log(shadow, '未找到 contenteditable 正文区域。');
      return false;
    }
    const pendingImages = state.images.filter((image) => image.localFile && !state.uploadedLocalPaths.has(image.localPath));
    if (pendingImages.length) {
      const proceed = confirm('检测到本地图片。未上传时会以临时数据图片插入，公众号保存后可能不显示。建议先点击“尝试上传本地图片”。仍要插入吗？');
      if (!proceed) return false;
    }
    const replace = shadow.querySelector('#replace').checked;
    const editor = target.element;
    editor.focus();
    const range = target.root.getSelection ? target.root.getSelection() : window.getSelection();
    if (replace) {
      editor.innerHTML = '';
    } else if (range && range.rangeCount === 0) {
      const selectionRange = target.root.createRange ? target.root.createRange() : document.createRange();
      selectionRange.selectNodeContents(editor);
      selectionRange.collapse(false);
      range.removeAllRanges();
      range.addRange(selectionRange);
    }
    const inserted = target.root.execCommand && target.root.execCommand('insertHTML', false, makeInsertHtml());
    if (!inserted) {
      if (replace) editor.innerHTML = makeInsertHtml();
      else editor.insertAdjacentHTML('beforeend', makeInsertHtml());
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: null }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    setStatus(shadow, `已尝试插入正文（目标：${target.label}）。请立即检查正文、图片和标题底图后，再点击后台保存。`);
    log(shadow, `已插入到 ${target.label}；${replace ? '替换模式' : '追加模式'}。`);
    return true;
  }

  async function uploadImagesNatively(shadow) {
    const allBodyImages = uniqueLocalImages(state.images.filter((image) => image.localFile));
    const localImages = allBodyImages.filter((image) => !state.uploadedLocalPaths.has(image.localPath));
    const reusedCount = allBodyImages.length - localImages.length;
    const coverFile = state.metadata?.coverFile || null;
    if (!localImages.length && !coverFile) {
      setStatus(shadow, reusedCount ? `正文图片已复用 ${reusedCount} 张已确认映射，无需重新上传。` : '没有可上传的本地图片。');
      return;
    }
    const materialInput = findMaterialLibraryInput();
    const input = materialInput || findImageInput();
    if (!input) {
      setStatus(shadow, '未找到公众号后台的图片上传控件。请先点击编辑器中的“图片”按钮，打开上传图片窗口，再回到这里重试。');
      log(shadow, '未找到 input[type=file]。');
      return;
    }
    const uploadingToLibrary = Boolean(materialInput || isMaterialLibraryOpen());
    const uploadItems = localImages.map((image) => ({ ...image, target: 'body' }));
    if (uploadingToLibrary && coverFile && !uploadItems.some((image) => image.localFile === coverFile)) {
      uploadItems.push({ kind: 'cover', localPath: coverFile.webkitRelativePath || coverFile.name, localFile: coverFile, target: 'cover' });
    }
    const coverNote = uploadingToLibrary && coverFile ? '（含封面图，上传后请在图库中选用）' : '';
    const reuseNote = reusedCount ? `；已复用 ${reusedCount} 张已确认图片，不会重新上传` : '';
    if (!confirm(`将通过公众号后台当前的上传控件安全上传 ${uploadItems.length} 张图片${coverNote}${reuseNote}。每张新图片出现后会要求你确认图库中的缩略图；无法唯一确认时不会回填正文。请勿在上传过程中切换页面。是否继续？`)) return;
    log(shadow, `开始尝试原生上传：${uploadItems.length} 张。${uploadingToLibrary ? ' 当前为图片库模式。' : ' 当前为正文图片模式。'}`);
    shadow.querySelector('#native-upload').disabled = true;
    let succeeded = 0;
    let coverSucceeded = false;
    const failedNames = [];
    for (const [index, image] of uploadItems.entries()) {
      let remoteUrl = '';
      let lastError = null;
      for (let attempt = 0; attempt <= UPLOAD_RETRY_LIMIT; attempt += 1) {
        try {
          setStatus(shadow, `正在上传 ${index + 1}/${uploadItems.length}：${image.localFile.name}${attempt ? '（正在重试）' : ''}\n当前图片确认完成后才会继续下一张。`);
          const freshInput = uploadingToLibrary ? (findMaterialLibraryInput() || input) : (findImageInput() || input);
          remoteUrl = await uploadOneThroughPage(freshInput, image.localFile, shadow);
          break;
        } catch (error) {
          lastError = error;
          if (!error?.noRetry && attempt < UPLOAD_RETRY_LIMIT) {
            log(shadow, `暂未确认：${image.localFile.name}；等待后重试一次。`);
            await wait(1200);
          } else {
            break;
          }
        }
      }
      if (remoteUrl) {
        if (image.target === 'cover') {
          state.metadata.coverRemoteUrl = remoteUrl;
          coverSucceeded = true;
        } else {
          replaceImageSource(image.localPath, remoteUrl);
          state.uploadedLocalPaths.add(image.localPath);
          await saveStoredImageMapping(image, remoteUrl, shadow);
        }
        succeeded += 1;
        log(shadow, `上传成功：${image.localFile.name}`);
      } else {
        failedNames.push(image.localFile.name);
        log(shadow, `上传失败：${image.localFile.name}；${lastError?.message || '未获得后台确认'}`);
      }
    }
    shadow.querySelector('#native-upload').disabled = false;
    state.images = findImages(state.bodyHtml);
    updatePreview(shadow);
    const coverResult = coverFile
      ? (uploadingToLibrary ? (coverSucceeded ? '封面已上传到当前图库，请在图库中选中它。' : '封面未确认上传成功。') : '当前不是图库窗口，封面未随正文图片上传。')
      : '';
    const failedResult = failedNames.length ? `未确认：${failedNames.join('、')}。` : '';
    setStatus(shadow, `安全上传完成：成功确认 ${succeeded}/${uploadItems.length} 张。${reusedCount ? `已复用 ${reusedCount} 张。` : ''}${coverResult}${failedResult}\n请在预览中检查后再插入。`);
  }

  function uniqueLocalImages(images) {
    const unique = new Map();
    for (const image of images) {
      if (image.localPath && !unique.has(image.localPath)) unique.set(image.localPath, image);
    }
    return [...unique.values()];
  }

  function findImageInput() {
    return [...document.querySelectorAll('input[type="file"]')].find((input) => {
      const accept = input.getAttribute('accept') || '';
      return /image|jpg|jpeg|png|gif|webp/i.test(accept) || !accept;
    }) || null;
  }

  function uploadOneThroughPage(input, file, shadow) {
    return new Promise((resolve, reject) => {
      const scope = findUploadScope(input);
      const before = collectRemoteMediaUrls(scope);
      let settleTimer = null;
      const timeout = setTimeout(() => {
        observer.disconnect();
        if (settleTimer) clearTimeout(settleTimer);
        reject(new Error('等待后台上传结果超时'));
      }, UPLOAD_TIMEOUT_MS);
      const finish = (url) => {
        clearTimeout(timeout);
        if (settleTimer) clearTimeout(settleTimer);
        observer.disconnect();
        resolve(url);
      };
      const failSafely = (message) => {
        clearTimeout(timeout);
        if (settleTimer) clearTimeout(settleTimer);
        observer.disconnect();
        const error = new Error(message);
        error.noRetry = true;
        reject(error);
      };
      const inspectCandidates = () => {
        const candidates = [...collectRemoteMediaUrls(scope)].filter((url) => !before.has(url));
        if (!candidates.length) return;
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          const stable = [...collectRemoteMediaUrls(scope)].filter((url) => !before.has(url));
          if (stable.length !== 1) {
            failSafely(`检测到 ${stable.length} 个新增图片候选，无法安全确认“${file.name}”对应的后台图片`);
            return;
          }
          const accepted = confirm(`请确认后台当前上传区域中新出现的缩略图就是：\n${file.name}\n\n确认后才会把它回填到正文；取消将保留图库图片但不修改正文。`);
          if (!accepted) {
            failSafely(`未人工确认“${file.name}”的后台图片，已停止回填`);
            return;
          }
          log(shadow, `已人工确认上传结果：${file.name}`);
          finish(stable[0]);
        }, UPLOAD_RESULT_SETTLE_MS);
      };
      const observer = new MutationObserver(() => {
        inspectCandidates();
      });
      observer.observe(scope, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'style', 'data-src'] });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function findUploadScope(input) {
    for (let node = input; node && node !== document.body; node = node.parentElement) {
      const marker = [node.id, node.className, node.getAttribute?.('role'), node.getAttribute?.('aria-label')]
        .filter((value) => typeof value === 'string')
        .join(' ');
      if (/dialog|modal|material|library|upload|media|素材|图库|上传/i.test(marker) && isVisible(node)) return node;
    }
    return document.body;
  }

  function collectRemoteMediaUrls(root = document) {
    const urls = new Set();
    root.querySelectorAll('img, [src], [data-src], [style*="url("]').forEach((element) => {
      for (const value of [element.currentSrc, element.src, element.getAttribute?.('src'), element.getAttribute?.('data-src')]) {
        if (value && /^https?:/i.test(value)) urls.add(value);
      }
      const style = element.getAttribute?.('style') || '';
      for (const match of style.matchAll(/url\(\s*(['"]?)(https?:[^)'"\s]+)\1\s*\)/gi)) urls.add(match[2]);
    });
    return urls;
  }

  function replaceImageSource(localPath, remoteUrl) {
    const doc = new DOMParser().parseFromString(state.bodyHtml, 'text/html');
    doc.querySelectorAll(`img[data-codex-local-path]`).forEach((image) => {
      if (image.dataset.codexLocalPath === localPath) {
        image.dataset.codexRemoteSrc = remoteUrl;
        image.src = remoteUrl;
      }
    });
    doc.querySelectorAll('[data-codex-style-local-paths]').forEach((node) => {
      const paths = parseJsonArray(node.dataset.codexStyleLocalPaths);
      const index = paths.indexOf(localPath);
      if (index < 0) return;
      const remotes = parseJsonObject(node.dataset.codexStyleRemoteSrcs);
      remotes[localPath] = remoteUrl;
      node.dataset.codexStyleRemoteSrcs = JSON.stringify(remotes);
      node.setAttribute('style', replaceStyleUrlAt(node.getAttribute('style') || '', index, remoteUrl));
    });
    state.bodyHtml = doc.body.innerHTML;
  }

  function parseJsonObject(value) {
    try {
      const parsed = JSON.parse(value || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) { return {}; }
  }

  function replaceStyleUrlAt(style, targetIndex, replacement) {
    let current = -1;
    return style.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (whole) => {
      current += 1;
      return current === targetIndex ? `url("${replacement}")` : whole;
    });
  }

  function reset(shadow, update = true) {
    state = { files: [], htmlCandidates: [], htmlFile: null, html: '', bodyHtml: '', images: [], imageMap: new Map(), uploadedLocalPaths: new Set(), restoredImageCount: 0, metadata: null };
    const choiceWrap = shadow.querySelector('#html-choice-wrap');
    if (choiceWrap) choiceWrap.hidden = true;
    shadow.querySelector('#insert').disabled = true;
    shadow.querySelector('#copy').disabled = true;
    shadow.querySelector('#native-upload').disabled = true;
    shadow.querySelector('#clear-image-mappings').disabled = true;
    shadow.querySelector('#apply-meta').disabled = true;
    shadow.querySelector('#upload-cover-library').disabled = true;
    shadow.querySelector('#meta-status').textContent = '选择完整文章文件夹后，可从 _源稿.md 读取标题、作者、推荐语和封面。';
    setStatus(shadow, '尚未选择文件。');
    shadow.querySelector('#log').textContent = '';
    if (update) updatePreview(shadow);
  }

  function setStatus(shadow, text) { shadow.querySelector('#status').textContent = text; }

  function lockPageScroll() {
    const html = document.documentElement;
    const body = document.body;
    const previousHtml = html.style.overflow;
    const previousBody = body.style.overflow;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    return () => {
      html.style.overflow = previousHtml;
      body.style.overflow = previousBody;
    };
  }

  function log(shadow, text) {
    const output = shadow.querySelector('#log');
    const lines = `${output.textContent}${output.textContent ? '\n' : ''}${text}`.split('\n').slice(-MAX_LOG_LINES);
    output.textContent = lines.join('\n');
    output.scrollTop = output.scrollHeight;
  }
  function normalizePath(value) {
    try { return decodeURIComponent(value).replace(/\\\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/'); }
    catch (_) { return value.replace(/\\\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/'); }
  }
})();
