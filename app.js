let ethers;

async function loadEthers() {
  if (ethers) return ethers;

  const sources = [
    "./vendor/ethers.min.js",
    "./ethers.min.js",
    "https://cdn.jsdelivr.net/npm/ethers@6.13.5/+esm",
    "https://esm.sh/ethers@6.13.5"
  ];

  for (const source of sources) {
    try {
      ({ ethers } = await import(source));
      return ethers;
    } catch {}
  }

  throw new Error("链上工具库加载失败。请确认当前网页能访问 jsdelivr 或 esm.sh，或把 ethers 打包到网页里。");
}

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)"
];

const BATCH_SENDER_ABI = [
  "function batchTransferNative(address[] recipients, uint256[] amounts) payable",
  "function batchTransferToken(address token, address[] recipients, uint256[] amounts)"
];

const NETWORKS = {
  1: "Ethereum",
  10: "Optimism",
  56: "BNB Chain",
  100: "Gnosis",
  137: "Polygon",
  250: "Fantom",
  324: "zkSync Era",
  8453: "Base",
  42161: "Arbitrum One",
  43114: "Avalanche",
  59144: "Linea"
};

const state = {
  provider: null,
  signer: null,
  account: "",
  chainId: null,
  mode: "erc20",
  sendMode: "simple",
  token: null,
  batchContract: null,
  tokenMeta: {
    address: "",
    symbol: "-",
    decimals: null,
    balance: 0n
  },
  rows: [],
  results: [],
  isSending: false,
  stopRequested: false
};

const els = {
  connectBtn: document.querySelector("#connectBtn"),
  walletAddress: document.querySelector("#walletAddress"),
  networkName: document.querySelector("#networkName"),
  walletBalance: document.querySelector("#walletBalance"),
  erc20Mode: document.querySelector("#erc20Mode"),
  nativeMode: document.querySelector("#nativeMode"),
  simpleSendMode: document.querySelector("#simpleSendMode"),
  contractSendMode: document.querySelector("#contractSendMode"),
  sendModeHint: document.querySelector("#sendModeHint"),
  contractSettings: document.querySelector("#contractSettings"),
  tokenField: document.querySelector("#tokenField"),
  tokenAddress: document.querySelector("#tokenAddress"),
  batchAddress: document.querySelector("#batchAddress"),
  tokenSymbol: document.querySelector("#tokenSymbol"),
  tokenDecimals: document.querySelector("#tokenDecimals"),
  tokenBalance: document.querySelector("#tokenBalance"),
  recipientInput: document.querySelector("#recipientInput"),
  validCount: document.querySelector("#validCount"),
  totalAmount: document.querySelector("#totalAmount"),
  txCount: document.querySelector("#txCount"),
  loadTokenBtn: document.querySelector("#loadTokenBtn"),
  validateBtn: document.querySelector("#validateBtn"),
  approveBtn: document.querySelector("#approveBtn"),
  sendBtn: document.querySelector("#sendBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  exportBtn: document.querySelector("#exportBtn"),
  progressText: document.querySelector("#progressText"),
  progressNumbers: document.querySelector("#progressNumbers"),
  progressFill: document.querySelector("#progressFill"),
  logList: document.querySelector("#logList"),
  recipientTable: document.querySelector("#recipientTable"),
  protocolNotice: document.querySelector("#protocolNotice")
};

function shortAddress(address) {
  if (!address) return "未连接";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function networkLabel(chainId) {
  if (!chainId) return "未识别";
  return NETWORKS[Number(chainId)] || `Chain ${chainId}`;
}

function setMode(mode) {
  state.mode = mode;
  const isErc20 = mode === "erc20";
  els.erc20Mode.classList.toggle("active", isErc20);
  els.nativeMode.classList.toggle("active", !isErc20);
  els.tokenField.style.display = isErc20 ? "grid" : "none";
  els.loadTokenBtn.style.display = isErc20 ? "inline-flex" : "none";
  els.approveBtn.style.display = state.sendMode === "contract" && isErc20 ? "inline-flex" : "none";
  els.approveBtn.disabled = state.sendMode !== "contract" || !isErc20;
  if (!isErc20) {
    state.token = null;
    state.tokenMeta = {
      address: "",
      symbol: nativeSymbol(),
      decimals: 18,
      balance: 0n
    };
    refreshNativeBalance();
  }
  validateRows();
}

function setSendMode(sendMode) {
  state.sendMode = sendMode;
  const isContract = sendMode === "contract";
  els.simpleSendMode.classList.toggle("active", !isContract);
  els.contractSendMode.classList.toggle("active", isContract);
  els.contractSettings.hidden = !isContract;
  els.approveBtn.style.display = isContract && state.mode === "erc20" ? "inline-flex" : "none";
  els.approveBtn.disabled = !isContract || state.mode !== "erc20";
  els.sendBtn.textContent = isContract ? "批量转账" : "开始转账";
  els.txCount.textContent = isContract ? (validateRows().length ? "1" : "0") : String(validateRows().length);
  els.sendModeHint.textContent = isContract
    ? "一次确认模式：需要批量合约地址，额度够时只确认一笔批量交易。"
    : "普通模式：不用部署合约，但每笔都要在小狐狸确认一次。";
}

function nativeSymbol() {
  const chainId = Number(state.chainId);
  if (chainId === 56) return "BNB";
  if (chainId === 137) return "POL";
  if (chainId === 43114) return "AVAX";
  if (chainId === 250) return "FTM";
  return "ETH";
}

function setBusy(isBusy) {
  state.isSending = isBusy;
  els.sendBtn.disabled = isBusy;
  els.validateBtn.disabled = isBusy;
  els.loadTokenBtn.disabled = isBusy;
  els.approveBtn.disabled = isBusy || state.mode !== "erc20" || state.sendMode !== "contract";
  els.stopBtn.disabled = !isBusy;
}

function addLog(title, detail = "", type = "pending") {
  const node = document.createElement("div");
  node.className = `log-item ${type}`;
  node.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`;
  els.logList.prepend(node);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    };
    return map[char];
  });
}

function formatUnitsSafe(value, decimals = 18) {
  try {
    return ethers.formatUnits(value, decimals);
  } catch {
    return "0";
  }
}

function parseAmount(value, decimals) {
  const trimmed = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("金额格式错误");
  }
  return ethers.parseUnits(trimmed, decimals);
}

async function ensureWallet() {
  if (location.protocol === "file:") {
    throw new Error("当前是 file:// 页面。请先双击 start.bat 启动服务，再打开 http://127.0.0.1:5173/。");
  }

  if (!window.ethereum) {
    throw new Error("未检测到 MetaMask。请确认正在用安装了小狐狸钱包扩展的 Chrome 打开 http://127.0.0.1:5173/。");
  }

  await loadEthers();
  state.provider = new ethers.BrowserProvider(window.ethereum);
  const accounts = await state.provider.send("eth_requestAccounts", []);
  state.account = ethers.getAddress(accounts[0]);
  state.signer = await state.provider.getSigner();
  const network = await state.provider.getNetwork();
  state.chainId = Number(network.chainId);
  await refreshWalletUi();
}

async function refreshWalletUi() {
  if (!state.provider || !state.account) return;
  const nativeBalance = await state.provider.getBalance(state.account);
  els.walletAddress.textContent = shortAddress(state.account);
  els.walletAddress.title = state.account;
  els.networkName.textContent = networkLabel(state.chainId);
  els.walletBalance.textContent = `${formatUnitsSafe(nativeBalance, 18)} ${nativeSymbol()}`;
  if (state.mode === "native") {
    state.tokenMeta.balance = nativeBalance;
    state.tokenMeta.symbol = nativeSymbol();
    state.tokenMeta.decimals = 18;
    renderTokenMeta();
  }
}

async function refreshNativeBalance() {
  if (!state.provider || !state.account) {
    renderTokenMeta();
    return;
  }
  const balance = await state.provider.getBalance(state.account);
  state.tokenMeta.balance = balance;
  renderTokenMeta();
}

async function loadToken() {
  await ensureWallet();
  const address = els.tokenAddress.value.trim();
  if (!ethers.isAddress(address)) {
    throw new Error("请输入正确的 ERC-20 合约地址。");
  }

  const checksumAddress = ethers.getAddress(address);
  const contract = new ethers.Contract(checksumAddress, ERC20_ABI, state.signer);
  const [symbol, decimals, balance] = await Promise.all([
    contract.symbol(),
    contract.decimals(),
    contract.balanceOf(state.account)
  ]);

  state.token = contract;
  state.tokenMeta = {
    address: checksumAddress,
    symbol,
    decimals: Number(decimals),
    balance
  };
  renderTokenMeta();
  validateRows();
  addLog("代币读取成功", `${symbol} ${checksumAddress}`, "success");
}

function renderTokenMeta() {
  const decimals = state.tokenMeta.decimals;
  els.tokenSymbol.value = state.tokenMeta.symbol || "-";
  els.tokenDecimals.value = decimals === null ? "-" : String(decimals);
  els.tokenBalance.value =
    decimals === null ? "-" : `${formatUnitsSafe(state.tokenMeta.balance, decimals)} ${state.tokenMeta.symbol}`;
}

function getBatchAddress() {
  const address = els.batchAddress.value.trim();
  if (!ethers.isAddress(address)) {
    throw new Error("请输入已部署的批量转账合约地址。");
  }
  return ethers.getAddress(address);
}

function getBatchContract() {
  const address = getBatchAddress();
  state.batchContract = new ethers.Contract(address, BATCH_SENDER_ABI, state.signer);
  return state.batchContract;
}

function getValidRowsAndTotal() {
  const validRows = validateRows();
  const total = validRows.reduce((sum, row) => sum + row.amountWei, 0n);
  return { validRows, total };
}

function parseRows() {
  const lines = els.recipientInput.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line, index) => {
    const parts = line.split(/[,\s\t]+/).filter(Boolean);
    const row = {
      index: index + 1,
      raw: line,
      address: parts[0] || "",
      checksumAddress: "",
      amountText: parts[1] || "",
      amountWei: 0n,
      status: "待校验",
      hash: "",
      error: ""
    };

    try {
      if (parts.length < 2) throw new Error("缺少地址或金额");
      if (!ethers) throw new Error("请先连接钱包");
      if (!ethers.isAddress(row.address)) throw new Error("地址格式错误");
      row.checksumAddress = ethers.getAddress(row.address);
      if (state.tokenMeta.decimals === null) throw new Error("请先读取代币或连接原生币网络");
      row.amountWei = parseAmount(row.amountText, state.tokenMeta.decimals);
      if (row.amountWei <= 0n) throw new Error("金额必须大于 0");
      row.status = "有效";
    } catch (error) {
      row.status = "无效";
      row.error = error.message;
    }

    return row;
  });
}

function validateRows() {
  if (state.mode === "erc20" && state.tokenMeta.decimals === null) {
    state.rows = parseRows();
  } else {
    state.rows = parseRows();
  }

  const validRows = state.rows.filter((row) => row.status === "有效");
  const total = validRows.reduce((sum, row) => sum + row.amountWei, 0n);
  const decimals = state.tokenMeta.decimals ?? 18;
  els.validCount.textContent = String(validRows.length);
  els.totalAmount.textContent = `${formatUnitsSafe(total, decimals)} ${state.tokenMeta.symbol || ""}`.trim();
  els.txCount.textContent = state.sendMode === "contract" ? (validRows.length ? "1" : "0") : String(validRows.length);
  renderTable();
  return validRows;
}

function renderTable() {
  if (!state.rows.length) {
    els.recipientTable.innerHTML = `<tr><td colspan="5" class="empty">粘贴收款清单后点击校验</td></tr>`;
    updateProgress(0, 0, "等待开始");
    return;
  }

  els.recipientTable.innerHTML = state.rows
    .map((row) => {
      const statusClass =
        row.status === "成功"
          ? "status-ok"
          : row.status === "失败" || row.status === "无效"
            ? "status-error"
            : row.status === "发送中" || row.status === "确认中"
              ? "status-pending"
              : "";
      const statusText = row.error ? `${row.status}: ${row.error}` : row.status;
      return `<tr>
        <td>${row.index}</td>
        <td class="addr">${escapeHtml(row.checksumAddress || row.address)}</td>
        <td>${escapeHtml(row.amountText)}</td>
        <td class="${statusClass}">${escapeHtml(statusText)}</td>
        <td class="hash">${escapeHtml(row.hash || "-")}</td>
      </tr>`;
    })
    .join("");
}

function updateProgress(done, total, label) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  els.progressText.textContent = label;
  els.progressNumbers.textContent = `${done} / ${total}`;
  els.progressFill.style.width = `${percent}%`;
}

function assertReady(validRows) {
  if (!state.account || !state.signer) {
    throw new Error("请先连接 MetaMask 钱包。");
  }
  if (state.sendMode === "contract") {
    getBatchAddress();
  }
  if (!validRows.length) {
    throw new Error("没有可发送的有效收款记录。");
  }
  if (state.mode === "erc20" && !state.token) {
    throw new Error("请先读取 ERC-20 代币信息。");
  }
  const total = validRows.reduce((sum, row) => sum + row.amountWei, 0n);
  if (state.tokenMeta.balance < total) {
    throw new Error("余额不足，无法覆盖本次批量转账总额。");
  }
}

async function ensureAllowance(total) {
  if (state.mode !== "erc20") return;
  const spender = getBatchAddress();
  const allowance = await state.token.allowance(state.account, spender);
  if (allowance >= total) {
    addLog("授权额度足够", `${formatUnitsSafe(allowance, state.tokenMeta.decimals)} ${state.tokenMeta.symbol}`, "success");
    return;
  }

  addLog("需要授权额度", "请在 MetaMask 中确认 approve，之后再确认批量转账", "pending");
  const tx = await state.token.approve(spender, total);
  addLog("授权交易已提交", tx.hash, "pending");
  const receipt = await tx.wait();
  if (receipt?.status !== 1) {
    throw new Error("授权交易失败");
  }
  addLog("授权成功", tx.hash, "success");
}

async function approveAllowance() {
  await ensureWallet();
  if (state.mode !== "erc20") {
    throw new Error("原生币不需要授权额度。");
  }
  if (!state.token) {
    await loadToken();
  }
  const { validRows, total } = getValidRowsAndTotal();
  assertReady(validRows);
  setBusy(true);
  try {
    await ensureAllowance(total);
  } finally {
    setBusy(false);
  }
}

async function sendBatch() {
  if (state.sendMode === "simple") {
    await sendSimpleBatch();
    return;
  }

  await ensureWallet();
  if (state.mode === "erc20" && !state.token) {
    await loadToken();
  }
  if (state.mode === "native") {
    await refreshNativeBalance();
  }

  const { validRows, total } = getValidRowsAndTotal();
  assertReady(validRows);

  state.results = [];
  state.stopRequested = false;
  setBusy(true);
  addLog("开始批量转账", `共 ${validRows.length} 个地址，本次只发起一笔批量交易`, "pending");

  try {
    updateProgress(0, validRows.length, "准备交易");
    validRows.forEach((row) => {
      row.status = "待批量发送";
      row.error = "";
      row.hash = "";
    });
    renderTable();

    const contract = getBatchContract();
    const recipients = validRows.map((row) => row.checksumAddress);
    const amounts = validRows.map((row) => row.amountWei);

    if (state.mode === "erc20") {
      await ensureAllowance(total);
    }

    validRows.forEach((row) => {
      row.status = "批量发送中";
    });
    renderTable();

    const tx =
      state.mode === "erc20"
        ? await contract.batchTransferToken(state.tokenMeta.address, recipients, amounts)
        : await contract.batchTransferNative(recipients, amounts, { value: total });

    validRows.forEach((row) => {
      row.status = "确认中";
      row.hash = tx.hash;
    });
    renderTable();
    addLog("批量交易已提交", tx.hash, "pending");

    const receipt = await tx.wait();
    if (receipt?.status !== 1) {
      throw new Error("交易已上链但状态失败");
    }

    validRows.forEach((row) => {
      row.status = "成功";
      row.hash = tx.hash;
    });
    updateProgress(validRows.length, validRows.length, "全部完成");
    addLog("批量转账成功", tx.hash, "success");
  } catch (error) {
    const message = error.shortMessage || error.reason || error.message || "批量转账失败";
    validRows.forEach((row) => {
      if (row.status !== "成功") {
        row.status = "失败";
        row.error = message;
      }
    });
    updateProgress(0, validRows.length, "失败");
    addLog("批量转账失败", message, "error");
  } finally {
    state.results = validRows.map((row) => ({
      index: row.index,
      address: row.checksumAddress,
      amount: row.amountText,
      status: row.status,
      hash: row.hash,
      error: row.error
    }));
    renderTable();
    setBusy(false);
    if (state.mode === "erc20" && state.token) {
      const balance = await state.token.balanceOf(state.account);
      state.tokenMeta.balance = balance;
      renderTokenMeta();
    } else {
      await refreshNativeBalance();
    }
  }
}

async function sendSimpleBatch() {
  await ensureWallet();
  if (state.mode === "erc20" && !state.token) {
    await loadToken();
  }
  if (state.mode === "native") {
    await refreshNativeBalance();
  }

  const validRows = validateRows();
  assertReady(validRows);

  state.results = [];
  state.stopRequested = false;
  setBusy(true);
  addLog("开始普通转账", `共 ${validRows.length} 笔，需要在 MetaMask 中逐笔确认`, "pending");

  let done = 0;
  updateProgress(done, validRows.length, "发送中");

  for (const row of validRows) {
    if (state.stopRequested) {
      row.status = "已停止";
      renderTable();
      addLog("已停止", "剩余交易未发送", "error");
      break;
    }

    try {
      row.status = "发送中";
      row.error = "";
      renderTable();

      const tx =
        state.mode === "erc20"
          ? await state.token.transfer(row.checksumAddress, row.amountWei)
          : await state.signer.sendTransaction({
              to: row.checksumAddress,
              value: row.amountWei
            });

      row.hash = tx.hash;
      row.status = "确认中";
      renderTable();
      addLog(`第 ${row.index} 笔已提交`, tx.hash, "pending");

      const receipt = await tx.wait();
      if (receipt?.status !== 1) {
        throw new Error("交易已上链但状态失败");
      }

      row.status = "成功";
      done += 1;
      updateProgress(done, validRows.length, "发送中");
      addLog(`第 ${row.index} 笔成功`, tx.hash, "success");
    } catch (error) {
      row.status = "失败";
      row.error = error.shortMessage || error.reason || error.message || "发送失败";
      addLog(`第 ${row.index} 笔失败`, row.error, "error");
    } finally {
      state.results.push({
        index: row.index,
        address: row.checksumAddress,
        amount: row.amountText,
        status: row.status,
        hash: row.hash,
        error: row.error
      });
      renderTable();
    }
  }

  updateProgress(done, validRows.length, done === validRows.length ? "全部完成" : "部分完成");
  setBusy(false);
  if (state.mode === "erc20" && state.token) {
    const balance = await state.token.balanceOf(state.account);
    state.tokenMeta.balance = balance;
    renderTokenMeta();
  } else {
    await refreshNativeBalance();
  }
}

function exportResults() {
  const rows = state.results.length
    ? state.results
    : state.rows.map((row) => ({
        index: row.index,
        address: row.checksumAddress || row.address,
        amount: row.amountText,
        status: row.status,
        hash: row.hash,
        error: row.error
      }));

  if (!rows.length) {
    addLog("暂无可导出结果", "请先校验或发送交易", "error");
    return;
  }

  const header = ["index", "address", "amount", "status", "tx_hash", "error"];
  const csv = [
    header.join(","),
    ...rows.map((row) =>
      [
        row.index,
        row.address,
        row.amount,
        row.status,
        row.hash,
        row.error
      ]
        .map((value) => `"${String(value ?? "").replace(/"/g, "\"\"")}"`)
        .join(",")
    )
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `batch-transfer-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

els.connectBtn.addEventListener("click", async () => {
  try {
    addLog("正在连接钱包", "请在 MetaMask 弹窗中确认连接", "pending");
    await ensureWallet();
    addLog("钱包已连接", `${state.account} on ${networkLabel(state.chainId)}`, "success");
  } catch (error) {
    addLog("连接失败", error.message, "error");
  }
});

els.loadTokenBtn.addEventListener("click", async () => {
  try {
    await loadToken();
  } catch (error) {
    addLog("读取代币失败", error.shortMessage || error.message, "error");
  }
});

els.approveBtn.addEventListener("click", async () => {
  try {
    await approveAllowance();
  } catch (error) {
    addLog("授权失败", error.shortMessage || error.message, "error");
  }
});

els.validateBtn.addEventListener("click", () => {
  const validRows = validateRows();
  addLog("校验完成", `有效 ${validRows.length} 条，无效 ${state.rows.length - validRows.length} 条`, "success");
});

els.sendBtn.addEventListener("click", async () => {
  try {
    await sendBatch();
  } catch (error) {
    setBusy(false);
    addLog("批量转账失败", error.shortMessage || error.message, "error");
  }
});

els.stopBtn.addEventListener("click", () => {
  state.stopRequested = true;
  els.stopBtn.disabled = true;
});

els.exportBtn.addEventListener("click", exportResults);
els.erc20Mode.addEventListener("click", () => setMode("erc20"));
els.nativeMode.addEventListener("click", () => setMode("native"));
els.simpleSendMode.addEventListener("click", () => setSendMode("simple"));
els.contractSendMode.addEventListener("click", () => setSendMode("contract"));
els.recipientInput.addEventListener("input", validateRows);

if (location.protocol === "file:") {
  els.protocolNotice.hidden = false;
  addLog("打开方式不对", "请先运行 start.bat，然后用 http://127.0.0.1:5173/ 打开页面", "error");
} else if (window.ethereum) {
  window.ethereum.on?.("accountsChanged", () => window.location.reload());
  window.ethereum.on?.("chainChanged", () => window.location.reload());
} else {
  addLog("未检测到 MetaMask", "请使用安装了小狐狸钱包扩展的 Chrome 打开本页面", "error");
}

setMode("erc20");
setSendMode("simple");
