const state = {
  transactions: [],
  balances: [],
  transactionIndex: 0,
  balanceIndex: 0,
  currentDate: null,
  endDate: null,
  running: false,
  blocked: false,
  checkpointKey: null,
  checkpoint: null,
  openingBalanceCents: 0,
};

const els = {
  transactionsFile: document.querySelector("#transactionsFile"),
  balancesFile: document.querySelector("#balancesFile"),
  openingBalance: document.querySelector("#openingBalance"),
  loadButton: document.querySelector("#loadButton"),
  stepButton: document.querySelector("#stepButton"),
  runButton: document.querySelector("#runButton"),
  pauseButton: document.querySelector("#pauseButton"),
  resetButton: document.querySelector("#resetButton"),
  runStatus: document.querySelector("#runStatus"),
  verifiedThrough: document.querySelector("#verifiedThrough"),
  totalThroughDate: document.querySelector("#totalThroughDate"),
  currentDateTotal: document.querySelector("#currentDateTotal"),
  statedBalance: document.querySelector("#statedBalance"),
  expectedBalance: document.querySelector("#expectedBalance"),
  difference: document.querySelector("#difference"),
  resultsBody: document.querySelector("#resultsBody"),
};

els.loadButton.addEventListener("click", loadFiles);
els.stepButton.addEventListener("click", verifyNextDate);
els.runButton.addEventListener("click", runUntilBlocked);
els.pauseButton.addEventListener("click", () => {
  state.running = false;
  setStatus("Paused");
  updateButtons();
});
els.resetButton.addEventListener("click", resetCheckpoint);

async function loadFiles() {
  try {
    const transactionFile = els.transactionsFile.files[0];
    const balanceFile = els.balancesFile.files[0];
    if (!transactionFile || !balanceFile) {
      throw new Error("Choose both CSV files first.");
    }

    state.openingBalanceCents = parseMoneyToCents(els.openingBalance.value);
    state.transactions = parseTransactions(await transactionFile.text());
    state.balances = parseBalances(await balanceFile.text());
    state.transactions.sort((a, b) => a.date.localeCompare(b.date));
    state.balances.sort((a, b) => a.date.localeCompare(b.date));
    const allDates = [...state.transactions, ...state.balances].map((row) => row.date).sort();
    state.currentDate = allDates[0] || null;
    state.endDate = allDates[allDates.length - 1] || null;
    state.checkpointKey = checkpointKey(transactionFile, balanceFile);
    state.checkpoint = loadCheckpoint();
    state.blocked = false;
    seekPastVerifiedDates();
    renderCheckpointRows();
    renderMetrics();
    setStatus("Loaded");
    updateButtons();
  } catch (error) {
    setStatus(error.message);
  }
}

function verifyNextDate() {
  const row = nextReconciliationRow();
  if (!row) {
    setStatus("Complete");
    state.running = false;
    state.blocked = true;
    updateButtons();
    return false;
  }

  appendRow(row);
  renderLatestMetrics(row);

  if (row.status !== "matched") {
    setStatus(row.status === "mismatch" ? "Mismatch found" : "Missing statement");
    state.running = false;
    state.blocked = true;
    updateButtons();
    return false;
  }

  state.checkpoint.verifiedThrough = row.date;
  state.checkpoint.expectedBalanceCents = row.expectedBalanceCents;
  state.checkpoint.totalThroughDateCents = row.totalThroughDateCents;
  state.checkpoint.reconciledDates[row.date] = row;
  saveCheckpoint();
  setStatus(`Verified ${row.date}`);
  updateButtons();
  return true;
}

async function runUntilBlocked() {
  state.running = true;
  updateButtons();
  while (state.running) {
    const shouldContinue = verifyNextDate();
    if (!shouldContinue) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 220));
  }
}

function nextReconciliationRow() {
  if (!state.currentDate || !state.endDate || state.currentDate > state.endDate) {
    return null;
  }

  const date = state.currentDate;

  let transactionCount = 0;
  let dateTotalCents = 0;
  while (state.transactions[state.transactionIndex]?.date === date) {
    transactionCount += 1;
    dateTotalCents += state.transactions[state.transactionIndex].amountCents;
    state.transactionIndex += 1;
  }

  let statedBalanceCents = null;
  if (state.balances[state.balanceIndex]?.date === date) {
    statedBalanceCents = state.balances[state.balanceIndex].balanceCents;
    state.balanceIndex += 1;
  }

  const expectedBalanceCents = state.checkpoint.expectedBalanceCents + dateTotalCents;
  const totalThroughDateCents = state.checkpoint.totalThroughDateCents + dateTotalCents;
  const differenceCents =
    statedBalanceCents === null ? null : statedBalanceCents - expectedBalanceCents;
  const status =
    statedBalanceCents === null
      ? "missing_statement"
      : differenceCents === 0
        ? "matched"
        : "mismatch";

  state.currentDate = addIsoDays(state.currentDate, 1);

  return {
    date,
    transactionCount,
    dateTotalCents,
    totalThroughDateCents,
    expectedBalanceCents,
    statedBalanceCents,
    differenceCents,
    status,
  };
}

function seekPastVerifiedDates() {
  state.transactionIndex = 0;
  state.balanceIndex = 0;
  const verifiedThrough = state.checkpoint.verifiedThrough;
  state.currentDate = earliestInputDate();
  if (!verifiedThrough) {
    return;
  }
  while (state.transactions[state.transactionIndex]?.date <= verifiedThrough) {
    state.transactionIndex += 1;
  }
  while (state.balances[state.balanceIndex]?.date <= verifiedThrough) {
    state.balanceIndex += 1;
  }
  state.currentDate = addIsoDays(verifiedThrough, 1);
}

function resetCheckpoint() {
  if (state.checkpointKey) {
    localStorage.removeItem(state.checkpointKey);
  }
  state.checkpoint = newCheckpoint();
  state.blocked = false;
  seekPastVerifiedDates();
  renderCheckpointRows();
  renderMetrics();
  setStatus("Checkpoint reset");
  updateButtons();
}

function loadCheckpoint() {
  const raw = localStorage.getItem(state.checkpointKey);
  if (!raw) {
    return newCheckpoint();
  }
  try {
    const checkpoint = JSON.parse(raw);
    return {
      verifiedThrough: checkpoint.verifiedThrough || null,
      expectedBalanceCents: Number(checkpoint.expectedBalanceCents),
      totalThroughDateCents: Number(checkpoint.totalThroughDateCents),
      reconciledDates: checkpoint.reconciledDates || {},
    };
  } catch {
    return newCheckpoint();
  }
}

function newCheckpoint() {
  return {
    verifiedThrough: null,
    expectedBalanceCents: state.openingBalanceCents,
    totalThroughDateCents: 0,
    reconciledDates: {},
  };
}

function saveCheckpoint() {
  localStorage.setItem(state.checkpointKey, JSON.stringify(state.checkpoint));
}

function renderCheckpointRows() {
  els.resultsBody.innerHTML = "";
  Object.values(state.checkpoint.reconciledDates)
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach(appendRow);
}

function appendRow(row) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${escapeHtml(row.date)}</td>
    <td>${row.transactionCount}</td>
    <td>${formatCents(row.dateTotalCents)}</td>
    <td>${formatCents(row.totalThroughDateCents)}</td>
    <td>${formatCents(row.expectedBalanceCents)}</td>
    <td>${row.statedBalanceCents === null ? "-" : formatCents(row.statedBalanceCents)}</td>
    <td>${row.differenceCents === null ? "-" : formatCents(row.differenceCents)}</td>
    <td><span class="status ${row.status}">${labelStatus(row.status)}</span></td>
  `;
  els.resultsBody.appendChild(tr);
}

function renderMetrics() {
  els.verifiedThrough.textContent = state.checkpoint.verifiedThrough || "None";
  els.totalThroughDate.textContent = formatCents(state.checkpoint.totalThroughDateCents);
  els.currentDateTotal.textContent = "0.00";
  els.statedBalance.textContent = "-";
  els.expectedBalance.textContent = formatCents(state.checkpoint.expectedBalanceCents);
  els.difference.textContent = "-";
}

function renderLatestMetrics(row) {
  els.verifiedThrough.textContent = row.status === "matched" ? row.date : state.checkpoint.verifiedThrough || "None";
  els.totalThroughDate.textContent = formatCents(row.totalThroughDateCents);
  els.currentDateTotal.textContent = formatCents(row.dateTotalCents);
  els.statedBalance.textContent = row.statedBalanceCents === null ? "-" : formatCents(row.statedBalanceCents);
  els.expectedBalance.textContent = formatCents(row.expectedBalanceCents);
  els.difference.textContent = row.differenceCents === null ? "-" : formatCents(row.differenceCents);
}

function parseTransactions(text) {
  return parseCsv(text).map((row, index) => ({
    date: required(row, "date", index),
    amountCents: parseMoneyToCents(required(row, "amount", index)),
  }));
}

function parseBalances(text) {
  const seen = new Set();
  return parseCsv(text).map((row, index) => {
    const date = required(row, "date", index);
    if (seen.has(date)) {
      throw new Error(`Duplicate bank balance date: ${date}`);
    }
    seen.add(date);
    return {
      date,
      balanceCents: parseMoneyToCents(required(row, "balance", index)),
    };
  });
}

function parseCsv(text) {
  const rows = csvRows(text.trim());
  if (rows.length === 0) {
    return [];
  }
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).filter((row) => row.some(Boolean)).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = row[index] ?? "";
    });
    return record;
  });
}

function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  rows.push(row);
  return rows;
}

function required(row, field, index) {
  const value = row[field]?.trim();
  if (!value) {
    throw new Error(`Missing ${field} on CSV row ${index + 2}`);
  }
  if (field === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date on CSV row ${index + 2}: ${value}`);
  }
  return value;
}

function parseMoneyToCents(value) {
  const normalized = String(value).trim();
  const match = normalized.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) {
    throw new Error(`Invalid money value: ${value}`);
  }
  const [, sign, dollars, cents = ""] = match;
  const amount = Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
  return sign === "-" ? -amount : amount;
}

function formatCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function checkpointKey(transactionFile, balanceFile) {
  return [
    "transaction-reconciler",
    transactionFile.name,
    transactionFile.size,
    transactionFile.lastModified,
    balanceFile.name,
    balanceFile.size,
    balanceFile.lastModified,
    state.openingBalanceCents,
  ].join(":");
}

function earliestInputDate() {
  const dates = [
    state.transactions[0]?.date,
    state.balances[0]?.date,
  ].filter(Boolean).sort();
  return dates[0] || null;
}

function addIsoDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function updateButtons() {
  const loaded = Boolean(state.checkpoint);
  els.stepButton.disabled = !loaded || state.running || state.blocked;
  els.runButton.disabled = !loaded || state.running || state.blocked;
  els.pauseButton.disabled = !state.running;
  els.resetButton.disabled = !loaded;
}

function setStatus(message) {
  els.runStatus.textContent = message;
}

function labelStatus(status) {
  return status.replace("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}
