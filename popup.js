// 错误捕获
window.onerror = function(msg, url, line) { console.error("Global Error:", msg); return false; };

// 退出确认
window.addEventListener('beforeunload', function (e) {
    if (pdfDoc) { e.preventDefault(); e.returnValue = ''; }
});

// PDFJS 检查
if (typeof pdfjsLib === 'undefined') {
    alert("❌ 错误：pdf.min.js 未加载");
} else {
    try { pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js'); } 
    catch (e) { pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js'; }
}

// --- IndexedDB ---
const DB = {
    name: 'PDFReaderDB', version: 1, db: null,
    init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.name, this.version);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
            };
            request.onsuccess = (e) => { this.db = e.target.result; resolve(); };
            request.onerror = (e) => reject(e);
        });
    },
    saveFile(arrayBuffer, fileName, currentPage, scale, inverted) {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject("DB error");
            const tx = this.db.transaction(['files'], 'readwrite');
            tx.objectStore('files').put({ id: 'current', data: arrayBuffer, name: fileName, page: currentPage, scale: scale, inverted: inverted, timestamp: Date.now() });
            tx.oncomplete = () => resolve();
        });
    },
    loadFile() {
        return new Promise((resolve) => {
            if (!this.db) return resolve(null);
            const req = this.db.transaction(['files'], 'readonly').objectStore('files').get('current');
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = () => resolve(null);
        });
    },
    updateProgress(page, scale, inverted) {
        if (!this.db) return;
        const store = this.db.transaction(['files'], 'readwrite').objectStore('files');
        store.get('current').onsuccess = (e) => {
            const data = e.target.result;
            if (data) { data.page = page; data.scale = scale; data.inverted = inverted; store.put(data); }
        };
    }
};

// 变量 (默认 inverted = true)
let pdfDoc = null, pageNum = 1, scale = 1.0, isInverted = true, currentFileName = "";
let isUserScrolling = false, scrollTimeout = null; 
let thumbnailObserver = null, mainPageObserver = null;
let visiblePages = new Map();
let outlinePageMap = []; 

// DOM
const mainContainer = document.getElementById('pdf-render-container'); 
const mainScroll = document.getElementById('main-scroll');
const pageNumInput = document.getElementById('page-num');
const pageCountSpan = document.getElementById('page-count');
const loadingIndicator = document.getElementById('loading-indicator');
const loadingText = document.getElementById('loading-text');

// --- 初始化 ---
(async function init() {
    await DB.init();
    const saved = await DB.loadFile();
    // 如果有保存的状态，使用保存的；否则默认 inv = true
    if (saved) {
        loadPdfFromBuffer(saved.data, saved.name, saved.page, saved.scale, saved.inverted);
    } else {
        // 初始状态，确保 UI 匹配默认的 true
        document.body.classList.add('invert-mode');
        document.getElementById('toggle-invert').textContent = "日间";
    }
})();

// --- 加载 (inv 默认为 true) ---
function loadPdfFromBuffer(buffer, name, p = 1, s = 1.0, inv = true) {
    loadingIndicator.style.display = 'flex';
    loadingText.innerText = "正在加载...";
    currentFileName = name; pageNum = p; scale = s; isInverted = inv;

    // 根据 inv 状态设置 UI
    if (isInverted) {
        document.body.classList.add('invert-mode');
        document.getElementById('toggle-invert').textContent = "日间";
    } else {
        document.body.classList.remove('invert-mode');
        document.getElementById('toggle-invert').textContent = "夜间";
    }
    
    updateZoomDisplay();

    const task = pdfjsLib.getDocument(buffer);
    task.promise.then(async (doc) => {
        pdfDoc = doc;
        pageCountSpan.textContent = pdfDoc.numPages;
        
        loadingText.innerText = "生成页面...";
        await initMainPages(); 
        initThumbnails(); 
        await renderOutline(); 

        if (pageNum > 1) scrollToPage(pageNum, true); 
        else updateSidebarSync(pageNum);

        loadingIndicator.style.display = 'none';
        DB.saveFile(buffer, currentFileName, pageNum, scale, isInverted);
    }).catch(err => {
        console.error(err);
        loadingIndicator.style.display = 'none';
        alert("加载失败: " + err.message);
    });
}

// --- 主页面渲染 ---
async function initMainPages() {
    mainContainer.innerHTML = ''; 
    visiblePages.clear();
    if (mainPageObserver) mainPageObserver.disconnect();

    mainPageObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const div = entry.target;
            const pNum = parseInt(div.dataset.pageNumber);

            if (entry.isIntersecting) {
                visiblePages.set(pNum, entry.intersectionRatio);
                if (!div.getAttribute('data-rendered')) renderMainPage(div, pNum);
            } else {
                visiblePages.delete(pNum);
                if (div.getAttribute('data-rendered')) {
                    div.style.height = div.clientHeight + 'px';
                    div.style.width = div.clientWidth + 'px';
                    div.innerHTML = '';
                    div.removeAttribute('data-rendered');
                }
            }
        });
        updateCurrentPageBasedOnVisibility();
    }, { root: mainScroll, rootMargin: '600px 0px', threshold: [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0] });

    const p1 = await pdfDoc.getPage(1);
    const vp = p1.getViewport({scale: scale});
    const defW = vp.width, defH = vp.height;

    for (let i = 1; i <= pdfDoc.numPages; i++) {
        const div = document.createElement('div');
        div.className = 'page-container';
        div.dataset.pageNumber = i;
        div.style.width = defW + 'px';
        div.style.height = defH + 'px';
        mainContainer.appendChild(div);
        mainPageObserver.observe(div);
    }
}

function updateCurrentPageBasedOnVisibility() {
    if (isUserScrolling) return; 

    let maxRatio = 0;
    let mostVisible = pageNum;
    
    for (let [p, r] of visiblePages) {
        if (r > maxRatio) { maxRatio = r; mostVisible = p; }
        else if (r === maxRatio) { mostVisible = Math.min(mostVisible, p); }
    }

    if (maxRatio > 0.05 && mostVisible !== pageNum) {
        pageNum = mostVisible;
        pageNumInput.value = pageNum;
        updateSidebarSync(pageNum);
        DB.updateProgress(pageNum, scale, isInverted);
    }
}

function renderMainPage(div, num) {
    if (div.getAttribute('data-rendered')) return;
    div.setAttribute('data-rendered', 'true');
    pdfDoc.getPage(num).then(page => {
        if (!div.getAttribute('data-rendered')) return;
        const vp = page.getViewport({scale: scale});
        div.style.width = vp.width + 'px';
        div.style.height = vp.height + 'px';
        const cvs = document.createElement('canvas');
        cvs.width = vp.width; cvs.height = vp.height;
        div.appendChild(cvs);
        page.render({canvasContext: cvs.getContext('2d'), viewport: vp});
    });
}

function scrollToPage(num, instant = false) {
    const target = mainContainer.querySelector(`.page-container[data-page-number="${num}"]`);
    if (target) {
        isUserScrolling = true;
        pageNum = num;
        pageNumInput.value = pageNum;
        updateSidebarSync(pageNum);
        DB.updateProgress(pageNum, scale, isInverted);
        target.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'start' });
        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => { isUserScrolling = false; }, instant ? 100 : 800);
    }
}

// --- 侧边栏同步 ---
function updateSidebarSync(num) {
    highlightThumbnail(num);
    highlightOutline(num);
}

function highlightThumbnail(num) {
    document.querySelectorAll('.thumbnail.active').forEach(el => el.classList.remove('active'));
    const current = document.querySelector(`.thumbnail[data-page-number="${num}"]`);
    if (current) {
        current.classList.add('active');
        if (document.getElementById('thumbnails-container').offsetParent !== null) {
            current.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
}

function highlightOutline(num) {
    document.querySelectorAll('.outline-link.active').forEach(el => el.classList.remove('active'));
    let activeItem = null;
    for (let i = 0; i < outlinePageMap.length; i++) {
        if (outlinePageMap[i].page <= num) {
            activeItem = outlinePageMap[i];
        } else {
            break;
        }
    }
    if (activeItem && activeItem.element) {
        activeItem.element.classList.add('active');
        if (document.getElementById('outline-container').offsetParent !== null) {
             activeItem.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
}

// --- 缩放 ---
function onZoomIn() { scale += 0.2; updateZoomDisplay(); reloadAllPages(); }
function onZoomOut() { if (scale <= 0.4) return; scale -= 0.2; updateZoomDisplay(); reloadAllPages(); }
function updateZoomDisplay() { document.getElementById('zoom-level').textContent = Math.round(scale * 100) + '%'; }
async function reloadAllPages() { const p = pageNum; await initMainPages(); scrollToPage(p, true); }

// --- 缩略图初始化 ---
function initThumbnails() {
    const container = document.getElementById('thumbnails-container');
    container.innerHTML = '';
    if (thumbnailObserver) thumbnailObserver.disconnect();

    thumbnailObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const div = entry.target;
            const p = parseInt(div.dataset.pageNumber);
            if (entry.isIntersecting) {
                if (div.querySelectorAll('canvas').length === 0) renderSingleThumb(div, p);
            } else {
                div.innerHTML = `<div class="thumb-page-num">第 ${p} 页</div>`;
                div.removeAttribute('data-rendered');
            }
        });
    }, { root: document.getElementById('sidebar-content'), rootMargin: '300px 0px', threshold: 0.01 });

    for (let i = 1; i <= pdfDoc.numPages; i++) {
        const div = document.createElement('div');
        div.className = 'thumbnail';
        div.dataset.pageNumber = i;
        div.style.minHeight = "140px";
        div.innerHTML = `<div class="thumb-page-num">第 ${i} 页</div>`;
        div.addEventListener('click', () => scrollToPage(i, true));
        container.appendChild(div);
        thumbnailObserver.observe(div);
    }
}

function renderSingleThumb(div, num) {
    if(div.getAttribute('data-rendered')) return;
    div.setAttribute('data-rendered', 'true');
    const cvs = document.createElement('canvas');
    div.insertBefore(cvs, div.firstChild); 
    pdfDoc.getPage(num).then(page => {
        if(!div.contains(cvs)) return;
        const vp = page.getViewport({scale: 0.15});
        cvs.width = vp.width; cvs.height = vp.height;
        div.style.minHeight = vp.height + 25 + "px";
        page.render({canvasContext: cvs.getContext('2d'), viewport: vp});
    });
}

// --- 目录初始化 ---
async function renderOutline() {
    const container = document.getElementById('outline-container');
    container.innerHTML = '';
    outlinePageMap = []; 
    
    const outline = await pdfDoc.getOutline();
    if (!outline || outline.length === 0) {
        container.innerHTML = '<p style="text-align:center;color:#999;margin-top:20px;font-size:12px;">无目录</p>';
        return;
    }

    function buildTree(items, parentDiv) {
        const ul = document.createElement('div');
        for (const item of items) {
            const div = document.createElement('div');
            div.className = 'outline-item';
            const a = document.createElement('a');
            a.className = 'outline-link';
            a.href = '#';
            a.innerText = item.title;
            a.title = item.title;

            if (item.dest) {
                a.dataset.hasDest = "true";
                a.onclick = async (e) => {
                    e.preventDefault();
                    let targetPage = parseInt(a.dataset.targetPage);
                    if (isNaN(targetPage)) {
                        try { targetPage = await resolveDestToPage(item.dest); } catch(err) {}
                    }
                    if (targetPage) scrollToPage(targetPage, true);
                };
            } else {
                a.style.color = '#999'; a.style.cursor = 'default';
            }

            div.appendChild(a);
            if (item.dest) outlinePageMap.push({ dest: item.dest, element: a, page: -1 });
            if (item.items && item.items.length > 0) {
                const childDiv = document.createElement('div');
                childDiv.className = 'outline-children';
                buildTree(item.items, childDiv);
                div.appendChild(childDiv);
            }
            ul.appendChild(div);
        }
        parentDiv.appendChild(ul);
    }

    buildTree(outline, container);
    resolveOutlinePages();
}

async function resolveDestToPage(dest) {
    if (typeof dest === 'string') dest = await pdfDoc.getDestination(dest);
    if (Array.isArray(dest)) {
        const ref = dest[0];
        const idx = await pdfDoc.getPageIndex(ref);
        return idx + 1;
    }
    return null;
}

async function resolveOutlinePages() {
    const promises = outlinePageMap.map(async (item) => {
        try {
            const p = await resolveDestToPage(item.dest);
            if (p) { item.page = p; item.element.dataset.targetPage = p; }
        } catch (e) {}
    });
    await Promise.all(promises);
    outlinePageMap = outlinePageMap.filter(item => item.page > 0).sort((a, b) => a.page - b.page);
    updateSidebarSync(pageNum);
}

// --- 事件监听 ---
document.getElementById('file-input').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file || file.type !== 'application/pdf') return;
    const reader = new FileReader();
    reader.onload = function() { loadPdfFromBuffer(this.result, file.name); };
    reader.readAsArrayBuffer(file);
});

document.getElementById('prev-page').addEventListener('click', () => { if (pageNum > 1) scrollToPage(pageNum - 1, true); });
document.getElementById('next-page').addEventListener('click', () => { if (pageNum < pdfDoc.numPages) scrollToPage(pageNum + 1, true); });
document.getElementById('zoom-in').addEventListener('click', onZoomIn);
document.getElementById('zoom-out').addEventListener('click', onZoomOut);
document.getElementById('page-num').addEventListener('change', (e) => {
    const val = parseInt(e.target.value);
    if(val >= 1 && val <= pdfDoc.numPages) scrollToPage(val, true);
});
document.getElementById('toggle-invert').addEventListener('click', function() {
    isInverted = !isInverted;
    if (isInverted) {
        document.body.classList.add('invert-mode');
        this.textContent = "日间";
    } else {
        document.body.classList.remove('invert-mode');
        this.textContent = "夜间";
    }
    DB.updateProgress(pageNum, scale, isInverted);
});

const tabThumbs = document.getElementById('tab-thumbs');
const tabOutline = document.getElementById('tab-outline');
const contentThumbs = document.getElementById('thumbnails-container');
const contentOutline = document.getElementById('outline-container');

tabThumbs.addEventListener('click', () => {
    tabThumbs.classList.add('active'); tabOutline.classList.remove('active');
    contentThumbs.style.display = 'block'; contentOutline.style.display = 'none';
    if(pageNum) highlightThumbnail(pageNum);
});

tabOutline.addEventListener('click', () => {
    tabOutline.classList.add('active'); tabThumbs.classList.remove('active');
    contentOutline.style.display = 'block'; contentThumbs.style.display = 'none';
    if(pageNum) highlightOutline(pageNum);
});

document.getElementById('toggle-sidebar').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('closed');
});