document.addEventListener('DOMContentLoaded', async () => {
  /* ------------------------------------------------------------------
     1) DOM References
  ------------------------------------------------------------------ */
  const loginBtn         = document.getElementById('loginBtn');
  const logoutBtn        = document.getElementById('logoutBtn');
  const loadingSpinner   = document.getElementById('loadingSpinner');
  const roomsCheckboxBar = document.getElementById('roomsCheckboxBar');
  const selectedRoomNameSpan = document.getElementById('selectedRoomNameSpan');

  // Toast
  const toastEl      = document.getElementById('myToast');
  const toastTitleEl = document.getElementById('toastTitle');
  const toastBodyEl  = document.getElementById('toastBody');
  const bsToast      = new bootstrap.Toast(toastEl, { delay: 3000 });

  // Expose references to calendar modals (used by calendar.js as well)
  window.viewEventModal          = new bootstrap.Modal(document.getElementById('viewEventModal'));
  window.viewEventTitle          = document.getElementById('viewEventTitle');
  window.viewEventStart          = document.getElementById('viewEventStart');
  window.viewEventEnd            = document.getElementById('viewEventEnd');
  window.viewEventEditBtn        = document.getElementById('viewEventEditBtn');
  window.viewEventDeleteBtn      = document.getElementById('viewEventDeleteBtn');
  window.viewEventOrganizerChips = document.getElementById('viewEventOrganizerChips');
  window.viewEventAttendeesChips = document.getElementById('viewEventAttendeesChips');

  // Expose references for the create/edit event modal
  window.eventModal           = new bootstrap.Modal(document.getElementById('eventModal'));
  window.eventForm            = document.getElementById('eventForm');
  window.calendarIdField      = document.getElementById('calendarId');
  window.eventIdField         = document.getElementById('eventId');
  window.eventTitleField      = document.getElementById('eventTitle');
  window.eventStartField      = document.getElementById('eventStart');
  window.eventEndField        = document.getElementById('eventEnd');
  window.eventGuestsContainer = document.getElementById('eventGuestsContainer');
  window.eventGuestsInput     = document.getElementById('eventGuestsInput');

  /* ------------------------------------------------------------------
     2) Toast & Spinner Helpers
  ------------------------------------------------------------------ */
  function showToast(title, message) {
    toastTitleEl.textContent = title;
    toastBodyEl.textContent  = message;
    bsToast.show();
  }
  function showError(message) {
    showToast('Error', message);
  }
  function showSpinner() {
    loadingSpinner.classList.remove('d-none');
  }
  function hideSpinner() {
    loadingSpinner.classList.add('d-none');
  }

  // Expose them globally so calendar.js can call them
  window.showToast   = showToast;
  window.showError   = showError;
  window.showSpinner = showSpinner;
  window.hideSpinner = hideSpinner;

  /* ------------------------------------------------------------------
     3) Shared Utilities
  ------------------------------------------------------------------ */
  async function fetchJSON(url, options = {}) {
    const res = await fetch(url, options);

    // Organizer token error => 403 => force re-login
    if (res.status === 403) {
      let errData;
      try {
        errData = await res.json();
      } catch (e) {
        errData = { error: 'Unknown error' };
      }
      if (errData.error === 'Organizer credentials invalid. Please re-authenticate.') {
        window.location.href = '/logout?organizerError=1';
        return;
      }
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`(${res.status}) ${text}`);
    }
    return res.json();
  }
  function toLocalDateTimeInput(jsDate) {
    const year   = jsDate.getFullYear();
    const month  = String(jsDate.getMonth() + 1).padStart(2, '0');
    const day    = String(jsDate.getDate()).padStart(2, '0');
    const hour   = String(jsDate.getHours()).padStart(2, '0');
    const minute = String(jsDate.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}:${minute}`;
  }

  // Expose globally
  window.fetchJSON            = fetchJSON;
  window.toLocalDateTimeInput = toLocalDateTimeInput;

  /* ------------------------------------------------------------------
     4) Login/Logout
  ------------------------------------------------------------------ */
  const loginBtnHandler = () => {
    window.location.href = '/login';
  };
  const logoutBtnHandler = () => {
    window.location.href = '/logout';
  };
  loginBtn.addEventListener('click', loginBtnHandler);
  logoutBtn.addEventListener('click', logoutBtnHandler);

  /* ------------------------------------------------------------------
     5) Check if user is logged in
  ------------------------------------------------------------------ */
  let currentUserEmail = null;
  let isLoggedIn       = false;

  try {
    const meRes = await fetch('/api/me');
    if (meRes.status === 200) {
      const meData = await meRes.json();
      currentUserEmail = meData.email;
      isLoggedIn = true;
    } else if (meRes.status === 401) {
      // Not logged in
    } else {
      const errText = await meRes.text();
      showError(`Could not check /api/me: (${meRes.status}) ${errText}`);
    }
  } catch (err) {
    showError(`Network error checking /api/me: ${err.message}`);
  }

  if (isLoggedIn) {
    logoutBtn.style.display = 'inline-block';
    loginBtn.style.display  = 'none';
  } else {
    logoutBtn.style.display = 'none';
    loginBtn.style.display  = 'inline-block';
    roomsCheckboxBar.style.display = 'none';
    // Stop if not logged in
    return;
  }

  // Expose globally for calendar.js if needed
  window.currentUserEmail = currentUserEmail;

  /* ------------------------------------------------------------------
     6) Fetch user list
  ------------------------------------------------------------------ */
  let prefetchedUsers = [];
  let lastKnownUserVersion = 1;
  try {
    const data = await fetchJSON('/api/all_users');
    prefetchedUsers = data.users || [];
  } catch (err) {
    showError(`Failed to load user list: ${err.message}`);
  }

  // Expose globally for calendar.js
  window.prefetchedUsers = prefetchedUsers;

  /* ------------------------------------------------------------------
     7) Fetch Rooms
  ------------------------------------------------------------------ */
  let rooms = [];
  try {
    const data = await fetchJSON('/api/rooms');
    rooms = data.rooms || [];
  } catch (err) {
    showError(`Failed to load rooms: ${err.message}`);
    return;
  }

  // Parse out "order:N" from description => _sortOrder, then sort
  rooms.forEach((room) => {
    const match = room.description?.match(/order:(\d+)/);
    room._sortOrder = match ? parseInt(match[1], 10) : 9999;
  });
  rooms.sort((a, b) => a._sortOrder - b._sortOrder);

  if (rooms.length === 0) {
    showError('No rooms found.');
    return;
  }

  /* ------------------------------------------------------------------
     Toggle "full viewport" modal when "Find a time" tab is active
  ------------------------------------------------------------------ */
  const eventModalDialog = document.getElementById('eventModalDialog');
  const locationTabBtn   = document.getElementById('location-tab');
  const blankTabBtn      = document.getElementById('blank-tab');

  const originalDialogClasses = eventModalDialog ? eventModalDialog.className : '';

  if (locationTabBtn && blankTabBtn && eventModalDialog) {
    // "Event Details" => restore original size
    locationTabBtn.addEventListener('shown.bs.tab', () => {
      eventModalDialog.className = originalDialogClasses;
    });

    // "Find a time" => make modal fullscreen
    blankTabBtn.addEventListener('shown.bs.tab', () => {
      eventModalDialog.classList.add('modal-fullscreen');
    });
  }

  /* ------------------------------------------------------------------
     8) Pre-Fetch All Room Events => store in memory
  ------------------------------------------------------------------ */
  const allEventsMap = {};
  async function prefetchAllRooms() {
    showSpinner();
    try {
      for (const room of rooms) {
        const resp = await fetchJSON(`/api/room_data?calendarId=${encodeURIComponent(room.id)}`);
        allEventsMap[room.id] = resp.events || [];
      }
    } catch (error) {
      showError(`Error prefetching room events: ${error.message}`);
    } finally {
      hideSpinner();
    }
  }
  await prefetchAllRooms();

  // Expose globally for calendar.js
  window.rooms        = rooms;
  window.allEventsMap = allEventsMap;

  /* ------------------------------------------------------------------
     9) Initialize Color-Coded Room Checkboxes
  ------------------------------------------------------------------ */
  const colorPalette = [
    '#E63946', // Bright Red
    '#457B9D', // Cool Blue
    '#F4A261', // Warm Orange
    '#8E44AD', // Deep Purple
    '#F1C40F', // Bright Yellow
    '#16A085', // Emerald Green
    '#E67E22', // Pumpkin Orange
    '#D35400', // Burnt Orange
    '#34495E'  // Slate Blue
  ];
  const roomColors = {};

  rooms.forEach((room, index) => {
    const roomColor = colorPalette[index % colorPalette.length];
    roomColors[room.id] = roomColor;

    const wrapper = document.createElement('div');
    wrapper.classList.add('room-checkbox');
    wrapper.style.setProperty('--room-color', roomColor);

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.id   = `roomChk_${room.id}`;
    chk.value= room.id;

    // Load user’s local selections
    let storedSelections = [];
    try {
      const raw = localStorage.getItem('selectedRoomIds');
      if (raw) {
        storedSelections = JSON.parse(raw);
      }
    } catch (err) {
      // ignore
    }

    if (storedSelections.includes(room.id)) {
      chk.checked = true;
    }

    const lbl = document.createElement('label');
    lbl.setAttribute('for', `roomChk_${room.id}`);
    lbl.textContent = room.summary;

    chk.addEventListener('change', (e) => {
      // If user tries to uncheck and it's the last one, revert
      const checkboxes = roomsCheckboxBar.querySelectorAll('input[type="checkbox"]');
      if (!e.target.checked) {
        const stillChecked = Array.from(checkboxes)
          .filter(c => c.checked && c !== e.target);
        if (stillChecked.length === 0) {
          e.target.checked = true;
          showToast("Notice", "At least one room must be selected. Re-selecting this room.");
          return;
        }
      }
      onRoomsCheckboxChange();
    });

    wrapper.appendChild(chk);
    wrapper.appendChild(lbl);
    roomsCheckboxBar.appendChild(wrapper);
  });

  // Expose globally
  window.roomColors = roomColors;

  function onRoomsCheckboxChange() {
    const checkboxes = roomsCheckboxBar.querySelectorAll('input[type="checkbox"]');
    const selectedIds = Array.from(checkboxes)
      .filter(ch => ch.checked)
      .map(ch => ch.value);

    localStorage.setItem('selectedRoomIds', JSON.stringify(selectedIds));

    if (window.multiCalendar) {
      window.multiCalendar.batchRendering(() => {
        window.multiCalendar.refetchResources();
        window.multiCalendar.refetchEvents();
      });
    }

    updateSingleRoomName(selectedIds);
  }

  function updateSingleRoomName(selectedRoomIds) {
    if (selectedRoomIds.length === 1) {
      const singleRoomId = selectedRoomIds[0];
      const foundRoom = rooms.find(r => r.id === singleRoomId);
      if (foundRoom) {
        selectedRoomNameSpan.style.display = 'inline-block';
        selectedRoomNameSpan.textContent = foundRoom.summary;
      }
    } else {
      selectedRoomNameSpan.style.display = 'none';
      selectedRoomNameSpan.textContent = '';
    }
  }

  function enforceDefaultSelection() {
    const checkboxes = roomsCheckboxBar.querySelectorAll('input[type="checkbox"]');
    const anyChecked = Array.from(checkboxes).some(ch => ch.checked);
    if (!anyChecked && rooms.length > 0) {
      checkboxes[0].checked = true;
    }
    onRoomsCheckboxChange();
  }

  /* ------------------------------------------------------------------
     10) Create/Edit Modal => Chips
  ------------------------------------------------------------------ */
  window.inviteChips = [];

  function clearChipsUI() {
    eventGuestsContainer.querySelectorAll('.chip').forEach(ch => ch.remove());
  }

  function renderChipsUI() {
    clearChipsUI();
    window.inviteChips.forEach(chip => {
      const chipEl = document.createElement('span');
      chipEl.className = 'chip badge bg-secondary me-1';
      chipEl.textContent = chip.label;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-close btn-close-white btn-sm ms-2';
      removeBtn.style.float = 'right';
      removeBtn.style.filter = 'invert(1)';
      removeBtn.addEventListener('click', () => {
        window.inviteChips = window.inviteChips.filter(c => c !== chip);
        renderChipsUI();
      });

      chipEl.appendChild(removeBtn);
      eventGuestsContainer.appendChild(chipEl);
    });
  }

  function addChip({ label, email }) {
    const existing = window.inviteChips.find(ch => ch.email === email);
    if (!existing) {
      window.inviteChips.push({ label, email });
    }
  }

  function isValidEmail(str) {
    const re = /^[^\s@]+@[^\s@]+$/;
    return re.test(str);
  }

  function resolveUserToken(token) {
    const lowerToken = token.toLowerCase();
    let found = prefetchedUsers.find(u => u.email && u.email.toLowerCase() === lowerToken);
    if (found) {
      const label = found.name ? `${found.name} <${found.email}>` : found.email;
      return { label, email: found.email };
    }
    found = prefetchedUsers.find(u => (u.name && u.name.toLowerCase() === lowerToken));
    if (found) {
      const label = found.name ? `${found.name} <${found.email}>` : found.email;
      return { label, email: found.email };
    }
    if (isValidEmail(token)) {
      return { label: token, email: token };
    }
    return null;
  }

  let typeaheadDiv;
  eventGuestsInput.addEventListener('input', (e) => {
    const val = e.target.value.toLowerCase().trim();
    if (typeaheadDiv) {
      typeaheadDiv.remove();
      typeaheadDiv = null;
    }
    if (!val) return;

    const matches = prefetchedUsers.filter(u =>
      u.email.toLowerCase().includes(val) ||
      (u.name && u.name.toLowerCase().includes(val))
    ).slice(0, 5);

    if (matches.length === 0) return;
    typeaheadDiv = document.createElement('div');
    typeaheadDiv.className = 'list-group position-absolute';
    typeaheadDiv.style.zIndex = '9999';
    typeaheadDiv.style.width = eventGuestsInput.offsetWidth + 'px';

    matches.forEach(user => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'list-group-item list-group-item-action';
      item.textContent = `${user.name} <${user.email}>`;

      item.onclick = () => {
        addChip({
          label: item.textContent,
          email: user.email
        });
        renderChipsUI();
        eventGuestsInput.value = '';
        typeaheadDiv.remove();
        typeaheadDiv = null;
      };

      typeaheadDiv.appendChild(item);
    });

    eventGuestsInput.parentNode.appendChild(typeaheadDiv);
  });

  eventGuestsInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const raw = eventGuestsInput.value.trim();
      if (raw) {
        processRawToken(raw);
      }
    }
  });

  function processRawToken(raw) {
    const tokens = raw.split(',').map(t => t.trim()).filter(Boolean);
    tokens.forEach(tok => {
      const chipData = resolveUserToken(tok);
      if (!chipData) {
        showError(`"${tok}" is not recognized as a user or valid email address.`);
        return;
      }
      addChip(chipData);
    });
    eventGuestsInput.value = '';
    renderChipsUI();
  }

  window.clearChipsUI    = clearChipsUI;
  window.renderChipsUI   = renderChipsUI;
  window.addChip         = addChip;
  window.processRawToken = processRawToken;

  /* ------------------------------------------------------------------
     11) Polling for Room & User Updates
  ------------------------------------------------------------------ */
  const lastKnownVersions = {};
  setInterval(checkRoomUpdates, 30000);
  setInterval(checkUserUpdates, 30000);

  async function checkRoomUpdates() {
    try {
      const data = await fetchJSON('/api/room_updates');
      data.updates.forEach(({ roomId, version }) => {
        const currentVer = lastKnownVersions[roomId] || 0;
        if (version > currentVer) {
          lastKnownVersions[roomId] = version;
          resyncSingleRoom(roomId);
        }
      });
    } catch (err) {
      showError(`Failed to check room updates: ${err.message}`);
    }
  }

  async function checkUserUpdates() {
    try {
      const data = await fetchJSON('/api/user_updates');
      const serverVer = data.version || 1;
      if (serverVer > lastKnownUserVersion) {
        lastKnownUserVersion = serverVer;
        const allData = await fetchJSON('/api/all_users');
        prefetchedUsers = allData.users || [];
        window.prefetchedUsers = prefetchedUsers;
      }
    } catch (err) {
      showError(`Failed to check user updates: ${err.message}`);
    }
  }

  window.resyncSingleRoom = async function(roomId) {
    // Called when the server indicates a specific room changed
    showSpinner();
    try {
      const resp = await fetchJSON(`/api/room_data?calendarId=${encodeURIComponent(roomId)}`);
      allEventsMap[roomId] = resp.events || [];
      // Refresh the calendar
      if (window.multiCalendar) {
        window.multiCalendar.refetchEvents();
      }
    } catch (error) {
      showError(`Failed to refresh room data: ${error.message}`);
    } finally {
      hideSpinner();
    }
  };

  /* ------------------------------------------------------------------
     12) Initialize the single FullCalendar
  ------------------------------------------------------------------ */
  initCalendar(); // from calendar.js
  enforceDefaultSelection();

  /* ------------------------------------------------------------------
     13) Handle form submission
     - Hide modal immediately, show spinner + toast: "Event is being created..."
  ------------------------------------------------------------------ */
  function localInputToUTCString(inputValue) {
    if (!inputValue) return null;
    const [datePart, timePart] = inputValue.split('T'); 
    const [yyyy, mm, dd] = datePart.split('-').map(Number);
    const [hh, min]      = timePart.split(':').map(Number);
    const localDate = new Date(yyyy, mm - 1, dd, hh, min);
    return localDate.toISOString();
  }

  eventForm.addEventListener('submit', async (e) => {
    e.preventDefault(); 

    // Hide modal right away:
    window.eventModal.hide();

    // Show spinner + "creating..." toast:
    showSpinner();
    showToast('Creating Event', 'Please wait...');

    const calendarId    = calendarIdField.value;
    const eventId       = eventIdField.value;
    const title         = eventTitleField.value.trim();

    const startUTC = localInputToUTCString(eventStartField.value);
    const endUTC   = localInputToUTCString(eventEndField.value);

    const descriptionEl = document.getElementById('eventDescription');
    const description   = descriptionEl ? descriptionEl.value.trim() : "";

    const participants = window.inviteChips.map(c => c.email);

    if (!calendarId || !title || !startUTC || !endUTC) {
      showError('Please fill out required fields (room, title, start, end).');
      hideSpinner();
      return;
    }

    try {
      if (eventId) {
        // Update existing event
        await window.calendarHelpers.updateEvent({
          calendarId,
          eventId,
          title,
          start: startUTC,
          end: endUTC,
          participants,
          description
        });
        showToast('Updated', 'Event updated successfully.');
      } else {
        // Create new event
        await window.calendarHelpers.createEvent({
          calendarId,
          title,
          start: startUTC,
          end: endUTC,
          participants,
          description
        });
        showToast('Created', 'Event created successfully.');
      }

      // Re-sync that room’s data
      await resyncSingleRoom(calendarId);

    } catch (err) {
      showError(`Error saving event: ${err.message}`);
    } finally {
      hideSpinner();
    }
  });
});
