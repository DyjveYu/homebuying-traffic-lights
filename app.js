// ===================== 配置 =====================
const CATEGORY_STYLE = {
  '避雷小区':   { color: '#d7263d', label: '避雷小区',   badgeBg: '#fdecee' },
  '跌幅过大':   { color: '#e0a800', label: '跌幅过大',   badgeBg: '#fff8e1' },
  '营销过度':   { color: '#e0a800', label: '营销过度',   badgeBg: '#fff8e1' },
  '不建议买':   { color: '#f2790f', label: '不建议买',   badgeBg: '#fff1e0' },
};
const DEFAULT_STYLE = { color: '#6b7280', label: '未分类', badgeBg: '#f1f2f4' };
function styleOf(category) { return CATEGORY_STYLE[category] || DEFAULT_STYLE; }

const BEIJING_CENTER = { lat: 39.9042, lng: 116.4074 };
const CLUSTER_PIXEL_RADIUS = 46; // 聚合判定的像素距离

// ===================== 状态 =====================
let allCommunities = [];
let map = null;
let overlays = []; // 当前地图上的自定义 DOMOverlay 实例
let activeCategoryFilters = new Set();
let activeDistrictFilters = new Set();
let searchKeyword = '';
let refreshTimer = null;
let lastZoom = null;

// ===================== Markdown 解析 =====================
function parseMarkdown(text) {
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
    const address = getField('地址');
    const lng = parseFloat(getField('经度'));
    const lat = parseFloat(getField('纬度'));

    let reason = '';
    const reasonStart = block.match(/^-\s*原因\s*[:：]\s*([\s\S]*)$/m);
    if (reasonStart) reason = reasonStart[1].trim();

    if (!name || !category || isNaN(lng) || isNaN(lat)) {
      console.warn('跳过格式不完整的小区区块:', name || `(第${idx + 1}块)`);
      return;
    }

    items.push({ id: 'c' + idx + '_' + name, name, category, district, address, lng, lat, reason });
  });

  return items;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ===================== 过滤 =====================
function passesFilter(item) {
  if (activeCategoryFilters.size > 0 && !activeCategoryFilters.has(item.category)) return false;
  if (activeDistrictFilters.size > 0 && !activeDistrictFilters.has(item.district)) return false;
  if (searchKeyword && !item.name.toLowerCase().includes(searchKeyword.toLowerCase())) return false;
  return true;
}

// ===================== 自定义 DOM 覆盖物：单个小区标注 =====================
function defineOverlayClasses() {
  // 单点：彩色圆点 + 小区名称
  window.CommunityOverlay = class extends TMap.DOMOverlay {
    onInit(options) {
      this.item = options.item;
      this.position = options.position;
      this.onSelect = options.onSelect;
    }
    createDOM() {
      const style = styleOf(this.item.category);
      const dom = document.createElement('div');
      dom.className = 'map-marker';
      dom.innerHTML = `
        <span class="map-marker-dot" style="background:${style.color}"></span>
        <span class="map-marker-label" style="color:${style.color}">${escapeHtml(this.item.name)}</span>
      `;
      dom.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onSelect(this.item);
      });
      return dom;
    }
    updateDOM() {
      if (!this.map) return;
      const pixel = this.map.projectToContainer(this.position);
      this.dom.style.left = (pixel.getX()) + 'px';
      this.dom.style.top = (pixel.getY()) + 'px';
    }
  };

  // 聚合气泡
  window.ClusterOverlay = class extends TMap.DOMOverlay {
    onInit(options) {
      this.position = options.position;
      this.count = options.count;
      this.dominantColor = options.dominantColor;
      this.onExpand = options.onExpand;
    }
    createDOM() {
      const dom = document.createElement('div');
      dom.className = 'map-cluster';
      const size = Math.min(56, 34 + this.count * 2);
      dom.style.width = size + 'px';
      dom.style.height = size + 'px';
      dom.style.lineHeight = size + 'px';
      dom.style.background = this.dominantColor;
      dom.textContent = this.count;
      dom.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onExpand(this.position);
      });
      return dom;
    }
    updateDOM() {
      if (!this.map) return;
      const pixel = this.map.projectToContainer(this.position);
      this.dom.style.left = pixel.getX() + 'px';
      this.dom.style.top = pixel.getY() + 'px';
    }
  };
}

// ===================== 聚合计算（基于屏幕像素距离，纯前端实现） =====================
function computeClusters(points, radiusPx) {
  const used = new Array(points.length).fill(false);
  const groups = [];
  for (let i = 0; i < points.length; i++) {
    if (used[i]) continue;
    const group = [points[i]];
    used[i] = true;
    for (let j = i + 1; j < points.length; j++) {
      if (used[j]) continue;
      const dx = points[i].px.getX() - points[j].px.getX();
      const dy = points[i].px.getY() - points[j].px.getY();
      if (Math.sqrt(dx * dx + dy * dy) <= radiusPx) {
        group.push(points[j]);
        used[j] = true;
      }
    }
    groups.push(group);
  }
  return groups;
}

function clearOverlays() {
  overlays.forEach(o => { try { o.setMap(null); } catch (e) {} });
  overlays = [];
}

function refreshMarkers() {
  if (!map || typeof TMap === 'undefined') return;
  clearOverlays();

  const visible = allCommunities.filter(passesFilter);
  const points = visible.map(item => {
    const latLng = new TMap.LatLng(item.lat, item.lng);
    return { item, latLng, px: map.projectToContainer(latLng) };
  });

  const groups = computeClusters(points, CLUSTER_PIXEL_RADIUS);

  groups.forEach(group => {
    if (group.length >= 2) {
      // 聚合气泡：中心取组内平均经纬度，颜色取组内出现最多的分类颜色
      let sumLat = 0, sumLng = 0;
      const colorCount = {};
      group.forEach(g => {
        sumLat += g.item.lat;
        sumLng += g.item.lng;
        const c = styleOf(g.item.category).color;
        colorCount[c] = (colorCount[c] || 0) + 1;
      });
      const centerLatLng = new TMap.LatLng(sumLat / group.length, sumLng / group.length);
      let dominantColor = '#4a5568';
      let maxCount = 0;
      Object.keys(colorCount).forEach(c => {
        if (colorCount[c] > maxCount) { maxCount = colorCount[c]; dominantColor = c; }
      });

      const cluster = new ClusterOverlay({
        map,
        position: centerLatLng,
        count: group.length,
        dominantColor,
        onExpand: (pos) => {
          map.setCenter(pos);
          map.setZoom(Math.min(18, map.getZoom() + 2));
        }
      });
      overlays.push(cluster);
    } else {
      const g = group[0];
      const marker = new CommunityOverlay({
        map,
        position: g.latLng,
        item: g.item,
        onSelect: openDetail
      });
      overlays.push(marker);
    }
  });

  document.getElementById('visible-count').textContent = visible.length;
  document.getElementById('total-count').textContent = allCommunities.length;
  renderListDrawer();
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshMarkers, 80);
}

// ===================== 详情弹窗 =====================
function openDetail(item) {
  const style = styleOf(item.category);
  const modal = document.getElementById('detail-modal');
  document.getElementById('detail-name').textContent = item.name;
  const badge = document.getElementById('detail-badge');
  badge.textContent = style.label;
  badge.style.color = style.color;
  badge.style.background = style.badgeBg;
  badge.style.border = `1px solid ${style.color}33`;

  const addrEl = document.getElementById('detail-address');
  if (item.address) {
    addrEl.style.display = 'block';
    addrEl.textContent = '📍 ' + item.address;
  } else {
    addrEl.style.display = 'none';
  }

  document.getElementById('detail-reason').innerHTML = escapeHtml(item.reason).replace(/\n/g, '<br>');
  modal.classList.add('open');
}

function closeDetail() {
  document.getElementById('detail-modal').classList.remove('open');
}

// ===================== 筛选面板 =====================
function renderFilterPanel() {
  const catWrap = document.getElementById('category-filters');
  const distWrap = document.getElementById('district-filters');

  const categories = Array.from(new Set(allCommunities.map(c => c.category)));
  const districts = Array.from(new Set(allCommunities.map(c => c.district).filter(Boolean)));

  catWrap.innerHTML = '';
  categories.forEach(cat => {
    const style = styleOf(cat);
    const btn = document.createElement('button');
    btn.className = 'filter-chip' + (activeCategoryFilters.has(cat) ? ' active' : '');
    btn.style.setProperty('--chip-color', style.color);
    btn.innerHTML = `<span class="dot" style="background:${style.color}"></span>${escapeHtml(cat)}
      <span class="chip-count">${allCommunities.filter(c => c.category === cat).length}</span>`;
    btn.addEventListener('click', () => {
      if (activeCategoryFilters.has(cat)) activeCategoryFilters.delete(cat);
      else activeCategoryFilters.add(cat);
      renderFilterPanel();
      scheduleRefresh();
      updateFilterBadge();
    });
    catWrap.appendChild(btn);
  });

  distWrap.innerHTML = '';
  districts.forEach(d => {
    const btn = document.createElement('button');
    btn.className = 'filter-chip district-chip' + (activeDistrictFilters.has(d) ? ' active' : '');
    btn.innerHTML = `${escapeHtml(d)}
      <span class="chip-count">${allCommunities.filter(c => c.district === d).length}</span>`;
    btn.addEventListener('click', () => {
      if (activeDistrictFilters.has(d)) activeDistrictFilters.delete(d);
      else activeDistrictFilters.add(d);
      renderFilterPanel();
      scheduleRefresh();
      updateFilterBadge();
    });
    distWrap.appendChild(btn);
  });

  document.getElementById('clear-filter').style.display =
    (activeCategoryFilters.size > 0 || activeDistrictFilters.size > 0) ? 'inline-flex' : 'none';
}

function updateFilterBadge() {
  const count = activeCategoryFilters.size + activeDistrictFilters.size;
  const badge = document.getElementById('filter-badge');
  if (count > 0) {
    badge.style.display = 'inline-flex';
    badge.textContent = count;
  } else {
    badge.style.display = 'none';
  }
}

// ===================== 列表抽屉 =====================
function renderListDrawer() {
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
    row.className = 'list-row';
    row.innerHTML = `
      <span class="dot" style="background:${style.color}"></span>
      <span class="list-name">${escapeHtml(item.name)}</span>
      <span class="list-cat" style="color:${style.color}">${escapeHtml(item.category)}</span>
      ${item.district ? `<span class="list-district">${escapeHtml(item.district)}</span>` : ''}
    `;
    row.addEventListener('click', () => {
      map.setCenter(new TMap.LatLng(item.lat, item.lng));
      map.setZoom(15);
      closeDrawers();
      openDetail(item);
    });
    list.appendChild(row);
  });
}

// ===================== 抽屉开关 =====================
function closeDrawers() {
  document.getElementById('filter-drawer').classList.remove('open');
  document.getElementById('list-drawer').classList.remove('open');
  document.getElementById('drawer-backdrop').classList.remove('open');
}

function openDrawer(id) {
  closeDrawers();
  document.getElementById(id).classList.add('open');
  document.getElementById('drawer-backdrop').classList.add('open');
}

// ===================== 地图初始化 =====================
function initMap() {
  defineOverlayClasses();
  const container = document.getElementById('map-container');
  map = new TMap.Map(container, {
    center: new TMap.LatLng(BEIJING_CENTER.lat, BEIJING_CENTER.lng),
    zoom: 10.5,
    pitch: 0,
    disableDefaultUI: false,
    showControl: false
  });

  lastZoom = map.getZoom();

  map.on('zoom_changed', scheduleRefresh);
  map.on('drag_end', scheduleRefresh);
  map.on('resize', scheduleRefresh);
  map.on('idle', scheduleRefresh);

  // 兜底：轮询检测缩放级别变化，避免个别事件名不触发导致聚合不刷新
  setInterval(() => {
    const z = map.getZoom();
    if (Math.abs(z - lastZoom) > 0.01) {
      lastZoom = z;
      scheduleRefresh();
    }
  }, 400);

  refreshMarkers();
}

// ===================== 数据加载 =====================
function initWithData(text) {
  allCommunities = parseMarkdown(text);
  document.getElementById('data-status').textContent = `已加载 ${allCommunities.length} 个小区`;
  document.getElementById('loader').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  renderFilterPanel();

  if (typeof TMap !== 'undefined') {
    initMap();
  } else {
    // TMap 脚本可能还没加载完，等待一下
    const waitTMap = setInterval(() => {
      if (typeof TMap !== 'undefined') {
        clearInterval(waitTMap);
        initMap();
      }
    }, 200);
  }
}

function showManualLoad() {
  document.getElementById('manual-load').style.display = 'block';
}

async function loadData() {
  try {
    const res = await fetch('data.md', { cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    const text = await res.text();
    initWithData(text);
  } catch (e) {
    showManualLoad();
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

// ===================== 搜索 / 按钮绑定 =====================
function setupUI() {
  document.getElementById('search-input').addEventListener('input', (e) => {
    searchKeyword = e.target.value.trim();
    scheduleRefresh();
  });

  document.getElementById('btn-filter').addEventListener('click', () => openDrawer('filter-drawer'));
  document.getElementById('btn-list').addEventListener('click', () => openDrawer('list-drawer'));
  document.getElementById('filter-drawer-close').addEventListener('click', closeDrawers);
  document.getElementById('list-drawer-close').addEventListener('click', closeDrawers);
  document.getElementById('drawer-backdrop').addEventListener('click', closeDrawers);

  document.getElementById('clear-filter').addEventListener('click', () => {
    activeCategoryFilters.clear();
    activeDistrictFilters.clear();
    renderFilterPanel();
    updateFilterBadge();
    scheduleRefresh();
  });

  document.getElementById('detail-close').addEventListener('click', closeDetail);
  document.getElementById('detail-backdrop').addEventListener('click', closeDetail);
}

// ===================== 启动 =====================
window.addEventListener('DOMContentLoaded', () => {
  setupManualFilePicker();
  setupUI();
  loadData();
});
