/* 历代历史文化名人关系网络 —— 前端（Canvas 力导向图，支持全量 ~4 万节点） */
(function () {
  'use strict';

  // ---------- 配色与常量 ----------
  var DYNASTY_COLORS = {
    '春秋战国': '#0072B2',
    '秦汉': '#E69F00',
    '魏晋南北朝': '#009E73',
    '隋唐': '#CC79A7',
    '五代十国': '#56B4E9',
    '宋': '#F0E442',
    '辽金西夏': '#D55E00',
    '元': '#8C564B',
    '明': '#882255',
    '清': '#44AA99',
    '未詳': '#9AA0A6'
  };
  var EDGE_COLORS = {
    '師生': '#D55E00',
    '好友': '#0072B2',
    '家族': '#8C564B',
    '同僚': '#E69F00',
    '政敵': '#CC79A7',
    '唱和': '#56B4E9',
    '交往': '#9AA0A6'
  };
  // 标签滑杆档位文案与度数阈值（阈值在加载数据后按分位数计算）
  var LABEL_LEVEL_NAMES = ['无', '极少', '较少', '中等', '较多', '全部'];
  var LABEL_LEVEL_PCT = [Infinity, 0.995, 0.98, 0.92, 0.75, 1]; // 0 档永远不显示

  var $ = function (id) { return document.getElementById(id); };

  // ---------- 状态 ----------
  var META = null;
  var NODES = [];          // 全量节点（含 x/y/degree）
  var EDGES = [];          // 全量边
  var nodeById = {};       // String(id) -> node
  var texts = [];          // metadata.texts（出处书名表）
  var maxDeg = 1;
  var labelThresholds = [];// 每档标签的度数阈值

  var activeTiers = {};    // tier -> bool
  var activeNodes = [];    // 经朝代筛选后的节点引用
  var activeEdges = [];    // 两端都在 activeNodes 内的边引用
  var activeSet = {};      // String(id) -> bool

  var labelLevel = 2;      // 标签滑杆档位
  var query = '';
  var focus = null;        // { id, neighbors:Set(String(id)) } 或 null

  // 视图变换：屏幕 = (世界坐标 - center) * scale + 画布中心
  var view = { cx: 0.5, cy: 0.5, scale: 800 };
  var W = 0, H = 0, DPR = 1;
  var dirty = true;

  var canvas, ctx;
  var pointerState = null; // 拖拽/捏合状态
  var dragMoved = false;   // 是否发生了拖拽（用于抑制点击误触）

  // ---------- 加载数据 ----------
  function load() {
    fetch('data/network.json')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        META = data.metadata || {};
        texts = META.texts || [];
        NODES = data.nodes || [];
        EDGES = data.edges || [];
        NODES.forEach(function (n) {
          nodeById[String(n.id)] = n;
          if (n.degree > maxDeg) maxDeg = n.degree;
        });
        NODES.sort(function (a, b) { return (b.degree || 0) - (a.degree || 0); });
        computeLabelThresholds();
        activeTiers = {};
        (META.dynasty_tiers || Object.keys(DYNASTY_COLORS)).forEach(function (t) {
          activeTiers[t] = true;
        });
        buildChips();
        buildLegend();
        setupCanvas();
        setupEvents();
        rebuildActive();
        fitView();
        $('loading').classList.add('hidden');
        render();
      })
      .catch(function (e) {
        $('loading').textContent = '加载失败：' + e.message +
          '。请通过 python -m http.server 启动本地服务器后访问。';
      });
  }

  function computeLabelThresholds() {
    var degs = NODES.map(function (n) { return n.degree || 1; }).sort(function (a, b) { return a - b; });
    labelThresholds = LABEL_LEVEL_PCT.map(function (p) {
      if (p === Infinity) return Infinity;
      var idx = Math.min(degs.length - 1, Math.floor(degs.length * p));
      return degs[idx] || 1;
    });
  }

  // ---------- UI 构建 ----------
  function buildChips() {
    var wrap = $('dynasty-chips');
    wrap.innerHTML = '';
    (META.dynasty_tiers || Object.keys(DYNASTY_COLORS)).forEach(function (tier) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip active';
      b.textContent = tier;
      b.addEventListener('click', function () {
        activeTiers[tier] = !activeTiers[tier];
        b.classList.toggle('active', activeTiers[tier]);
        rebuildActive();
        render();
      });
      wrap.appendChild(b);
    });
  }

  function buildLegend() {
    var el = $('legend');
    var html = '<div class="legend-title">朝代（节点颜色）</div>';
    (META.dynasty_tiers || Object.keys(DYNASTY_COLORS)).forEach(function (tier) {
      html += '<div class="legend-row"><span class="legend-dot" style="background:' +
        (DYNASTY_COLORS[tier] || '#999') + '"></span>' + tier + '</div>';
    });
    html += '<div class="legend-title" style="margin-top:6px">性别（节点形状）</div>';
    html += '<div class="legend-row"><svg class="legend-shape" viewBox="-6 -6 12 12"><circle r="5" fill="#666"/></svg>男</div>';
    html += '<div class="legend-row"><svg class="legend-shape" viewBox="-6 -6 12 12"><path d="M0,-5 L5,4 L-5,4 Z" fill="#666"/></svg>女</div>';
    el.innerHTML = html;
  }

  // ---------- 画布 ----------
  function setupCanvas() {
    canvas = $('graph');
    ctx = canvas.getContext('2d');
    resize();
  }

  function resize() {
    var box = $('container').getBoundingClientRect();
    W = box.width;
    H = box.height;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    dirty = true;
  }

  function fitView() {
    view.scale = Math.min(W, H) * 0.98;
    view.cx = 0.5;
    view.cy = 0.5;
    dirty = true;
  }

  // 世界坐标 -> 屏幕坐标
  function wx(wx) { return (wx - view.cx) * view.scale + W / 2; }
  function wy(wy) { return (wy - view.cy) * view.scale + H / 2; }
  function sx(x) { return wx(x); }
  function sy(y) { return wy(y); }

  function rebuildActive() {
    activeNodes = [];
    activeSet = {};
    var q = query.toLowerCase();
    var matchIds = null;
    if (q) {
      matchIds = {};
      NODES.forEach(function (n) {
        var hay = (n.name + ' ' + (n.courtesy_name || '') + ' ' + (n.style_name || '')).toLowerCase();
        if (hay.indexOf(q) >= 0) matchIds[String(n.id)] = true;
      });
      var matchList = Object.keys(matchIds);
      if (matchList.length) {
        // 聚焦首个匹配人物及其一阶邻居
        var first = matchList[0];
        var neighbors = {};
        neighbors[first] = true;
        EDGES.forEach(function (e) {
          var s = String(e.source), t = String(e.target);
          if (matchIds[s]) neighbors[t] = true;
          if (matchIds[t]) neighbors[s] = true;
        });
        focus = { id: first, neighbors: neighbors, matches: matchIds };
        NODES.forEach(function (n) {
          if (neighbors[String(n.id)] && activeTiersCheck(n)) {
            activeNodes.push(n);
            activeSet[String(n.id)] = true;
          }
        });
      } else {
        focus = null;
      }
    } else {
      focus = null;
      NODES.forEach(function (n) {
        if (activeTiersCheck(n)) {
          activeNodes.push(n);
          activeSet[String(n.id)] = true;
        }
      });
    }

    activeEdges = [];
    if (focus) {
      // 聚焦模式下只画聚焦节点与其邻居之间的边（保证可读）
      var nb = focus.neighbors;
      EDGES.forEach(function (e) {
        var s = String(e.source), t = String(e.target);
        if ((nb[s] || nb[t]) && activeSet[s] && activeSet[t]) activeEdges.push(e);
      });
    } else {
      EDGES.forEach(function (e) {
        if (activeSet[String(e.source)] && activeSet[String(e.target)]) activeEdges.push(e);
      });
    }
    updateStats();
    dirty = true;
  }

  function activeTiersCheck(n) {
    var tiers = (n.dynasty_tiers && n.dynasty_tiers.length) ? n.dynasty_tiers : [n.dynasty_tier];
    for (var i = 0; i < tiers.length; i++) {
      if (activeTiers[tiers[i]]) return true;
    }
    return false;
  }

  function updateStats() {
    $('stat-people').textContent = activeNodes.length.toLocaleString();
    $('stat-edges').textContent = activeEdges.length.toLocaleString();
    var tiers = {};
    activeNodes.forEach(function (n) {
      var t = (n.dynasty_tiers && n.dynasty_tiers.length) ? n.dynasty_tiers : [n.dynasty_tier];
      t.forEach(function (x) { tiers[x] = true; });
    });
    $('stat-dynasties').textContent = Object.keys(tiers).length;
  }

  // ---------- 渲染 ----------
  function render() {
    if (!canvas || !dirty) return;
    dirty = false;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, 0, W, H);

    var margin = 40;
    var x0 = -margin, x1 = W + margin, y0 = -margin, y1 = H + margin;

    var focusDim = focus ? 0.12 : 1;
    var focusNb = focus ? focus.neighbors : null;
    var focusMatches = focus ? focus.matches : null;

    // --- 边 ---
    ctx.lineWidth = 1;
    for (var i = 0; i < activeEdges.length; i++) {
      var e = activeEdges[i];
      var a = nodeById[String(e.source)];
      var b = nodeById[String(e.target)];
      if (!a || !b) continue;
      var ax = sx(a.x), ay = sy(a.y), bx = sx(b.x), by = sy(b.y);
      // 视口裁剪
      if ((ax < x0 && bx < x0) || (ax > x1 && bx > x1) || (ay < y0 && by < y0) || (ay > y1 && by > y1)) continue;
      var alpha = 0.22;
      if (focus) {
        var sa = String(a.id), sb = String(b.id);
        if (focusNb[sa] || focusNb[sb]) alpha = 0.35; else alpha = 0.05;
      }
      ctx.strokeStyle = EDGE_COLORS[e.type] || '#ccc';
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // --- 节点 ---
    for (var j = 0; j < activeNodes.length; j++) {
      var n = activeNodes[j];
      var px = sx(n.x), py = sy(n.y);
      if (px < x0 || px > x1 || py < y0 || py > y1) continue;
      var deg = n.degree || 1;
      var r = 1.6 + 9 * Math.sqrt(deg / maxDeg);
      var alpha = 0.28 + 0.72 * Math.pow(deg / maxDeg, 0.3);
      var color = DYNASTY_COLORS[n.dynasty_tier] || '#999';

      if (focus) {
        var id = String(n.id);
        if (id === focus.id) {
          alpha = 1; r = Math.max(r, 8);
        } else if (focusNb[id]) {
          alpha = 0.85;
        } else {
          alpha = 0.12;
        }
      }

      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      if (n.gender === '女') {
        // 女性：上三角
        var s = r * 1.25;
        ctx.beginPath();
        ctx.moveTo(px, py - s);
        ctx.lineTo(px + s * 0.95, py + s * 0.7);
        ctx.lineTo(px - s * 0.95, py + s * 0.7);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // 聚焦匹配高亮描边
      if (focus && focusMatches && focusMatches[id]) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#111';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, r + 2.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // --- 标签（按度数阈值 + 视口裁剪 + 防重叠） ---
    var thr = labelThresholds[labelLevel];
    if (thr !== Infinity) {
      var cellW = 90, cellH = 16;
      var occupied = {};
      ctx.font = '11px -apple-system, "PingFang SC", "Hiragino Sans GB", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      var drawn = 0;
      for (var k = 0; k < activeNodes.length; k++) {
        if (drawn > 4000) break; // 单帧标签上限，保证流畅
        var m = activeNodes[k];
        if ((m.degree || 0) < thr) continue; // 度数不足不显示
        var lx = sx(m.x), ly = sy(m.y);
        if (lx < 4 || lx > W - 40 || ly < 8 || ly > H - 8) continue;
        var ck = Math.floor(lx / cellW) + '_' + Math.floor(ly / cellH);
        if (occupied[ck]) continue;
        occupied[ck] = true;
        drawn++;
        ctx.globalAlpha = focus && !focusNb[String(m.id)] ? 0.3 : 0.9;
        ctx.fillStyle = '#333';
        ctx.fillText(m.name, lx + 5, ly);
      }
      ctx.globalAlpha = 1;
    }
  }

  function loop() {
    render();
    requestAnimationFrame(loop);
  }

  // ---------- 交互 ----------
  function setupEvents() {
    window.addEventListener('resize', function () { resize(); render(); });

    // 标签滑杆
    var slider = $('label-slider');
    slider.addEventListener('input', function () {
      labelLevel = parseInt(slider.value, 10);
      $('label-slider-val').textContent = LABEL_LEVEL_NAMES[labelLevel];
      dirty = true;
      render();
    });

    // 搜索
    $('search').addEventListener('input', function (e) {
      query = e.target.value.trim();
      rebuildActive();
      if (focus) centerOnNode(focus.id);
      render();
    });

    // 重置视图
    $('reset-view').addEventListener('click', function () {
      $('search').value = '';
      query = '';
      rebuildActive();
      fitView();
      render();
    });

    // 详情关闭
    $('detail-close').addEventListener('click', closeDetail);

    // 指针交互（鼠标 + 触控统一处理）
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('pointerleave', function () { hideTooltip(); });
  }

  function screenToWorld(px, py) {
    return { x: (px - W / 2) / view.scale + view.cx, y: (py - H / 2) / view.scale + view.cy };
  }

  function onPointerDown(e) {
    canvas.setPointerCapture(e.pointerId);
    if (!pointerState) {
      pointerState = {
        startX: e.clientX, startY: e.clientY,
        cx: view.cx, cy: view.cy,
        pointers: {}, prevDist: null
      };
      dragMoved = false;
    }
    pointerState.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!pointerState) { handleHover(e); return; }
    pointerState.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(pointerState.pointers);
    var rect = canvas.getBoundingClientRect();
    if (ids.length === 2) {
      // 捏合缩放
      var p0 = pointerState.pointers[ids[0]];
      var p1 = pointerState.pointers[ids[1]];
      var dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      var prev = pointerState.prevDist || dist;
      var midX = (p0.x + p1.x) / 2 - rect.left;
      var midY = (p0.y + p1.y) / 2 - rect.top;
      zoomAt(midX, midY, view.scale * (dist / prev));
      pointerState.prevDist = dist;
    } else {
      // 拖拽平移
      var dx = e.clientX - pointerState.startX;
      var dy = e.clientY - pointerState.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragMoved = true;
      view.cx = pointerState.cx - dx / view.scale;
      view.cy = pointerState.cy - dy / view.scale;
      dirty = true;
      render();
    }
  }

  function onPointerUp(e) {
    if (!pointerState) return;
    delete pointerState.pointers[e.pointerId];
    if (Object.keys(pointerState.pointers).length === 0) {
      pointerState = null;
    }
  }

  function onWheel(e) {
    e.preventDefault();
    var rect = canvas.getBoundingClientRect();
    var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, view.scale * factor);
  }

  function zoomAt(px, py, newScale) {
    newScale = Math.max(20, Math.min(60000, newScale));
    var w = screenToWorld(px, py);
    view.scale = newScale;
    view.cx = w.x - (px - W / 2) / view.scale;
    view.cy = w.y - (py - H / 2) / view.scale;
    dirty = true;
    render();
  }

  function centerOnNode(id) {
    var n = nodeById[String(id)];
    if (!n) return;
    view.cx = n.x;
    view.cy = n.y;
    dirty = true;
  }

  function hitTest(px, py) {
    var best = null, bestD = 10; // 命中半径（像素）
    for (var i = 0; i < activeNodes.length; i++) {
      var n = activeNodes[i];
      var nx = sx(n.x), ny = sy(n.y);
      var dx = nx - px, dy = ny - py;
      var d = dx * dx + dy * dy;
      if (d < bestD * bestD) { bestD = Math.sqrt(d); best = n; }
    }
    return best;
  }

  function handleHover(e) {
    var rect = canvas.getBoundingClientRect();
    var n = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (n) showTooltip(n, e.clientX, e.clientY);
    else hideTooltip();
  }

  function onClick(e) {
    if (dragMoved) { dragMoved = false; return; }
    var rect = canvas.getBoundingClientRect();
    var n = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (n) showDetail(n);
  }

  // ---------- 提示与详情 ----------
  function showTooltip(n, cx, cy) {
    var tt = $('tooltip');
    var yrs = (n.birth_year || n.death_year) ? ('（' + (n.birth_year || '?') + '–' + (n.death_year || '?') + '）') : '';
    var tiers = (n.dynasty_tiers && n.dynasty_tiers.length) ? n.dynasty_tiers.join('/') : n.dynasty_tier;
    tt.innerHTML = '<b>' + escapeHtml(n.name) + '</b> ' + escapeHtml(yrs) +
      '<br>' + escapeHtml(tiers) + ' · ' + escapeHtml(n.gender || '') + ' · ' +
      escapeHtml(n.category || '') + '<br>关系数：' + (n.degree || 0);
    tt.classList.remove('hidden');
    var w = tt.offsetWidth, h = tt.offsetHeight;
    var left = cx + 14, top = cy + 14;
    if (left + w > window.innerWidth - 8) left = cx - w - 14;
    if (top + h > window.innerHeight - 8) top = cy - h - 14;
    tt.style.left = Math.max(4, left) + 'px';
    tt.style.top = Math.max(4, top) + 'px';
  }

  function hideTooltip() { $('tooltip').classList.add('hidden'); }

  function showDetail(person) {
    var body = $('detail-body');
    var yrs = (person.birth_year || person.death_year)
      ? (person.birth_year || '?') + ' – ' + (person.death_year || '?') : '不详';
    var alias = [person.courtesy_name ? '字' + person.courtesy_name : '',
                 person.style_name ? '號' + person.style_name : ''].filter(Boolean).join('　');
    var tiers = (person.dynasty_tiers && person.dynasty_tiers.length)
      ? person.dynasty_tiers.join(' / ') : person.dynasty_tier;

    var html = '<h2>' + escapeHtml(person.name) + '</h2>';
    if (alias) html += '<p class="alias">' + escapeHtml(alias) + '</p>';
    html += '<div class="kv"><span class="k">朝代</span><span class="v">' +
      escapeHtml(tiers) + (person.dynasty ? '（' + escapeHtml(person.dynasty) + '）' : '') + '</span></div>';
    html += '<div class="kv"><span class="k">性别</span><span class="v">' + escapeHtml(person.gender || '—') + '</span></div>';
    html += '<div class="kv"><span class="k">生卒年</span><span class="v">' + escapeHtml(yrs) + '</span></div>';
    html += '<div class="kv"><span class="k">类别</span><span class="v">' + escapeHtml(person.category || '—') + '</span></div>';
    html += '<div class="kv"><span class="k">关系数</span><span class="v">' + (person.degree || 0) + '</span></div>';

    // 邻接关系列表（按对方度数降序，取前 60）
    var id = String(person.id);
    var rels = [];
    EDGES.forEach(function (e) {
      if (String(e.source) === id || String(e.target) === id) {
        var otherId = String(e.source) === id ? String(e.target) : String(e.source);
        var other = nodeById[otherId];
        if (other) rels.push({ other: other, type: e.type, text: e.text_id != null ? texts[e.text_id] : '' });
      }
    });
    rels.sort(function (a, b) { return (b.other.degree || 0) - (a.other.degree || 0); });
    html += '<div class="section-title">关联人物（' + rels.length + '）</div><ul class="rels">';
    rels.slice(0, 60).forEach(function (r) {
      html += '<li><span class="rel-type">' + escapeHtml(r.type) + '</span>' +
        '<span class="rel-name" data-id="' + r.other.id + '">' + escapeHtml(r.other.name) + '</span>' +
        '</li>';
    });
    html += '</ul>';
    body.innerHTML = html;

    body.querySelectorAll('.rel-name').forEach(function (el) {
      el.addEventListener('click', function () {
        var n = nodeById[String(el.getAttribute('data-id'))];
        if (n) {
          showDetail(n);
          centerOnNode(n.id);
          render();
        }
      });
    });
    $('detail').classList.remove('hidden');
  }

  function closeDetail() { $('detail').classList.add('hidden'); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  load();
  requestAnimationFrame(loop);
})();
