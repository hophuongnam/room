document.addEventListener('DOMContentLoaded', async () => {
  /* ------------------------------------------------------------------
     1) DOM References
  ------------------------------------------------------------------ */
  const loginBtn         = document.getElementById('loginBtn');
  const logoutBtn        = document.getElementById('logoutBtn');
  const errorAlert       = document.getElementById('errorAlert');
  const loadingSpinner   = document.getElementById('loadingSpinner');

  // Rooms dropdown
  const roomDropdown     = document.getElementById('roomDropdown');
  const roomDropdownMenu = document.getElementById('roomDropdownMenu');

  // Calendar Container
  const calendarContainer = document.getElementById('calendarContainer');

  // View Event Modal + elements
  const viewEventModal         = new bootstrap.Modal(document.getElementById('viewEventModal'));
  const viewEventTitle         = document.getElementById('viewEventTitle');
  const viewEventStart         = document.getElementById('viewEventStart');
  const viewEventEnd           = document.getElementById('viewEventEnd');
  const viewEventOrganizer     = document.getElementById('viewEventOrganizer');
  const viewEventAttendees     = document.getElementById('viewEventAttendees');
  const viewEventEditBtn       = document.getElementById('viewEventEditBtn');
  const viewEventDeleteBtn     = document.getElementById('viewEventDeleteBtn');

  // Create/Edit Event Modal
  const eventModal             = new bootstrap.Modal(document.getElementById('eventModal'));
  const eventForm              = document.getElementById('eventForm');
  const calendarIdField        = document.getElementById('calendarId');
  const eventIdField           = document.getElementById('eventId');
  const eventTitleField        = document.getElementById('eventTitle');
  const eventStartField        = document.getElementById('eventStart');
  const eventEndField          = document.getElementById('eventEnd');
  const eventGuestsContainer   = document.getElementById('eventGuestsContainer');
  const eventGuestsInput       = document.getElementById('eventGuestsInput');

  /* ------------------------------------------------------------------
     2) State Variables
  ------------------------------------------------------------------ */
  let currentUserEmail   = null;
  let isLoggedIn         = false;
  let currentRoomId      = null;
  const calendars        = {}; // { calendarId: FullCalendar instance }
  const lastKnownVersions= {}; // { calendarId: number }
  const roomMap          = {};

  // For user-list
  let prefetchedUsers    = [];  // Array of { email, name }
  let lastKnownUserVersion = 1;

  // For chips-based participants
  let inviteChips        = [];

  /* ------------------------------------------------------------------
     3) Helper Functions
  ------------------------------------------------------------------ */
  function showError(msg) {
    errorAlert.textContent = msg;
    errorAlert.classList.remove('d-none');
  }
  function hideError() {
    errorAlert.classList.add('d-none');
  }
  function showSpinner() {
    loadingSpinner.classList.remove('d-none');
  }
  function hideSpinner() {
    loadingSpinner.classList.add('d-none');
  }

  async function fetchJSON(url, options = {}) {
    const res = await fetch(url, options);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Fetch error (${res.status}): ${text}`);
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

  // FRONTEND Overlap Check:
  // This checks *all* events, including linked ones, as per your request.
  function selectionOverlapsExisting(selectInfo, calendarObj) {
    const existingEvents = calendarObj.getEvents();
    for (const ev of existingEvents) {
      if (selectInfo.start < ev.end && selectInfo.end > ev.start) {
        return true;
      }
    }
    return false;
  }

  // CRUD helpers
  async function createEvent({ calendarId, title, start, end, participants }) {
    return fetchJSON('/api/create_event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId, title, start, end, participants }),
    });
  }
  async function updateEvent({ calendarId, eventId, title, start, end, participants }) {
    return fetchJSON('/api/update_event', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId, eventId, title, start, end, participants }),
    });
  }
  async function deleteEvent({ calendarId, id }) {
    return fetchJSON('/api/delete_event', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId, id }),
    });
  }

  /* ------------------------------------------------------------------
     4) Check if user is logged in
  ------------------------------------------------------------------ */
  try {
    const meRes = await fetch('/api/me');
    if (meRes.status === 200) {
      const meData = await meRes.json();
      currentUserEmail = meData.email;
      isLoggedIn = true;
    }
  } catch (err) {
    console.error('Error checking /api/me:', err);
  }

  // Show/hide Login or Logout
  if (isLoggedIn) {
    logoutBtn.style.display = 'inline-block';
    loginBtn.style.display  = 'none';
  } else {
    logoutBtn.style.display = 'none';
    loginBtn.style.display  = 'inline-block';
  }

  // If not logged in, stop
  if (!isLoggedIn) {
    return;
  }

  /* ------------------------------------------------------------------
     5) Fetch user list + rooms
  ------------------------------------------------------------------ */
  try {
    const data = await fetchJSON('/api/all_users');
    prefetchedUsers = data.users || [];
  } catch (err) {
    console.error('Failed to load user list:', err);
  }

  let rooms = [];
  try {
    const data = await fetchJSON('/api/rooms');
    rooms = data.rooms || [];
  } catch (err) {
    console.error(err);
    showError('Failed to load rooms.');
    return;
  }

  if (rooms.length === 0) {
    showError('No rooms found.');
    return;
  }

  // Populate a dropdown or list
  rooms.forEach((room, index) => {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'dropdown-item';
    link.href = '#';
    link.textContent = room.summary;
    link.addEventListener('click', () => {
      selectRoom(room.id);
    });

    li.appendChild(link);
    roomDropdownMenu.appendChild(li);
    roomMap[room.id] = room.summary;

    // auto-select the first room
    if (index === 0) {
      selectRoom(room.id);
    }
  });

  /* ------------------------------------------------------------------
     6) Select a room => show the calendar
  ------------------------------------------------------------------ */
  function selectRoom(roomId) {
    if (currentRoomId === roomId) return;
    currentRoomId = roomId;
    hideError();
    showSpinner();
    roomDropdown.textContent = roomMap[roomId];
    initCalendar(roomId);
  }

  function initCalendar(calendarId) {
    if (calendars[calendarId]) {
      calendars[calendarId].refetchEvents();
      hideSpinner();
      return;
    }

    const calendar = new FullCalendar.Calendar(calendarContainer, {
      timeZone: 'local',
      height: 'auto',
      nowIndicator: true,
      slotMinTime: '08:00:00',
      slotMaxTime: '18:00:00',
      initialView: 'timeGridWeek',
      firstDay: 1,
      headerToolbar: {
        left: 'prev,next today',
        center: 'title',
        right: 'dayGridMonth,timeGridWeek,timeGridDay',
      },
      events: async (info, successCallback, failureCallback) => {
        try {
          const data = await fetchJSON(`/api/room_data?calendarId=${encodeURIComponent(calendarId)}`);
          successCallback(data.events || []);
        } catch (err) {
          console.error(err);
          failureCallback(err);
          showError('Failed to load events.');
        } finally {
          hideSpinner();
        }
      },
      dateClick: (info) => {
        // user cannot create an event in the past
        if (info.date < new Date()) return;
        const startTime = info.date;
        const endTime   = new Date(startTime.getTime() + 30*60*1000);
        openEventModal({ calendarId, start: startTime, end: endTime });
      },
      selectable: true,
      // IMPORTANT: The frontend checks *all* events for overlaps (including linked).
      selectAllow: (selectInfo) => {
        if (selectInfo.start < new Date()) return false; // no past
        if (selectionOverlapsExisting(selectInfo, calendar)) return false;
        return true;
      },
      select: (selectionInfo) => {
        openEventModal({
          calendarId,
          start: selectionInfo.start,
          end: selectionInfo.end
        });
      },
      eventClick: (clickInfo) => {
        openViewEventModal(clickInfo.event, calendarId);
      }
    });

    calendar.render();
    calendars[calendarId] = calendar;
  }

  /* ------------------------------------------------------------------
     7) View Existing Event
  ------------------------------------------------------------------ */
  let currentEventId = null;

  function openViewEventModal(event, calendarId) {
    hideError();
    currentEventId = event.id;

    viewEventTitle.textContent = event.title || 'Untitled';
    const startTime = event.start ? new Date(event.start) : null;
    const endTime   = event.end   ? new Date(event.end)   : null;
    const formatOptions = { 
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    };
    viewEventStart.textContent = startTime
      ? startTime.toLocaleString(undefined, formatOptions)
      : 'N/A';
    viewEventEnd.textContent   = endTime
      ? endTime.toLocaleString(undefined, formatOptions)
      : 'N/A';

    const organizer = event.extendedProps?.organizer || '';
    viewEventOrganizer.textContent = organizer;
    const attendees = event.extendedProps?.attendees || event.attendees || [];
    viewEventAttendees.textContent = Array.isArray(attendees) ? attendees.join(', ') : '';

    const isLinked = (event.extendedProps?.is_linked === true || event.extendedProps?.is_linked === 'true');

    // If it is a linked event => no edit/delete. Otherwise, check if user is organizer or attendee.
    let canEditOrDelete = true;
    if (isLinked) {
      canEditOrDelete = false;
    } else {
      if (!attendees.includes(currentUserEmail) && organizer !== currentUserEmail) {
        canEditOrDelete = false;
      }
    }

    viewEventEditBtn.style.display   = canEditOrDelete ? 'inline-block' : 'none';
    viewEventDeleteBtn.style.display = canEditOrDelete ? 'inline-block' : 'none';

    viewEventModal.show();

    // Edit
    viewEventEditBtn.onclick = () => {
      if (canEditOrDelete) {
        openEventModal({
          calendarId,
          eventId: event.id,
          title: event.title,
          start: event.start,
          end: event.end,
          attendees
        });
      }
      viewEventModal.hide();
    };

    // Delete
    viewEventDeleteBtn.onclick = async () => {
      if (!canEditOrDelete) return;
      const confirmDelete = confirm('Are you sure you want to delete this event?');
      if (!confirmDelete) return;

      try {
        await deleteEvent({ calendarId, id: event.id });
        const fcEvent = calendars[calendarId]?.getEventById(event.id);
        if (fcEvent) fcEvent.remove();
        viewEventModal.hide();
      } catch (err) {
        console.error(err);
        showError('Failed to delete event.');
      }
    };
  }

  /* ------------------------------------------------------------------
     8) Create/Edit Modal => Chips for participants
  ------------------------------------------------------------------ */
  function openEventModal({ calendarId, eventId, title, start, end, attendees }) {
    hideError();

    calendarIdField.value = calendarId || '';
    eventIdField.value    = eventId    || '';
    eventTitleField.value = title      || '';

    if (start) {
      eventStartField.value = toLocalDateTimeInput(new Date(start));
    } else {
      eventStartField.value = '';
    }
    if (end) {
      eventEndField.value = toLocalDateTimeInput(new Date(end));
    } else {
      eventEndField.value = '';
    }

    // Clear old chips
    inviteChips = [];
    clearChipsUI();

    if (attendees && attendees.length > 0) {
      attendees.forEach((email) => {
        const userObj = prefetchedUsers.find(u => u.email === email);
        if (userObj) {
          addChip({
            label: `${userObj.name} <${userObj.email}>`,
            email: userObj.email
          });
        } else {
          addChip({ label: email, email: email });
        }
      });
      renderChipsUI();
    }

    // If editing => disallow changing the time
    if (eventId) {
      eventStartField.disabled = true;
      eventEndField.disabled   = true;
    } else {
      eventStartField.disabled = false;
      eventEndField.disabled   = false;
    }

    eventModal.show();
  }

  eventForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();

    const calendarId = calendarIdField.value;
    const eventId    = eventIdField.value;
    const title      = eventTitleField.value.trim();

    const localStart = new Date(eventStartField.value);
    const localEnd   = new Date(eventEndField.value);
    const startUTC   = localStart.toISOString();
    const endUTC     = localEnd.toISOString();

    if (!calendarId || !title) {
      showError('Missing required fields.');
      return;
    }

    const participants = inviteChips.map(ch => ch.email);

    // For new events, ensure the user doesn't pick an invalid time
    if (!eventId) {
      if (!startUTC || !endUTC) {
        showError('Missing start or end time.');
        return;
      }
      if (localStart < new Date()) {
        showError('Cannot create an event in the past.');
        return;
      }
      if (localEnd <= localStart) {
        showError('End time must be after start time.');
        return;
      }
    }

    showSpinner();
    try {
      if (eventId) {
        await updateEvent({ calendarId, eventId, title, start: startUTC, end: endUTC, participants });
      } else {
        await createEvent({ calendarId, title, start: startUTC, end: endUTC, participants });
      }
      eventModal.hide();
      calendars[calendarId].refetchEvents();
    } catch (err) {
      console.error(err);
      showError('Failed to save event.');
    } finally {
      hideSpinner();
    }
  });

  // Chips UI
  const chipsContainer = eventGuestsContainer;
  const chipsInput     = eventGuestsInput;

  function clearChipsUI() {
    chipsContainer.querySelectorAll('.chip').forEach(ch => ch.remove());
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
      chipsContainer.insertBefore(chipEl, chipsInput);
    });
  }

  function addChip({ label, email }) {
    if (!inviteChips.find(ch => ch.email === email)) {
      inviteChips.push({ label, email });
    }
  }

  chipsInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const raw = chipsInput.value.trim();
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
    chipsInput.value = '';
    renderChipsUI();
  }

  function isValidEmail(str) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(str);
  }

  function resolveUserToken(token) {
    const lowerToken = token.toLowerCase();
    // Check exact email in prefetchedUsers
    let found = prefetchedUsers.find(u => {
      return u.email && u.email.toLowerCase() === lowerToken;
    });
    if (found) {
      const label = found.name ? `${found.name} <${found.email}>` : found.email;
      return { label, email: found.email };
    }
    // Check name
    found = prefetchedUsers.find(u => {
      return u.name && u.name.toLowerCase() === lowerToken;
    });
    if (found) {
      const label = found.name ? `${found.name} <${found.email}>` : found.email;
      return { label, email: found.email };
    }
    // Otherwise must be valid email
    if (isValidEmail(token)) {
      return { label: token, email: token };
    }
    return null;
  }

  // Basic typeahead
  let typeaheadDiv;
  chipsInput.addEventListener('input', (e) => {
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
    typeaheadDiv.style.width = chipsInput.offsetWidth + 'px';

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
        chipsInput.value = '';
        typeaheadDiv.remove();
        typeaheadDiv = null;
      };
      typeaheadDiv.appendChild(item);
    });
    chipsInput.parentNode.appendChild(typeaheadDiv);
  });

  /* ------------------------------------------------------------------
     9) Polling for Room & User Updates
  ------------------------------------------------------------------ */
  setInterval(checkRoomUpdates, 30000);
  setInterval(checkUserUpdates, 30000);

  async function checkRoomUpdates() {
    try {
      const data = await fetchJSON('/api/room_updates');
      data.updates.forEach(({ roomId, version }) => {
        const currentVer = lastKnownVersions[roomId] || 0;
        if (version > currentVer) {
          lastKnownVersions[roomId] = version;
          if (calendars[roomId]) {
            calendars[roomId].refetchEvents();
          }
        }
      });
    } catch (err) {
      console.error('Failed to check updates:', err);
    }
  }

  async function checkUserUpdates() {
    try {
      const data = await fetchJSON('/api/user_updates');
      const serverVer = data.version || 1;
      if (serverVer > lastKnownUserVersion) {
        lastKnownUserVersion = serverVer;
        // re-fetch user list
        const allData = await fetchJSON('/api/all_users');
        prefetchedUsers = allData.users || [];
      }
    } catch (err) {
      console.error('Failed to check user updates:', err);
    }
  }

  // Initial checks
  checkRoomUpdates();
  checkUserUpdates();
});
