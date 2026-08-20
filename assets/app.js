/* 历代历史文化名人关系网络 —— 前端逻辑（ECharts 力导向图） */
(function () {
  'use strict';

  // 色盲友好配色（Okabe-Ito 系，8 朝代）
  var DYNASTY_COLORS = {
    '春秋战国': '#0072B2',
    '秦汉': '#E69F00',
    '魏晋南北朝': '#009E73',
    '隋唐': '#CC79A7',
    '宋': '#56B4E9',
    '元': '#D55E00',
    '明': '#F0E442',
    '清': '#8C564B'
  };
  // 边关系类型配色
  var EDGE_COLORS = {
    '師生': '#D55E00',
    '好友': '#0072B2',
    '家族': '#8C564B',
    '同僚': '#E69F00',
    '政敵': '#CC79A7',
    '唱和': '#56B4E9',
    '交往': '#9AA0A6'
  };

  var NODES = [];
  var EDGES = [];
  var nodeById = {};   // cbdbId(string) -> node
  var activeTiers = {}; // tier -> bool（默认全开）
  var query = '';
  var showLabels = true;
  var showEdgeLabels = false;

  var chart = null;

  var $ = function (id) { return document.getElementById(id); };

  function init() {
    fetch('data/network.json')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        NODES = data.nodes || [];
        EDGES = data.edges || [];
        NODES.forEach(function (n) { nodeById[String(n.id)] = n; });
        activeTiers = {};
        (data.metadata && data.metadata.dynasty_tiers || Object.keys(DYNASTY_COLORS))
          .forEach(function (t) { activeTiers[t] = true; });
        buildChips();
        buildLegend();
        setupEvents();
        render();
      })
      .catch(function (e) {
        $('graph').innerHTML = '<p style="padding:20px;color:#c00;">加载失败：' + e.message +
          '。请通过 <code>python -m http.server</code> 启动本地服务器后访问。</p>';
      });
  }

  function buildChips() {
    var wrap = $('dynasty-chips');
    wrap.innerHTML = '';
    Object.keys(DYNASTY_COLORS).forEach(function (tier) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip active';
      b.textContent = tier;
      b.addEventListener('click', function () {
        activeTiers[tier] = !activeTiers[tier];
        b.classList.toggle('active', activeTiers[tier]);
        render(true);
      });
      wrap.appendChild(b);
    });
  }

  function buildLegend() {
    var el = $('legend');
    var html = '<div class="legend-title">朝代（节点色）</div>';
    Object.keys(DYNASTY_COLORS).forEach(function (tier) {
      html += '<div class="legend-row"><span class="legend-dot" style="background:' +
        DYNASTY_COLORS[tier] + '"></span>' + tier + '</div>';
    });
    el.innerHTML = html;
  }

  function setupEvents() {
    $('search').addEventListener('input', function (e) {
      query = e.target.value.trim();
      render(false);
    });
    $('toggle-labels').addEventListener('click', function (e) {
      showLabels = !showLabels;
      e.target.classList.toggle('on', showLabels);
      render(false);
    });
    $('toggle-edgelabels').addEventListener('click', function (e) {
      showEdgeLabels = !showEdgeLabels;
      e.target.classList.toggle('on', showEdgeLabels);
      render(false);
    });
    $('detail-close').addEventListener('click', closeDetail);
    $('toggle-labels').classList.add('on');
  }

  // 依据朝代筛选 + 搜索，计算当前应显示的节点与边
  function computeSubgraph() {
    var kept = {};
    NODES.forEach(function (n) {
      if (activeTiers[n.dynasty_tier]) kept[String(n.id)] = true;
    });

    var q = query.toLowerCase();
    var matchIds = null;
    if (q) {
      matchIds = {};
      NODES.forEach(function (n) {
        var hay = (n.name + ' ' + (n.courtesy_name || '') + ' ' + (n.style_name || '')).toLowerCase();
        if (hay.indexOf(q) >= 0) matchIds[String(n.id)] = true;
      });
      // 聚焦模式：命中节点 + 其一阶邻居
      var expanded = {};
      Object.keys(matchIds).forEach(function (id) { expanded[id] = true; });
      EDGES.forEach(function (e) {
        var s = String(e.source), t = String(e.target);
        if (matchIds[s] && kept[t]) expanded[t] = true;
        if (matchIds[t] && kept[s]) expanded[s] = true;
      });
      kept = expanded;
    }

    var nodes = NODES.filter(function (n) { return kept[String(n.id)]; });
    var nodeSet = {};
    nodes.forEach(function (n) { nodeSet[String(n.id)] = true; });
    var edges = EDGES.filter(function (e) {
      return nodeSet[String(e.source)] && nodeSet[String(e.target)];
    });
    return { nodes: nodes, edges: edges, matchIds: matchIds };
  }

  function render(resetView) {
    var sub = computeSubgraph();
    var maxDeg = 1;
    sub.nodes.forEach(function (n) { if (n.degree > maxDeg) maxDeg = n.degree; });

    var gNodes = sub.nodes.map(function (n) {
      var matched = sub.matchIds && sub.matchIds[String(n.id)];
      return {
        id: 'cbdb-' + n.id,
        name: 'cbdb-' + n.id,
        value: n.degree || 1,
        symbolSize: 6 + 26 * Math.sqrt((n.degree || 1) / maxDeg),
        itemStyle: {
          color: DYNASTY_COLORS[n.dynasty_tier] || '#999',
          borderColor: matched ? '#111' : 'rgba(0,0,0,0.15)',
          borderWidth: matched ? 2.5 : 1
        },
        label: {
          show: showLabels && (n.degree >= 6 || matched),
          formatter: n.name,
          position: 'right',
          fontSize: 11,
          color: '#333'
        },
        labelLayout: { hideOverlap: true },
        person: n
      };
    });

    var gEdges = sub.edges.map(function (e) {
      return {
        source: 'cbdb-' + e.source,
        target: 'cbdb-' + e.target,
        lineStyle: {
          color: EDGE_COLORS[e.type] || '#ccc',
          width: 1,
          opacity: 0.45,
          curveness: 0.08
        },
        label: {
          show: showEdgeLabels,
          formatter: e.type,
          fontSize: 9,
          color: EDGE_COLORS[e.type] || '#666'
        },
        edgeLabel: { show: false },
        rel: e
      };
    });

    // 更新统计
    $('stat-people').textContent = sub.nodes.length;
    $('stat-edges').textContent = sub.edges.length;
    var tiers = {};
    sub.nodes.forEach(function (n) { tiers[n.dynasty_tier] = true; });
    $('stat-dynasties').textContent = Object.keys(tiers).length;

    var option = {
      backgroundColor: '#fafafa',
      tooltip: {
        confine: true,
        formatter: function (p) {
          if (p.dataType === 'edge') {
            var r = p.data.rel || {};
            var a = nodeById[String(r.source)], b = nodeById[String(r.target)];
            var head = (a ? a.name : r.source) + ' ─ ' + (b ? b.name : r.target);
            var src = r.source_text ? ('<br>出处：' + r.source_text + (r.source_pages ? ' · 第' + r.source_pages + '页' : '')) : '';
            return '<b>' + head + '</b><br>' + r.type + (r.subtype ? '（' + r.subtype + '）' : '') + src;
          }
          var n = p.data.person || {};
          var yrs = (n.birth_year || n.death_year) ? ('（' + (n.birth_year || '?') + '–' + (n.death_year || '?') + '）') : '';
          var alias = [n.courtesy_name ? '字' + n.courtesy_name : '', n.style_name ? '號' + n.style_name : ''].filter(Boolean).join(' ');
          return '<b>' + n.name + '</b> ' + yrs + '<br>' + n.dynasty_tier + ' · ' + (n.category || '') +
            (alias ? '<br>' + alias : '') + '<br>关系数：' + (n.degree || 0);
        }
      },
      series: [{
        type: 'graph',
        layout: 'force',
        data: gNodes,
        links: gEdges,
        roam: true,
        draggable: true,
        force: {
          repulsion: 150,
          edgeLength: [30, 70],
          gravity: 0.08,
          friction: 0.6,
          layoutAnimation: true
        },
        emphasis: {
          focus: 'adjacency',
          label: { show: true, fontSize: 13, fontWeight: 'bold' },
          lineStyle: { width: 2, opacity: 0.8 }
        },
        blur: {
          itemStyle: { opacity: 0.12 },
          lineStyle: { opacity: 0.05 },
          label: { opacity: 0.1 }
        },
        lineStyle: { color: 'source', curveness: 0.08 },
        label: { show: true, position: 'right', fontSize: 11 }
      }]
    };

    if (!chart) {
      chart = echarts.init($('graph'));
      chart.on('click', function (params) {
        if (params.dataType === 'node') {
          showDetail(params.data.person);
        } else if (params.dataType === 'edge') {
          showDetail(null, params.data.rel);
        }
      });
      window.addEventListener('resize', function () { chart.resize(); });
    }
    chart.setOption(option, { notMerge: true });
    if (resetView) chart.dispatchAction({ type: 'restore' });
  }

  function showDetail(person, rel) {
    var body = $('detail-body');
    if (!person) {
      body.innerHTML = '<p style="color:#666;">未找到该人物详情。</p>';
    } else {
      var yrs = (person.birth_year || person.death_year)
        ? (person.birth_year || '?') + ' – ' + (person.death_year || '?') : '不详';
      var alias = [person.courtesy_name ? '字' + person.courtesy_name : '',
                   person.style_name ? '號' + person.style_name : ''].filter(Boolean).join('　');

      var html = '<h2>' + escapeHtml(person.name) + '</h2>';
      if (alias) html += '<p class="alias">' + escapeHtml(alias) + '</p>';
      html += '<div class="kv"><span class="k">朝代</span><span class="v">' +
        escapeHtml(person.dynasty_tier) + '（' + escapeHtml(person.dynasty || '') + '）</span></div>';
      html += '<div class="kv"><span class="k">生卒年</span><span class="v">' + escapeHtml(yrs) + '</span></div>';
      html += '<div class="kv"><span class="k">类别</span><span class="v">' + escapeHtml(person.category || '—') + '</span></div>';
      html += '<div class="kv"><span class="k">简介</span><span class="v">' + escapeHtml(person.bio || '—') + '</span></div>';
      html += '<div class="kv"><span class="k">关系数</span><span class="v">' + (person.degree || 0) + '</span></div>';

      // 邻接关系列表
      var id = String(person.id);
      var rels = EDGES.filter(function (e) {
        return String(e.source) === id || String(e.target) === id;
      });
      html += '<div class="section-title">关联人物（' + rels.length + '）</div><ul class="rels">';
      rels.slice(0, 60).forEach(function (e) {
        var otherId = String(e.source) === id ? e.target : e.source;
        var other = nodeById[String(otherId)];
        var nm = other ? other.name : String(otherId);
        html += '<li><span class="rel-type" style="background:' + (EDGE_COLORS[e.type] || '#999') + '">' +
          escapeHtml(e.type) + '</span><span class="rel-name" data-id="' + otherId + '">' + escapeHtml(nm) +
          '</span>' + (e.subtype ? '<span class="rel-sub">' + escapeHtml(e.subtype) + '</span>' : '') + '</li>';
      });
      html += '</ul>';
      body.innerHTML = html;

      body.querySelectorAll('.rel-name').forEach(function (el) {
        el.addEventListener('click', function () {
          var n = nodeById[el.getAttribute('data-id')];
          if (n) { showDetail(n); $('search').value = n.name; query = n.name; render(false); }
        });
      });
    }
    $('detail').classList.remove('hidden');
  }

  function closeDetail() { $('detail').classList.add('hidden'); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  init();
})();
