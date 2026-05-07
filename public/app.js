const state = {
  data: null,
  filtered: [],
  selectedUserId: null,
  riskFiltersActive: false,
};

const nodes = {
  status: document.querySelector("#status"),
  uploadForm: document.querySelector("#uploadForm"),
  dataFile: document.querySelector("#dataFile"),
  lookupIps: document.querySelector("#lookupIps"),
  uploadButton: document.querySelector("#uploadButton"),
  uploadStatus: document.querySelector("#uploadStatus"),
  minOrders: document.querySelector("#minOrders"),
  minProfit: document.querySelector("#minProfit"),
  minIpCount: document.querySelector("#minIpCount"),
  maxActiveHours: document.querySelector("#maxActiveHours"),
  minTopIpShare: document.querySelector("#minTopIpShare"),
  sortBy: document.querySelector("#sortBy"),
  search: document.querySelector("#search"),
  riskCount: document.querySelector("#riskCount"),
  orderCount: document.querySelector("#orderCount"),
  profitSum: document.querySelector("#profitSum"),
  avgRtp: document.querySelector("#avgRtp"),
  dataMeta: document.querySelector("#dataMeta"),
  metricChartSelect: document.querySelector("#metricChartSelect"),
  metricChart: document.querySelector("#metricChart"),
  userRows: document.querySelector("#userRows"),
  rtpChart: document.querySelector("#rtpChart"),
  ipChart: document.querySelector("#ipChart"),
  userDetail: document.querySelector("#userDetail"),
  selectedUserLabel: document.querySelector("#selectedUserLabel"),
};

const colors = ["#1f6f78", "#d26a2e", "#4b8f57", "#8f5aa7", "#b79324", "#3688b8", "#c74f4f", "#5f6b74"];
const groupOrder = ["boost_pool", "dynamic_rtp_v2", "default"];
const groupColors = {
  boost_pool: "#4b8f57",
  dynamic_rtp_v2: "#b79324",
  default: "#d26a2e",
};

const metricChartConfig = {
  total_orders: { label: "订单", mode: "bucket", digits: 0 },
  total_bet: { label: "下注", mode: "bucket", digits: 0 },
  total_payout: { label: "派彩", mode: "bucket", digits: 0 },
  total_profit: { label: "净赢", mode: "bucket", digits: 0 },
  risk_score: { label: "Risk 分数", mode: "frequency", digits: 0, suffix: "分" },
  rtp: { label: "RTP", mode: "bucket", digits: 1, suffix: "%" },
  kill_rate: { label: "击杀率", mode: "bucket", digits: 1, suffix: "%" },
  active_duration_seconds: {
    label: "Active 具体",
    mode: "bucket",
    digits: 1,
    suffix: "小时",
    value: (user) => user.active_duration_seconds / 3600,
  },
  active_hours: {
    label: "Active 小时",
    mode: "bucket",
    digits: 1,
    suffix: "小时",
    value: (user) => user.active_duration_seconds / 3600,
  },
  ip_count: { label: "IP 数", mode: "frequency", digits: 0, suffix: "个 IP" },
  group_user_counts: { label: "组人数", mode: "group-users", digits: 0 },
};

function setStatus(text, mode = "ready") {
  nodes.status.textContent = text;
  nodes.status.className = `status ${mode}`;
}

function setUploadStatus(text, mode = "ready") {
  nodes.uploadStatus.textContent = text;
  nodes.uploadStatus.className = `upload-status ${mode}`;
}

function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(Number(value) || 0);
}

function formatPercent(value) {
  return `${formatNumber(value, 2)}%`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[character];
  });
}

function currentFilters() {
  const maxActiveHours = nodes.maxActiveHours.value === "" ? Number.POSITIVE_INFINITY : Number(nodes.maxActiveHours.value);
  return {
    minOrders: Number(nodes.minOrders.value || 0),
    minProfit: Number(nodes.minProfit.value || Number.NEGATIVE_INFINITY),
    minIpCount: Number(nodes.minIpCount.value || 0),
    maxActiveSeconds: maxActiveHours * 3600,
    minTopIpShare: Number(nodes.minTopIpShare.value || 0),
    sortBy: nodes.sortBy.value,
    query: nodes.search.value.trim().toLowerCase(),
  };
}

function sortUsersDescending(users, field) {
  return users.sort((a, b) => {
    const left = getSortValue(a, field);
    const right = getSortValue(b, field);
    if (right !== left) return right - left;
    return a.user_id.localeCompare(b.user_id);
  });
}

function getSortValue(user, field) {
  const groupMatch = field.match(/^group_share_(.+)$/);
  if (groupMatch) {
    return Number(user.group_mix?.[groupMatch[1]]?.order_share || 0);
  }
  return Number(user[field]) || 0;
}

function applyFilters() {
  const filters = currentFilters();
  state.filtered = sortUsersDescending(
    state.data.users.filter((user) => {
      const matchesAnyRiskRule =
        user.total_orders === 0 ||
        user.total_profit > filters.minProfit ||
        user.ip_count > filters.minIpCount ||
        user.active_duration_seconds <= filters.maxActiveSeconds;
      const matchesMetric =
        user.total_orders >= filters.minOrders &&
        (!state.riskFiltersActive || matchesAnyRiskRule) &&
        user.top_ip_share >= filters.minTopIpShare;
      if (!matchesMetric) return false;
      if (!filters.query) return true;
      return (
        user.user_id.includes(filters.query) ||
        user.top_ip.includes(filters.query) ||
        user.ip_distribution.some((entry) => entry.ip.includes(filters.query))
      );
    }),
    filters.sortBy,
  );

  if (!state.filtered.some((user) => user.user_id === state.selectedUserId)) {
    state.selectedUserId = state.filtered[0]?.user_id || null;
  }

  render();
}

function renderKpis() {
  const totalOrders = state.filtered.reduce((sum, user) => sum + user.total_orders, 0);
  const profitSum = state.filtered.reduce((sum, user) => sum + user.total_profit, 0);
  const avgRtp = state.filtered.length
    ? state.filtered.reduce((sum, user) => sum + user.rtp, 0) / state.filtered.length
    : 0;

  nodes.riskCount.textContent = formatNumber(state.filtered.length);
  nodes.orderCount.textContent = formatNumber(totalOrders);
  nodes.profitSum.textContent = formatNumber(profitSum, 2);
  nodes.avgRtp.textContent = formatPercent(avgRtp);
}

function renderTable() {
  if (!state.filtered.length) {
    nodes.userRows.innerHTML = `<tr><td colspan="15" class="empty-cell">没有符合当前条件的玩家</td></tr>`;
    return;
  }

  const groupColumns = getOrderedGroupColumns();

  nodes.userRows.innerHTML = state.filtered
    .map((user, index) => {
      const selected = user.user_id === state.selectedUserId ? "selected" : "";
      const reasons = user.risk_reasons.length ? user.risk_reasons : ["无 risk 信号"];
      return `
        <tr class="${selected}" data-user-id="${escapeHtml(user.user_id)}">
          <td class="rank-cell">${index + 1}</td>
          <td><button class="link-button" type="button">${escapeHtml(user.user_id)}</button></td>
          <td>${formatNumber(user.total_orders)}</td>
          <td>${formatNumber(user.total_bet, 2)}</td>
          <td>${formatNumber(user.total_payout, 2)}</td>
          <td class="${user.total_profit >= 0 ? "positive" : "negative"}">${formatNumber(user.total_profit, 2)}</td>
          <td>${formatNumber(user.risk_score)}</td>
          <td>${formatPercent(user.rtp)}</td>
          <td>${formatPercent(user.kill_rate)}</td>
          <td>${escapeHtml(user.active_duration_exact || "")}</td>
          <td>${escapeHtml(user.active_duration_days_hours || "")}</td>
          <td>${formatNumber(user.ip_count)}</td>
          <td>
            <div>${escapeHtml(user.top_ip)}</div>
            <small>${formatPercent(user.top_ip_share)}</small>
          </td>
          <td>${renderGroupMixBar(user.group_mix, groupColumns, "order_share")}</td>
          <td>${renderGroupMixBar(user.group_mix, groupColumns, "profit_share")}</td>
          <td>${renderGroupMixBar(user.group_mix, groupColumns, "bet_share")}</td>
          <td>${reasons.map((reason) => `<span class="chip">${escapeHtml(reason)}</span>`).join("")}</td>
        </tr>
      `;
    })
    .join("");
}

function getOrderedGroupColumns() {
  const available = new Set(state.data.group_columns || []);
  const ordered = groupOrder.filter((group) => available.has(group));
  for (const group of state.data.group_columns || []) {
    if (!ordered.includes(group) && ordered.length < 3) {
      ordered.push(group);
    }
  }
  return ordered.slice(0, 3);
}

function renderGroupMixBar(groupMix, groupColumns, shareKey) {
  const items = groupColumns.map((group) => ({
    group,
    share: Number(groupMix?.[group]?.[shareKey] || 0),
  }));
  const visibleItems = items.filter((item) => item.share > 0);
  if (!visibleItems.length) {
    return '<span class="muted">0%</span>';
  }

  const segments = visibleItems
    .map((item) => {
      const width = Math.max(1, item.share);
      const color = groupColors[item.group] || colors[0];
      return `
        <i
          style="width:${width}%;background:${color}"
          title="${escapeHtml(item.group)} ${formatPercent(item.share)}"
        ></i>
      `;
    })
    .join("");
  const labels = visibleItems
    .map((item) => `
      <span>
        <b style="background:${groupColors[item.group] || colors[0]}"></b>
        ${escapeHtml(item.group)} ${formatPercent(item.share)}
      </span>
    `)
    .join("");

  return `
    <div class="group-mix-cell">
      <div class="group-progress">${segments}</div>
      <div class="group-progress-labels">${labels}</div>
    </div>
  `;
}

function getMetricValue(user, field, config) {
  const raw = config.value ? config.value(user) : user[field];
  return Number(raw) || 0;
}

function formatMetricValue(value, config) {
  const formatted = formatNumber(value, config.digits || 0);
  return config.suffix ? `${formatted}${config.suffix}` : formatted;
}

function niceStep(rawStep) {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const exponent = Math.floor(Math.log10(rawStep));
  const base = 10 ** exponent;
  const fraction = rawStep / base;
  if (fraction <= 1) return base;
  if (fraction <= 2) return 2 * base;
  if (fraction <= 5) return 5 * base;
  return 10 * base;
}

function roundedBucketStep(rawStep, config) {
  const step = niceStep(rawStep);
  if (config.suffix === "%" && step < 5) return 5;
  if (config.suffix === "小时") {
    if (step < 1) return 1;
    if (step <= 6) return Math.ceil(step);
    if (step <= 24) return 24;
  }
  return step;
}

function roundedSplitPoint(start, end, config) {
  const width = end - start;
  if (!Number.isFinite(width) || width <= 0) return null;

  let splitStep = niceStep(width / 2);
  if (config.suffix === "%" && width >= 10 && splitStep < 5) {
    splitStep = 5;
  }
  if (config.suffix === "小时") {
    const hourSteps = [1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168, 336, 720, 1440, 2160];
    splitStep = hourSteps.find((candidate) => candidate >= width / 3) || niceStep(width / 2);
    if (splitStep >= width) {
      splitStep = hourSteps.filter((candidate) => candidate < width).at(-1) || width / 2;
    }
  }
  if (splitStep >= width) {
    splitStep = niceStep(width / 3);
  }

  const target = start + width / 2;
  const candidates = [
    Math.round(target / splitStep) * splitStep,
    Math.floor(target / splitStep) * splitStep,
    Math.ceil(target / splitStep) * splitStep,
    start + splitStep,
    end - splitStep,
  ];
  return candidates.find((candidate) => candidate > start && candidate < end) || null;
}

function buildBucketChart(users, field, config) {
  const values = users.map((user) => getMetricValue(user, field, config)).filter((value) => Number.isFinite(value));
  if (!values.length) return [];

  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    return [{ label: formatMetricValue(min, config), value: values.length }];
  }

  const baseBucketCount = Math.min(7, Math.max(4, Math.ceil(Math.sqrt(values.length) / 2)));
  const maxBucketCount = 14;
  const denseThreshold = Math.max(8, Math.ceil(values.length * 0.16));
  let step = roundedBucketStep((max - min) / baseBucketCount, config);
  const roundedMin = Math.floor(min / step) * step;
  const roundedMax = Math.ceil(max / step) * step;
  let bucketCount = Math.max(1, Math.round((roundedMax - roundedMin) / step));
  while (bucketCount > baseBucketCount + 2) {
    step = roundedBucketStep(step * 1.6, config);
    bucketCount = Math.max(1, Math.ceil((roundedMax - roundedMin) / step));
  }

  let buckets = Array.from({ length: bucketCount }, (_, index) => ({
    start: roundedMin + step * index,
    end: roundedMin + step * (index + 1),
    value: 0,
  }));

  function countBuckets(nextBuckets) {
    for (const bucket of nextBuckets) {
      bucket.value = 0;
    }
    for (const value of values) {
      const index = nextBuckets.findIndex((bucket, bucketIndex) => {
        const isLast = bucketIndex === nextBuckets.length - 1;
        return value >= bucket.start && (value < bucket.end || (isLast && value <= bucket.end));
      });
      nextBuckets[Math.max(0, index)].value += 1;
    }
  }

  countBuckets(buckets);
  while (buckets.length < maxBucketCount) {
    const candidateIndex = buckets.reduce((bestIndex, bucket, index) => {
      const best = buckets[bestIndex];
      if (bucket.value <= denseThreshold || bucket.end <= bucket.start) return bestIndex;
      return bucket.value > best.value ? index : bestIndex;
    }, 0);
    const candidate = buckets[candidateIndex];
    if (candidate.value <= denseThreshold || candidate.end <= candidate.start) break;

    const midpoint = roundedSplitPoint(candidate.start, candidate.end, config);
    if (midpoint === null) break;
    buckets.splice(
      candidateIndex,
      1,
      { start: candidate.start, end: midpoint, value: 0 },
      { start: midpoint, end: candidate.end, value: 0 },
    );
    countBuckets(buckets);
  }

  return buckets.map(({ start, end, value }) => ({
    label: `${formatMetricValue(start, config)}-${formatMetricValue(end, config)}`,
    value,
  }));
}

function buildFrequencyChart(users, field, config) {
  const counter = new Map();
  for (const user of users) {
    const value = getMetricValue(user, field, config);
    counter.set(value, (counter.get(value) || 0) + 1);
  }
  return [...counter.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, count]) => ({ label: formatMetricValue(value, config), value: count }));
}

function renderMetricChart() {
  const field = nodes.metricChartSelect.value;
  const config = metricChartConfig[field] || metricChartConfig.total_orders;
  const items =
    config.mode === "group-users"
      ? buildGroupUserChart()
      : config.mode === "frequency"
        ? buildFrequencyChart(state.filtered, field, config)
        : buildBucketChart(state.filtered, field, config);

  nodes.metricChart.innerHTML = `
    <div class="metric-chart-header">
      <strong>${escapeHtml(config.label)}分布</strong>
      <span>${config.mode === "frequency" ? "frequency" : "bucket"} · ${formatNumber(state.filtered.length)} users</span>
    </div>
    <div class="chart compact-chart">${barRows(items, { digits: 0 })}</div>
  `;
}

function buildGroupUserChart() {
  const configuredGroups = getOrderedGroupColumns();
  return configuredGroups.map((group) => {
    const count = state.filtered.filter((user) => user.group_mix?.[group]?.orders > 0).length;
    return { label: group, value: count, color: groupColors[group] || colors[0] };
  });
}

function barRows(items, options = {}) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return items
    .map((item, index) => {
      const width = Math.max(2, (item.value / max) * 100);
      return `
        <div class="bar-row">
          <span title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>
          <div class="bar-track"><i style="width:${width}%;background:${item.color || colors[index % colors.length]}"></i></div>
          <strong>${options.percent ? formatPercent(item.value) : formatNumber(item.value, options.digits || 0)}</strong>
        </div>
      `;
    })
    .join("");
}

function renderRtpChart() {
  const users = state.filtered.slice(0, 18);
  const items = users.map((user) => ({
    label: user.user_id,
    value: user.rtp,
  }));
  nodes.rtpChart.innerHTML = barRows(items, { percent: true });
}

function renderIpChart() {
  const counter = new Map();
  for (const user of state.filtered) {
    for (const ip of user.ip_distribution) {
      const current = counter.get(ip.ip) || { label: ip.ip, location: ip.location, value: 0 };
      current.value += ip.count;
      counter.set(ip.ip, current);
    }
  }
  const items = [...counter.values()]
    .sort((a, b) => b.value - a.value)
    .slice(0, 14)
    .map((item) => ({
      label: item.location && item.location !== "Unknown" ? `${item.label} · ${item.location}` : item.label,
      value: item.value,
    }));
  nodes.ipChart.innerHTML = barRows(items);
}

function renderDistribution(title, rows, valueKey = "count") {
  if (!rows?.length) {
    return `<section class="mini-panel"><h3>${escapeHtml(title)}</h3><p class="muted">暂无数据</p></section>`;
  }
  const items = rows.map((row) => ({ label: row.name, value: row[valueKey] }));
  return `<section class="mini-panel"><h3>${escapeHtml(title)}</h3>${barRows(items)}</section>`;
}

function renderDetail() {
  const user = state.filtered.find((candidate) => candidate.user_id === state.selectedUserId);
  if (!user) {
    nodes.selectedUserLabel.textContent = "";
    nodes.userDetail.className = "detail-empty";
    nodes.userDetail.textContent = "选择上方任意玩家查看 IP、策略、子弹、鱼值分布";
    return;
  }

  nodes.selectedUserLabel.textContent = `${user.user_id} · ${formatNumber(user.total_orders)} orders`;
  nodes.userDetail.className = "detail-grid";
  nodes.userDetail.innerHTML = `
    <section class="mini-panel ip-panel">
      <h3>IP Distribution</h3>
      ${user.ip_distribution
        .map(
          (entry) => `
            <div class="ip-line">
              <div>
                <strong>${escapeHtml(entry.ip)}</strong>
                <span>${escapeHtml(entry.location || "Unknown")}</span>
              </div>
              <b>${formatNumber(entry.count)} · ${formatPercent(entry.share)}</b>
            </div>
          `,
        )
        .join("")}
    </section>
    ${renderDistribution("Strategy", user.strategy_distribution)}
    ${renderDistribution("Bullet Level", user.bullet_distribution)}
    ${renderDistribution("Fish Value", user.fish_distribution)}
    ${renderDistribution("Multiplier", user.multiplier_distribution)}
    ${renderDistribution("投注时段（每2小时）", user.bet_time_distribution)}
  `;
}

function render() {
  renderKpis();
  renderMetricChart();
  renderTable();
  renderRtpChart();
  renderIpChart();
  renderDetail();
}

async function loadDashboard() {
  const response = await fetch("/api/dashboard-data");
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Dashboard 数据加载失败");
  }
  state.data = data;

  nodes.minOrders.value = data.default_filters.min_orders;
  nodes.minProfit.value = data.default_filters.min_profit;
  nodes.minIpCount.value = data.default_filters.min_ip_count;
  nodes.maxActiveHours.value = data.default_filters.max_active_hours;
  nodes.minTopIpShare.value = data.default_filters.min_top_ip_share;
  nodes.dataMeta.textContent = `${formatNumber(data.user_count)} users · ${formatNumber(data.ip_count)} IPs`;
  setStatus("已连接");
  applyFilters();
}

async function uploadDashboardData(event) {
  event.preventDefault();
  const file = nodes.dataFile.files[0];
  if (!file) {
    setUploadStatus("请先选择一个 CSV 文件。", "error");
    return;
  }

  const formData = new FormData();
  formData.append("dataFile", file);
  if (nodes.lookupIps.checked) {
    formData.append("lookupIps", "on");
  }

  try {
    nodes.uploadButton.disabled = true;
    setStatus("处理中");
    setUploadStatus("正在上传并重新生成 dashboard，大文件可能需要几十秒。", "working");
    const response = await fetch("/api/upload-dashboard-data", {
      method: "POST",
      body: formData,
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "上传失败");
    }

    state.data = payload.dashboard;
    state.selectedUserId = null;
    nodes.dataMeta.textContent = `${formatNumber(state.data.user_count)} users · ${formatNumber(state.data.ip_count)} IPs`;
    setStatus("已连接");
    setUploadStatus(`已加载 ${file.name}：${formatNumber(state.data.user_count)} users，${formatNumber(state.data.order_count)} orders。`);
    applyFilters();
  } catch (error) {
    setStatus("上传失败", "error");
    setUploadStatus(error.message, "error");
  } finally {
    nodes.uploadButton.disabled = false;
  }
}

document.querySelector(".controls").addEventListener("input", applyFilters);
document.querySelector(".controls").addEventListener("change", applyFilters);
nodes.uploadForm.addEventListener("submit", uploadDashboardData);
nodes.metricChartSelect.addEventListener("change", renderMetricChart);
nodes.userRows.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-user-id]");
  if (!row) return;
  state.selectedUserId = row.dataset.userId;
  render();
  document.querySelector('[aria-label="玩家详情"]').scrollIntoView({ behavior: "smooth", block: "start" });
});

loadDashboard().catch((error) => {
  setStatus(error.message, "error");
});
