// ===================== 配置 =====================
const CATEGORY_STYLE = {
  '避雷小区':   { color: '#d7263d', label: '避雷小区',       badgeBg: '#fdecee' },
  '跌幅过大':   { color: '#e0a800', label: '跌幅过大',       badgeBg: '#fff8e1' },
  '营销过度':   { color: '#e0a800', label: '营销过度',       badgeBg: '#fff8e1' },
  '不建议买':   { color: '#f2790f', label: '不建议买',       badgeBg: '#fff1e0' },
};
const DEFAULT_STYLE = { color: '#6b7280', label: '未分类', badgeBg: '#f1f2f4' };

function styleOf(category) {
  return CATEGORY_STYLE[category] || DEFAULT_STYLE;
}

// ===================== 状态 =====================
let allCommunities = [];
let activeFilters = new Set(); // 空集合 = 全部显示
let selectedId = null;
let searchKeyword = '';

// ===================== Markdown 解析 =====================
// 期望格式:
// ### 小区名称
// - 分类: xxx
// - 所在区: xxx
// - 经度: 116.xx
// - 纬度: 39.xx
// - 原因: xxxxx
// ---
function parseMarkdown(text) {
  // 去掉 HTML 注释块 <!-- ... -->
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  const blocks = text.split(/^\s*---\s*$/m).map(b => b.trim()).filter(Boolean);
  const items = [];

  blocks.forEach((block, idx) => {
    const nameMatch = block.match(/^###\s*(.+)$/m);
    if (!nameMatch) return;
    const name = nameMatch[1].trim();

    const getField = (label) => {
      const re = new RegExp('^-\\s*' + label + '\\s*[:：]\\s*(.+)$', 'm');
      const m = block.match(re);
      return m ? m[1].trim() : '';
    };

    const category = getField('分类');
    const district = getField('所在区');
    const lng = parseFloat(getField('经度'));
    const lat = parseFloat(getField('纬度'));

    // 原因 字段可能跨多行：从 "- 原因:" 开始，直到本 block 结束
    let reason = '';
    const reasonStart = block.match(/^-\s*原因\s*[:：]\s*([\s\S]*)$/m);
    if (reasonStart) {
      reason = reasonStart[1].trim();
    }

    if (!name || !category || isNaN(lng) || isNaN(lat)) {
      console.warn('跳过格式不完整的小区区块:', name || `(第${idx + 1}块)`);
      return;
    }

    items.push({
      id: 'c' + idx + '_' + name,
      name, category, district, lng, lat, reason
    });
  });

  return items;
}

// ===================== 地图投影 =====================
// 根据北京 geojson 的经纬度范围，做等经纬度投影（带纬度余弦修正）
let projectPoint = null;
let districtPaths = [];

const VIEW_W = 800, VIEW_H = 860, PAD = 30;

function buildProjection(geojson) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  const walk = (coords) => {
    if (typeof coords[0] === 'number') {
      const [x, y] = coords;
      if (x < minLon) minLon = x;
      if (x > maxLon) maxLon = x;
      if (y < minLat) minLat = y;
      if (y > maxLat) maxLat = y;
    } else {
      coords.forEach(walk);
    }
  };
  geojson.features.forEach(f => walk(f.geometry.coordinates));

  const latMid = (minLat + maxLat) / 2;
  const cos = Math.cos(latMid * Math.PI / 180);

  const spanX = (maxLon - minLon) * cos;
  const spanY = (maxLat - minLat);

  const availW = VIEW_W - PAD * 2;
  const availH = VIEW_H - PAD * 2;
  const scale = Math.min(availW / spanX, availH / spanY);

  const offsetX = PAD + (availW - spanX * scale) / 2;
  const offsetY = PAD + (availH - spanY * scale) / 2;

  projectPoint = (lng, lat) => {
    const x = (lng - minLon) * cos * scale + offsetX;
    const y = (maxLat - lat) * scale + offsetY;
    return [x, y];
  };
}

function ringToPath(ring) {
  return ring.map(([lng, lat], i) => {
    const [x, y] = projectPoint(lng, lat);
    return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ') + ' Z';
}

function polygonToPath(coords) {
  // coords: array of rings
  return coords.map(ringToPath).join(' ');
}

function buildDistrictPaths(geojson) {
  districtPaths = geojson.features.map(f => {
    const geom = f.geometry;
    let d = '';
    if (geom.type === 'Polygon') {
      d = polygonToPath(geom.coordinates);
    } else if (geom.type === 'MultiPolygon') {
      d = geom.coordinates.map(polygonToPath).join(' ');
    }
    const [cx, cy] = projectPoint(f.properties.cp[0], f.properties.cp[1]);
    return { name: f.properties.name, d, cx, cy };
  });
}

// ===================== 渲染：底图 =====================
function renderBaseMap() {
  const svg = document.getElementById('map-svg');
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`);

  const layer = document.getElementById('district-layer');
  layer.innerHTML = '';

  districtPaths.forEach(d => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d.d);
    path.setAttribute('class', 'district-shape');
    layer.appendChild(path);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', d.cx);
    label.setAttribute('y', d.cy);
    label.setAttribute('class', 'district-label');
    label.textContent = d.name;
    layer.appendChild(label);
  });
}

// ===================== 渲染：小区标注 =====================
function passesFilter(item) {
  if (activeFilters.size > 0 && !activeFilters.has(item.category)) return false;
  if (searchKeyword && !item.name.toLowerCase().includes(searchKeyword.toLowerCase())) return false;
  return true;
}

function renderMarkers() {
  const layer = document.getElementById('marker-layer');
  layer.innerHTML = '';

  const visible = allCommunities.filter(passesFilter);

  visible.forEach(item => {
    const [x, y] = projectPoint(item.lng, item.lat);
    const style = styleOf(item.category);
    const isSelected = item.id === selectedId;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'marker-group' + (isSelected ? ' selected' : ''));
    g.setAttribute('data-id', item.id);
    g.style.cursor = 'pointer';

    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y);
    dot.setAttribute('r', isSelected ? 6 : 4.5);
    dot.setAttribute('fill', style.color);
    dot.setAttribute('stroke', '#fff');
    dot.setAttribute('stroke-width', '1.5');
    g.appendChild(dot);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x + 7);
    text.setAttribute('y', y + 3);
    text.setAttribute('class', 'marker-label');
    text.setAttribute('fill', style.color);
    text.textContent = item.name;
    g.appendChild(text);

    g.addEventListener('click', () => selectCommunity(item.id));
    layer.appendChild(g);
  });

  document.getElementById('visible-count').textContent = visible.length;
  document.getElementById('total-count').textContent = allCommunities.length;
}

// ===================== 详情面板 =====================
function selectCommunity(id) {
  selectedId = id;
  renderMarkers();
  renderDetail();
  renderList();
}

function renderDetail() {
  const panel = document.getElementById('detail-panel');
  const item = allCommunities.find(c => c.id === selectedId);

  if (!item) {
    panel.innerHTML = `<div class="detail-empty">点击地图上的小区名称，或下方列表中的小区，查看分类和详细原因</div>`;
    return;
  }

  const style = styleOf(item.category);
  panel.innerHTML = `
    <div class="detail-header">
      <div class="detail-name">${escapeHtml(item.name)}</div>
      <span class="detail-badge" style="color:${style.color};background:${style.badgeBg};border:1px solid ${style.color}33">${escapeHtml(style.label)}</span>
    </div>
    ${item.district ? `<div class="detail-district">📍 ${escapeHtml(item.district)}</div>` : ''}
    <div class="detail-reason-title">具体原因</div>
    <div class="detail-reason">${escapeHtml(item.reason).replace(/\n/g, '<br>')}</div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ===================== 筛选栏 =====================
function renderFilterBar() {
  const bar = document.getElementById('filter-bar');
  const categories = Array.from(new Set(allCommunities.map(c => c.category)));

  bar.innerHTML = '';
  categories.forEach(cat => {
    const style = styleOf(cat);
    const btn = document.createElement('button');
    btn.className = 'filter-chip' + (activeFilters.has(cat) ? ' active' : '');
    btn.style.setProperty('--chip-color', style.color);
    btn.innerHTML = `<span class="dot" style="background:${style.color}"></span>${escapeHtml(cat)}
      <span class="chip-count">${allCommunities.filter(c => c.category === cat).length}</span>`;
    btn.addEventListener('click', () => {
      if (activeFilters.has(cat)) activeFilters.delete(cat);
      else activeFilters.add(cat);
      renderFilterBar();
      renderMarkers();
      renderList();
    });
    bar.appendChild(btn);
  });

  const clearBtn = document.getElementById('clear-filter');
  clearBtn.style.display = activeFilters.size > 0 ? 'inline-flex' : 'none';
}

// ===================== 列表视图 =====================
function renderList() {
  const list = document.getElementById('community-list');
  const visible = allCommunities.filter(passesFilter);
  list.innerHTML = '';

  if (visible.length === 0) {
    list.innerHTML = `<div class="list-empty">没有匹配的小区</div>`;
    return;
  }

  visible.forEach(item => {
    const style = styleOf(item.category);
    const row = document.createElement('div');
    row.className = 'list-row' + (item.id === selectedId ? ' selected' : '');
    row.innerHTML = `
      <span class="dot" style="background:${style.color}"></span>
      <span class="list-name">${escapeHtml(item.name)}</span>
      <span class="list-cat" style="color:${style.color}">${escapeHtml(item.category)}</span>
      ${item.district ? `<span class="list-district">${escapeHtml(item.district)}</span>` : ''}
    `;
    row.addEventListener('click', () => selectCommunity(item.id));
    list.appendChild(row);
  });
}

// ===================== 数据加载 =====================
function initWithData(text) {
  allCommunities = parseMarkdown(text);
  document.getElementById('data-status').textContent = `已加载 ${allCommunities.length} 个小区`;
  document.getElementById('loader').style.display = 'none';
  document.getElementById('app').style.display = 'grid';

  buildProjection(BEIJING_GEOJSON);
  buildDistrictPaths(BEIJING_GEOJSON);
  renderBaseMap();
  renderFilterBar();
  renderMarkers();
  renderDetail();
  renderList();
}

function showManualLoad(message) {
  document.getElementById('loader-text').textContent = message;
  document.getElementById('manual-load').style.display = 'block';
}

async function loadData() {
  try {
    const res = await fetch('data.md', { cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    const text = await res.text();
    initWithData(text);
  } catch (e) {
    showManualLoad('无法通过浏览器直接读取本地 data.md 文件（这是浏览器的安全限制，不是故障）。请在下方手动选择该文件，或参考下面的说明启动一个本地服务器。');
  }
}

function setupManualFilePicker() {
  const input = document.getElementById('file-input');
  input.addEventListener('change', (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      document.getElementById('manual-load').style.display = 'none';
      initWithData(e.target.result);
    };
    reader.readAsText(file, 'utf-8');
  });
}

// ===================== 搜索 =====================
function setupSearch() {
  const input = document.getElementById('search-input');
  input.addEventListener('input', () => {
    searchKeyword = input.value.trim();
    renderMarkers();
    renderList();
  });
}

// ===================== 地图缩放/平移 =====================
function setupMapZoomPan() {
  const svg = document.getElementById('map-svg');
  const zoomLayer = document.getElementById('zoom-layer');
  let scale = 1, tx = 0, ty = 0;
  let dragging = false, lastX = 0, lastY = 0;

  function applyTransform() {
    zoomLayer.setAttribute('transform', `translate(${tx},${ty}) scale(${scale})`);
  }

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width * VIEW_W;
    const my = (e.clientY - rect.top) / rect.height * VIEW_H;
    const delta = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newScale = Math.min(8, Math.max(1, scale * delta));
    tx = mx - (mx - tx) * (newScale / scale);
    ty = my - (my - ty) * (newScale / scale);
    scale = newScale;
    applyTransform();
  }, { passive: false });

  svg.addEventListener('mousedown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    svg.classList.add('dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = svg.getBoundingClientRect();
    const dx = (e.clientX - lastX) / rect.width * VIEW_W;
    const dy = (e.clientY - lastY) / rect.height * VIEW_H;
    tx += dx; ty += dy;
    lastX = e.clientX; lastY = e.clientY;
    applyTransform();
  });
  window.addEventListener('mouseup', () => { dragging = false; svg.classList.remove('dragging'); });

  document.getElementById('zoom-reset').addEventListener('click', () => {
    scale = 1; tx = 0; ty = 0; applyTransform();
  });
  document.getElementById('zoom-in').addEventListener('click', () => {
    scale = Math.min(8, scale * 1.3); applyTransform();
  });
  document.getElementById('zoom-out').addEventListener('click', () => {
    scale = Math.max(1, scale / 1.3); applyTransform();
  });
}

// ===================== 启动 =====================
window.addEventListener('DOMContentLoaded', () => {
  setupManualFilePicker();
  setupSearch();
  setupMapZoomPan();
  loadData();
});
