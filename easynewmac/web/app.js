(function () {
  "use strict";

  const FILTERS = [
    {
      id: "all",
      label: "全部项目",
      icon: "apps",
      predicate: () => true,
    },
    {
      id: "automatic",
      label: "可自动安装",
      icon: "wand",
      predicate: EasyNewMacCore.isAutomatic,
    },
    {
      id: "cask",
      label: "图形应用",
      icon: "package",
      predicate: (item) => item.kind === "cask",
    },
    {
      id: "mas",
      label: "App Store",
      icon: "store",
      predicate: (item) => item.kind === "mas",
    },
    {
      id: "formula",
      label: "命令行工具",
      icon: "terminal",
      predicate: (item) => item.kind === "formula",
    },
    {
      id: "pwa",
      label: "网页应用",
      icon: "globe",
      predicate: (item) => item.kind === "pwa",
    },
    {
      id: "manual",
      label: "手动安装",
      icon: "hand",
      predicate: (item) => item.kind === "manual",
    },
  ];

  const KIND_LABELS = {
    homebrew: "Homebrew",
    cask: "Homebrew Cask",
    formula: "命令行工具",
    mas: "App Store",
    pwa: "网页应用",
    manual: "手动安装",
  };

  const state = {
    items: [],
    selected: new Set(),
    filter: "all",
    query: "",
    script: "",
  };

  const elements = {
    workspace: document.querySelector("#workspace"),
    scanStatus: document.querySelector("#scanStatus"),
    loadError: document.querySelector("#loadError"),
    scanSource: document.querySelector("#scanSource"),
    scanCount: document.querySelector("#scanCount"),
    filterNav: document.querySelector("#filterNav"),
    searchInput: document.querySelector("#searchInput"),
    selectVisibleButton: document.querySelector("#selectVisibleButton"),
    clearSelectionButton: document.querySelector("#clearSelectionButton"),
    selectAutomaticButton: document.querySelector("#selectAutomaticButton"),
    libraryTitle: document.querySelector("#libraryTitle"),
    resultSummary: document.querySelector("#resultSummary"),
    appList: document.querySelector("#appList"),
    emptyState: document.querySelector("#emptyState"),
    selectedSummary: document.querySelector("#selectedSummary"),
    selectionCount: document.querySelector("#selectionCount"),
    automaticCount: document.querySelector("#automaticCount"),
    pwaCount: document.querySelector("#pwaCount"),
    manualCount: document.querySelector("#manualCount"),
    dependencyStatus: document.querySelector("#dependencyStatus"),
    scriptPreview: document.querySelector("#scriptPreview"),
    downloadButton: document.querySelector("#downloadButton"),
    toast: document.querySelector("#toast"),
  };

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#icon-${name}`);
    svg.append(use);
    return svg;
  }

  function normalize(value) {
    return value
      .normalize("NFKC")
      .toLocaleLowerCase("zh-Hans-CN")
      .replace(/\s+/g, " ")
      .trim();
  }

  function visibleItems() {
    const activeFilter =
      FILTERS.find((filter) => filter.id === state.filter) || FILTERS[0];
    const query = normalize(state.query);

    return state.items.filter((item) => {
      if (!activeFilter.predicate(item)) return false;
      if (!query) return true;

      return normalize(
        [item.name, item.version, item.bundleId, item.installId, item.path].join(
          " ",
        ),
      ).includes(query);
    });
  }

  function selectedItems() {
    return state.items.filter((item) => state.selected.has(item.id));
  }

  function itemDetail(item) {
    if (item.kind === "manual") {
      return item.bundleId || item.path || "未识别安装来源";
    }
    if (item.kind === "mas") {
      return `App Store ID ${item.installId}`;
    }
    if (item.kind === "pwa") {
      const browser = item.bundleId.startsWith("com.google.Chrome.app.")
        ? "Chrome"
        : item.bundleId.startsWith("com.microsoft.edgemac.app.")
          ? "Edge"
          : "浏览器";
      return `${browser} · ${item.installId}`;
    }
    if (item.kind === "homebrew") {
      return "自动准备所选项目的前置依赖";
    }
    return item.installId;
  }

  function renderFilters() {
    elements.filterNav.replaceChildren();

    FILTERS.forEach((filter) => {
      const count = state.items.filter(filter.predicate).length;
      const button = document.createElement("button");
      button.className = `filter-button${state.filter === filter.id ? " active" : ""}`;
      button.type = "button";
      button.dataset.filter = filter.id;
      button.setAttribute(
        "aria-current",
        state.filter === filter.id ? "page" : "false",
      );

      const label = document.createElement("span");
      label.textContent = filter.label;
      const output = document.createElement("output");
      output.textContent = String(count);

      button.append(icon(filter.icon), label, output);
      elements.filterNav.append(button);
    });
  }

  function renderList() {
    const items = visibleItems();
    const filter = FILTERS.find((entry) => entry.id === state.filter);
    elements.libraryTitle.textContent = filter?.label || "全部项目";
    elements.resultSummary.textContent = `${items.length} 个结果`;
    elements.appList.replaceChildren();
    elements.appList.hidden = items.length === 0;
    elements.emptyState.hidden = items.length !== 0;

    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
      const row = document.createElement("label");
      row.className = `app-row${state.selected.has(item.id) ? " selected" : ""}`;
      row.dataset.id = item.id;
      row.setAttribute("role", "listitem");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.selected.has(item.id);
      checkbox.setAttribute("aria-label", `选择 ${item.name}`);

      const main = document.createElement("div");
      main.className = "app-main";
      const nameLine = document.createElement("div");
      nameLine.className = "app-name-line";
      const name = document.createElement("span");
      name.className = "app-name";
      name.textContent = item.name;
      name.title = item.name;
      nameLine.append(name);

      if (item.version) {
        const version = document.createElement("span");
        version.className = "version";
        version.textContent = item.version;
        nameLine.append(version);
      }

      const detail = document.createElement("span");
      detail.className = "app-detail";
      detail.textContent = itemDetail(item);
      detail.title = detail.textContent;
      main.append(nameLine, detail);

      const badge = document.createElement("span");
      badge.className = [
        "kind-badge",
        EasyNewMacCore.isAutomatic(item) ? "automatic" : "",
        item.kind === "pwa" ? "pwa" : "",
      ]
        .filter(Boolean)
        .join(" ");
      badge.textContent = KIND_LABELS[item.kind];

      row.append(checkbox, main, badge);
      fragment.append(row);
    });
    elements.appList.append(fragment);
  }

  function renderPlan() {
    const items = selectedItems();
    const summary = EasyNewMacCore.summarize(items);
    state.script = EasyNewMacCore.generateInstallScript(items);

    elements.selectionCount.textContent = String(summary.total);
    elements.automaticCount.textContent = String(summary.automatic);
    elements.pwaCount.textContent = String(summary.pwa);
    elements.manualCount.textContent = String(summary.manual);
    elements.selectedSummary.textContent =
      summary.total === 0 ? "尚未选择项目" : `已选择 ${summary.total} 个项目`;
    elements.downloadButton.disabled = summary.total === 0;
    elements.scriptPreview.textContent =
      summary.total === 0
        ? "# 选择项目后，这里会显示完整迁移脚本。"
        : state.script;

    elements.dependencyStatus.classList.toggle(
      "required",
      summary.homebrew,
    );
    const statusTitle = elements.dependencyStatus.querySelector("strong");
    const statusDescription = elements.dependencyStatus.querySelector("span");
    if (summary.homebrew) {
      statusTitle.textContent = "需要 Homebrew";
      statusDescription.textContent =
        summary.appStore > 0
          ? "脚本会先安装 Homebrew 和 mas，再处理所选项目"
          : "脚本会先检测并按需安装 Homebrew";
    } else {
      statusTitle.textContent = "无需 Homebrew";
      if (summary.pwa > 0 && summary.manual > 0) {
        statusDescription.textContent = "当前脚本只会列出需要手动处理的项目";
      } else if (summary.pwa > 0) {
        statusDescription.textContent = "当前脚本只会列出网页应用及清理跟踪参数后的地址";
      } else if (summary.manual > 0) {
        statusDescription.textContent = "当前脚本只会列出手动安装提醒";
      } else {
        statusDescription.textContent = "选择可自动安装项目后会自动加入";
      }
    }
  }

  function renderSelectionControls() {
    elements.clearSelectionButton.disabled = state.selected.size === 0;
    elements.selectAutomaticButton.disabled =
      state.items.filter(EasyNewMacCore.isAutomatic).length === 0;
  }

  function render() {
    renderFilters();
    renderList();
    renderPlan();
    renderSelectionControls();
  }

  function toggleSelection(id, checked) {
    if (checked) {
      state.selected.add(id);
    } else {
      state.selected.delete(id);
    }
    renderList();
    renderPlan();
    renderSelectionControls();
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("visible");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      elements.toast.classList.remove("visible");
    }, 2400);
  }

  function downloadScript() {
    const items = selectedItems();
    if (items.length === 0) return;

    const zipBytes = EasyNewMacCore.createExecutableZip(
      "EasyNewMac-Migration.command",
      state.script,
    );
    const blob = new Blob([zipBytes], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    anchor.href = url;
    anchor.download = `EasyNewMac-Migration-${date}.zip`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("迁移脚本已下载");
  }

  function bindEvents() {
    elements.filterNav.addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button) return;
      state.filter = button.dataset.filter;
      renderFilters();
      renderList();
    });

    elements.searchInput.addEventListener("input", () => {
      state.query = elements.searchInput.value;
      renderList();
    });

    elements.appList.addEventListener("change", (event) => {
      const checkbox = event.target.closest('input[type="checkbox"]');
      const row = checkbox?.closest("[data-id]");
      if (!checkbox || !row) return;
      toggleSelection(row.dataset.id, checkbox.checked);
    });

    elements.selectVisibleButton.addEventListener("click", () => {
      const items = visibleItems();
      items.forEach((item) => state.selected.add(item.id));
      render();
      showToast(`已选择当前结果中的 ${items.length} 个项目`);
    });

    elements.clearSelectionButton.addEventListener("click", () => {
      state.selected.clear();
      render();
    });

    elements.selectAutomaticButton.addEventListener("click", () => {
      const items = state.items.filter(EasyNewMacCore.isAutomatic);
      items.forEach((item) => state.selected.add(item.id));
      render();
      showToast(`已选择 ${items.length} 个可自动安装项目`);
    });

    elements.downloadButton.addEventListener("click", downloadScript);
  }

  function formatScanSource(scan) {
    const date = new Date(scan.scannedAt);
    const time = Number.isNaN(date.getTime())
      ? ""
      : new Intl.DateTimeFormat("zh-CN", {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(date);

    return [scan.computerName, time ? `${time} 扫描` : ""]
      .filter(Boolean)
      .join(" · ");
  }

  function initialize() {
    try {
      const scan = EasyNewMacCore.decodeScanPayload(window.EASYNEWMAC_SCAN);
      state.items = scan.items.sort((left, right) => {
        const order = ["homebrew", "cask", "mas", "formula", "pwa", "manual"];
        const kindDifference =
          order.indexOf(left.kind) - order.indexOf(right.kind);
        return (
          kindDifference ||
          left.name.localeCompare(right.name, "zh-Hans-CN", {
            sensitivity: "base",
            numeric: true,
          })
        );
      });
      elements.scanSource.textContent =
        formatScanSource(scan) || "本地扫描结果";
      elements.scanCount.textContent = String(state.items.length);
      elements.workspace.hidden = false;
      elements.scanStatus.hidden = true;
      elements.loadError.hidden = true;
      bindEvents();
      render();
    } catch (error) {
      console.error(error);
      elements.scanSource.textContent = "未找到本地扫描结果";
      elements.workspace.hidden = true;
      elements.scanStatus.hidden = true;
      elements.loadError.hidden = false;
    }
  }

  function loadScanData() {
    delete window.EASYNEWMAC_PENDING;
    delete window.EASYNEWMAC_SCAN;

    const script = document.createElement("script");
    script.src = `data.js?${Date.now()}`;
    script.addEventListener("load", () => {
      script.remove();
      if (window.EASYNEWMAC_PENDING) {
        window.setTimeout(loadScanData, 800);
        return;
      }
      initialize();
    });
    script.addEventListener("error", () => {
      script.remove();
      initialize();
    });
    document.head.append(script);
  }

  loadScanData();
})();
