const REQUIRED = ['KWACHA_TREASURY', 'FOREIGN_CURRENCY', 'BANCS_TREASURY'];
const state = {
  token: sessionStorage.getItem('nodevault_token') || '',
  me: null,
  books: [],
  book: null,
  directory: [],
  businessDate: '',
  dates: [],
  amendingLine: null,
};

const loginView = document.getElementById('login-view');
const deskView = document.getElementById('desk-view');

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
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
  if (!view.rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = flat.length;
    td.textContent = 'No lines on this book yet.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  for (const row of view.rows) {
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
    const card = document.createElement('article');
    const title = document.createElement('h3');
    title.textContent = person.system_role === 'HEAD_TELLER_COORDINATOR'
      ? 'Weekly teller coordinator'
      : 'Vault custodian';
    const name = document.createElement('p');
    name.textContent = person.full_legal_name;
    const id = document.createElement('p');
    id.textContent = `${person.employee_id} · ${person.two_letter_initials}`;
    const line = document.createElement('div');
    line.className = 'sig-line';
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

async function openBook(bookId) {
  const status = document.getElementById('desk-status');
  status.textContent = 'Pulling the vault book…';
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
    const card = document.createElement('article');
    card.className = 'rounded border border-gray-200 bg-white px-4 py-3 shadow-sm';
    const title = document.createElement('h3');
    title.className = 'text-sm font-semibold text-gray-900';
    title.textContent = post.label;
    const holder = document.createElement('p');
    holder.className = 'mt-2 text-sm text-gray-800';
    holder.textContent = post.current && !post.current.unassigned
      ? `${post.current.fullLegalName} | ${post.current.employeeId} (${post.current.initials})`
      : 'No holder for this period | -';
    const dates = document.createElement('p');
    dates.className = 'mt-1 text-sm text-gray-600';
    const span = post.current || post.next;
    dates.textContent = span ? `${span.periodStart} to ${span.periodEnd}` : '';
    const cadence = document.createElement('p');
    cadence.className = 'mt-2 text-sm text-gray-700';
    cadence.textContent = `Rotates: ${cadenceLabel(post)}`;
    card.append(title, holder, dates, cadence);
    host.appendChild(card);
  }
}

function field(labelText, control) {
  const label = document.createElement('label');
  label.textContent = labelText;
  label.appendChild(control);
  return label;
}

function renderCalendar(calendar) {
  const host = document.getElementById('calendar-panel');
  host.replaceChildren();
  const title = document.createElement('h3');
  title.className = 'mb-2 text-base font-semibold text-gray-900';
  title.textContent = 'Non-working days';
  host.append(title);
  if (calendar.nonWorking) {
    const note = document.createElement('p');
    note.className = 'mb-2 text-sm text-gray-600';
    note.textContent = `Today is not a working day (${calendar.nonWorking.name}). No new book opens.`;
    host.append(note);
  }

  const list = document.createElement('ul');
  list.className = 'grid grid-cols-1 gap-x-10 md:grid-cols-2';
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
    items.push({ date: closure.startDate, label: `${closure.reason} · ${span}`, kind: closure.scope });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
  if (!items.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No public holiday or closure in the next four months.';
    list.appendChild(empty);
  }
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'flex items-baseline gap-4 border-b border-gray-200 py-2 text-sm';
    const when = document.createElement('time');
    when.dateTime = item.date;
    when.className = 'w-28 shrink-0 font-mono text-[13px] text-gray-800';
    when.textContent = item.date;
    const text = document.createElement('span');
    text.className = 'text-gray-700';
    text.textContent = `${item.label} · ${item.kind}`;
    li.append(when, text);
    list.appendChild(li);
  }
  host.appendChild(list);

  if (!calendar.canManage) return;
  const forms = document.createElement('div');
  forms.className = 'mt-4 grid gap-4 border-t border-gray-200 pt-4 md:grid-cols-2';
  forms.append(closureForm(calendar), gazetteForm());
  const pending = (calendar.closures || []).filter((row) => row.cancellable);
  const gazettes = (calendar.gazetted || []).filter((row) => row.cancellable);
  if (pending.length || gazettes.length) {
    const manage = document.createElement('div');
    const heading = document.createElement('h3');
    heading.textContent = 'Cancel before the date';
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
    forms.appendChild(manage);
  }
  host.appendChild(forms);
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
  const title = document.createElement('h3');
  title.className = 'text-base font-semibold text-gray-900';
  title.textContent = deskOpen
    ? `Handover due ${rotation.dueDate}`
    : 'This cycle stays shut until handover is acknowledged';
  host.append(title);
  const form = document.createElement('form');
  form.id = 'handover-form';
  form.className = 'mt-3';
  for (const post of due) {
    const block = document.createElement('div');
    block.className = 'handover-post mt-3 grid gap-3';
    block.dataset.post = post.postCode;
    const row = document.createElement('div');
    row.className = 'grid gap-3 md:grid-cols-2';
    const candidates = state.directory.filter((user) => user.system_role === post.role && user.user_id !== post.outgoing?.userId);
    const select = document.createElement('select');
    select.dataset.field = 'incoming';
    select.className = 'h-10 rounded border border-gray-300 bg-white px-2 text-sm text-gray-800';
    for (const user of candidates) {
      const option = document.createElement('option');
      option.value = user.user_id;
      option.textContent = `${user.full_legal_name}: ${user.employee_id} | ${user.two_letter_initials}`;
      option.dataset.employeeId = user.employee_id;
      option.dataset.initials = user.two_letter_initials;
      select.appendChild(option);
    }
    const outgoing = document.createElement('input');
    outgoing.readOnly = true;
    outgoing.className = 'h-10 rounded border border-gray-300 bg-gray-50 px-3 text-sm text-gray-700';
    const outgoingName = post.postCode === 'HEAD_TELLER' ? 'Outgoing Coordinator' : 'Outgoing custodian';
    outgoing.value = post.outgoing
      ? `${outgoingName}: ${post.outgoing.initials}`
      : 'Outgoing holder is not on the calendar';
    const pins = document.createElement('div');
    pins.className = 'grid gap-3 md:grid-cols-2';
    const outgoingPin = document.createElement('input');
    outgoingPin.type = 'password';
    outgoingPin.placeholder = 'Outgoing closing PIN';
    outgoingPin.autocomplete = 'off';
    outgoingPin.required = true;
    outgoingPin.dataset.field = 'outgoing-pin';
    outgoingPin.className = 'h-10 rounded border border-gray-300 px-3 text-sm';
    const incomingPin = document.createElement('input');
    incomingPin.type = 'password';
    incomingPin.placeholder = 'Incoming closing PIN';
    incomingPin.autocomplete = 'off';
    incomingPin.required = true;
    incomingPin.dataset.field = 'incoming-pin';
    incomingPin.className = 'h-10 rounded border border-gray-300 px-3 text-sm';
    pins.append(outgoingPin, incomingPin);
    row.append(select, outgoing);
    block.append(row, pins);
    form.appendChild(block);
  }
  const error = document.createElement('p');
  error.id = 'handover-error';
  error.className = 'error mt-3 flex items-start gap-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700';
  error.setAttribute('role', 'alert');
  const actions = document.createElement('div');
  actions.className = 'mt-3 flex justify-end';
  const button = document.createElement('button');
  button.type = 'submit';
  button.className = '!mt-0 rounded bg-[#102833] px-4 py-2 text-sm font-medium text-white';
  button.textContent = 'Acknowledge Handover';
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
    option.textContent = `${user.full_legal_name} (${user.system_role})`;
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
    document.getElementById('acting-copy').textContent = `Testing as ${state.me.full_legal_name} (${state.me.system_role}). Simulating administrative and operational views.`;
    document.getElementById('session-user').textContent = `Testing as ${state.me.full_legal_name} · ${state.me.system_role}`;
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
    note.textContent = 'This role cannot write a line. Sign in as the master admin, or open the desk as a vault custodian or the weekly head teller.';
    return;
  }
  form.hidden = false;
  state.amendingLine = null;
  document.getElementById('entry-title').textContent = 'Write a line';
  document.getElementById('entry-submit').textContent = 'Post the line';
  document.getElementById('entry-cancel').hidden = true;
  document.getElementById('entry-flow').disabled = false;
  note.textContent = view.square_required
    ? 'Amounts, not pieces. Post the line, then write Bal c/d so the sheet squares.'
    : 'Amounts, not pieces. The line is appended to this open book.';
  if (canAmendBook(view)) {
    note.textContent += ' Amend any line while this book is open. A later Bal c/d follows the corrected position.';
  }
  document.getElementById('entry-square').hidden = !view.square_required;
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
      const label = document.createElement('label');
      label.append(document.createTextNode(column.header), input);
      grid.appendChild(label);
    }
    block.append(title, grid);
    host.appendChild(block);
  }
}

const FLOW_LABELS = {
  CIT_IN: 'CIT In',
  CIT_OUT: 'CIT Out',
  IN: 'In',
  OUT: 'Out',
};

function entryMovement() {
  const choice = document.getElementById('entry-flow').value;
  const reference = document.getElementById('entry-label').value.trim();
  if (choice === 'CIT_IN' || choice === 'CIT_OUT') {
    return {
      flow_direction: choice === 'CIT_IN' ? 'IN' : 'OUT',
      accounting_label: FLOW_LABELS[choice],
      line_reference: reference,
    };
  }
  return {
    flow_direction: choice,
    accounting_label: reference,
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
    if (row.in_or_out === 'CIT In') flow.value = 'CIT_IN';
    else if (row.in_or_out === 'CIT Out') flow.value = 'CIT_OUT';
    else flow.value = row.flow_direction === 'OUT' ? 'OUT' : 'IN';
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
  document.getElementById('session-user').textContent = `${state.me.full_legal_name} · ${state.me.system_role}`;
  const banner = document.getElementById('maintenance-banner');
  if (state.me.break_glass) {
    banner.hidden = false;
    banner.textContent = `Break-glass maintenance window open until ${new Date(state.me.break_glass_expires_at).toLocaleString()}.`;
  } else {
    banner.hidden = true;
  }
  await renderEntraAdmin();
  renderActAs();
  renderCalendar(desk.calendar || {});
  renderRotation(desk.rotation || { posts: [] });
  renderFlags(desk.carryFlags);
  renderHandover(desk.rotation || { due: [] }, desk.deskOpen);
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
  const defaults = new Set(['', ...Object.values(FLOW_LABELS)]);
  if (defaults.has(current)) input.value = FLOW_LABELS[document.getElementById('entry-flow').value] || current;
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
      await openBook(state.book.book.book_id);
      document.getElementById('desk-status').textContent = `Line ${amending} is amended.`;
    } else {
      const result = await api(`/api/books/${state.book.book.book_id}/entries`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      await openBook(state.book.book.book_id);
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
    await openBook(state.book.book.book_id);
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
