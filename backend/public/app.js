const REQUIRED = ['KWACHA_TREASURY', 'FOREIGN_CURRENCY', 'BANCS_TREASURY'];
const LINES_PER_PAGE = 30;
const state = {
  token: sessionStorage.getItem('nodevault_token') || '',
  me: null,
  books: [],
  book: null,
  directory: [],
  staff: null,
  branches: null,
  businessDate: '',
  dates: [],
  amendingLine: null,
  sheetPage: 1,
};

const loginView = document.getElementById('login-view');
const deskView = document.getElementById('desk-view');

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (_error) {
      throw new Error('The desk sent a page instead of data. Reload the desk and try again.');
    }
  }
  if (!response.ok) {
    const error = new Error(body?.message || 'Request failed');
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function cellKey(column) {
  return `${column.channel}|${column.code}|${column.kind}`;
}

function columnClasses(column, index, size) {
  if (column.gutter) return 'gutter';
  const classes = [`page-${String(column.page || 'left').toLowerCase()}`];
  if (column.key === 'line_number' || column.key === 'line_repeat') classes.push('col-no');
  else if (column.key === 'date' || column.key === 'in_or_out' || column.key === 'reference' || column.key === 'initials') classes.push('col-identity');
  if (column.kind === 'GRAND') classes.push('col-grand');
  if (column.kind === 'SUBTOTAL' || column.kind === 'GRAND') classes.push('col-total');
  if (index === 0) classes.push('group-start');
  if (index === size - 1) classes.push('group-end');
  return classes.join(' ');
}

function sheetPageCount(lastLine) {
  const last = Number(lastLine) || 0;
  return Math.max(1, Math.ceil(last / LINES_PER_PAGE));
}

function pageForLine(lineNumber) {
  const line = Number(lineNumber);
  if (!Number.isInteger(line) || line < 1) return 1;
  return Math.ceil(line / LINES_PER_PAGE);
}

function lastSheetLine(rows) {
  return (rows || []).reduce((max, row) => Math.max(max, Number(row.line_number) || 0), 0);
}

function sheetPageLabel(page, pages, rows) {
  if (!rows.length) return 'No lines';
  const startLine = (page - 1) * LINES_PER_PAGE + 1;
  const endLine = page * LINES_PER_PAGE;
  const shown = rows
    .map((row) => Number(row.line_number))
    .filter((line) => line >= startLine && line <= endLine)
    .sort((a, b) => a - b);
  if (!shown.length) return `No lines · Page ${page} of ${pages}`;
  const first = shown[0];
  const last = shown[shown.length - 1];
  const span = first === last ? `Line ${first}` : `Lines ${first}–${last}`;
  return `${span} · Page ${page} of ${pages}`;
}

function syncSheetPager(view) {
  const rows = view?.rows || [];
  const pages = sheetPageCount(lastSheetLine(rows));
  let page = Number(state.sheetPage) || 1;
  if (page < 1) page = 1;
  if (page > pages) page = pages;
  state.sheetPage = page;
  const label = document.getElementById('sheet-page-label');
  const prev = document.getElementById('sheet-prev');
  const next = document.getElementById('sheet-next');
  if (label) label.textContent = sheetPageLabel(page, pages, rows);
  if (prev) prev.disabled = page <= 1;
  if (next) next.disabled = page >= pages;
  return page;
}

function rowsOnSheetPage(rows, page) {
  const startLine = (page - 1) * LINES_PER_PAGE + 1;
  const endLine = page * LINES_PER_PAGE;
  return rows.filter((row) => {
    const line = Number(row.line_number);
    return line >= startLine && line <= endLine;
  });
}

function renderSpread(view) {
  const table = document.getElementById('ledger');
  const title = document.getElementById('sheet-title');
  if (title) title.textContent = view.layout.sheet_title || view.layout.title;
  const groups = view.layout.groups;
  const headGroups = document.createElement('tr');
  const headCols = document.createElement('tr');
  let gutterDone = false;
  const flat = [];
  for (const group of groups) {
    if (group.page === 'RIGHT' && !gutterDone) {
      const gutter = document.createElement('th');
      gutter.className = 'gutter';
      gutter.rowSpan = 2;
      headGroups.appendChild(gutter);
      gutterDone = true;
      flat.push({ gutter: true });
    }
    const groupCell = document.createElement('th');
    groupCell.colSpan = group.columns.length;
    groupCell.className = `group-head page-${group.page.toLowerCase()}`;
    groupCell.textContent = group.label || '';
    headGroups.appendChild(groupCell);
    group.columns.forEach((column, index) => {
      const th = document.createElement('th');
      th.className = columnClasses({ ...column, page: group.page }, index, group.columns.length);
      const span = document.createElement('span');
      span.className = 'ledger-th-text';
      span.textContent = column.header;
      th.appendChild(span);
      headCols.appendChild(th);
      flat.push({
        ...column,
        page: group.page,
        className: columnClasses({ ...column, page: group.page }, index, group.columns.length),
      });
    });
  }
  const thead = document.createElement('thead');
  thead.append(headGroups, headCols);
  const tbody = document.createElement('tbody');
  const page = syncSheetPager(view);
  const pageRows = rowsOnSheetPage(view.rows, page);
  if (!pageRows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = flat.length;
    td.textContent = view.rows.length ? 'No lines on this page.' : 'No lines on this book yet.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  for (const row of pageRows) {
    const tr = document.createElement('tr');
    tr.dataset.label = row.accounting_label;
    for (const column of flat) {
      const td = document.createElement('td');
      if (column.gutter) {
        td.className = 'gutter';
        tr.appendChild(td);
        continue;
      }
      td.className = column.className;
      let text = '';
      if (column.key === 'line_number' || column.key === 'line_repeat') text = String(row.line_number);
      else if (column.key === 'date') text = row.date_display;
      else if (column.key === 'in_or_out') text = row.in_or_out;
      else if (column.key === 'reference') text = row.reference || '';
      else if (column.key === 'initials') text = row.initials;
      else {
        text = row.displays[cellKey(column)] || '';
        td.classList.add('dynamic-fit-value');
      }
      td.textContent = text;
      if (column.key === 'line_number' && canAmendBook(view)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'amend-line';
        button.textContent = 'Amend';
        button.addEventListener('click', () => startAmend(row));
        td.appendChild(button);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
    if (Number(row.line_number) === 1 && view.narration && view.narration.text) {
      const note = document.createElement('tr');
      note.className = 'narration-row';
      const cell = document.createElement('td');
      cell.colSpan = flat.length;
      cell.textContent = view.narration.text;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'slip-open';
      open.textContent = 'Takeover slip';
      open.addEventListener('click', () => openTakeoverSlip(view.narration.handover_id));
      cell.appendChild(open);
      note.appendChild(cell);
      tbody.appendChild(note);
    }
  }
  table.replaceChildren(thead, tbody);
  if (typeof synchronizeHorizontalMatrixLayout === 'function') {
    synchronizeHorizontalMatrixLayout();
  }
  syncSheetHead();
}

function renderPosition(view) {
  const chips = document.getElementById('position-chips');
  chips.replaceChildren();
  const position = view.position;
  if (!position) return;
  if (position.error) {
    chips.textContent = position.error;
    return;
  }
  for (const [currency, value] of Object.entries(position)) {
    const chip = document.createElement('span');
    chip.textContent = `${currency} ${value.display}`;
    chips.appendChild(chip);
  }
}

function renderSignoff() {
  const host = document.getElementById('signoff');
  const custodians = state.directory.filter((user) => user.system_role === 'VAULT_CUSTODIAN');
  const coord = state.directory.find((user) => user.system_role === 'HEAD_TELLER_COORDINATOR');
  const people = [...custodians, coord].filter(Boolean);
  host.replaceChildren();
  for (const person of people) {
    const coordinator = person.system_role === 'HEAD_TELLER_COORDINATOR';
    const card = document.createElement('article');
    card.className = coordinator ? 'sign-card is-coordinator' : 'sign-card';
    const title = document.createElement('h3');
    title.className = 'seat-kicker';
    title.textContent = coordinator ? 'Head Teller' : 'Vault custodian';
    const name = document.createElement('p');
    name.className = 'seat-name';
    name.textContent = person.full_legal_name;
    const id = document.createElement('p');
    id.className = 'seat-meta';
    id.textContent = `${person.employee_id} · ${person.two_letter_initials}`;
    const line = document.createElement('div');
    line.className = 'sig-line';
    const caption = document.createElement('span');
    caption.textContent = 'Signature';
    line.appendChild(caption);
    card.append(title, name, id, line);
    host.appendChild(card);
  }
}

function fillSelect(select, users, preferredRole) {
  select.replaceChildren();
  for (const user of users) {
    const option = document.createElement('option');
    option.value = user.user_id;
    option.textContent = `${user.full_legal_name} · ${user.two_letter_initials}`;
    if (user.system_role === preferredRole) option.selected = true;
    select.appendChild(option);
  }
}

async function openBook(bookId, options = {}) {
  const status = document.getElementById('desk-status');
  status.textContent = 'Pulling the vault book…';
  const sameBook = Number(state.book?.book?.book_id) === Number(bookId);
  if (options.focusLine) state.sheetPage = pageForLine(options.focusLine);
  else if (!sameBook) state.sheetPage = 1;
  try {
    const view = await api(`/api/books/${bookId}`);
    state.book = view;
    const formula = view.layout.formula.endsWith('.')
      ? view.layout.formula
      : `${view.layout.formula}.`;
    document.getElementById('book-formula').textContent = `${view.layout.instruction}. ${formula}`;
    const stamp = view.book.status === 'BALANCED_CLOSED' ? ' CLOSED' : '';
    status.textContent = `${view.layout.title} · ${view.book.business_date} · ${view.book.branch_name}${stamp}`;
    document.getElementById('open-close').disabled = view.book.status !== 'OPEN' || !view.position || view.position.error;
    renderSpread(view);
    renderPosition(view);
    renderEntry(view);
    for (const button of document.querySelectorAll('#book-tabs button')) {
      button.setAttribute('aria-selected', button.dataset.bookId === String(bookId) ? 'true' : 'false');
    }
  } catch (error) {
    status.textContent = error.message;
  }
}

function renderTabs() {
  const host = document.getElementById('book-tabs');
  host.replaceChildren();
  const present = new Set(state.books.map((book) => book.book_class));
  const missing = REQUIRED.filter((code) => !present.has(code));
  for (const book of state.books) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.bookId = book.book_id;
    button.dataset.bookClass = book.book_class;
    button.setAttribute('role', 'tab');
    button.textContent = book.book_class === 'KWACHA_TREASURY'
      ? 'Kwacha Treasury Book'
      : book.book_class === 'FOREIGN_CURRENCY'
        ? 'Foreign Currency Treasury Book'
        : 'Bancs Treasury Book';
    button.addEventListener('click', () => openBook(book.book_id));
    host.appendChild(button);
  }
  if (missing.length) {
    const note = document.createElement('p');
    note.className = 'error';
    note.textContent = 'This branch is missing one of the three treasury books.';
    host.appendChild(note);
  }
}

const BOOK_TITLES = {
  KWACHA_TREASURY: 'Kwacha Treasury Book',
  FOREIGN_CURRENCY: 'Foreign Currency Treasury Book',
  BANCS_TREASURY: 'Bancs Treasury Book',
};

function cadenceLabel(post) {
  if (post.cadence === 'WEEKLY') return 'Weekly';
  if (post.cadence === 'FORTNIGHTLY') return 'Bi-weekly';
  if (post.cadence === 'MONTHLY') return 'Monthly';
  return `Every ${post.customDays} days`;
}

function renderRotation(rotation) {
  const host = document.getElementById('rotation-panel');
  host.replaceChildren();
  for (const post of rotation.posts || []) {
    const held = post.current && !post.current.unassigned;
    const card = document.createElement('article');
    card.className = 'seat-card';
    const title = document.createElement('h3');
    title.className = 'seat-kicker';
    title.textContent = post.label;
    const holder = document.createElement('p');
    holder.className = 'seat-name';
    holder.textContent = held ? post.current.fullLegalName : 'No holder for this period';
    const meta = document.createElement('p');
    meta.className = 'seat-meta';
    meta.textContent = held ? `${post.current.employeeId} · ${post.current.initials}` : 'Unassigned';
    const dates = document.createElement('p');
    dates.className = 'seat-dates';
    const span = post.current || post.next;
    dates.textContent = span ? `${span.periodStart} to ${span.periodEnd}` : '';
    const cadence = document.createElement('p');
    cadence.className = 'seat-cadence';
    cadence.textContent = cadenceLabel(post);
    card.append(title, holder, meta, dates, cadence);
    host.appendChild(card);
  }
}

function field(labelText, control) {
  const label = document.createElement('label');
  label.textContent = labelText;
  label.appendChild(control);
  return label;
}

function labeledField(labelText, control) {
  const label = document.createElement('label');
  const caption = document.createElement('span');
  caption.textContent = labelText;
  label.append(caption, control);
  return label;
}

function dayKind(kind) {
  if (kind === 'TENANT') return 'All branches';
  if (kind === 'PROVINCE') return 'Province';
  if (kind === 'LOCATION') return 'Town';
  if (kind === 'BRANCH') return 'One branch';
  return kind;
}

function renderCalendar(calendar) {
  const host = document.getElementById('calendar-body');
  if (!host) return;
  host.replaceChildren();
  const lead = document.createElement('p');
  lead.className = 'fold-lead';
  lead.textContent = 'Sundays and public holidays are already closed. A day set here does not open a treasury book.';
  host.append(lead);
  if (calendar.nonWorking) {
    const note = document.createElement('p');
    note.className = 'day-today';
    note.textContent = `Today is not a working day (${calendar.nonWorking.name}). No new book opens.`;
    host.append(note);
  }
  if (calendar.canSetDay) host.appendChild(nonWorkingDayForm(calendar));

  const list = document.createElement('ul');
  list.className = 'day-list';
  const items = [];
  for (const holiday of calendar.holidays || []) {
    const label = holiday.observance === 'SUNDAY_FOLLOWING'
      ? `${holiday.name} (observed Monday)`
      : holiday.name;
    items.push({ date: holiday.date, label, kind: 'Public holiday' });
  }
  for (const holiday of calendar.gazetted || []) {
    if (holiday.cancelled) continue;
    items.push({ date: holiday.date, label: holiday.name, kind: 'Gazetted' });
  }
  for (const closure of calendar.closures || []) {
    if (closure.cancelled || !closure.appliesHere) continue;
    const span = closure.startDate === closure.endDate
      ? closure.startDate
      : `${closure.startDate} to ${closure.endDate}`;
    const codes = (closure.branches || []).map((row) => row.branchCode);
    const where = closure.scope === 'BRANCH' && codes.length
      ? codes.join(', ')
      : '';
    items.push({
      date: closure.startDate,
      label: where ? `${closure.reason} · ${span} · ${where}` : `${closure.reason} · ${span}`,
      kind: closure.scope === 'BRANCH' && codes.length > 1 ? `${codes.length} branches` : closure.scope,
    });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
  setFoldCount('calendar-count', items.length === 1 ? '1 day' : `${items.length} days`);
  if (!items.length) {
    const empty = document.createElement('li');
    empty.className = 'day-empty';
    empty.textContent = 'No public holiday or closure in the next four months.';
    list.appendChild(empty);
  }
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'day-row';
    const when = document.createElement('time');
    when.dateTime = item.date;
    when.textContent = item.date;
    const text = document.createElement('span');
    text.className = 'day-name';
    text.textContent = item.label;
    const pill = document.createElement('span');
    pill.className = 'day-pill';
    pill.textContent = dayKind(item.kind);
    li.append(when, text, pill);
    list.appendChild(li);
  }
  host.appendChild(list);

  if (calendar.canManage) {
    const forms = document.createElement('div');
    forms.className = 'day-tools';
    forms.append(closureForm(calendar), gazetteForm());
    host.appendChild(forms);
  }
  const pending = calendar.canSetDay
    ? (calendar.closures || []).filter((row) => row.cancellable)
    : [];
  const gazettes = calendar.canManage
    ? (calendar.gazetted || []).filter((row) => row.cancellable)
    : [];
  if (pending.length || gazettes.length) {
    const manage = document.createElement('div');
    manage.className = 'day-cancel';
    const heading = document.createElement('h4');
    heading.textContent = 'Withdraw before the date';
    manage.appendChild(heading);
    for (const row of pending) {
      manage.appendChild(cancelLine(
        `${row.startDate}–${row.endDate} · ${row.reason}`,
        () => api(`/api/calendar/closures/${row.closureId}/cancel`, { method: 'POST', body: '{}' }),
      ));
    }
    for (const row of gazettes) {
      manage.appendChild(cancelLine(
        `${row.date} · ${row.name}`,
        () => api(`/api/calendar/gazetted/${row.holidayId}/cancel`, { method: 'POST', body: '{}' }),
      ));
    }
    host.appendChild(manage);
  }
}

function provinceColumns(branches) {
  const groups = new Map();
  for (const row of branches || []) {
    const province = row.province || 'Other';
    if (!groups.has(province)) groups.set(province, []);
    groups.get(province).push(row);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.branchName.localeCompare(b.branchName) || a.branchCode.localeCompare(b.branchCode));
  }
  const preferred = ['Lusaka', 'Copperbelt', 'Central', 'Southern', 'Eastern', 'North-Western', 'Western', 'Luapula', 'Muchinga', 'Northern'];
  const names = [...groups.keys()].sort((a, b) => {
    const ia = preferred.indexOf(a);
    const ib = preferred.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  const columns = [[], [], []];
  if (names.includes('Lusaka')) columns[0].push('Lusaka');
  if (names.includes('Copperbelt')) columns[1].push('Copperbelt');
  columns[2].push(...names.filter((name) => name !== 'Lusaka' && name !== 'Copperbelt'));
  return columns.filter((column) => column.length).map((column) => column.map((province) => ({
    province,
    branches: groups.get(province),
  })));
}

function nonWorkingDayForm(calendar) {
  if (calendar.ownBranchOnly) return ownBranchDayForm(calendar);
  const form = document.createElement('form');
  form.id = 'day-form';
  form.className = 'day-form';
  const heading = document.createElement('h4');
  heading.textContent = 'Set a non-working day';
  const hint = document.createElement('p');
  hint.className = 'fold-lead';
  hint.textContent = 'Close every branch on that date, or tick branches by province.';
  const coverage = document.createElement('select');
  coverage.id = 'day-coverage';
  for (const [value, label] of [
    ['SELECTED', 'Selected branches'],
    ['ALL', 'All branches'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    coverage.appendChild(option);
  }
  const picks = document.createElement('div');
  picks.id = 'day-branches';
  picks.className = 'day-picks';
  const summary = document.createElement('p');
  summary.className = 'day-pick-summary';
  function syncSummary() {
    const boxes = [...picks.querySelectorAll('input[type="checkbox"]')];
    const ticked = boxes.filter((box) => box.checked).length;
    summary.textContent = ticked === boxes.length
      ? `All ${boxes.length} branches ticked`
      : `${ticked} of ${boxes.length} branches ticked`;
  }
  for (const column of provinceColumns(calendar.branches)) {
    const col = document.createElement('div');
    col.className = 'day-col';
    for (const group of column) {
      const card = document.createElement('section');
      card.className = 'day-province';
      const title = document.createElement('h5');
      const name = document.createElement('span');
      name.textContent = group.province;
      const mark = document.createElement('button');
      mark.type = 'button';
      mark.className = 'day-province-all';
      mark.textContent = 'All';
      title.append(name, mark);
      card.appendChild(title);
      const boxesInCard = [];
      function syncMark() {
        mark.textContent = boxesInCard.length && boxesInCard.every((box) => box.checked) ? 'Clear' : 'All';
      }
      for (const row of group.branches) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = String(row.branchId);
        if (Number(calendar.homeBranchId) === Number(row.branchId)) box.checked = true;
        boxesInCard.push(box);
        box.addEventListener('change', () => {
          syncSummary();
          syncMark();
        });
        const branchName = document.createElement('span');
        branchName.className = 'day-branch-name';
        branchName.textContent = row.branchName;
        const code = document.createElement('span');
        code.className = 'day-branch-code';
        code.textContent = row.branchCode;
        const label = document.createElement('label');
        label.append(box, branchName, code);
        card.appendChild(label);
      }
      mark.addEventListener('click', () => {
        const turnOn = boxesInCard.some((box) => !box.checked);
        boxesInCard.forEach((box) => { box.checked = turnOn; });
        syncMark();
        syncSummary();
      });
      syncMark();
      col.appendChild(card);
    }
    picks.appendChild(col);
  }
  const date = document.createElement('input');
  date.id = 'day-date';
  date.type = 'date';
  date.required = true;
  const reason = document.createElement('input');
  reason.id = 'day-reason';
  reason.required = true;
  reason.maxLength = 400;
  reason.placeholder = 'Why this day is closed';
  const error = document.createElement('p');
  error.id = 'day-error';
  error.className = 'error';
  const button = document.createElement('button');
  button.type = 'submit';
  button.id = 'day-submit';
  button.textContent = 'Set this day';
  const controls = document.createElement('div');
  controls.className = 'day-controls';
  controls.append(field('Coverage', coverage), field('Date', date), field('Reason', reason), button);
  const board = document.createElement('div');
  board.className = 'day-board';
  board.append(summary, picks);
  coverage.addEventListener('change', () => {
    board.hidden = coverage.value === 'ALL';
  });
  syncSummary();
  form.append(heading, hint, controls, board, error);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const allBranches = coverage.value === 'ALL';
    const branchIds = [...picks.querySelectorAll('input:checked')].map((box) => Number(box.value));
    if (!allBranches && !branchIds.length) {
      error.textContent = 'Tick at least one branch, or choose all branches.';
      return;
    }
    button.disabled = true;
    try {
      await api('/api/calendar/non-working', {
        method: 'POST',
        body: JSON.stringify({
          all_branches: allBranches,
          branch_ids: branchIds,
          non_working_date: date.value,
          reason: reason.value,
        }),
      });
      await enterDesk(state.businessDate || undefined);
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
    }
  });
  return form;
}

function ownBranchDayForm(calendar) {
  const form = document.createElement('form');
  form.id = 'day-form';
  form.className = 'day-form';
  const heading = document.createElement('h4');
  heading.textContent = 'Set a non-working day';
  const hint = document.createElement('p');
  hint.className = 'fold-lead';
  hint.textContent = 'This closes your branch for that one day.';
  const date = document.createElement('input');
  date.id = 'day-date';
  date.type = 'date';
  date.required = true;
  const reason = document.createElement('input');
  reason.id = 'day-reason';
  reason.required = true;
  reason.maxLength = 400;
  reason.placeholder = 'Why this day is closed';
  const error = document.createElement('p');
  error.id = 'day-error';
  error.className = 'error';
  const button = document.createElement('button');
  button.type = 'submit';
  button.id = 'day-submit';
  button.textContent = 'Set this day';
  const controls = document.createElement('div');
  controls.className = 'day-controls';
  controls.append(field('Date', date), field('Reason', reason), button);
  form.append(heading, hint, controls, error);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    button.disabled = true;
    try {
      await api('/api/calendar/non-working', {
        method: 'POST',
        body: JSON.stringify({
          all_branches: false,
          branch_ids: [Number(calendar.homeBranchId)],
          non_working_date: date.value,
          reason: reason.value,
        }),
      });
      await enterDesk(state.businessDate || undefined);
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
    }
  });
  return form;
}

function cancelLine(label, action) {
  const row = document.createElement('p');
  const text = document.createElement('span');
  text.textContent = label;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cancel';
  button.textContent = 'Cancel';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await action();
      await enterDesk();
    } catch (error) {
      button.disabled = false;
      text.textContent = error.message;
    }
  });
  row.append(text, button);
  return row;
}

function closureForm(calendar) {
  const form = document.createElement('form');
  const heading = document.createElement('h3');
  heading.textContent = 'Set a closure';
  const scope = document.createElement('select');
  for (const [value, label] of [
    ['TENANT', 'All branches'],
    ['PROVINCE', 'One province'],
    ['LOCATION', 'One location'],
    ['BRANCH', 'Selected branches'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    scope.appendChild(option);
  }
  const province = document.createElement('input');
  province.placeholder = 'Province';
  const location = document.createElement('input');
  location.placeholder = 'Location';
  const picks = document.createElement('div');
  picks.className = 'branch-picks';
  for (const branch of calendar.branches || []) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = branch.branchId;
    const label = document.createElement('label');
    label.append(box, document.createTextNode(` ${branch.branchCode} ${branch.branchName}`));
    picks.appendChild(label);
  }
  const start = document.createElement('input');
  start.type = 'date';
  start.required = true;
  const end = document.createElement('input');
  end.type = 'date';
  end.required = true;
  const reason = document.createElement('input');
  reason.required = true;
  reason.maxLength = 400;
  reason.placeholder = 'Why the bank is closed';
  const error = document.createElement('p');
  error.className = 'error';
  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = 'Declare closure';
  form.append(
    heading,
    field('Scope', scope),
    field('Province', province),
    field('Location', location),
    picks,
    field('From', start),
    field('To', end),
    field('Reason', reason),
    error,
    button,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const branchIds = [...picks.querySelectorAll('input:checked')].map((box) => Number(box.value));
    try {
      await api('/api/calendar/closures', {
        method: 'POST',
        body: JSON.stringify({
          scope: scope.value,
          province: province.value,
          location_name: location.value,
          branch_ids: branchIds,
          start_date: start.value,
          end_date: end.value,
          reason: reason.value,
        }),
      });
      await enterDesk();
    } catch (err) {
      error.textContent = err.message;
    }
  });
  return form;
}

function gazetteForm() {
  const form = document.createElement('form');
  const heading = document.createElement('h3');
  heading.textContent = 'Gazetted holiday';
  const date = document.createElement('input');
  date.type = 'date';
  date.required = true;
  const name = document.createElement('input');
  name.required = true;
  name.maxLength = 160;
  name.placeholder = 'Name on the gazette';
  const reference = document.createElement('input');
  reference.placeholder = 'Gazette reference';
  const error = document.createElement('p');
  error.className = 'error';
  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = 'Add national holiday';
  form.append(
    heading,
    field('Date', date),
    field('Name', name),
    field('Gazette reference', reference),
    error,
    button,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    try {
      await api('/api/calendar/gazetted', {
        method: 'POST',
        body: JSON.stringify({
          holiday_date: date.value,
          name: name.value,
          gazette_reference: reference.value,
        }),
      });
      await enterDesk();
    } catch (err) {
      error.textContent = err.message;
    }
  });
  return form;
}

function renderFlags(flags) {
  const host = document.getElementById('carry-flags');
  const reasons = {
    NOT_CLOSED: 'is still open',
    MISSING: 'does not exist',
    NO_CARRIED_DOWN: 'has no Bal c/d',
  };
  host.textContent = (flags || []).map((flag) => (
    `${BOOK_TITLES[flag.book_class] || flag.book_class} was not opened for ${flag.business_date}: the ${flag.prior_business_date} book ${reasons[flag.reason] || flag.reason}.`
  )).join(' ');
}

function renderHandover(rotation, deskOpen) {
  const host = document.getElementById('handover-panel');
  host.replaceChildren();
  const due = rotation.due || [];
  if (!due.length) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const kicker = document.createElement('p');
  kicker.className = 'desk-kicker';
  kicker.textContent = 'Rotation';
  const title = document.createElement('h3');
  title.className = 'desk-title';
  title.textContent = deskOpen
    ? `Handover due ${rotation.dueDate}`
    : 'This cycle stays shut until handover is acknowledged';
  host.append(kicker, title);
  const form = document.createElement('form');
  form.id = 'handover-form';
  form.className = 'handover-form';
  for (const post of due) {
    const block = document.createElement('div');
    block.className = 'handover-post';
    block.dataset.post = post.postCode;
    const row = document.createElement('div');
    row.className = 'handover-grid';
    const candidates = state.directory.filter((user) => user.system_role === post.role && user.user_id !== post.outgoing?.userId);
    const select = document.createElement('select');
    select.dataset.field = 'incoming';
    for (const user of candidates) {
      const option = document.createElement('option');
      option.value = user.user_id;
      option.textContent = `${user.full_legal_name} · ${user.employee_id} · ${user.two_letter_initials}`;
      option.dataset.employeeId = user.employee_id;
      option.dataset.initials = user.two_letter_initials;
      select.appendChild(option);
    }
    const outgoing = document.createElement('input');
    outgoing.readOnly = true;
    const outgoingName = post.postCode === 'HEAD_TELLER' ? 'Outgoing coordinator' : 'Outgoing custodian';
    outgoing.value = post.outgoing ? post.outgoing.initials : 'Not on the calendar';
    const pins = document.createElement('div');
    pins.className = 'handover-grid';
    const outgoingPin = document.createElement('input');
    outgoingPin.type = 'password';
    outgoingPin.autocomplete = 'off';
    outgoingPin.required = true;
    outgoingPin.dataset.field = 'outgoing-pin';
    const incomingPin = document.createElement('input');
    incomingPin.type = 'password';
    incomingPin.autocomplete = 'off';
    incomingPin.required = true;
    incomingPin.dataset.field = 'incoming-pin';
    pins.append(
      labeledField('Outgoing closing PIN', outgoingPin),
      labeledField('Incoming closing PIN', incomingPin),
    );
    row.append(
      labeledField('Incoming holder', select),
      labeledField(outgoingName, outgoing),
    );
    block.append(row, pins);
    form.appendChild(block);
  }
  const error = document.createElement('p');
  error.id = 'handover-error';
  error.className = 'error';
  error.setAttribute('role', 'alert');
  const actions = document.createElement('div');
  actions.className = 'handover-actions';
  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = 'Acknowledge handover';
  form.append(error, actions);
  actions.appendChild(button);
  form.addEventListener('submit', submitHandover);
  host.appendChild(form);
}

async function submitHandover(event) {
  event.preventDefault();
  const error = document.getElementById('handover-error');
  error.textContent = '';
  const posts = [];
  for (const block of event.currentTarget.querySelectorAll('.handover-post')) {
    const select = block.querySelector('[data-field="incoming"]');
    const option = select.selectedOptions[0];
    if (!option) {
      error.textContent = 'Choose the incoming holder.';
      return;
    }
    posts.push({
      post_code: block.dataset.post,
      incoming_user_id: Number(option.value),
      employee_id: option.dataset.employeeId,
      initials: option.dataset.initials,
      outgoing_pin: block.querySelector('[data-field="outgoing-pin"]').value,
      incoming_pin: block.querySelector('[data-field="incoming-pin"]').value,
    });
  }
  try {
    await api('/api/rotation/handover', {
      method: 'POST',
      body: JSON.stringify({
        effective_date: state.rotation.dueDate,
        posts,
      }),
    });
    await enterDesk();
  } catch (err) {
    error.textContent = err.message;
  }
}

function personLine(person) {
  return `${person.fullLegalName || person.full_legal_name}, ${person.employeeId || person.employee_id}`;
}

function slipArticle(title, lines) {
  const article = document.createElement('article');
  const heading = document.createElement('h2');
  heading.textContent = title;
  article.appendChild(heading);
  for (const line of lines) article.appendChild(line);
  return article;
}

function paragraph(text, className) {
  const p = document.createElement('p');
  if (className) p.className = className;
  p.textContent = text;
  return p;
}

function signatureBlock(caption, people) {
  const block = document.createElement('section');
  block.className = 'slip-signs';
  const heading = document.createElement('h3');
  heading.textContent = caption;
  block.appendChild(heading);
  for (const person of people) {
    const row = document.createElement('p');
    row.className = 'slip-sign';
    const name = document.createElement('span');
    name.textContent = personLine(person);
    const line = document.createElement('span');
    line.className = 'sig-line';
    line.textContent = 'Signature';
    row.append(name, line);
    block.appendChild(row);
  }
  return block;
}

function showSlip(dialogId, bodyId, node) {
  const body = document.getElementById(bodyId);
  body.replaceChildren(node);
  document.getElementById(dialogId).showModal();
}

async function sendSlipToPrinter(printPath) {
  const note = document.getElementById('desk-status');
  try {
    const result = await api(printPath, { method: 'POST' });
    if (note) {
      note.textContent = result.status === 'SENT'
        ? 'Sent to the branch printer.'
        : `The branch printer did not take it. ${result.error || 'It stays queued.'}`;
    }
  } catch (error) {
    if (note) note.textContent = error.message;
  }
}

function showTakeoverSlip(slip) {
  document.getElementById('takeover-slip').dataset.printPath = `/api/handovers/${slip.handover_id}/slip/print`;
  const root = document.createElement('div');
  root.append(
    paragraph(slip.bank_name, 'slip-bank'),
    paragraph(`${slip.branch_name} · ${slip.branch_code}`, 'slip-branch'),
    paragraph(`Takeover ${slip.taken_over_at}`, 'slip-when'),
  );
  for (const book of slip.books) {
    const block = document.createElement('section');
    block.className = 'slip-book';
    const title = document.createElement('h3');
    title.textContent = book.book_class === 'KWACHA_TREASURY'
      ? 'Kwacha Treasury Book'
      : book.book_class === 'FOREIGN_CURRENCY'
        ? 'Foreign Currency Treasury Book'
        : 'Bancs Treasury Book';
    block.appendChild(title);
    for (const total of book.totals) {
      const figure = document.createElement('p');
      figure.className = 'slip-total';
      const strong = document.createElement('strong');
      strong.textContent = `Total B/F ${total.figure}`;
      figure.append(strong, document.createTextNode(` (${total.words})`));
      block.appendChild(figure);
    }
    block.appendChild(paragraph(book.narration_text, 'slip-narration'));
    root.appendChild(block);
  }
  root.append(
    signatureBlock('Handing over', slip.handing_over),
    signatureBlock('Taking over', slip.taking_over),
  );
  showSlip('takeover-slip', 'takeover-slip-body', root);
}

async function openTakeoverSlip(handoverId) {
  showTakeoverSlip(await api(`/api/handovers/${handoverId}/slip`));
}

function showSurpriseSlip(slip) {
  document.getElementById('surprise-slip').dataset.printPath = `/api/surprise-checks/${slip.check_id}/slip/print`;
  const root = document.createElement('div');
  root.append(
    paragraph(slip.bank_name, 'slip-bank'),
    paragraph(`${slip.branch_name} · ${slip.branch_code}`, 'slip-branch'),
    paragraph(`Surprise cash check ${slip.checked_at_display}`, 'slip-when'),
    paragraph(`${slip.checker_name}, ${slip.checker_employee_id} · ${slip.checker_role}`, 'slip-checker'),
  );
  const present = (slip.custodians_present || []).map(personLine);
  root.appendChild(paragraph(
    present.length
      ? `Custodians present: ${present.join(' and ')}. They do not sign.`
      : 'No custodian was assigned on this date.',
    'slip-aside',
  ));
  for (const book of slip.books) {
    const block = document.createElement('section');
    block.className = 'slip-book';
    const title = document.createElement('h3');
    title.textContent = book.book_class === 'KWACHA_TREASURY'
      ? 'Kwacha Treasury Book'
      : book.book_class === 'FOREIGN_CURRENCY'
        ? 'Foreign Currency Treasury Book'
        : 'Bancs Treasury Book';
    block.appendChild(title);
    block.appendChild(paragraph(book.narration_text, 'slip-narration'));
    root.appendChild(block);
  }
  root.appendChild(signatureBlock('Checker', [{
    fullLegalName: slip.checker_name,
    employeeId: slip.checker_employee_id,
  }]));
  showSlip('surprise-slip', 'surprise-slip-body', root);
}

async function openAuditorBranches(user, card) {
  const existing = card.querySelector('.auditor-branches');
  if (existing) {
    existing.remove();
    return;
  }
  const box = document.createElement('form');
  box.className = 'auditor-branches';
  const note = document.createElement('p');
  note.className = 'staff-meta';
  note.textContent = 'One branch at a time. They mark the current branch reviewed or pending final comment before moving.';
  box.appendChild(note);
  const [directory, assigned] = await Promise.all([
    api('/api/branches'),
    api(`/api/auditors/${user.user_id}/branches`),
  ]);
  const chosen = new Set((assigned.branch_ids || []).map(String));
  for (const branch of directory.branches || []) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(branch.branch_id);
    input.checked = chosen.has(String(branch.branch_id));
    label.append(input, document.createTextNode(` ${branch.branch_name}`));
    box.appendChild(label);
  }
  const save = document.createElement('button');
  save.type = 'submit';
  save.textContent = 'Save auditor branches';
  box.appendChild(save);
  box.addEventListener('submit', async (event) => {
    event.preventDefault();
    const branch_ids = [...box.querySelectorAll('input:checked')].map((input) => Number(input.value));
    note.textContent = '';
    try {
      await api(`/api/auditors/${user.user_id}/branches`, {
        method: 'POST',
        body: JSON.stringify({ branch_ids }),
      });
      note.textContent = 'Those branches are assigned.';
    } catch (error) {
      note.textContent = error.message;
    }
  });
  card.appendChild(box);
}

const VAULT_FIELDS = {
  KWACHA_TREASURY: [
    ['REISSUABLE', 'K500', 'K500'], ['REISSUABLE', 'K200', 'K200'], ['REISSUABLE', 'K100', 'K100'],
    ['REISSUABLE', 'K50', 'K50'], ['REISSUABLE', 'K20', 'K20'], ['REISSUABLE', 'K10', 'K10'],
    ['COINS', 'K5', 'K5'], ['COINS', 'K2', 'K2'], ['COINS', 'K1', 'K1'],
    ['COINS', '50n', 'N50'], ['COINS', '10n', 'N10'], ['COINS', '5n', 'N5'],
  ],
  FOREIGN_CURRENCY: [
    ['EUR', '500', 'EUR 500'], ['EUR', '200', 'EUR 200'], ['EUR', '100', 'EUR 100'], ['EUR', '50', 'EUR 50'],
    ['EUR', '20', 'EUR 20'], ['EUR', '10', 'EUR 10'], ['EUR', '5', 'EUR 5'],
    ['GBP', '50', 'GBP 50'], ['GBP', '20', 'GBP 20'], ['GBP', '10', 'GBP 10'], ['GBP', '5', 'GBP 5'],
    ['USD', '100', 'USD 100'], ['USD', '50', 'USD 50'], ['USD', '20', 'USD 20'], ['USD', '10', 'USD 10'],
    ['USD', '5', 'USD 5'], ['USD', '1', 'USD 1'],
    ['ZAR', '200', 'ZAR 200'], ['ZAR', '100', 'ZAR 100'], ['ZAR', '50', 'ZAR 50'], ['ZAR', '20', 'ZAR 20'],
    ['ZAR', '10', 'ZAR 10'],
  ],
};

function holderId(postCode) {
  const post = (state.rotation && state.rotation.posts || []).find((item) => item.postCode === postCode);
  return post && post.current && !post.current.unassigned ? post.current.userId : '';
}

function renderVaultSheet(desk) {
  const panel = document.getElementById('vault-sheet-panel');
  if (!panel) return;
  const allowed = Boolean(state.me && state.me.can_vault_sheet && desk && desk.deskOpen && state.books.length);
  panel.hidden = !allowed;
  panel.replaceChildren();
  if (!allowed) return;
  const form = document.createElement('form');
  form.id = 'vault-sheet-form';
  const title = document.createElement('h3');
  title.textContent = 'From Vault / To Vault';
  const lead = document.createElement('p');
  lead.className = 'hint';
  lead.textContent = 'Type the cash by denomination. A book left at zero is printed at zero and does not post a line. The sheet goes to this branch’s A4 printer, landscape, before the vault is opened.';
  const direction = document.createElement('select');
  direction.id = 'vault-direction';
  for (const [value, label] of [['FROM_VAULT', 'From Vault'], ['TO_VAULT', 'To Vault']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    direction.appendChild(option);
  }
  const books = document.createElement('div');
  books.className = 'vault-books';
  const classes = [
    ['KWACHA_TREASURY', 'Kwacha Treasury Book'],
    ['FOREIGN_CURRENCY', 'Foreign Currency Treasury Book'],
    ['BANCS_TREASURY', 'Bancs Treasury Book'],
  ];
  for (const [bookClass, label] of classes) {
    const block = document.createElement('section');
    block.className = 'vault-book';
    const heading = document.createElement('h4');
    heading.textContent = label;
    block.appendChild(heading);
    const fields = bookClass === 'BANCS_TREASURY' ? VAULT_FIELDS.FOREIGN_CURRENCY : VAULT_FIELDS[bookClass];
    for (const [channel, code, name] of fields) {
      const row = document.createElement('label');
      row.textContent = name;
      const input = document.createElement('input');
      input.inputMode = 'decimal';
      input.placeholder = '0.00';
      input.dataset.book = bookClass;
      input.dataset.channel = channel;
      input.dataset.code = code;
      row.appendChild(input);
      block.appendChild(row);
    }
    books.appendChild(block);
  }
  const pins = document.createElement('div');
  pins.className = 'entry-meta';
  const pinField = (id, label, value) => {
    const wrap = document.createElement('label');
    wrap.textContent = label;
    const input = document.createElement('input');
    input.id = id;
    input.value = value == null ? '' : String(value);
    wrap.appendChild(input);
    return wrap;
  };
  pins.append(
    pinField('vault-c1', 'Custodian 1 id', holderId('CUSTODIAN_ONE')),
    pinField('vault-c1-pin', 'Custodian 1 PIN', ''),
    pinField('vault-c2', 'Custodian 2 id', holderId('CUSTODIAN_TWO')),
    pinField('vault-c2-pin', 'Custodian 2 PIN', ''),
    pinField('vault-coord', 'Head teller id', holderId('HEAD_TELLER')),
    pinField('vault-coord-pin', 'Head teller PIN', ''),
  );
  const error = document.createElement('p');
  error.id = 'vault-sheet-error';
  error.className = 'error';
  error.setAttribute('role', 'alert');
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Post and print the sheet';
  form.append(title, lead, direction, books, pins, error, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const payloadBooks = {};
    for (const input of form.querySelectorAll('input[data-book]')) {
      const value = input.value.trim();
      if (!value) continue;
      const book = payloadBooks[input.dataset.book] || {};
      const channel = book[input.dataset.channel] || {};
      channel[input.dataset.code] = value;
      book[input.dataset.channel] = channel;
      payloadBooks[input.dataset.book] = book;
    }
    try {
      const created = await api(`/api/branches/${state.books[0].branch_id}/vault-sheets`, {
        method: 'POST',
        body: JSON.stringify({
          direction: direction.value,
          operating_date: state.businessDate,
          books: payloadBooks,
          c1_id: Number(document.getElementById('vault-c1').value),
          c1_pin: document.getElementById('vault-c1-pin').value,
          c2_id: Number(document.getElementById('vault-c2').value),
          c2_pin: document.getElementById('vault-c2-pin').value,
          coord_id: Number(document.getElementById('vault-coord').value),
          coord_pin: document.getElementById('vault-coord-pin').value,
        }),
      });
      error.textContent = created.print && created.print.status === 'SENT'
        ? 'The sheet is on the branch printer.'
        : 'The lines are on the books. The printer did not take the sheet, so it can be sent again.';
      if (state.book && state.book.book) await openBook(state.book.book.book_id);
    } catch (err) {
      error.textContent = err.message;
    }
  });
  panel.appendChild(form);
}

async function renderAudit() {
  const panel = document.getElementById('audit-panel');
  if (!panel) return;
  if (!state.me || !state.me.can_audit) {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }
  panel.hidden = false;
  panel.replaceChildren();
  const assignment = await api('/api/audit/branches');
  const title = document.createElement('h3');
  title.textContent = 'Audit review';
  const lead = document.createElement('p');
  lead.className = 'hint';
  lead.textContent = 'One branch at a time. Mark every line, then sign the end-of-audit comment. The audit sheet prints on that branch’s A4 printer. The logo is on the sheet, not on this screen.';
  const switches = document.createElement('div');
  switches.className = 'audit-branches';
  for (const branch of assignment.branches) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = branch.branch_id === assignment.current_audit_branch_id
      ? `${branch.branch_name} (current)`
      : branch.branch_name;
    button.addEventListener('click', async () => {
      lead.textContent = '';
      try {
        await api('/api/audit/current-branch', {
          method: 'POST',
          body: JSON.stringify({ branch_id: branch.branch_id }),
        });
        await renderAudit();
      } catch (error) {
        lead.textContent = error.message;
      }
    });
    switches.appendChild(button);
  }
  const from = document.createElement('input');
  from.type = 'date';
  from.value = state.businessDate || '';
  const to = document.createElement('input');
  to.type = 'date';
  to.value = state.businessDate || '';
  const load = document.createElement('button');
  load.type = 'button';
  load.textContent = 'Load this range';
  const linesHost = document.createElement('div');
  linesHost.className = 'audit-lines';
  const pending = document.createElement('button');
  pending.type = 'button';
  pending.textContent = 'Pending final comment';
  const comment = document.createElement('textarea');
  comment.rows = 3;
  comment.placeholder = 'End of audit comment';
  const sign = document.createElement('button');
  sign.type = 'button';
  sign.textContent = 'Sign off and print';
  const status = document.createElement('p');
  status.className = 'staff-meta';
  pending.addEventListener('click', async () => {
    status.textContent = '';
    try {
      await api(`/api/branches/${assignment.current_audit_branch_id}/audit/pending-final-comment`, { method: 'POST' });
      status.textContent = 'Marked pending final comment. The branch is not signed off.';
    } catch (error) {
      status.textContent = error.message;
    }
  });
  load.addEventListener('click', async () => {
    linesHost.replaceChildren();
    status.textContent = '';
    try {
      const review = await api(`/api/branches/${assignment.current_audit_branch_id}/audit?from=${from.value}&to=${to.value}`);
      if (!review.lines.length) linesHost.appendChild(paragraph('No ledger lines in this range.'));
      for (const line of review.lines) {
        const card = document.createElement('article');
        card.className = 'audit-line';
        const summary = document.createElement('p');
        summary.textContent = `${line.book_title} · line ${line.line_number} · ${line.date_display} · ${line.accounting_label}`;
        const select = document.createElement('select');
        for (const [value, label] of [
          ['REVIEWED', 'Reviewed'],
          ['MATCHED', 'Matched'],
          ['UNMATCHED', 'Unmatched'],
          ['MATCHED_WITH_DIFFERENCE', 'Matched with a difference'],
        ]) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          if (line.mark_status === value) option.selected = true;
          select.appendChild(option);
        }
        const kind = document.createElement('select');
        for (const [value, label] of [['', 'No core reference'], ['CIT_SLIP', 'CIT slip'], ['ATM', 'ATM'], ['TELLER', 'Teller']]) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          if ((line.core_ref_kind || '') === value) option.selected = true;
          kind.appendChild(option);
        }
        const note = document.createElement('input');
        note.value = line.comment || '';
        note.placeholder = 'Comment, optional';
        const save = document.createElement('button');
        save.type = 'button';
        save.textContent = 'Save mark';
        save.addEventListener('click', async () => {
          status.textContent = '';
          try {
            await api(`/api/branches/${assignment.current_audit_branch_id}/audit/lines/${line.matrix_tx_id}/mark`, {
              method: 'POST',
              body: JSON.stringify({
                status: select.value,
                comment: note.value,
                core_ref_kind: kind.value,
              }),
            });
            status.textContent = `Line ${line.line_number} marked.`;
          } catch (error) {
            status.textContent = error.message;
          }
        });
        card.append(summary, select, kind, note, save);
        linesHost.appendChild(card);
      }
      const physical = review.totals.map((row) => (
        `${row.currency} physical ${row.physical_minor == null ? 'blank' : row.physical_minor}`
      )).join(' · ');
      linesHost.appendChild(paragraph(physical));
    } catch (error) {
      status.textContent = error.message;
    }
  });
  sign.addEventListener('click', async () => {
    status.textContent = '';
    try {
      const signed = await api(`/api/branches/${assignment.current_audit_branch_id}/audit/signoff`, {
        method: 'POST',
        body: JSON.stringify({ from: from.value, to: to.value, comment: comment.value }),
      });
      status.textContent = signed.print && signed.print.status === 'SENT'
        ? 'Signed off. The audit sheet is on the branch printer.'
        : 'Signed off. The printer did not take the sheet, and the sign-off still stands.';
    } catch (error) {
      status.textContent = error.message;
    }
  });
  panel.append(title, lead, switches, from, to, load, linesHost, pending, comment, sign, status);
}

function renderMovementOptions() {
  const panel = document.getElementById('movement-panel');
  if (!panel) return;
  const allowed = Boolean(state.me && state.me.can_configure_movements);
  panel.hidden = !allowed;
  if (!allowed) return;
  const options = state.movementOptions || [];
  document.getElementById('movement-count').textContent = String(options.filter((option) => option.is_active).length);
}

async function renderSurprise(desk) {
  const panel = document.getElementById('surprise-panel');
  const review = document.getElementById('surprise-review');
  review.replaceChildren();
  const date = state.businessDate || (state.dates[0] && state.dates[0].business_date) || '';
  let checks = [];
  if (date) {
    try {
      checks = (await api(`/api/surprise-checks?date=${encodeURIComponent(date)}`)).checks;
    } catch (_error) {
      checks = [];
    }
  }
  const heading = document.createElement('h3');
  heading.textContent = 'Surprise cash checks';
  const lead = document.createElement('p');
  lead.className = 'hint';
  lead.textContent = 'Shown at the date and time the check happened. A check is not a ledger line, so Bal b/f, Bal b/d, and Bal c/d stay as they were.';
  review.append(heading, lead);
  if (!checks.length) {
    review.appendChild(paragraph('No surprise cash check is recorded for this date.'));
  }
  for (const check of checks) {
    const card = document.createElement('article');
    card.className = 'check-card';
    card.append(
      paragraph(`${check.checked_at_display} · ${check.checker_name}, ${check.checker_employee_id}`, 'check-when'),
    );
    for (const book of check.books) {
      card.appendChild(paragraph(book.narration_text, 'slip-narration'));
    }
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = 'Surprise check slip';
    open.addEventListener('click', async () => {
      showSurpriseSlip(await api(`/api/surprise-checks/${check.check_id}/slip`));
    });
    card.appendChild(open);
    review.appendChild(card);
  }
  const allowed = Boolean(state.me && state.me.can_surprise_check && desk.deskOpen !== false && state.books.length);
  panel.hidden = !allowed;
  panel.replaceChildren();
  if (!allowed) return;
  const form = document.createElement('form');
  form.id = 'surprise-form';
  form.append(
    paragraph('Surprise cash check', 'desk-kicker'),
    paragraph('An auditor or the regional operations manager counts the vault. They stand outside the two custodian seats, so the custodians on duty are named as present and do not sign. The master admin can record one while not acting as someone else, which is how this desk is demonstrated. A vault custodian, the head teller, and a branch manager cannot check the cash they hold.', 'hint'),
  );
  const when = document.createElement('input');
  when.id = 'surprise-when';
  when.type = 'datetime-local';
  when.required = true;
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  when.value = local;
  form.appendChild(labeledField('Date and time', when));
  const host = document.createElement('div');
  host.id = 'surprise-counts';
  form.appendChild(host);
  const error = document.createElement('p');
  error.id = 'surprise-error';
  error.className = 'error';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Record surprise cash check';
  form.append(error, submit);
  form.addEventListener('submit', submitSurprise);
  panel.appendChild(form);
  const counts = [];
  for (const book of state.books) {
    const view = await api(`/api/books/${book.book_id}`);
    const block = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = `${view.layout.title} · system position`;
    block.appendChild(legend);
    const fields = {};
    for (const [currency, value] of Object.entries(view.position || {})) {
      if (currency === 'error' || !value || !value.decimal) continue;
      const input = document.createElement('input');
      input.value = value.decimal;
      input.inputMode = 'decimal';
      input.required = true;
      input.dataset.currency = currency;
      fields[currency] = input;
      block.appendChild(labeledField(`${currency} counted (${value.display} on the book)`, input));
    }
    host.appendChild(block);
    counts.push({ book_class: book.book_class, fields });
  }
  form.dataset.ready = '1';
  form._counts = counts;
}

async function submitSurprise(event) {
  event.preventDefault();
  const error = document.getElementById('surprise-error');
  error.textContent = '';
  const form = event.currentTarget;
  const when = document.getElementById('surprise-when').value;
  const books = (form._counts || []).map((book) => {
    const counted = {};
    for (const [currency, input] of Object.entries(book.fields)) counted[currency] = input.value.trim();
    return { book_class: book.book_class, counted };
  });
  try {
    const created = await api('/api/surprise-checks', {
      method: 'POST',
      body: JSON.stringify({
        checked_at: new Date(when).toISOString(),
        business_date: state.businessDate,
        books,
      }),
    });
    showSurpriseSlip(await api(`/api/surprise-checks/${created.check_id}/slip`));
    await renderSurprise({ deskOpen: true });
  } catch (err) {
    error.textContent = err.message;
  }
}

function entraCopy(enabled) {
  return enabled
    ? 'Directory sign-in is on. Turn it off to allow manual desk passwords. Break-glass requires manual override.'
    : 'Directory sign-in is off. Manual desk passwords are the door. Break-glass still requires the directory assertion.';
}

async function renderEntraAdmin() {
  const panel = document.getElementById('entra-admin');
  const show = state.me?.system_role === 'IT_SUPER_ADMIN' || state.me?.acting_as || state.me?.can_act_as;
  if (!panel || !show) {
    if (panel) panel.hidden = true;
    return;
  }
  const setting = await api('/api/auth/entra');
  panel.hidden = false;
  const button = document.getElementById('entra-toggle');
  const on = Boolean(setting.entraEnabled);
  button.setAttribute('aria-pressed', on ? 'true' : 'false');
  button.classList.toggle('bg-slate-800', on);
  button.classList.toggle('bg-slate-300', !on);
  const knob = button.querySelector('span');
  knob.classList.toggle('translate-x-5', on);
  knob.classList.toggle('translate-x-0', !on);
  document.getElementById('entra-admin-copy').textContent = entraCopy(on);
}

function fillActAsSelect() {
  const select = document.getElementById('act-as-user');
  const current = select.value;
  select.replaceChildren();
  for (const user of state.directory) {
    if (user.system_role === 'IT_SUPER_ADMIN' || user.user_id === state.me.user_id) continue;
    const option = document.createElement('option');
    option.value = String(user.user_id);
    option.textContent = `${user.full_legal_name} (${user.role_label || user.system_role})`;
    select.appendChild(option);
  }
  if (current && [...select.options].some((option) => option.value === current)) select.value = current;
}

function renderActAs() {
  const panel = document.getElementById('act-as');
  const banner = document.getElementById('acting-banner');
  const exit = document.getElementById('acting-exit');
  const icon = document.getElementById('acting-icon');
  if (!panel || !banner) return;
  if (state.me?.acting_as) {
    banner.hidden = false;
    panel.hidden = false;
    if (exit) exit.hidden = false;
    if (icon) icon.hidden = false;
    const roleLabel = state.me.role_label || state.me.system_role;
    document.getElementById('acting-copy').textContent = `Testing as ${state.me.full_legal_name} (${roleLabel}). Simulating administrative and operational views.`;
    document.getElementById('session-user').textContent = `Testing as ${state.me.full_legal_name} · ${roleLabel}`;
    fillActAsSelect();
    return;
  }
  banner.hidden = true;
  if (exit) exit.hidden = true;
  if (icon) icon.hidden = true;
  if (!state.me?.can_act_as) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  document.getElementById('acting-copy').textContent = 'Open the desk as a staff member. A vault custodian or the weekly head teller can write a line.';
  fillActAsSelect();
}

function addIsoDays(iso, days) {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fillSelect(select, options, selected) {
  const current = selected || select.value;
  select.replaceChildren();
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    select.appendChild(node);
  }
  if (current && [...select.options].some((option) => option.value === current)) select.value = current;
}

function staffRoleLabel(code) {
  const found = (state.staff?.roles || []).find((role) => role.code === code);
  return found ? found.label : code;
}

function staffBranchOptions() {
  return (state.staff?.branches || []).map((branch) => ({
    value: String(branch.branch_id),
    label: `${branch.branch_name} (${branch.branch_code})`,
  }));
}

function fillStaffChoices() {
  const source = state.staff?.can_manage
    ? (state.staff?.roles || [])
    : (state.staff?.assignable_roles || []);
  const roles = source.map((role) => ({ value: role.code, label: role.label }));
  const branches = staffBranchOptions();
  fillSelect(document.getElementById('staff-role'), roles);
  fillSelect(
    document.getElementById('staff-branch'),
    branches,
    state.staff?.home_branch_id ? String(state.staff.home_branch_id) : '',
  );
  fillSelect(document.getElementById('staff-edit-role'), roles);
  fillSelect(document.getElementById('staff-edit-branch'), branches);
  fillSelect(document.getElementById('staff-assign-branch'), branches);
}

function coverageText(item) {
  if (item.coverage === 'current') return 'Holds now';
  if (item.coverage === 'upcoming') return 'Upcoming';
  return 'Recent';
}

function renderStaffList() {
  const host = document.getElementById('staff-list');
  host.replaceChildren();
  const register = state.staff;
  const people = register?.users || [];
  const activePeople = people.filter((user) => user.is_active).length;
  setFoldCount('staff-count', activePeople === 1 ? '1 person' : `${activePeople} people`);
  if (!people.length) {
    const empty = document.createElement('p');
    empty.className = 'staff-meta';
    empty.textContent = 'No one is on the staff register yet.';
    host.appendChild(empty);
    return;
  }
  for (const user of people) {
    const card = document.createElement('article');
    card.className = `staff-card${user.is_active ? '' : ' is-removed'}`;
    card.dataset.userId = String(user.user_id);
    const title = document.createElement('h4');
    title.textContent = user.full_legal_name;
    const identity = document.createElement('p');
    identity.className = 'staff-meta';
    identity.textContent = `${user.employee_id} · ${user.two_letter_initials} · ${user.work_email}`;
    const place = document.createElement('p');
    place.className = 'staff-meta';
    const branch = user.branch_name ? `${user.branch_name}` : 'No branch';
    place.textContent = user.is_active
      ? `${staffRoleLabel(user.system_role)} · ${branch}`
      : `${staffRoleLabel(user.system_role)} · ${branch} · Removed from the desk`;
    const posts = document.createElement('ul');
    posts.className = 'staff-posts';
    if (!user.assignments.length) {
      const item = document.createElement('li');
      item.textContent = 'No vault post in the last two weeks.';
      posts.appendChild(item);
    } else {
      for (const assignment of user.assignments) {
        const item = document.createElement('li');
        item.textContent = `${coverageText(assignment)} · ${assignment.label} · ${assignment.branch_name} · ${assignment.period_start} to ${assignment.period_end}`;
        posts.appendChild(item);
      }
    }
    card.append(title, identity, place, posts);
    const roleEditable = register.can_edit_roles
      && user.is_active
      && !user.protected
      && (register.assignable_roles || []).some((role) => role.code === user.system_role);
    if (register.can_manage && !user.protected) {
      const actions = document.createElement('div');
      actions.className = 'staff-actions';
      if (user.is_active) {
        const matching = (register.posts || []).filter((post) => post.role === user.system_role);
        if (matching.length) {
          const assign = document.createElement('button');
          assign.type = 'button';
          assign.textContent = 'Assign post';
          assign.addEventListener('click', () => openStaffAssign(user));
          actions.appendChild(assign);
        }
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'staff-quiet';
        edit.textContent = 'Change role or branch';
        edit.addEventListener('click', () => openStaffEdit(user));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'staff-quiet';
        remove.textContent = 'Remove from desk';
        remove.addEventListener('click', () => removeStaffMember(user));
        actions.append(edit, remove);
      } else {
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.textContent = 'Restore to the desk';
        restore.addEventListener('click', () => restoreStaffMember(user));
        actions.appendChild(restore);
      }
      if (user.system_role === 'AUDITOR' && user.is_active) {
        const auditBranches = document.createElement('button');
        auditBranches.type = 'button';
        auditBranches.className = 'staff-quiet';
        auditBranches.textContent = 'Audit branches';
        auditBranches.addEventListener('click', () => openAuditorBranches(user, card));
        actions.appendChild(auditBranches);
      }
      card.appendChild(actions);
    } else if (roleEditable) {
      const actions = document.createElement('div');
      actions.className = 'staff-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'staff-quiet';
      edit.textContent = 'Change role';
      edit.addEventListener('click', () => openStaffEdit(user));
      actions.appendChild(edit);
      card.appendChild(actions);
    } else if (user.protected) {
      const fixed = document.createElement('p');
      fixed.className = 'staff-meta';
      fixed.textContent = 'This account stays on the register.';
      card.appendChild(fixed);
    }
    host.appendChild(card);
  }
}

function hideStaffEditors() {
  document.getElementById('staff-edit').hidden = true;
  document.getElementById('staff-assign').hidden = true;
  document.getElementById('staff-edit-error').textContent = '';
  document.getElementById('staff-assign-error').textContent = '';
}

function openStaffEdit(user) {
  hideStaffEditors();
  document.getElementById('staff-note').textContent = '';
  const form = document.getElementById('staff-edit');
  form.hidden = false;
  document.getElementById('staff-edit-user').value = String(user.user_id);
  document.getElementById('staff-edit-title').textContent = state.staff?.can_manage
    ? `Change role or branch for ${user.full_legal_name}`
    : `Change role for ${user.full_legal_name}`;
  const branchLabel = document.getElementById('staff-edit-branch').closest('label');
  if (branchLabel) branchLabel.hidden = !state.staff?.can_manage;
  const pinLabel = document.getElementById('staff-edit-pin').closest('label');
  if (pinLabel) pinLabel.hidden = !state.staff?.can_manage;
  document.getElementById('staff-edit-role').value = user.system_role;
  if (user.branch_id) document.getElementById('staff-edit-branch').value = String(user.branch_id);
  document.getElementById('staff-edit-pin').value = '';
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function openStaffAssign(user) {
  hideStaffEditors();
  document.getElementById('staff-note').textContent = '';
  const posts = (state.staff?.posts || [])
    .filter((post) => post.role === user.system_role)
    .map((post) => ({ value: post.code, label: post.label }));
  fillSelect(document.getElementById('staff-assign-post'), posts);
  const form = document.getElementById('staff-assign');
  form.hidden = false;
  document.getElementById('staff-assign-user').value = String(user.user_id);
  document.getElementById('staff-assign-title').textContent = `Assign a vault post to ${user.full_legal_name}`;
  if (user.branch_id) document.getElementById('staff-assign-branch').value = String(user.branch_id);
  const today = state.staff?.today;
  if (today) {
    document.getElementById('staff-assign-start').value = today;
    document.getElementById('staff-assign-end').value = addIsoDays(today, 13);
  }
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function placeText(branch) {
  const parts = [branch.province, branch.location_name].filter(Boolean);
  return parts.join(' · ');
}

async function renderBranches() {
  const panel = document.getElementById('branch-panel');
  if (!panel) return;
  const show = state.me?.system_role === 'AUDITOR' || state.me?.can_act_as || state.me?.branch_scoped;
  if (!show) {
    panel.hidden = true;
    state.branches = null;
    return;
  }
  panel.hidden = false;
  const error = document.getElementById('branch-error');
  error.textContent = '';
  let register;
  try {
    register = await api('/api/branches');
  } catch (err) {
    error.textContent = err.message;
    document.getElementById('branch-list').replaceChildren();
    document.getElementById('branch-add').hidden = true;
    document.getElementById('branch-edit').hidden = true;
    return;
  }
  state.branches = register;
  document.getElementById('branch-copy').textContent = register.can_manage
    ? 'Add a branch, correct its name and code, or assign staff to it. A closed branch can be reopened, or closed for good. The list includes branches published by First National Bank Zambia.'
    : register.can_manage_own
      ? 'Close this branch, or reopen it. Closing it for good stays with the master admin.'
      : 'The branch vault assigned to you, and the staff attached to it.';
  document.getElementById('branch-add').hidden = !register.can_manage;
  document.getElementById('branch-edit').hidden = true;
  const host = document.getElementById('branch-list');
  host.replaceChildren();
  const openBranches = register.branches.filter((branch) => branch.is_active).length;
  setFoldCount('branch-count', openBranches === 1 ? '1 open' : `${openBranches} open`);
  if (!register.branches.length) {
    const empty = document.createElement('p');
    empty.className = 'staff-meta';
    empty.textContent = 'No branches are on this bank yet.';
    host.appendChild(empty);
    return;
  }
  for (const branch of register.branches) {
    const card = document.createElement('article');
    card.className = `staff-card${branch.is_active ? '' : ' is-removed'}`;
    const title = document.createElement('h4');
    title.textContent = branch.branch_name;
    const code = document.createElement('p');
    code.className = 'staff-meta';
    const where = placeText(branch);
    code.textContent = where ? `${branch.branch_code} · ${where}` : branch.branch_code;
    const people = document.createElement('p');
    people.className = 'staff-meta';
    if (branch.permanently_closed) {
      people.textContent = 'Closed for good.';
    } else if (!branch.is_active) {
      people.textContent = register.can_manage_own
        ? 'Closed. Reopen it when the branch should trade again.'
        : 'Closed. Reopen it, or close it for good.';
    } else if (!branch.staff.length) {
      people.textContent = 'No staff assigned.';
    } else {
      const names = branch.staff.map((person) => person.full_legal_name);
      people.textContent = names.length === 1
        ? names[0]
        : `${names.length} people · ${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}`;
    }
    const printerLine = document.createElement('p');
    printerLine.className = 'staff-meta';
    printerLine.textContent = branch.printer_target
      ? `Printer ${branch.printer_target}`
      : 'No branch printer set.';
    card.append(title, code, people, printerLine);
    if (register.can_manage && branch.is_active) {
      const choices = (register.assignable || []).filter((person) => person.branch_id !== branch.branch_id);
      if (choices.length) {
        const row = document.createElement('div');
        row.className = 'branch-assign';
        const select = document.createElement('select');
        select.setAttribute('aria-label', `Assign a person to ${branch.branch_name}`);
        for (const person of choices) {
          const option = document.createElement('option');
          option.value = String(person.user_id);
          option.textContent = person.full_legal_name;
          select.appendChild(option);
        }
        const assign = document.createElement('button');
        assign.type = 'button';
        assign.textContent = 'Assign to this branch';
        assign.addEventListener('click', () => assignPersonToBranch(branch, select.value));
        row.append(select, assign);
        card.appendChild(row);
      }
      const actions = document.createElement('div');
      actions.className = 'staff-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'staff-quiet';
      edit.textContent = 'Correct details';
      edit.addEventListener('click', () => openBranchEdit(branch));
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'staff-quiet';
      close.textContent = 'Close branch';
      close.addEventListener('click', () => closeBranchDesk(branch));
      actions.append(edit, close);
      card.appendChild(actions);
    } else if (register.can_manage_own && branch.is_active) {
      const actions = document.createElement('div');
      actions.className = 'staff-actions';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'staff-quiet';
      close.textContent = 'Close branch';
      close.addEventListener('click', () => closeBranchDesk(branch));
      actions.appendChild(close);
      card.appendChild(actions);
    } else if (register.can_manage && !branch.permanently_closed) {
      const actions = document.createElement('div');
      actions.className = 'staff-actions';
      const reopen = document.createElement('button');
      reopen.type = 'button';
      reopen.textContent = 'Reopen branch';
      reopen.addEventListener('click', () => reopenBranchDesk(branch));
      const permanent = document.createElement('button');
      permanent.type = 'button';
      permanent.className = 'staff-quiet';
      permanent.textContent = 'Close permanently';
      permanent.addEventListener('click', () => {
        actions.replaceChildren();
        const warning = document.createElement('p');
        warning.className = 'staff-meta';
        warning.textContent = 'This cannot be reopened.';
        const yes = document.createElement('button');
        yes.type = 'button';
        yes.textContent = 'Close for good';
        yes.addEventListener('click', () => permanentlyCloseBranch(branch));
        const no = document.createElement('button');
        no.type = 'button';
        no.className = 'staff-quiet';
        no.textContent = 'Keep it closed';
        no.addEventListener('click', () => renderBranches());
        actions.append(warning, yes, no);
      });
      actions.append(reopen, permanent);
      card.appendChild(actions);
    } else if (register.can_manage_own && !branch.permanently_closed && !branch.is_active) {
      const actions = document.createElement('div');
      actions.className = 'staff-actions';
      const reopen = document.createElement('button');
      reopen.type = 'button';
      reopen.textContent = 'Reopen branch';
      reopen.addEventListener('click', () => reopenBranchDesk(branch));
      actions.appendChild(reopen);
      card.appendChild(actions);
    }
    host.appendChild(card);
  }
}

function openBranchEdit(branch) {
  document.getElementById('branch-note').textContent = '';
  document.getElementById('branch-edit-error').textContent = '';
  const form = document.getElementById('branch-edit');
  form.hidden = false;
  document.getElementById('branch-edit-id').value = String(branch.branch_id);
  document.getElementById('branch-edit-title').textContent = `Correct ${branch.branch_name}`;
  document.getElementById('branch-edit-name').value = branch.branch_name;
  document.getElementById('branch-edit-code').value = branch.branch_code;
  document.getElementById('branch-edit-province').value = branch.province || '';
  document.getElementById('branch-edit-location').value = branch.location_name || '';
  const printer = document.getElementById('branch-edit-printer');
  if (printer) printer.value = branch.printer_target || '';
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function assignPersonToBranch(branch, userId) {
  const error = document.getElementById('branch-error');
  const note = document.getElementById('branch-note');
  error.textContent = '';
  note.textContent = '';
  try {
    const saved = await api(`/api/branches/${branch.branch_id}/staff`, {
      method: 'POST',
      body: JSON.stringify({ user_id: Number(userId) }),
    });
    note.textContent = `${saved.full_legal_name} is assigned to ${branch.branch_name}.`;
    await enterDesk(state.businessDate || undefined);
  } catch (err) {
    error.textContent = err.message;
  }
}

async function closeBranchDesk(branch) {
  const error = document.getElementById('branch-error');
  const note = document.getElementById('branch-note');
  error.textContent = '';
  note.textContent = '';
  try {
    await api(`/api/branches/${branch.branch_id}`, { method: 'DELETE' });
    note.textContent = `${branch.branch_name} is closed.`;
    await enterDesk(state.businessDate || undefined);
  } catch (err) {
    error.textContent = err.message;
  }
}

async function permanentlyCloseBranch(branch) {
  const error = document.getElementById('branch-error');
  const note = document.getElementById('branch-note');
  error.textContent = '';
  note.textContent = '';
  try {
    await api(`/api/branches/${branch.branch_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ permanently_closed: true }),
    });
    note.textContent = `${branch.branch_name} is closed for good.`;
    await enterDesk(state.businessDate || undefined);
  } catch (err) {
    error.textContent = err.message;
  }
}

async function reopenBranchDesk(branch) {
  const error = document.getElementById('branch-error');
  const note = document.getElementById('branch-note');
  error.textContent = '';
  note.textContent = '';
  try {
    await api(`/api/branches/${branch.branch_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active: true }),
    });
    note.textContent = `${branch.branch_name} is open again.`;
    await enterDesk(state.businessDate || undefined);
  } catch (err) {
    error.textContent = err.message;
  }
}

async function renderRoles() {
  const panel = document.getElementById('role-panel');
  if (!panel) return;
  if (!state.me?.can_act_as) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const error = document.getElementById('role-error');
  error.textContent = '';
  let catalogue;
  try {
    catalogue = await api('/api/roles');
  } catch (err) {
    error.textContent = err.message;
    document.getElementById('role-list').replaceChildren();
    document.getElementById('role-add').hidden = true;
    return;
  }
  document.getElementById('role-copy').textContent = 'Built-in roles stay, including Head Teller. Add a role when a branch needs another reader, administrator, or manager. Remove one only when nobody holds it.';
  document.getElementById('role-add').hidden = !catalogue.can_manage;
  const host = document.getElementById('role-list');
  host.replaceChildren();
  const roles = catalogue.roles || [];
  setFoldCount('role-count', roles.length === 1 ? '1 role' : `${roles.length} roles`);
  for (const role of roles) {
    const card = document.createElement('article');
    card.className = 'staff-card';
    const title = document.createElement('h4');
    title.textContent = role.label;
    const meta = document.createElement('p');
    meta.className = 'staff-meta';
    const held = role.holders === 1 ? '1 person' : `${role.holders} people`;
    meta.textContent = role.builtin ? `Built in · ${held}` : `${role.tier_label} · ${held}`;
    card.append(title, meta);
    if (!role.builtin && catalogue.can_manage) {
      const row = document.createElement('div');
      row.className = 'role-rename';
      const input = document.createElement('input');
      input.value = role.label;
      input.maxLength = 80;
      input.setAttribute('aria-label', `Name for ${role.label}`);
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'staff-quiet';
      save.textContent = 'Save name';
      save.addEventListener('click', () => renameDeskRole(role, input.value));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'staff-quiet';
      remove.textContent = 'Remove';
      remove.disabled = role.holders > 0;
      remove.addEventListener('click', () => removeDeskRole(role));
      row.append(input, save, remove);
      card.appendChild(row);
    }
    host.appendChild(card);
  }
}

async function renameDeskRole(role, name) {
  const error = document.getElementById('role-error');
  const note = document.getElementById('role-note');
  error.textContent = '';
  note.textContent = '';
  try {
    const saved = await api(`/api/roles/${encodeURIComponent(role.code)}`, {
      method: 'PATCH',
      body: JSON.stringify({ display_name: name }),
    });
    note.textContent = `${saved.label} is the name on the desk.`;
    await enterDesk(state.businessDate || undefined);
  } catch (err) {
    error.textContent = err.message;
  }
}

async function removeDeskRole(role) {
  const error = document.getElementById('role-error');
  const note = document.getElementById('role-note');
  error.textContent = '';
  note.textContent = '';
  try {
    await api(`/api/roles/${encodeURIComponent(role.code)}`, { method: 'DELETE' });
    note.textContent = `${role.label} is removed.`;
    await enterDesk(state.businessDate || undefined);
  } catch (err) {
    error.textContent = err.message;
  }
}

async function renderStaff() {
  const panel = document.getElementById('staff-panel');
  if (!panel) return;
  const show = state.me?.system_role === 'AUDITOR' || state.me?.can_act_as || state.me?.branch_scoped;
  if (!show) {
    panel.hidden = true;
    state.staff = null;
    return;
  }
  panel.hidden = false;
  const error = document.getElementById('staff-error');
  error.textContent = '';
  let register;
  try {
    register = await api('/api/staff');
  } catch (err) {
    error.textContent = err.message;
    document.getElementById('staff-list').replaceChildren();
    document.getElementById('staff-add').hidden = true;
    hideStaffEditors();
    return;
  }
  state.staff = register;
  document.getElementById('staff-copy').textContent = register.can_manage
    ? 'Add a person, assign their branch and role, put them on a vault post, or remove them from the desk. Branch Manager and Branch Administrator each see one branch vault.'
    : register.can_edit_roles
      ? 'Change the role of tellers and branch roles already on this branch.'
      : 'Who holds this branch, and the role each person has.';
  document.getElementById('staff-add').hidden = !register.can_manage;
  hideStaffEditors();
  fillStaffChoices();
  renderStaffList();
}

async function removeStaffMember(user) {
  const error = document.getElementById('staff-error');
  const note = document.getElementById('staff-note');
  error.textContent = '';
  note.textContent = '';
  try {
    await api(`/api/staff/${user.user_id}`, { method: 'DELETE' });
    note.textContent = `${user.full_legal_name} is removed from the desk.`;
    await enterDesk(state.businessDate || undefined);
  } catch (err) {
    error.textContent = err.message;
  }
}

async function restoreStaffMember(user) {
  const error = document.getElementById('staff-error');
  const note = document.getElementById('staff-note');
  error.textContent = '';
  note.textContent = '';
  try {
    await api(`/api/staff/${user.user_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active: true }),
    });
    note.textContent = `${user.full_legal_name} is back on the desk.`;
    await enterDesk(state.businessDate || undefined);
  } catch (err) {
    error.textContent = err.message;
  }
}

function canPostEntries() {
  const role = state.me?.system_role;
  if (role === 'VAULT_CUSTODIAN' || role === 'HEAD_TELLER_COORDINATOR') return true;
  if (role === 'IT_SUPER_ADMIN' && (state.me.break_glass || state.me.can_act_as)) return true;
  return false;
}

function canAmendBook(view) {
  if (view?.book?.status !== 'OPEN') return false;
  if (state.me?.system_role === 'VAULT_CUSTODIAN') return true;
  return Boolean(state.me?.can_act_as);
}

function prettyDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function renderBookDate() {
  const select = document.getElementById('book-date');
  select.replaceChildren();
  for (const item of state.dates) {
    const option = document.createElement('option');
    option.value = item.business_date;
    const stamp = item.status === 'OPEN' ? 'open' : 'closed';
    option.textContent = `${prettyDate(item.business_date)} · ${stamp}`;
    select.appendChild(option);
  }
  if (state.businessDate) select.value = state.businessDate;
}

function rosterInitials() {
  const custodians = state.directory.filter((user) => user.system_role === 'VAULT_CUSTODIAN');
  const coord = state.directory.find((user) => user.system_role === 'HEAD_TELLER_COORDINATOR');
  return {
    c1: custodians[0]?.two_letter_initials || '',
    c2: custodians[1]?.two_letter_initials || '',
    coord: coord?.two_letter_initials || '',
  };
}

function renderEntry(view) {
  const panel = document.getElementById('entry-panel');
  const form = document.getElementById('entry-form');
  const note = document.getElementById('entry-note');
  const error = document.getElementById('entry-error');
  error.textContent = '';
  if (!view) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const open = view.book.status === 'OPEN';
  const allowed = canPostEntries();
  if (!open) {
    form.hidden = true;
    note.textContent = 'This book is closed. Choose the open date to write a line.';
    return;
  }
  if (!allowed) {
    form.hidden = true;
    note.textContent = 'This role cannot write a line. Sign in as the master admin, or open the desk as a vault custodian or the head teller.';
    return;
  }
  form.hidden = false;
  state.amendingLine = null;
  document.getElementById('entry-title').textContent = 'Write a line';
  document.getElementById('entry-submit').textContent = 'Post the line';
  document.getElementById('entry-cancel').hidden = true;
  document.getElementById('entry-flow').disabled = false;
  const carry = view.carry_label || 'In Vault';
  note.textContent = view.square_required
    ? `Amounts, not pieces. Bal c/d is written only after ${carry}.`
    : 'Amounts, not pieces. The line is appended to this open book.';
  if (canAmendBook(view)) {
    note.textContent += ' Amend any line while this book is open. A later Bal c/d follows the corrected position.';
  }
  document.getElementById('entry-square').hidden = !view.square_required;
  fillEntryFlow();
  document.getElementById('entry-label').value = document.getElementById('entry-flow').value;
  const initials = rosterInitials();
  document.getElementById('entry-c1').value = initials.c1;
  document.getElementById('entry-c2').value = initials.c2;
  document.getElementById('entry-coord').value = initials.coord;
  const host = document.getElementById('entry-amounts');
  host.replaceChildren();
  for (const group of view.layout.groups) {
    const denoms = group.columns.filter((column) => column.kind === 'DENOMINATION');
    if (!denoms.length) continue;
    const block = document.createElement('div');
    block.className = 'entry-group';
    const title = document.createElement('h4');
    title.textContent = group.label || 'Denominations';
    const grid = document.createElement('div');
    grid.className = 'entry-amounts-grid';
    for (const column of denoms) {
      const input = document.createElement('input');
      input.inputMode = 'decimal';
      input.autocomplete = 'off';
      input.placeholder = '0.00';
      input.dataset.channel = column.channel;
      input.dataset.code = column.code;
      input.setAttribute('aria-label', `${group.label} ${column.header}`);
      const caption = document.createElement('span');
      caption.className = 'entry-denom';
      caption.textContent = column.header;
      const label = document.createElement('label');
      label.append(caption, input);
      grid.appendChild(label);
    }
    block.append(title, grid);
    host.appendChild(block);
  }
}

function fillEntryFlow(selected) {
  const flow = document.getElementById('entry-flow');
  const options = (state.movementOptions || []).filter((option) => option.is_active);
  flow.replaceChildren();
  for (const option of options) {
    const item = document.createElement('option');
    item.value = option.label;
    item.textContent = option.label;
    item.dataset.flow = option.flow_direction;
    flow.appendChild(item);
  }
  if (selected && [...flow.options].some((option) => option.value === selected)) flow.value = selected;
}

function entryMovement() {
  const flow = document.getElementById('entry-flow');
  const choice = flow.selectedOptions[0];
  const reference = document.getElementById('entry-label').value.trim();
  return {
    flow_direction: choice ? choice.dataset.flow : 'IN',
    accounting_label: flow.value,
    line_reference: reference,
  };
}

function startAmend(row) {
  state.amendingLine = row.line_number;
  state.amendingLabel = row.accounting_label;
  state.amendingFlow = row.flow_direction;
  document.getElementById('entry-title').textContent = `Amend line ${row.line_number}`;
  document.getElementById('entry-submit').textContent = 'Save amendment';
  document.getElementById('entry-cancel').hidden = false;
  document.getElementById('entry-square').hidden = true;
  document.getElementById('entry-error').textContent = '';
  const flow = document.getElementById('entry-flow');
  if (row.flow_direction === 'BAL') {
    flow.disabled = true;
  } else {
    flow.disabled = false;
    const named = (state.movementOptions || []).find((option) => option.label === row.accounting_label || option.label === row.in_or_out);
    if (named) flow.value = named.label;
    else {
      const same = (state.movementOptions || []).find((option) => option.flow_direction === row.flow_direction && option.is_active);
      if (same) flow.value = same.label;
    }
  }
  document.getElementById('entry-label').value = row.reference || row.accounting_label || '';
  document.getElementById('entry-c1').value = row.custodian_one_initials || '';
  document.getElementById('entry-c2').value = row.custodian_two_initials || '';
  document.getElementById('entry-coord').value = row.teller_coord_initials || '';
  for (const input of document.querySelectorAll('#entry-amounts input')) {
    const raw = row.amounts?.[input.dataset.channel]?.[input.dataset.code];
    input.value = raw && raw !== '0.00' ? raw : '';
  }
  document.getElementById('entry-note').textContent = row.flow_direction === 'BAL'
    ? 'This balance line keeps its Bal label. Amounts have to match the running position.'
    : 'Saving rewrites a later Bal c/d so the sheet still squares.';
  document.getElementById('entry-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function entryPayload() {
  const amounts = {};
  for (const input of document.querySelectorAll('#entry-amounts input')) {
    const raw = input.value.trim();
    if (!raw || raw === '0' || raw === '0.00') continue;
    if (!amounts[input.dataset.channel]) amounts[input.dataset.channel] = {};
    amounts[input.dataset.channel][input.dataset.code] = raw;
  }
  const movement = state.amendingFlow === 'BAL'
    ? {
      flow_direction: 'BAL',
      accounting_label: state.amendingLabel,
      line_reference: document.getElementById('entry-label').value.trim(),
    }
    : entryMovement();
  return {
    ...movement,
    custodian_one_initials: document.getElementById('entry-c1').value.trim(),
    custodian_two_initials: document.getElementById('entry-c2').value.trim(),
    teller_coord_initials: document.getElementById('entry-coord').value.trim(),
    amounts,
  };
}

async function enterDesk(date) {
  const keepClass = state.book?.book?.book_class;
  state.me = await api('/api/me');
  const query = date ? `?date=${encodeURIComponent(date)}` : '';
  const desk = await api(`/api/books${query}`);
  state.books = desk.books;
  state.businessDate = desk.businessDate || '';
  state.dates = desk.dates || [];
  state.rotation = desk.rotation;
  state.directory = (await api('/api/directory')).users;
  loginView.hidden = true;
  deskView.hidden = false;
  document.body.classList.remove('is-gate');
  document.getElementById('sign-out').hidden = false;
  document.getElementById('bank-name').textContent = state.me.bank_name;
  document.getElementById('session-user').textContent = `${state.me.full_legal_name} · ${state.me.role_label || state.me.system_role}`;
  const banner = document.getElementById('maintenance-banner');
  if (state.me.break_glass) {
    banner.hidden = false;
    banner.textContent = `Break-glass maintenance window open until ${new Date(state.me.break_glass_expires_at).toLocaleString()}.`;
  } else {
    banner.hidden = true;
  }
  try {
    await renderEntraAdmin();
  } catch (_error) {
    const entra = document.getElementById('entra-admin');
    if (entra) entra.hidden = true;
  }
  renderActAs();
  try {
    await renderBranches();
  } catch (_error) {
    const branches = document.getElementById('branch-panel');
    if (branches) branches.hidden = true;
  }
  try {
    await renderStaff();
  } catch (_error) {
    const staff = document.getElementById('staff-panel');
    if (staff) staff.hidden = true;
  }
  try {
    await renderRoles();
  } catch (_error) {
    const roles = document.getElementById('role-panel');
    if (roles) roles.hidden = true;
  }
  renderCalendar(desk.calendar || {});
  renderRotation(desk.rotation || { posts: [] });
  renderFlags(desk.carryFlags);
  renderHandover(desk.rotation || { due: [] }, desk.deskOpen);
  try {
    const catalogue = await api('/api/movement-options');
    state.movementOptions = catalogue.options;
    state.logoLabel = catalogue.logo_label || '';
    state.logoFile = catalogue.logo_file || '';
  } catch (_error) {
    state.movementOptions = state.movementOptions || [];
  }
  renderMovementOptions();
  const logo = document.getElementById('brand-logo');
  if (logo && document.activeElement !== logo) logo.value = state.logoLabel || '';
  const logoFile = document.getElementById('brand-logo-file');
  if (logoFile && document.activeElement !== logoFile) logoFile.value = state.logoFile || '';
    try {
    await renderSurprise(desk);
  } catch (error) {
    document.getElementById('surprise-review').textContent = error.message;
  }
  try {
    await renderAudit();
  } catch (error) {
    const audit = document.getElementById('audit-panel');
    if (audit) audit.textContent = error.message;
  }
  try {
    renderVaultSheet(desk);
  } catch (error) {
    const vault = document.getElementById('vault-sheet-panel');
    if (vault) vault.textContent = error.message;
  }
  const ledger = document.getElementById('ledger-panel');
  ledger.hidden = !desk.deskOpen;
  if (!desk.deskOpen) {
    document.getElementById('desk-status').textContent = `Handover required before ${desk.businessDate} can open.`;
    return;
  }
  renderTabs();
  renderBookDate();
  renderSignoff();
  const next = state.books.find((book) => book.book_class === keepClass) || state.books[0];
  if (next) await openBook(next.book_id);
  else {
    renderEntry(null);
    document.getElementById('desk-status').textContent = desk.businessDate
      ? `No treasury book is open for ${desk.businessDate}.`
      : 'No treasury book has been opened yet.';
  }
}

function showLogin() {
  state.token = '';
  sessionStorage.removeItem('nodevault_token');
  loginView.hidden = false;
  deskView.hidden = true;
  document.getElementById('acting-banner').hidden = true;
  document.body.classList.add('is-gate');
  document.getElementById('sign-out').hidden = true;
  refreshGate().catch(() => {});
}

async function submitSignIn(form, error, request) {
  const button = form.querySelector('button[type="submit"]');
  const label = button.textContent;
  error.textContent = '';
  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    await request();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

document.getElementById('forgot-password').addEventListener('click', () => {
  const note = document.getElementById('forgot-note');
  note.hidden = !note.hidden;
  if (!note.hidden) note.focus?.();
});

document.getElementById('toggle-password').addEventListener('click', () => {
  const input = document.getElementById('password');
  const button = document.getElementById('toggle-password');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  button.textContent = show ? 'Hide' : 'Show';
  button.setAttribute('aria-pressed', show ? 'true' : 'false');
});

document.getElementById('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById('password-error');
  await submitSignIn(form, error, async () => {
    const result = await api('/api/auth/login/password', {
      method: 'POST',
      body: JSON.stringify({
        email: document.getElementById('password-email').value,
        password: document.getElementById('password').value,
      }),
    });
    state.token = result.token;
    sessionStorage.setItem('nodevault_token', result.token);
    await enterDesk();
  });
});

document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById('login-error');
  await submitSignIn(form, error, async () => {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: document.getElementById('email').value,
        assertion: document.getElementById('assertion').value,
      }),
    });
    state.token = result.token;
    sessionStorage.setItem('nodevault_token', result.token);
    await enterDesk();
  });
});

document.getElementById('sign-out').addEventListener('click', showLogin);

document.getElementById('entry-flow').addEventListener('change', () => {
  const input = document.getElementById('entry-label');
  const current = input.value.trim();
  const known = new Set(['', ...(state.movementOptions || []).map((option) => option.label)]);
  if (known.has(current)) input.value = document.getElementById('entry-flow').value;
});

document.getElementById('movement-add').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('movement-error');
  error.textContent = '';
  try {
    await api('/api/movement-options', {
      method: 'POST',
      body: JSON.stringify({
        label: document.getElementById('movement-label').value,
        flow_direction: document.getElementById('movement-flow').value,
      }),
    });
    document.getElementById('movement-label').value = '';
    const catalogue = await api('/api/movement-options');
    state.movementOptions = catalogue.options;
    renderMovementOptions();
    fillEntryFlow();
  } catch (err) {
    error.textContent = err.message;
  }
});

document.getElementById('brand-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const note = document.getElementById('brand-note');
  note.textContent = '';
  try {
    const body = { logo_label: document.getElementById('brand-logo').value };
    const file = document.getElementById('brand-logo-file').value.trim();
    if (file) body.logo_file = file;
    const saved = await api('/api/brand', {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    state.logoLabel = saved.logo_label;
    note.textContent = `Prints use ${saved.logo_label}. The logo file is not shown on this desk.`;
  } catch (err) {
    note.textContent = err.message;
  }
});

document.getElementById('takeover-slip-close').addEventListener('click', () => {
  document.getElementById('takeover-slip').close();
});
document.getElementById('surprise-slip-close').addEventListener('click', () => {
  document.getElementById('surprise-slip').close();
});
document.getElementById('takeover-slip-print').addEventListener('click', () => {
  sendSlipToPrinter(document.getElementById('takeover-slip').dataset.printPath);
});
document.getElementById('surprise-slip-print').addEventListener('click', () => {
  sendSlipToPrinter(document.getElementById('surprise-slip').dataset.printPath);
});

document.getElementById('book-date').addEventListener('change', () => {
  enterDesk(document.getElementById('book-date').value).catch((error) => {
    document.getElementById('desk-status').textContent = error.message;
  });
});

document.getElementById('entry-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('entry-error');
  const button = document.getElementById('entry-submit');
  error.textContent = '';
  const payload = entryPayload();
  const amending = state.amendingLine;
  if (payload.flow_direction !== 'BAL' && !Object.keys(payload.amounts).length) {
    error.textContent = 'Enter an amount on at least one denomination.';
    return;
  }
  button.disabled = true;
  try {
    if (amending) {
      await api(`/api/books/${state.book.book.book_id}/entries/${amending}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      await openBook(state.book.book.book_id, { focusLine: amending });
      document.getElementById('desk-status').textContent = `Line ${amending} is amended.`;
    } else {
      const result = await api(`/api/books/${state.book.book.book_id}/entries`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      await openBook(state.book.book.book_id, { focusLine: result.lineNumber });
      document.getElementById('desk-status').textContent = `Line ${result.lineNumber} is on the sheet.`;
    }
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById('entry-cancel').addEventListener('click', () => {
  renderEntry(state.book);
});

document.getElementById('entry-square').addEventListener('click', async () => {
  const error = document.getElementById('entry-error');
  const button = document.getElementById('entry-square');
  error.textContent = '';
  button.disabled = true;
  try {
    const result = await api(`/api/books/${state.book.book.book_id}/square`, {
      method: 'POST',
      body: JSON.stringify(entryPayload()),
    });
    await openBook(state.book.book.book_id, { focusLine: result.lineNumber });
    document.getElementById('desk-status').textContent = `Bal c/d is line ${result.lineNumber}. The sheet squares.`;
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById('open-close').addEventListener('click', () => {
  const users = state.directory;
  const custodians = users.filter((user) => user.system_role === 'VAULT_CUSTODIAN');
  fillSelect(document.getElementById('c1-id'), custodians, 'VAULT_CUSTODIAN');
  fillSelect(document.getElementById('c2-id'), custodians, 'VAULT_CUSTODIAN');
  if (custodians[1]) document.getElementById('c2-id').value = custodians[1].user_id;
  fillSelect(
    document.getElementById('coord-id'),
    users.filter((user) => user.system_role === 'HEAD_TELLER_COORDINATOR'),
    'HEAD_TELLER_COORDINATOR',
  );
  const position = state.book?.position || {};
  const bits = Object.entries(position).filter((entry) => entry[0] !== 'error').map(([currency, value]) => `${currency} ${value.display}`);
  document.getElementById('close-summary').textContent = bits.join(' · ');
  document.getElementById('close-error').textContent = '';
  document.getElementById('close-dialog').showModal();
});

document.getElementById('close-cancel').addEventListener('click', () => {
  document.getElementById('close-dialog').close();
});

document.getElementById('close-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('close-error');
  error.textContent = '';
  const position = {};
  for (const [currency, value] of Object.entries(state.book.position)) {
    if (currency === 'error') continue;
    position[currency] = value.decimal;
  }
  try {
    const result = await api(`/api/books/${state.book.book.book_id}/close`, {
      method: 'POST',
      body: JSON.stringify({
        c1_id: Number(document.getElementById('c1-id').value),
        c1_pin: document.getElementById('c1-pin').value,
        c2_id: Number(document.getElementById('c2-id').value),
        c2_pin: document.getElementById('c2-pin').value,
        coord_id: Number(document.getElementById('coord-id').value),
        coord_pin: document.getElementById('coord-pin').value,
        operating_date: state.book.book.business_date,
        calculated_matrix_cash_total: position,
      }),
    });
    document.getElementById('close-dialog').close();
    const failed = (result.dispatch || []).filter((item) => item.status === 'FAILED');
    document.getElementById('desk-status').textContent = failed.length
      ? 'Book locked. Printer or email needs a retry; the close itself stands.'
      : 'Book locked. Closing sheet sent to the printer and both custodians.';
    await openBook(state.book.book.book_id);
  } catch (err) {
    error.textContent = err.message;
  }
});

document.getElementById('show-break-glass').addEventListener('click', () => {
  document.getElementById('glass-error').textContent = '';
  document.getElementById('glass-dialog').showModal();
});
document.getElementById('glass-cancel').addEventListener('click', () => {
  document.getElementById('glass-dialog').close();
});
document.getElementById('glass-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('glass-error');
  error.textContent = '';
  try {
    const result = await api('/api/auth/break-glass', {
      method: 'POST',
      body: JSON.stringify({
        admin_email: document.getElementById('glass-admin-email').value,
        admin_assertion: document.getElementById('glass-admin-assertion').value,
        custodian_one_email: document.getElementById('glass-c1-email').value,
        custodian_one_assertion: document.getElementById('glass-c1-assertion').value,
        custodian_two_email: document.getElementById('glass-c2-email').value,
        custodian_two_assertion: document.getElementById('glass-c2-assertion').value,
      }),
    });
    state.token = result.token;
    sessionStorage.setItem('nodevault_token', result.token);
    document.getElementById('glass-dialog').close();
    await enterDesk();
  } catch (err) {
    error.textContent = err.message;
  }
});

function applyLedgerTheme(theme) {
  const margin = document.querySelector('.ledger-margin');
  if (!margin) return;
  const next = theme === 'desk' ? 'desk' : 'paper';
  margin.dataset.theme = next;
  const select = document.getElementById('ledger-theme');
  if (select && select.value !== next) select.value = next;
  sessionStorage.setItem('ledger-theme', next);
}

const themeSelect = document.getElementById('ledger-theme');
if (themeSelect) {
  applyLedgerTheme(sessionStorage.getItem('ledger-theme') || 'paper');
  themeSelect.addEventListener('change', () => applyLedgerTheme(themeSelect.value));
}

function setFoldCount(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}

function setFold(button, body, open) {
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (body) body.hidden = !open;
  const word = button.querySelector('.fold-word');
  if (word) word.textContent = open ? 'Hide' : 'Show';
}

function bindFolds() {
  for (const button of document.querySelectorAll('.fold-toggle')) {
    const body = document.getElementById(button.getAttribute('aria-controls'));
    const key = `fold:${button.getAttribute('aria-controls')}`;
    setFold(button, body, sessionStorage.getItem(key) !== 'closed');
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      setFold(button, body, open);
      sessionStorage.setItem(key, open ? 'open' : 'closed');
    });
  }
}

bindFolds();

function turnSheetPage(step) {
  if (!state.book) return;
  const pages = sheetPageCount(lastSheetLine(state.book.rows));
  const next = Math.min(pages, Math.max(1, state.sheetPage + step));
  if (next === state.sheetPage) return;
  state.sheetPage = next;
  renderSpread(state.book);
  const title = document.getElementById('sheet-title');
  const bar = document.getElementById('sheet-suspend');
  if (title && bar) {
    const top = title.getBoundingClientRect().top + window.scrollY - bar.getBoundingClientRect().height - 8;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
}

document.getElementById('sheet-prev').addEventListener('click', () => turnSheetPage(-1));
document.getElementById('sheet-next').addEventListener('click', () => turnSheetPage(1));

const ledgerPanel = document.getElementById('ledger-panel');
const expandButton = document.getElementById('sheet-expand');
const fullscreenButton = document.getElementById('sheet-fullscreen');

function activeFullscreen() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function setSheetExpanded(on) {
  ledgerPanel.classList.toggle('is-expanded', on);
  document.body.classList.toggle('sheet-expanded', on);
  expandButton.textContent = on ? 'Collapse' : 'Expand';
  expandButton.setAttribute('aria-pressed', on ? 'true' : 'false');
  if (typeof synchronizeHorizontalMatrixLayout === 'function') synchronizeHorizontalMatrixLayout();
  syncSuspendedSheet();
}

function syncFullscreenButton() {
  const on = activeFullscreen() === ledgerPanel;
  fullscreenButton.textContent = on ? 'Exit full screen' : 'Full screen';
  fullscreenButton.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function syncSheetHead() {
  const pin = document.getElementById('sheet-head-pin');
  const scroller = document.querySelector('.ledger-scroll');
  const title = document.getElementById('sheet-title');
  const thead = document.querySelector('#ledger thead');
  const bar = document.getElementById('sheet-suspend');
  if (!pin || !scroller || !title || !thead || !bar) return;
  const barBox = bar.getBoundingClientRect();
  const titleBox = title.getBoundingClientRect();
  const theadBox = thead.getBoundingClientRect();
  const scrollerBox = scroller.getBoundingClientRect();
  const headerHeight = theadBox.bottom - titleBox.top;
  const stuck = titleBox.top <= barBox.bottom + 0.5 && scrollerBox.bottom > barBox.bottom + headerHeight;
  pin.hidden = !stuck;
  title.classList.toggle('is-covered', stuck);
  thead.classList.toggle('is-covered', stuck);
  if (!stuck) return;
  pin.style.top = `${barBox.bottom}px`;
  pin.style.left = `${scrollerBox.left}px`;
  pin.style.width = `${scroller.clientWidth}px`;
  pin.querySelector('.sheet-title').textContent = title.textContent;
  const theadCopy = pin.querySelector('thead');
  const stamp = `${title.textContent}|${thead.innerHTML.length}|${Math.round(theadBox.width)}`;
  if (pin.dataset.stamp !== stamp) {
    theadCopy.replaceChildren(...[...thead.children].map((row) => row.cloneNode(true)));
    pin.dataset.stamp = stamp;
  }
  const copyCells = [...theadCopy.querySelectorAll('th')];
  [...thead.querySelectorAll('th')].forEach((cell, index) => {
    const copy = copyCells[index];
    if (!copy) return;
    const width = cell.getBoundingClientRect().width;
    copy.style.boxSizing = 'border-box';
    copy.style.width = `${width}px`;
    copy.style.minWidth = `${width}px`;
    copy.style.maxWidth = `${width}px`;
  });
  const table = pin.querySelector('table');
  const sourceTable = document.getElementById('ledger');
  const sourceBox = sourceTable.getBoundingClientRect();
  const borderInset = sourceBox.left - scrollerBox.left + scroller.scrollLeft;
  table.style.width = `${sourceBox.width}px`;
  table.style.transform = `translateX(${borderInset - scroller.scrollLeft}px)`;
}

function syncSuspendedSheet() {
  const bar = document.getElementById('sheet-suspend');
  if (!bar) return;
  bar.classList.toggle('is-stuck', bar.getBoundingClientRect().top <= 1);
  syncSheetHead();
}

expandButton.addEventListener('click', () => {
  setSheetExpanded(!ledgerPanel.classList.contains('is-expanded'));
});

fullscreenButton.addEventListener('click', async () => {
  try {
    if (activeFullscreen() === ledgerPanel) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      await exit.call(document);
    } else {
      const request = ledgerPanel.requestFullscreen || ledgerPanel.webkitRequestFullscreen;
      if (!request) throw new Error('unavailable');
      await request.call(ledgerPanel);
    }
  } catch (_error) {
    document.getElementById('desk-status').textContent = 'Full screen is not available in this browser. Expand still opens the sheet across the window.';
  }
});

document.addEventListener('fullscreenchange', syncFullscreenButton);
document.addEventListener('webkitfullscreenchange', syncFullscreenButton);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || activeFullscreen()) return;
  if (ledgerPanel.classList.contains('is-expanded')) setSheetExpanded(false);
});
window.addEventListener('scroll', syncSuspendedSheet, { passive: true });
ledgerPanel.addEventListener('scroll', syncSuspendedSheet, { passive: true });
document.querySelector('.ledger-scroll').addEventListener('scroll', syncSheetHead, { passive: true });
window.addEventListener('resize', syncSuspendedSheet);

function applyPublicConfig(config) {
  const passwordForm = document.getElementById('password-form');
  const entraFold = document.getElementById('entra-fold');
  const entraOn = config.entraEnabled !== false;
  passwordForm.hidden = !config.localLogin;
  entraFold.hidden = !entraOn;
  entraFold.open = entraOn && !config.localLogin;
  entraFold.classList.toggle('entra-primary', entraOn && !config.localLogin);
  const domain = config.enforcedDomain
    ? `@${config.enforcedDomain}`
    : 'each bank tenant domain';
  const sample = config.enforcedDomain ? `name@${config.enforcedDomain}` : 'name@bank';
  document.getElementById('password-email').placeholder = sample;
  document.getElementById('email').placeholder = sample;
  let hint = `Microsoft Entra sign-in is restricted to ${domain}.`;
  if (config.localLogin && entraOn) hint = `Password and Entra sign-in are both restricted to ${domain}.`;
  else if (config.localLogin) hint = `Password sign-in is restricted to ${domain}.`;
  document.getElementById('domain-hint').textContent = hint;
  document.getElementById('entra-hint').textContent = config.entraMode === 'mock'
    ? 'This deployment checks a mock assertion, not a live Microsoft token.'
    : 'Use your bank Microsoft Entra account.';
}

async function refreshGate() {
  const config = await api('/api/public-config');
  applyPublicConfig(config);
}

document.getElementById('act-as-open').addEventListener('click', async () => {
  const error = document.getElementById('act-as-error');
  const button = document.getElementById('act-as-open');
  error.textContent = '';
  button.disabled = true;
  try {
    const result = await api('/api/auth/act-as', {
      method: 'POST',
      body: JSON.stringify({ user_id: Number(document.getElementById('act-as-user').value) }),
    });
    state.token = result.token;
    sessionStorage.setItem('nodevault_token', result.token);
    await enterDesk();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

async function leaveSimulation(button) {
  button.disabled = true;
  try {
    const result = await api('/api/auth/act-as/return', { method: 'POST', body: '{}' });
    state.token = result.token;
    sessionStorage.setItem('nodevault_token', result.token);
    await enterDesk();
  } catch (err) {
    document.getElementById('act-as-error').textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

document.getElementById('acting-return').addEventListener('click', () => {
  leaveSimulation(document.getElementById('acting-return'));
});
document.getElementById('acting-exit').addEventListener('click', () => {
  leaveSimulation(document.getElementById('acting-exit'));
});

document.getElementById('entra-toggle').addEventListener('click', async () => {
  const button = document.getElementById('entra-toggle');
  if (state.me?.system_role !== 'IT_SUPER_ADMIN') {
    document.getElementById('entra-admin-copy').textContent = 'Return to Admin to change Microsoft Entra.';
    return;
  }
  const next = button.getAttribute('aria-pressed') !== 'true';
  button.disabled = true;
  try {
    await api('/api/auth/entra', {
      method: 'PUT',
      body: JSON.stringify({ enabled: next }),
    });
    await renderEntraAdmin();
    await refreshGate();
  } catch (err) {
    document.getElementById('entra-admin-copy').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById('branch-add').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('branch-add-error');
  const note = document.getElementById('branch-note');
  const button = document.getElementById('branch-add-submit');
  error.textContent = '';
  note.textContent = '';
  button.disabled = true;
  try {
    const created = await api('/api/branches', {
      method: 'POST',
      body: JSON.stringify({
        branch_name: document.getElementById('branch-name').value,
        branch_code: document.getElementById('branch-code').value,
        province: document.getElementById('branch-province').value,
        location_name: document.getElementById('branch-location').value,
      }),
    });
    document.getElementById('branch-add').reset();
    note.textContent = `${created.branch_name} is on the branch list.`;
    await enterDesk(state.businessDate || undefined);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById('branch-edit').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('branch-edit-error');
  const note = document.getElementById('branch-note');
  const button = document.getElementById('branch-edit-submit');
  error.textContent = '';
  note.textContent = '';
  button.disabled = true;
  try {
    const saved = await api(`/api/branches/${document.getElementById('branch-edit-id').value}`, {
      method: 'PATCH',
      body: JSON.stringify({
        branch_name: document.getElementById('branch-edit-name').value,
        branch_code: document.getElementById('branch-edit-code').value,
        province: document.getElementById('branch-edit-province').value,
        location_name: document.getElementById('branch-edit-location').value,
        printer_target: document.getElementById('branch-edit-printer').value,
      }),
    });
    note.textContent = `${saved.branch_name} is updated.`;
    await enterDesk(state.businessDate || undefined);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById('branch-edit-cancel').addEventListener('click', () => {
  document.getElementById('branch-edit').hidden = true;
  document.getElementById('branch-edit-error').textContent = '';
});

document.getElementById('role-add').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('role-add-error');
  const note = document.getElementById('role-note');
  const button = document.getElementById('role-add-submit');
  error.textContent = '';
  note.textContent = '';
  button.disabled = true;
  try {
    const created = await api('/api/roles', {
      method: 'POST',
      body: JSON.stringify({
        display_name: document.getElementById('role-name').value,
        power_tier: document.getElementById('role-tier').value,
      }),
    });
    document.getElementById('role-add').reset();
    note.textContent = `${created.label} is on the desk.`;
    await enterDesk(state.businessDate || undefined);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById('staff-add').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('staff-add-error');
  const note = document.getElementById('staff-note');
  const button = document.getElementById('staff-add-submit');
  error.textContent = '';
  note.textContent = '';
  button.disabled = true;
  const pin = document.getElementById('staff-pin').value.trim();
  try {
    const created = await api('/api/staff', {
      method: 'POST',
      body: JSON.stringify({
        full_legal_name: document.getElementById('staff-name').value,
        work_email: document.getElementById('staff-email').value,
        employee_id: document.getElementById('staff-employee').value,
        two_letter_initials: document.getElementById('staff-initials').value,
        system_role: document.getElementById('staff-role').value,
        branch_id: Number(document.getElementById('staff-branch').value),
        password: document.getElementById('staff-password').value,
        closing_pin: pin,
      }),
    });
    document.getElementById('staff-add').reset();
    note.textContent = `${created.full_legal_name} is on the register.`;
    await enterDesk(state.businessDate || undefined);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById('staff-edit').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('staff-edit-error');
  const note = document.getElementById('staff-note');
  const button = document.getElementById('staff-edit-submit');
  error.textContent = '';
  note.textContent = '';
  button.disabled = true;
  const pin = document.getElementById('staff-edit-pin').value.trim();
  const body = {
    system_role: document.getElementById('staff-edit-role').value,
  };
  if (state.staff?.can_manage) {
    body.branch_id = Number(document.getElementById('staff-edit-branch').value);
    if (pin) body.closing_pin = pin;
  }
  try {
    const saved = await api(`/api/staff/${document.getElementById('staff-edit-user').value}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    note.textContent = `${saved.full_legal_name} is updated.`;
    await enterDesk(state.businessDate || undefined);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById('staff-edit-cancel').addEventListener('click', () => {
  document.getElementById('staff-edit').hidden = true;
  document.getElementById('staff-edit-error').textContent = '';
});

document.getElementById('staff-assign').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('staff-assign-error');
  const note = document.getElementById('staff-note');
  const button = document.getElementById('staff-assign-submit');
  error.textContent = '';
  note.textContent = '';
  button.disabled = true;
  try {
    await api('/api/staff/assignments', {
      method: 'POST',
      body: JSON.stringify({
        user_id: Number(document.getElementById('staff-assign-user').value),
        post_code: document.getElementById('staff-assign-post').value,
        branch_id: Number(document.getElementById('staff-assign-branch').value),
        period_start: document.getElementById('staff-assign-start').value,
        period_end: document.getElementById('staff-assign-end').value,
      }),
    });
    note.textContent = 'The vault post is assigned.';
    await enterDesk(state.businessDate || undefined);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById('staff-assign-cancel').addEventListener('click', () => {
  document.getElementById('staff-assign').hidden = true;
  document.getElementById('staff-assign-error').textContent = '';
});

async function boot() {
  try {
    await refreshGate();
  } catch (_error) {
    document.getElementById('login-error').textContent = 'The desk configuration could not be read.';
  }
  if (!state.token) return;
  try {
    await enterDesk();
  } catch (_error) {
    showLogin();
  }
}

boot();
