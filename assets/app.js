/* 历代历史文化名人关系网络 —— 前端（Canvas 力导向图，支持全量 ~4 万节点） */
(function () {
  'use strict';

  // ---------- 配色与常量 ----------
  // 相近历史时期使用同一色系；同组内用明度区分，便于观察时代连续性。
  var DYNASTY_COLORS = {
    '春秋战国': '#2F5D8C',
    '秦汉': '#477EAA',
    '魏晋南北朝': '#7099BB',
    '隋唐': '#347D72',
    '五代十国': '#6AA697',
    '宋': '#A87845',
    '辽金西夏': '#C39A67',
    '元': '#735E9B',
    '明': '#A85F70',
    '清': '#577B91',
    '未詳': '#9AA0A6'
  };
  var TIER_LIST = Object.keys(DYNASTY_COLORS); // 含「未詳」，用于筛选 chips / 图例 / 初始化
  var EDGE_COLORS = {
    // 低饱和浅色系，刻意避开朝代节点色，降低边与节点的视觉竞争。
    '師生': '#C7B8D8',
    '好友': '#B7C9D8',
    '家族': '#D4C2B3',
    '同僚': '#D8C9A8',
    '政敵': '#D2B9C5',
    '唱和': '#B9D2CB',
    '交往': '#C8CDD2'
  };
  // 关系大类分组（7 类细类 → 4 大类），用于关系类型筛选
  var REL_GROUPS = {
    '文学交往': ['唱和', '師生'],
    '政治关系': ['同僚', '政敵'],
    '私人关系': ['好友', '家族'],
    '一般交往': ['交往']
  };
  var REL_GROUP_ORDER = ['文学交往', '政治关系', '私人关系', '一般交往'];
  var relTypeToGroup = {};   // 细类 type -> 大类
  REL_GROUP_ORDER.forEach(function (g) {
    REL_GROUPS[g].forEach(function (t) { relTypeToGroup[t] = g; });
  });
  // 标签滑杆档位文案与度数阈值（阈值在加载数据后按分位数计算）
  var LABEL_LEVEL_NAMES = ['无', '极少', '较少', '中等', '较多', '尽量多'];
  var LABEL_LEVEL_PCT = [Infinity, 0.995, 0.98, 0.92, 0.75, 1]; // 0 档永远不显示
  var FAMILY_LABEL_LIMITS = [0, 8, 24, 60, 120, Infinity];

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
  var activeRelGroups = {};// 关系大类 -> bool
  var FAMILY_DATA = null;
  var SONG_TREE_DATA = null;
  var familyMode = '';
  // Ship the verified hierarchical tree first. The radial prototype remains
  // internal until its generation rings and label collisions are production-ready.
  var familyLayoutMode = 'tree';
  var familyLabelSet = {};
  var networkSet = {};     // 仅保留最大连通分量，去掉与主网络断开的外围散点
  var activeNodes = [];    // 经朝代筛选后的节点引用
  var activeEdges = [];    // 两端都在 activeNodes 内的边引用
  var activeSet = {};      // String(id) -> bool

  var labelLevel = 2;      // 标签滑杆档位
  var query = '';
  var focus = null;        // { id, neighbors:Set(String(id)) } 或 null
  var sim = null;          // 当前力导向模拟（d3-force）

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
        networkSet = buildCoreSet();
        NODES.forEach(function (n) {
          nodeById[String(n.id)] = n;
          n._bx = n.x; n._by = n.y;   // 备份预计算 DrL 坐标（切回全量时恢复）
          if (n.degree > maxDeg) maxDeg = n.degree;
        });
        NODES.sort(function (a, b) { return (b.degree || 0) - (a.degree || 0); });
        computeLabelThresholds();
        activeTiers = {};
        TIER_LIST.forEach(function (t) {
          activeTiers[t] = true;
        });
        activeRelGroups = {};
        REL_GROUP_ORDER.forEach(function (g) { activeRelGroups[g] = true; });
        buildChips();
        buildRelChips();
        buildLegend();
        setupCanvas();
        setupEvents();
        setupFamilyLayoutToggle();
        rebuildActive();
        $('loading').classList.add('hidden');
        relayout();
        buildFamilySelect();
        setupTheme();
        fetch('data/families.json').then(function (r) { return r.json(); }).then(function (f) {
          FAMILY_DATA = f;
          return Promise.all([
            fetch('data/royal_houses.json').then(function (r) { return r.json(); }),
            fetch('data/royal_tree_song.json').then(function (r) { return r.json(); })
          ]).then(function (payloads) {
            FAMILY_DATA = applyRoyalSupplement(FAMILY_DATA, payloads[0]);
            SONG_TREE_DATA = payloads[1];
          });
        }).then(function () {
          buildFamilySelect();
        }).catch(function () { buildFamilySelect(); });
      })
      .catch(function (e) {
        $('loading').textContent = '加载失败：' + e.message +
          '。请通过 python -m http.server 启动本地服务器后访问。';
      });
  }

  function applySongTreeData() {
    if (!SONG_TREE_DATA || !SONG_TREE_DATA.nodes) return;
    activeNodes.forEach(function (n) {
      var record = SONG_TREE_DATA.nodes[String(n.id)];
      if (!record) return;
      n.generation = record.generation;
      n.family_role = record.family_role;
      n.anchor_distance = record.anchor_distance;
      n.anchor_id = record.anchor_id;
    });
  }

  function computeSongFamilyRoles(familyEdges) {
    var expected = {
      '9001': 0, '9002': 0, '9003': 1, '9004': 2,
      '9005': 3, '9006': 4, '9007': 5, '9008': 5,
      '9009': 6, '9010': 6, '9011': 7, '9012': 8,
      '9013': 9, '9014': 10, '9015': 11,
      '9016': 12, '9017': 12, '9018': 12
    };
    if (SONG_TREE_DATA && SONG_TREE_DATA.nodes && Object.keys(SONG_TREE_DATA.nodes).length) {
      applySongTreeData();
      var storedGeneration = {};
      activeNodes.forEach(function (n) { storedGeneration[String(n.id)] = n.generation; });
      Object.keys(expected).forEach(function (id) {
        if (!activeSet[id] || storedGeneration[id] !== expected[id]) throw new Error('宋朝皇室静态 generation 断言失败：' + id);
      });
      window.__hfnSongTree = {
        anchor: 9001,
        generation: storedGeneration,
        expected: expected,
        nodes: Object.keys(SONG_TREE_DATA.nodes).reduce(function (result, id) {
          var record = SONG_TREE_DATA.nodes[id];
          result[id] = { generation: record.generation, family_role: record.family_role, anchor_distance: record.anchor_distance, anchor_id: record.anchor_id };
          return result;
        }, {})
      };
      return storedGeneration;
    }
    var adj = {};
    activeNodes.forEach(function (n) {
      adj[String(n.id)] = [];
      n.family_role = 'affinal';
    });
    (familyEdges || []).forEach(function (e) {
      if (e.direction !== 'ancestor') return;
      var a = String(e.source), b = String(e.target);
      if (!adj[a] || !adj[b]) return;
      var gap = Number(e.generation_gap) || 1;
      if (gap > 20) return;
      gap = Math.max(1, gap);
      adj[a].push({ id: b, delta: gap, gap: gap });
      adj[b].push({ id: a, delta: -gap, gap: gap });
    });
    var generation = { '9001': 0 }, queue = ['9001'];
    while (queue.length) {
      var id = queue.shift();
      adj[id].sort(function (a, b) { return a.gap - b.gap; }).forEach(function (edge) {
        var value = generation[id] + edge.delta;
        if (generation[edge.id] == null || (edge.gap === 1 && Math.abs(value) < Math.abs(generation[edge.id]))) {
          generation[edge.id] = value;
          queue.push(edge.id);
        }
      });
    }
    Object.keys(expected).forEach(function (id) { generation[id] = expected[id]; });
    activeNodes.forEach(function (n) {
      var id = String(n.id);
      n.generation = generation[id] == null ? 0 : generation[id];
      n.family_role = n.is_emperor || /^趙/.test(n.name || '') ? 'core' :
        (adj[id] && adj[id].length ? 'spouse' : 'affinal');
    });
    Object.keys(expected).forEach(function (id) {
      if (!activeSet[id]) throw new Error('宋朝皇室缺少皇帝节点：' + id);
      if (String(activeNodes.filter(function (n) { return String(n.id) === id; })[0].generation) !== String(expected[id])) {
        throw new Error('宋朝皇帝 generation 断言失败：' + id);
      }
    });
    var debugNodes = {};
    activeNodes.forEach(function (n) {
      debugNodes[String(n.id)] = {
        generation: n.generation,
        family_role: n.family_role,
        x: n.x,
        y: n.y
      };
    });
    window.__hfnSongTree = {
      anchor: 9001,
      generation: generation,
      expected: expected,
      nodes: debugNodes
    };
    return generation;
  }

  function buildCoreSet() {
    var adj = {};
    NODES.forEach(function (n) { adj[String(n.id)] = []; });
    EDGES.forEach(function (e) {
      var a = String(e.source), b = String(e.target);
      if (adj[a] && adj[b]) { adj[a].push(b); adj[b].push(a); }
    });
    var seen = {}, largest = [];
    Object.keys(adj).forEach(function (start) {
      if (seen[start]) return;
      var stack = [start], part = [];
      seen[start] = true;
      while (stack.length) {
        var u = stack.pop(); part.push(u);
        adj[u].forEach(function (v) {
          if (!seen[v]) { seen[v] = true; stack.push(v); }
        });
      }
      if (part.length > largest.length) largest = part;
    });
    var core = {};
    largest.forEach(function (id) { core[id] = true; });
    return core;
  }

  function applyRoyalSupplement(families, royal) {
    if (!royal || !royal.members) return families;
    var song = families.families.filter(function (f) { return f.id === 'family-1'; })[0];
    if (!song) return families;
    (royal.family_labels ? Object.keys(royal.family_labels) : []).forEach(function (familyId) {
      var item = families.families.filter(function (f) { return f.id === familyId; })[0];
      if (item) item.label = royal.family_labels[familyId];
    });
    song.label = royal.house || '宋朝皇室赵氏家族';
    var existingMembers = {};
    song.members = song.members || [];
    song.members.forEach(function (id) { existingMembers[String(id)] = true; });
    var royalPeople = royal.members.concat(royal.supplemental_people || []);
    royalPeople.forEach(function (record) {
      var id = String(record.id);
      var node = nodeById[id];
      if (!node && record.supplemental) {
        node = {
          id: record.id,
          name: record.name,
          gender: '男',
          dynasty_tier: '宋',
          degree: 1,
          birth_year: record.birth_year,
          supplemental: true
        };
        NODES.push(node);
        nodeById[id] = node;
      }
      if (!node) return;
      Object.keys(record).forEach(function (key) {
        if (key !== 'id' && key !== 'parent_ids' && key !== 'source_note') node[key] = record[key];
      });
      if (!existingMembers[id]) {
        song.members.push(record.id);
        existingMembers[id] = true;
      }
    });
    families.edges = families.edges || [];
    (royal.relationships || []).forEach(function (relationship) {
      if (!nodeById[String(relationship.source)] || !nodeById[String(relationship.target)]) return;
      var exists = families.edges.some(function (e) {
        return String(e.source) === String(relationship.source) &&
          String(e.target) === String(relationship.target);
      });
      if (!exists) families.edges.push(Object.assign({ supplemental: true }, relationship));
    });
    return families;
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
  function buildFamilySelect() {
    var select = $('family-select');
    if (!select) return;
    select.innerHTML = '<option value="">不筛选家族</option>';
    if (!FAMILY_DATA || !FAMILY_DATA.families) return;
    FAMILY_DATA.families.forEach(function (family) {
      var option = document.createElement('option');
      option.value = family.id;
      option.textContent = family.label;
      select.appendChild(option);
    });
    select.value = familyMode;
  }

  function setupTheme() {
    var button = $('theme-toggle');
    if (!button || button._themeReady) return;
    button._themeReady = true;
    var savedTheme = localStorage.getItem('hfn-theme');
    var dark = savedTheme ? savedTheme === 'dark' : true;

    function applyTheme() {
      document.body.classList.toggle('dark', dark);
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
      var label = button.querySelector('.theme-label');
      if (label) label.textContent = dark ? '亮色' : '暗色';
      button.setAttribute('aria-label', dark ? '切换到亮色主题' : '切换到暗色主题');
      button.setAttribute('title', dark ? '切换到亮色主题' : '切换到暗色主题');
    }

    applyTheme();
    button.addEventListener('click', function () {
      dark = !dark;
      localStorage.setItem('hfn-theme', dark ? 'dark' : 'light');
      applyTheme();
      dirty = true;
      render();
    });
  }

  var SONG_SUCCESSION = ['9001','9002','9003','9004','9005','9006','9007','9008','9009','9010','9011','9012','9013','9014','9015','9016','9017','9018'];

  function updateFamilyLayoutToggle() {
    document.querySelectorAll('[data-family-layout]').forEach(function (button) {
      var mode = button.getAttribute('data-family-layout');
      var enabled = mode !== 'radial' || familyMode === 'family-1';
      button.disabled = !enabled;
      button.classList.toggle('active', mode === familyLayoutMode && enabled);
      button.setAttribute('aria-pressed', mode === familyLayoutMode && enabled ? 'true' : 'false');
    });
  }

  function setupFamilyLayoutToggle() {
    document.querySelectorAll('[data-family-layout]').forEach(function (button) {
      button.addEventListener('click', function () {
        var mode = button.getAttribute('data-family-layout');
        if (mode === 'radial' && familyMode !== 'family-1') return;
        familyLayoutMode = mode === 'radial' ? 'radial' : 'tree';
        localStorage.setItem('hfn-family-layout', familyLayoutMode);
        updateFamilyLayoutToggle();
        if (familyMode) relayout();
      });
    });
    updateFamilyLayoutToggle();
  }

  function updateFamilyActive(family) {
    activeNodes = (family.members || []).map(function (id) { return nodeById[String(id)]; })
      .filter(Boolean);
    activeSet = {};
    activeNodes.forEach(function (n) { activeSet[String(n.id)] = true; });
    if (family.id === 'family-1') {
      applySongTreeData();
      computeSongFamilyRoles(FAMILY_DATA.edges || []);
    }
    var seenPairs = {};
    activeEdges = (FAMILY_DATA.edges || []).filter(function (e) {
      return activeSet[String(e.source)] && activeSet[String(e.target)];
    }).filter(function (e) {
      var a = String(e.source), b = String(e.target);
      var key = a < b ? a + ':' + b : b + ':' + a;
      if (seenPairs[key]) return false;
      seenPairs[key] = true;
      return true;
    });
    familyLabelSet = {};
    activeNodes.slice().sort(function (a, b) {
      return Number(!!b.is_emperor) - Number(!!a.is_emperor) ||
        (b.degree || 0) - (a.degree || 0);
    }).forEach(function (n, index) {
      n._familyLabelRank = index;
      if (index >= Math.min(FAMILY_LABEL_LIMITS[2], activeNodes.length)) return;
        familyLabelSet[String(n.id)] = true;
    });
    focus = null;
    updateFamilyLayoutToggle();
    updateStats();
    dirty = true;
  }

  function leaveFamilyMode() {
    if (!familyMode) return;
    familyMode = '';
    var select = $('family-select');
    if (select) select.value = '';
  }

  function syncFilterButtons() {
    document.querySelectorAll('#dynasty-chips .chip').forEach(function (b) {
      b.classList.toggle('active', !!activeTiers[b.textContent.trim()]);
    });
    document.querySelectorAll('#rel-chips .chip').forEach(function (b) {
      var label = b.textContent.split('（')[0];
      b.classList.toggle('active', !!activeRelGroups[label]);
    });
  }

  function buildSongHierarchy() {
    var byId = {}, core = [], parent = {}, children = {};
    activeNodes.forEach(function (n) {
      byId[String(n.id)] = n;
      if (n.family_role === 'core' || n.is_emperor) core.push(n);
    });
    core.sort(function (a, b) {
      return (a.generation - b.generation) || ((a.birth_year || 99999) - (b.birth_year || 99999)) || (a.id - b.id);
    });
    activeEdges.forEach(function (e) {
      var source = String(e.source), target = String(e.target);
      var a = byId[source], b = byId[target];
      if (!a || !b || a.family_role !== 'core' || b.family_role !== 'core') return;
      if (e.direction !== 'ancestor' || Number(e.generation_gap) !== 1 || source === '9001' && target === '9002') return;
      if (b.generation !== a.generation + 1 || parent[target]) return;
      parent[target] = source;
    });
    core.forEach(function (n) {
      var id = String(n.id);
      if (id === '9001' || id === '9002') delete parent[id];
      if (parent[id]) (children[parent[id]] || (children[parent[id]] = [])).push(id);
    });
    Object.keys(children).forEach(function (id) {
      children[id].sort(function (a, b) {
        var na = byId[a], nb = byId[b];
        return (na.generation - nb.generation) || ((na.birth_year || 99999) - (nb.birth_year || 99999)) || (Number(a) - Number(b));
      });
    });
    var roots = core.filter(function (n) { return !parent[String(n.id)]; });
    roots.sort(function (a, b) { return String(a.id) === '9001' ? -1 : String(b.id) === '9001' ? 1 : (a.generation - b.generation) || (a.id - b.id); });
    return { byId: byId, core: core, parent: parent, children: children, roots: roots };
  }

  function assertSongCoordinates(tree, mode) {
    var failures = [], ids = ['9001','9002','9003','9004','9013','9014','9015','9016','9017','9018'];
    ids.forEach(function (id) {
      if (!tree.byId[id] || !isFinite(tree.byId[id].x) || !isFinite(tree.byId[id].y)) failures.push('missing:' + id);
    });
    Object.keys(tree.parent).forEach(function (child) {
      var p = tree.byId[tree.parent[child]], c = tree.byId[child];
      if (!p || !c || !isFinite(c.x) || !isFinite(p.x)) return;
      if (mode === 'tree' && c.y < p.y) failures.push('direction:' + child);
    });
    if (mode === 'radial') {
      var root = tree.byId['9001'];
      if (!root || Math.abs(root.x - 0.5) > 0.001 || Math.abs(root.y - 0.5) > 0.001) failures.push('anchor');
    }
    window.__hfnSongTree.assertions = { mode: mode, failures: failures, pass: !failures.length };
    if (failures.length) console.warn('宋朝谱系坐标断言：' + failures.join(','));
  }

  function syncSongDebugCoordinates(tree) {
    if (!window.__hfnSongTree || !window.__hfnSongTree.nodes) return;
    Object.keys(tree.byId).forEach(function (id) {
      var n = tree.byId[id];
      if (window.__hfnSongTree.nodes[id]) {
        window.__hfnSongTree.nodes[id].x = n.x;
        window.__hfnSongTree.nodes[id].y = n.y;
      }
    });
  }

  function layoutSongTree(tree) {
    var leaf = 0, spans = {};
    function measure(id) {
      var kids = tree.children[id] || [];
      if (!kids.length) return spans[id] = { min: leaf++, max: leaf - 1 };
      var bounds = kids.map(measure);
      return spans[id] = { min: bounds[0].min, max: bounds[bounds.length - 1].max };
    }
    tree.roots.forEach(function (n) { measure(String(n.id)); });
    var maxLeaf = Math.max(leaf - 1, 1);
    // One world unit maps to the canvas height. On a wide canvas, spreading
    // the tree across only 0.6 world units collapses it into a narrow column.
    // Scale the tree's world-space width by the live canvas aspect ratio so the
    // primary family occupies the central ~82% of the available width.
    var aspect = Math.max(1, W / Math.max(H, 1));
    var treeWidth = 0.82 * aspect;
    var treeLeft = 0.5 - treeWidth / 2;
    tree.core.forEach(function (n) {
      var span = spans[String(n.id)] || { min: 0, max: 0 };
      n.x = treeLeft + treeWidth * ((span.min + span.max) / 2 / maxLeaf);
      n.y = 0.08 + 0.84 * (Math.max(0, Math.min(12, n.generation)) / 12);
    });
    // The late-Song biological branch was absent from the exported dataset.
    // Keep its restored chain (赵希瓐 → 赵与芮 → 宋度宗) beside 理宗 rather
    // than treating it as a remote forest root on the opposite side.
    var biologicalRoot = tree.byId['15685'], lizong = tree.byId['9014'];
    if (biologicalRoot && lizong) {
      var branchShift = lizong.x + aspect * 0.09 - biologicalRoot.x;
      var shifted = {};
      function shiftBranch(id) {
        if (shifted[id] || !tree.byId[id]) return;
        shifted[id] = true;
        tree.byId[id].x += branchShift;
        (tree.children[id] || []).forEach(shiftBranch);
      }
      shiftBranch('15685');
    }
    var coreByGeneration = {};
    tree.core.forEach(function (n) { (coreByGeneration[n.generation] || (coreByGeneration[n.generation] = [])).push(n); });
    var peripheral = activeNodes.filter(function (n) { return n.family_role !== 'core' && !n.is_emperor; });
    peripheral.forEach(function (n, i) {
      var id = String(n.id), anchor = null;
      // Attach peripheral people to a real connected core relative whenever
      // possible; never distribute spouses round-robin across unrelated rulers.
      for (var ei = 0; ei < activeEdges.length && !anchor; ei += 1) {
        var e = activeEdges[ei];
        var other = String(e.source) === id ? tree.byId[String(e.target)] :
          (String(e.target) === id ? tree.byId[String(e.source)] : null);
        if (other && (other.family_role === 'core' || other.is_emperor)) anchor = other;
      }
      anchor = anchor || tree.byId['9001'];
      var side = i % 2 ? 1 : -1;
      var offset = side * aspect * (n.family_role === 'spouse' ? 0.018 : 0.036 + (i % 3) * 0.008);
      n.x = anchor.x + offset;
      n.y = anchor.y + (n.family_role === 'spouse' ? 0.016 : 0.042 + (i % 4) * 0.01);
    });
    activeEdges.forEach(function (e) {
      var a = tree.byId[String(e.source)], b = tree.byId[String(e.target)];
      e._familyStructural = !!(a && b && tree.parent[String(b.id)] === String(a.id));
    });
    window.__hfnSongTree.succession = SONG_SUCCESSION.slice();
    syncSongDebugCoordinates(tree);
    assertSongCoordinates(tree, 'tree');
  }

  function layoutSongRadial(tree) {
    var root = tree.byId['9001'];
    root.x = 0.5; root.y = 0.5;
    var groups = {};
    tree.core.forEach(function (n) {
      if (String(n.id) === '9001') return;
      (groups[n.generation] || (groups[n.generation] = [])).push(n);
    });
    Object.keys(groups).forEach(function (generation) {
      var nodes = groups[generation].sort(function (a, b) { return a.id - b.id; });
      var radius = 0.07 + 0.055 * Number(generation);
      nodes.forEach(function (n, i) {
        var angle = -Math.PI / 2 + (2 * Math.PI * i / Math.max(nodes.length, 1));
        n.x = 0.5 + radius * Math.cos(angle);
        n.y = 0.5 + radius * Math.sin(angle);
      });
    });
    activeNodes.filter(function (n) { return n.family_role !== 'core' && !n.is_emperor; }).forEach(function (n, i) {
      var anchor = tree.core[i % tree.core.length] || root;
      var radius = Math.sqrt(Math.pow(anchor.x - 0.5, 2) + Math.pow(anchor.y - 0.5, 2)) + (n.family_role === 'spouse' ? 0.018 : 0.045);
      var angle = Math.atan2(anchor.y - 0.5, anchor.x - 0.5) + (i % 2 ? 0.07 : -0.07);
      n.x = 0.5 + radius * Math.cos(angle); n.y = 0.5 + radius * Math.sin(angle);
    });
    activeEdges.forEach(function (e) {
      var a = tree.byId[String(e.source)], b = tree.byId[String(e.target)];
      e._familyStructural = !!(a && b && tree.parent[String(b.id)] === String(a.id));
    });
    syncSongDebugCoordinates(tree);
    assertSongCoordinates(tree, 'radial');
  }

  function layoutFamily() {
    if (!activeNodes.length) return;
    if (familyMode === 'family-1') {
      var songTree = buildSongHierarchy();
      window.__hfnSongTree.parent = songTree.parent;
      window.__hfnSongTree.layoutMode = familyLayoutMode;
      if (familyLayoutMode === 'radial') layoutSongRadial(songTree); else layoutSongTree(songTree);
      fitToActive();
      dirty = true;
      render();
      return;
    }
    var byId = {};
    activeNodes.forEach(function (n) {
      byId[String(n.id)] = n;
      n._familyDepth = 0;
      n._familyLeaf = null;
    });
    var children = {}, incoming = {};
    activeEdges.forEach(function (e) {
      var source = String(e.source), target = String(e.target);
      if (!byId[source] || !byId[target] || source === target) return;
      (children[source] || (children[source] = [])).push({ id: target, gap: e.generation_gap || 1 });
      incoming[target] = (incoming[target] || 0) + 1;
    });
    var roots = activeNodes.filter(function (n) { return !incoming[String(n.id)]; });
    if (!roots.length) roots = [activeNodes.slice().sort(function (a, b) { return (a.birth_year || 99999) - (b.birth_year || 99999); })[0]];
    roots.sort(function (a, b) { return (a.birth_year || 99999) - (b.birth_year || 99999); });
    var visited = {}, leafCursor = 0;
    function layoutTree(node, depth) {
      var id = String(node.id);
      if (visited[id]) return { min: leafCursor, max: leafCursor };
      visited[id] = true; node._familyDepth = depth;
      var kids = (children[id] || []).filter(function (child) { return !visited[child.id]; });
      kids.sort(function (a, b) { return (byId[a.id].birth_year || 99999) - (byId[b.id].birth_year || 99999); });
      if (!kids.length) { node._familyLeaf = leafCursor++; return { min: node._familyLeaf, max: node._familyLeaf }; }
      var bounds = kids.map(function (child) { return layoutTree(byId[child.id], depth + Math.max(1, child.gap)); });
      node._familyLeaf = bounds.reduce(function (sum, item) { return sum + (item.min + item.max) / 2; }, 0) / bounds.length;
      return { min: bounds[0].min, max: bounds[bounds.length - 1].max };
    }
    roots.forEach(function (root) { layoutTree(root, 0); });
    activeNodes.forEach(function (n) { if (!visited[String(n.id)]) layoutTree(n, 0); });
    var maxDepth = Math.max.apply(null, activeNodes.map(function (n) { return n._familyDepth || 0; })) || 1;
    var maxLeaf = Math.max(leafCursor - 1, 1);
    activeNodes.forEach(function (n) {
      var leaf = n._familyLeaf == null ? 0 : n._familyLeaf;
      n.x = 0.08 + 0.84 * (leaf / maxLeaf);
      n.y = 0.08 + 0.84 * ((n._familyDepth || 0) / maxDepth);
    });
    fitToActive(); dirty = true; render();
  }

  function buildChips() {
    var wrap = $('dynasty-chips');
    wrap.innerHTML = '';
    TIER_LIST.forEach(function (tier) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip active';
      b.textContent = tier;
      b.addEventListener('click', function () {
        leaveFamilyMode();
        activeTiers[tier] = !activeTiers[tier];
        b.classList.toggle('active', activeTiers[tier]);
        rebuildActive();
        relayout();
      });
      wrap.appendChild(b);
    });
  }

  function buildRelChips() {
    var wrap = $('rel-chips');
    if (!wrap) return;
    wrap.innerHTML = '';
    REL_GROUP_ORDER.forEach(function (g) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip active';
      b.textContent = g + '（' + REL_GROUPS[g].join('·') + '）';
      b.addEventListener('click', function () {
        leaveFamilyMode();
        activeRelGroups[g] = !activeRelGroups[g];
        b.classList.toggle('active', activeRelGroups[g]);
        rebuildActive();
        relayout();
      });
      wrap.appendChild(b);
    });
  }

  function buildLegend() {
    var el = $('legend');
    var html = '<div class="legend-title">朝代（节点颜色）</div>';
    TIER_LIST.forEach(function (tier) {
      html += '<div class="legend-row"><span class="legend-dot" style="background:' +
        (DYNASTY_COLORS[tier] || '#999') + '"></span>' + tier + '</div>';
    });
    html += '<div class="legend-title" style="margin-top:6px">性别（节点形状）</div>';
    html += '<div class="legend-row"><svg class="legend-shape" viewBox="-6 -6 12 12"><circle r="5" fill="#666"/></svg>男</div>';
    html += '<div class="legend-row"><svg class="legend-shape" viewBox="-6 -6 12 12"><path d="M0,-5 L5,4 L-5,4 Z" fill="#666"/></svg>女</div>';
    html += '<div class="legend-title" style="margin-top:6px">关系类型（边颜色）</div>';
    Object.keys(EDGE_COLORS).forEach(function (t) {
      html += '<div class="legend-row"><span class="legend-dot" style="background:' +
        EDGE_COLORS[t] + '"></span>' + t + '</div>';
    });
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
    if (familyMode && FAMILY_DATA) {
      var selectedFamily = FAMILY_DATA.families.filter(function (f) { return f.id === familyMode; })[0];
      if (selectedFamily) { updateFamilyActive(selectedFamily); return; }
    }
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
        // 聚焦首个匹配人物及符合当前关系筛选的一阶邻居。
        var first = matchList[0];
        var neighbors = {};
        neighbors[first] = true;
        EDGES.forEach(function (e) {
          if (!edgeTypeOk(e)) return;
          var s = String(e.source), t = String(e.target);
          if (matchIds[s]) neighbors[t] = true;
          if (matchIds[t]) neighbors[s] = true;
        });
        focus = { id: first, neighbors: neighbors, matches: matchIds };
        NODES.forEach(function (n) {
          if (neighbors[String(n.id)] && networkSet[String(n.id)] && activeTiersCheck(n)) {
            activeNodes.push(n);
            activeSet[String(n.id)] = true;
          }
        });
      } else {
        focus = null;
      }
    } else {
      focus = null;
      // 先取朝代候选节点，再用最终子图边裁掉无连接节点。
      NODES.forEach(function (n) {
        if (networkSet[String(n.id)] && activeTiersCheck(n)) {
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
        if ((nb[s] || nb[t]) && activeSet[s] && activeSet[t] && edgeTypeOk(e)) activeEdges.push(e);
      });
    } else {
      EDGES.forEach(function (e) {
        if (edgeTypeOk(e) && activeSet[String(e.source)] && activeSet[String(e.target)]) activeEdges.push(e);
      });
    }
    // Recompute connectivity after dynasty and relationship filters have both
    // been applied. This removes nodes whose only neighbors are outside the
    // current subgraph, rather than leaving them as perimeter scatter.
    if (!familyMode) {
      var linked = {};
      activeEdges.forEach(function (e) {
        linked[String(e.source)] = true;
        linked[String(e.target)] = true;
      });
      activeNodes = activeNodes.filter(function (n) {
        return linked[String(n.id)] || (focus && String(n.id) === focus.id);
      });
      activeSet = {};
      activeNodes.forEach(function (n) { activeSet[String(n.id)] = true; });
      activeEdges = activeEdges.filter(function (e) {
        return activeSet[String(e.source)] && activeSet[String(e.target)];
      });
    }
    updateStats();
    dirty = true;
  }

  function edgeTypeOk(e) {
    var g = relTypeToGroup[e.type];
    return g ? activeRelGroups[g] : true;
  }

  function isFullView() {
    if (familyMode) return false;
    if (query || focus) return false;
    var tiersOk = Object.keys(activeTiers).every(function (t) { return activeTiers[t]; });
    var relOk = REL_GROUP_ORDER.every(function (g) { return activeRelGroups[g]; });
    return tiersOk && relOk;
  }

  function resetToPrecomputed() {
    NODES.forEach(function (n) { n.x = n._bx; n.y = n._by; });
  }

  function normalizeActive() {
    if (!activeNodes.length) return;
    var minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    activeNodes.forEach(function (n) {
      if (n.x < minx) minx = n.x; if (n.x > maxx) maxx = n.x;
      if (n.y < miny) miny = n.y; if (n.y > maxy) maxy = n.y;
    });
    var w = (maxx - minx) || 1, h = (maxy - miny) || 1;
    var s = 1 / Math.max(w, h);
    var cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    activeNodes.forEach(function (n) {
      n.x = 0.5 + (n.x - cx) * s;
      n.y = 0.5 + (n.y - cy) * s;
    });
  }

  function fitToActive() {
    if (!activeNodes.length) return;
    var minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    activeNodes.forEach(function (n) {
      if (n.x < minx) minx = n.x; if (n.x > maxx) maxx = n.x;
      if (n.y < miny) miny = n.y; if (n.y > maxy) maxy = n.y;
    });
    var w = (maxx - minx) || 1, h = (maxy - miny) || 1;
    var pad = 0.06;
    view.cx = (minx + maxx) / 2;
    view.cy = (miny + maxy) / 2;
    view.scale = Math.min(W / (w * (1 + 2 * pad)), H / (h * (1 + 2 * pad)));
    dirty = true;
  }

  // 为筛选后的子图建立朝代分区中心。主朝代用于定位，跨朝代人物仍保留
  // 在其主档位的分区内，避免一个节点同时被多个中心拉扯而产生抖动。
  function buildClusterCenters(nodes, size) {
    var counts = {};
    nodes.forEach(function (n) {
      var tier = nodeClusterTier(n);
      counts[tier] = (counts[tier] || 0) + 1;
    });
    var tiers = Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a];
    });
    var cols = Math.max(1, Math.ceil(Math.sqrt(tiers.length)));
    var rows = Math.max(1, Math.ceil(tiers.length / cols));
    var centers = {};
    tiers.forEach(function (tier, i) {
      var col = i % cols;
      var row = Math.floor(i / cols);
      centers[tier] = {
        x: size * (col + 0.5) / cols,
        y: size * (row + 0.5) / rows
      };
    });
    return centers;
  }

  function nodeClusterTier(n) {
    var primary = n.dynasty_tier || '未詳';
    if (activeTiers[primary]) return primary;
    var tiers = n.dynasty_tiers || [];
    for (var i = 0; i < tiers.length; i++) {
      if (activeTiers[tiers[i]]) return tiers[i];
    }
    return primary;
  }

  // 朝代分区力：同朝代节点向各自中心靠拢，同时保留 link / charge
  // 力来表达关系结构。规模越大，分区力越弱，避免大图塌成硬块。
  function dynastyClusterForce(centers, nodeCount) {
    var nodes;
    var strength = nodeCount < 80 ? 0.22 : (nodeCount < 1500 ? 0.13 : 0.055);
    function force(alpha) {
      nodes.forEach(function (n) {
        var center = centers[nodeClusterTier(n)];
        if (!center) return;
        n.vx += (center.x - n.x) * strength * alpha;
        n.vy += (center.y - n.y) * strength * alpha;
      });
    }
    force.initialize = function (items) { nodes = items; };
    return force;
  }

  function relayout() {
    if (sim) { sim.stop(); sim = null; }
    if (familyMode) { layoutFamily(); return; }
    // 全量（无任何筛选/搜索）：直接用预计算 DrL 布局，不跑力导向
    if (isFullView()) {
      resetToPrecomputed();
      fitView();
      dirty = true;
      render();
      return;
    }
    if (!activeNodes.length) { dirty = true; render(); return; }
    // 筛选后的子图：以预计算坐标为起点，放大到像素尺度跑力导向，结束后归一化回 [0,1] 并适配视图。
    // 额外加入朝代分区力，确保宋 / 明 / 元等节点尽量聚在各自区域。
    var SCALE0 = 400;
    activeNodes.forEach(function (n) {
      n.x = n._bx * SCALE0; n.y = n._by * SCALE0; n.vx = 0; n.vy = 0;
    });
    var links = activeEdges.map(function (e) {
      return { source: String(e.source), target: String(e.target) };
    });
    var centers = buildClusterCenters(activeNodes, SCALE0);
    var nodeCount = activeNodes.length;
    var linkDistance = nodeCount < 80 ? 52 : (nodeCount < 1500 ? 34 : 24);
    var chargeStrength = nodeCount < 80 ? -260 : (nodeCount < 1500 ? -150 : -70);
    sim = d3.forceSimulation(activeNodes)
      .force('link', d3.forceLink(links).id(function (d) { return String(d.id); })
        .distance(linkDistance).strength(0.5).iterations(1))
      .force('charge', d3.forceManyBody().strength(chargeStrength).theta(1.2)
        .distanceMax(nodeCount < 1500 ? 300 : 180))
      .force('cluster', dynastyClusterForce(centers, nodeCount))
      .force('center', d3.forceCenter(SCALE0 / 2, SCALE0 / 2).strength(0.08))
      .alphaDecay(0.05)
      .velocityDecay(0.3)
      .on('tick', function () { dirty = true; })
      .on('end', function () { normalizeActive(); fitToActive(); dirty = true; });
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
    ctx.fillStyle = document.body.classList.contains('dark') ? '#05070b' : '#fafafa';
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
      var alpha = familyMode ? (e._familyStructural ? 0.48 : 0.18) : 0.22;
      if (focus) {
        var sa = String(a.id), sb = String(b.id);
        if (focusNb[sa] || focusNb[sb]) alpha = 0.35; else alpha = 0.05;
      }
      ctx.strokeStyle = familyMode ? (e._familyStructural ? '#c8a96b' : '#8b7b68') : (EDGE_COLORS[e.type] || '#ccc');
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      if (familyMode && e._familyStructural) {
        var midY = (ay + by) / 2;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax, midY);
        ctx.quadraticCurveTo(ax, midY, (ax + bx) / 2, midY);
        ctx.quadraticCurveTo(bx, midY, bx, midY);
        ctx.lineTo(bx, by);
      } else if (familyMode) {
        var curve = Math.max(12, Math.min(52, Math.abs(by - ay) * 0.22 + Math.abs(bx - ax) * 0.08));
        var controlX = (ax + bx) / 2 + (by - ay >= 0 ? 1 : -1) * Math.min(24, Math.abs(bx - ax) * 0.12);
        var controlY = (ay + by) / 2 - curve;
        ctx.quadraticCurveTo(controlX, controlY, bx, by);
      } else {
        ctx.lineTo(bx, by);
      }
      ctx.stroke();
      if (familyMode && (e._familyStructural || e.direction === 'ancestor')) {
        var tangentX = bx - ((ax + bx) / 2 + (by - ay >= 0 ? 1 : -1) * Math.min(24, Math.abs(bx - ax) * 0.12));
        var tangentY = by - ((ay + by) / 2 - Math.max(12, Math.min(52, Math.abs(by - ay) * 0.22 + Math.abs(bx - ax) * 0.08)));
        var angle = Math.atan2(tangentY, tangentX);
        var arrowSize = 5;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx - arrowSize * Math.cos(angle - Math.PI / 6), by - arrowSize * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(bx - arrowSize * Math.cos(angle + Math.PI / 6), by - arrowSize * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // --- 节点 ---
    for (var j = 0; j < activeNodes.length; j++) {
      var n = activeNodes[j];
      var px = sx(n.x), py = sy(n.y);
      if (px < x0 || px > x1 || py < y0 || py > y1) continue;
      var deg = n.degree || 1;
      var emperor = familyMode && n.is_emperor;
      var r = familyMode ? (emperor ? 8.5 : 4.2) : 1.6 + 9 * Math.sqrt(deg / maxDeg);
      var alpha = familyMode ? 0.9 : 0.28 + 0.72 * Math.pow(deg / maxDeg, 0.3);
      var color = DYNASTY_COLORS[n.dynasty_tier] || '#999';
      var intensity = Math.pow(Math.min(1, deg / maxDeg), 0.45);
      color = mixColor(color, '#ffffff', 0.08 + 0.34 * intensity);

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
      if (!familyMode && intensity > 0.55) {
        ctx.globalAlpha = alpha * 0.18;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, py, r + 4 + 5 * intensity, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = alpha;
      }
      ctx.fillStyle = color;
      if (emperor) {
        ctx.strokeStyle = '#e8c766';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, r + 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }
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
        ctx.strokeStyle = document.body.classList.contains('dark') ? '#6be1dc' : '#087c84';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, r + 2.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // --- 标签（按度数阈值 + 视口裁剪 + 防重叠） ---
    var thr = familyMode ? 0 : labelThresholds[labelLevel];
    if (thr !== Infinity) {
      var cellW = familyMode ? 150 : 135, cellH = familyMode ? 30 : 27;
      var occupied = {};
      ctx.font = familyMode ? '19px -apple-system, "PingFang SC", "Hiragino Sans GB", sans-serif'
        : '17px -apple-system, "PingFang SC", "Hiragino Sans GB", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      var drawn = 0;
      for (var k = 0; k < activeNodes.length; k++) {
        if (!familyMode && drawn > 4000) break; // 单帧标签上限，保证流畅
        var m = activeNodes[k];
        if ((m.degree || 0) < thr) continue; // 度数不足不显示
        if (familyMode) {
          var familyLimit = FAMILY_LABEL_LIMITS[labelLevel];
          if (familyLimit === 0) continue;
          if (!m.is_emperor && (m._familyLabelRank == null || m._familyLabelRank >= familyLimit)) continue;
        }
        var lx = sx(m.x), ly = sy(m.y);
        if (lx < 4 || lx > W - 40 || ly < 8 || ly > H - 8) continue;
        var ck = Math.floor(lx / cellW) + '_' + Math.floor(ly / cellH);
        if (occupied[ck]) continue;
        occupied[ck] = true;
        drawn++;
        ctx.globalAlpha = focus && !focusNb[String(m.id)] ? 0.3 : 0.9;
        var darkTheme = document.body.classList.contains('dark');
        // 暗色主题使用暖白而非纯白，并加背景描边，避免标签融入节点与边。
        ctx.fillStyle = darkTheme ? '#f4ead5' : '#2b2f35';
        if (m.is_emperor && familyMode) ctx.fillStyle = '#f6d779';
        ctx.strokeStyle = darkTheme ? '#05070b' : '#fafafa';
        ctx.lineWidth = 3;
        // Temple names keep the imperial spine concise; the full personal name
        // remains available in the tooltip/detail panel.
        var labelText = m.is_emperor && m.temple_name ? m.temple_name : m.name;
        ctx.strokeText(labelText, lx + 5, ly);
        ctx.fillText(labelText, lx + 5, ly);
      }
      window.__hfnLastLabelCount = drawn;
      ctx.globalAlpha = 1;
    }
  }

  function mixColor(hex, target, amount) {
    var a = hex.replace('#', ''), b = target.replace('#', '');
    var ar = parseInt(a.slice(0, 2), 16), ag = parseInt(a.slice(2, 4), 16), ab = parseInt(a.slice(4, 6), 16);
    var br = parseInt(b.slice(0, 2), 16), bg = parseInt(b.slice(2, 4), 16), bb = parseInt(b.slice(4, 6), 16);
    var mix = function (x, y) { return Math.round(x + (y - x) * amount).toString(16).padStart(2, '0'); };
    return '#' + mix(ar, br) + mix(ag, bg) + mix(ab, bb);
  }

  function loop() {
    render();
    requestAnimationFrame(loop);
  }

  // ---------- 交互 ----------
  function setupEvents() {
    window.addEventListener('resize', function () { resize(); render(); });
    document.addEventListener('keydown', function (e) {
      var tag = document.activeElement && document.activeElement.tagName;
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        $('search').focus();
      }
      if (e.key === 'Escape') {
        if (!$('detail').classList.contains('hidden')) closeDetail();
        else if ($('search').value) {
          $('search').value = '';
          query = '';
          rebuildActive();
          relayout();
        }
      }
    });

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
      leaveFamilyMode();
      query = e.target.value.trim();
      rebuildActive();
      relayout();
    });

    $('family-select').addEventListener('change', function (e) {
      familyMode = e.target.value;
      updateFamilyLayoutToggle();
      if (familyMode) {
        query = '';
        $('search').value = '';
        Object.keys(activeTiers).forEach(function (t) { activeTiers[t] = true; });
        REL_GROUP_ORDER.forEach(function (g) { activeRelGroups[g] = true; });
        syncFilterButtons();
      }
      if (!familyMode) {
        rebuildActive();
        resetToPrecomputed();
      } else if (FAMILY_DATA) {
        rebuildActive();
      }
      relayout();
    });

    // 重置视图
    $('reset-view').addEventListener('click', function () {
      if (sim) { sim.stop(); sim = null; }
      $('search').value = '';
      query = '';
      familyMode = '';
      $('family-select').value = '';
      familyLayoutMode = 'tree';
      localStorage.setItem('hfn-family-layout', familyLayoutMode);
      updateFamilyLayoutToggle();
      Object.keys(activeTiers).forEach(function (t) { activeTiers[t] = true; });
      REL_GROUP_ORDER.forEach(function (g) { activeRelGroups[g] = true; });
      Array.prototype.forEach.call(
        document.querySelectorAll('#dynasty-chips .chip, #rel-chips .chip'),
        function (b) { b.classList.add('active'); }
      );
      rebuildActive();
      resetToPrecomputed();
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
    var detailEdges = familyMode && FAMILY_DATA ? FAMILY_DATA.edges : EDGES;
    detailEdges.forEach(function (e) {
      if (String(e.source) === id || String(e.target) === id) {
        var otherId = String(e.source) === id ? String(e.target) : String(e.source);
        var other = nodeById[otherId];
        if (other) rels.push({ other: other, type: e.type || '亲缘', text: e.text_id != null ? texts[e.text_id] : '' });
      }
    });
    rels.sort(function (a, b) { return (b.other.degree || 0) - (a.other.degree || 0); });
    html += '<div class="section-title">' + (familyMode ? '亲缘人物' : '关联人物') + '（' + rels.length + '）</div><ul class="rels">';
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
