/* ------------------------------------------------------------------
   main.js
   - Handles general UI setup (login/logout, user checks, rooms fetch)
   - Provides helpers like fetchJSON, showToast, showSpinner, etc.
   - Exposes data & functions for calendar.js
------------------------------------------------------------------ */

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

    // Check for organizer token error => 403
    if (res.status === 403) {
      let errData;
      try {
        errData = await res.json();
      } catch (e) {
        errData = { error: 'Unknown error' };
      }
      if (errData.error === 'Organizer credentials invalid. Please re-authenticate.') {
        // Force logout => redirect with organizerError=1
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
  loginBtn.addEventListener('click', () => {
    window.location.href = '/login';
  });
  logoutBtn.addEventListener('click', () => {
    window.location.href = '/logout';
  });

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
      console.log('User not logged in');
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

  if (rooms.length === 0) {
    showError('No rooms found.');
    return;
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
    '#F16B61', '#3B76C2', '#EC8670', '#009688',
    '#AD1457', '#E67E22', '#8E44AD', '#757575'
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
      console.error('Error parsing localStorage:', err);
    }

    if (storedSelections.includes(room.id)) {
      chk.checked = true;
    }

    const lbl = document.createElement('label');
    lbl.setAttribute('for', `roomChk_${room.id}`);
    lbl.textContent = room.summary;

    chk.addEventListener('change', (e) => {
      // If user tries to uncheck and it's the last one, revert
      if (!e.target.checked) {
        const stillChecked = Array.from(roomsCheckboxBar.querySelectorAll('input[type="checkbox"]'))
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

    window.roomColors = roomColors;
  });

  function onRoomsCheckboxChange() {
    const checkboxes = roomsCheckboxBar.querySelectorAll('input[type="checkbox"]');
    const selectedIds = Array.from(checkboxes)
      .filter(ch => ch.checked)
      .map(ch => ch.value);

    localStorage.setItem('selectedRoomIds', JSON.stringify(selectedIds));
    applyCheckedRoomSources(selectedIds);
    updateSingleRoomName(selectedIds);
  }

  function applyCheckedRoomSources(selectedIds) {
    if (!window.multiCalendar) return;

    window.multiCalendar.batchRendering(() => {
      window.multiCalendar.removeAllEventSources();

      selectedIds.forEach((roomId) => {
        window.multiCalendar.addEventSource({
          id: roomId,
          events: function(fetchInfo, successCallback, failureCallback) {
            const data = allEventsMap[roomId] || [];
            successCallback(data);
          },
          color: roomColors[roomId] || '#333',
          textColor: '#fff'
        });
      });
    });
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
  let inviteChips = [];
  window.inviteChips = inviteChips;

  function clearChipsUI() {
    eventGuestsContainer.querySelectorAll('.chip').forEach(ch => ch.remove());
  }

  function renderChipsUI() {
    clearChipsUI();
    inviteChips.forEach(chip => {
      const chipEl = document.createElement('span');
      chipEl.className = 'chip badge bg-secondary me-1';
      chipEl.textContent = chip.label;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-close btn-close-white btn-sm ms-2';
      removeBtn.style.float = 'right';
      removeBtn.style.filter = 'invert(1)';
      removeBtn.addEventListener('click', () => {
        inviteChips = inviteChips.filter(c => c !== chip);
        renderChipsUI();
      });

      chipEl.appendChild(removeBtn);
      eventGuestsContainer.insertBefore(chipEl, eventGuestsInput);
    });
  }

  function addChip({ label, email }) {
    if (!inviteChips.find(ch => ch.email === email)) {
      inviteChips.push({ label, email });
    }
  }

  function isValidEmail(str) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
          label: `${user.name} <${user.email}>`,
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
          // Re-fetch data from the server, then update the calendar
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
    // Placeholder, real logic is in calendar.js
  };

  /* ------------------------------------------------------------------
     12) Initialize the calendar first, THEN enforce default selection
  ------------------------------------------------------------------ */
  initCalendar();            
  enforceDefaultSelection(); 
});
