document.addEventListener('DOMContentLoaded', async () => {
  /* ------------------------------------------------------------------
     1) DOM References
  ------------------------------------------------------------------ */
  const loginBtn         = document.getElementById('loginBtn');
  const logoutBtn        = document.getElementById('logoutBtn');
  const loadingSpinner   = document.getElementById('loadingSpinner');

  const roomsCheckboxBar = document.getElementById('roomsCheckboxBar');

  // Single & Multi Calendar Containers
  const singleCalendarContainer = document.getElementById('singleCalendarContainer');
  const multiCalendarContainer  = document.getElementById('multiCalendarContainer');

  // Calendar DOM elements
  const singleCalendarEl = document.getElementById('singleCalendar');
  const multiCalendarEl  = document.getElementById('multiCalendar');

  // For showing the selected room name in single view
  const selectedRoomName = document.getElementById('selectedRoomName');

  // View Event Modal + elements
  const viewEventModal          = new bootstrap.Modal(document.getElementById('viewEventModal'));
  const viewEventTitle          = document.getElementById('viewEventTitle');
  const viewEventStart          = document.getElementById('viewEventStart');
  const viewEventEnd            = document.getElementById('viewEventEnd');
  const viewEventEditBtn        = document.getElementById('viewEventEditBtn');
  const viewEventDeleteBtn      = document.getElementById('viewEventDeleteBtn');
  const viewEventOrganizerChips = document.getElementById('viewEventOrganizerChips');
  const viewEventAttendeesChips = document.getElementById('viewEventAttendeesChips');

  // Create/Edit Event Modal
  const eventModal              = new bootstrap.Modal(document.getElementById('eventModal'));
  const eventForm               = document.getElementById('eventForm');
  const calendarIdField         = document.getElementById('calendarId');
  const eventIdField            = document.getElementById('eventId');
  const eventTitleField         = document.getElementById('eventTitle');
  const eventStartField         = document.getElementById('eventStart');
  const eventEndField           = document.getElementById('eventEnd');
  const eventGuestsContainer    = document.getElementById('eventGuestsContainer');
  const eventGuestsInput        = document.getElementById('eventGuestsInput');

  // Toast
  const toastEl      = document.getElementById('myToast');
  const toastTitleEl = document.getElementById('toastTitle');
  const toastBodyEl  = document.getElementById('toastBody');
  const bsToast      = new bootstrap.Toast(toastEl, { delay: 3000 });

  /* ------------------------------------------------------------------
     2) Toast Helpers
  ------------------------------------------------------------------ */
  function showToast(title, message) {
    toastTitleEl.textContent = title;
    toastBodyEl.textContent  = message;
    bsToast.show();
  }

  // We'll have a helper for errors to unify the message
  function showError(message) {
    showToast('Error', message);
  }

  // Spinner
  function showSpinner() {
    loadingSpinner.classList.remove('d-none');
  }
  function hideSpinner() {
    loadingSpinner.classList.add('d-none');
  }

  /* Helper fetch that throws an Error for non-OK statuses */
  async function fetchJSON(url, options = {}) {
    const res = await fetch(url, options);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`(${res.status}) ${text}`);
    }
    return res.json();
  }

  /* Misc helpers */
  function toLocalDateTimeInput(jsDate) {
    const year   = jsDate.getFullYear();
    const month  = String(jsDate.getMonth() + 1).padStart(2, '0');
    const day    = String(jsDate.getDate()).padStart(2, '0');
    const hour   = String(jsDate.getHours()).padStart(2, '0');
    const minute = String(jsDate.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}:${minute}`;
  }
  function isPast(dateObj) {
    return dateObj < new Date();
  }

  /* ------------------------------------------------------------------
     3) Login/Logout
  ------------------------------------------------------------------ */
  loginBtn.addEventListener('click', () => {
    window.location.href = '/login';
  });
  logoutBtn.addEventListener('click', () => {
    window.location.href = '/logout';
  });

  /* ------------------------------------------------------------------
     4) Check if user is logged in
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
      // Not logged in => no toast needed, we'll just show login
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
    // not logged in => stop
    return;
  }

  /* ------------------------------------------------------------------
     5) Fetch user list 
  ------------------------------------------------------------------ */
  let prefetchedUsers = [];
  let lastKnownUserVersion = 1;
  try {
    const data = await fetchJSON('/api/all_users');
    prefetchedUsers = data.users || [];
  } catch (err) {
    showError(`Failed to load user list: ${err.message}`);
  }

  /* ------------------------------------------------------------------
     6) Fetch Rooms
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
     7) Build color-coded checkboxes 
  ------------------------------------------------------------------ */
  let storedSelections = [];
  try {
    const raw = localStorage.getItem('selectedRoomIds');
    if (raw) {
      storedSelections = JSON.parse(raw);
    }
  } catch (err) {
    console.error('Error parsing localStorage:', err);
  }

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

    if (storedSelections.includes(room.id)) {
      chk.checked = true;
    }

    const lbl = document.createElement('label');
    lbl.setAttribute('for', `roomChk_${room.id}`);
    lbl.textContent = room.summary;

    chk.addEventListener('change', onRoomsCheckboxChange);

    wrapper.appendChild(chk);
    wrapper.appendChild(lbl);
    roomsCheckboxBar.appendChild(wrapper);
  });

  /* ------------------------------------------------------------------
     8) Single & Multi Calendar Setup
  ------------------------------------------------------------------ */
  let singleCalendar;
  let multiCalendar;
  let singleRoomId = null;

  // Overlap check
  function doesOverlap(movingEvent, newStart, newEnd, calendar) {
    const allEvents = calendar.getEvents();
    for (const ev of allEvents) {
      if (ev.id === movingEvent.id) continue;
      const evStart = ev.start?.getTime();
      const evEnd   = (ev.end || ev.start)?.getTime();
      const newStartMs = newStart.getTime();
      const newEndMs   = newEnd.getTime();

      if (evStart < newEndMs && evEnd > newStartMs) {
        return true;
      }
    }
    return false;
  }

  // SINGLE CALENDAR
  singleCalendar = new FullCalendar.Calendar(singleCalendarEl, {
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
    selectable: true,
    selectMirror: true,
    editable: true,
    eventResizableFromStart: true,

    selectAllow: (selectInfo) => {
      if (isPast(selectInfo.start)) return false;
      const dummyEvent = { id: 'dummy' };
      return !doesOverlap(dummyEvent, selectInfo.start, selectInfo.end, singleCalendar);
    },

    select: (info) => {
      if (!singleRoomId) return;
      openEventModal({
        calendarId: singleRoomId,
        start: info.start,
        end: info.end
      });
    },

    eventClick: (clickInfo) => {
      if (!singleRoomId) return;
      openViewEventModal(clickInfo.event, singleRoomId);
    },

    events: async (info, successCallback, failureCallback) => {
      if (!singleRoomId) {
        successCallback([]);
        return;
      }
      try {
        const data = await fetchJSON(`/api/room_data?calendarId=${encodeURIComponent(singleRoomId)}`);
        successCallback(data.events || []);
      } catch (err) {
        showError(`Failed to load single-room events: ${err.message}`);
        failureCallback(err);
      }
    },

    eventDrop: async (info) => {
      if (!confirm("Are you sure you want to move this event?")) {
        info.revert();
        return;
      }
      const event = info.event;
      const newStart = event.start;
      const newEnd   = event.end || new Date(newStart.getTime() + 30 * 60 * 1000);

      if (doesOverlap(event, newStart, newEnd, singleCalendar)) {
        showToast('Error', "This move overlaps another event in this room. Reverting.");
        info.revert();
        return;
      }

      showSpinner();
      try {
        await updateEvent({
          calendarId: singleRoomId,
          eventId: event.id,
          title: event.title,
          start: newStart.toISOString(),
          end:   newEnd.toISOString(),
          participants: event.extendedProps.attendees || []
        });
        showToast("Updated", "Event was successfully moved.");
      } catch (err) {
        showError(`Failed to move event: ${err.message}`);
        info.revert();
      } finally {
        hideSpinner();
      }
    },

    eventResize: async (info) => {
      if (!confirm("Are you sure you want to resize this event?")) {
        info.revert();
        return;
      }
      const event = info.event;
      const newStart = event.start;
      const newEnd   = event.end;

      if (!newEnd) {
        info.revert();
        return;
      }

      if (doesOverlap(event, newStart, newEnd, singleCalendar)) {
        showToast('Error', "Resized event overlaps another event in this room. Reverting.");
        info.revert();
        return;
      }

      showSpinner();
      try {
        await updateEvent({
          calendarId: singleRoomId,
          eventId: event.id,
          title: event.title,
          start: newStart.toISOString(),
          end:   newEnd.toISOString(),
          participants: event.extendedProps.attendees || []
        });
        showToast("Updated", "Event was resized successfully.");
      } catch (err) {
        showError(`Failed to resize event: ${err.message}`);
        info.revert();
      } finally {
        hideSpinner();
      }
    },
  });
  singleCalendar.render();

  // MULTI CALENDAR
  multiCalendar = new FullCalendar.Calendar(multiCalendarEl, {
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
    editable: true,
    eventResizableFromStart: true,

    dateClick: (info) => {
      showToast("Multiple Rooms", "Select single-room view to create an event.");
    },
    eventClick: (clickInfo) => {
      const source = clickInfo.event.source;
      const rawUrl = source?.url || '';
      const match  = rawUrl.match(/calendarId=([^&]+)/);
      const roomId = match ? decodeURIComponent(match[1]) : null;
      openViewEventModal(clickInfo.event, roomId);
    },

    eventDrop: async (info) => {
      if (!confirm("Move this event? (Multi-room view)")) {
        info.revert();
        return;
      }
      const event = info.event;
      const newStart = event.start;
      const newEnd   = event.end || new Date(newStart.getTime() + 30*60*1000);

      const sourceUrl = event.source?.url || '';
      const match = sourceUrl.match(/calendarId=([^&]+)/);
      const calId = match ? decodeURIComponent(match[1]) : null;

      if (!calId) {
        info.revert();
        return;
      }

      showSpinner();
      try {
        await updateEvent({
          calendarId: calId,
          eventId: event.id,
          title: event.title,
          start: newStart.toISOString(),
          end:   newEnd.toISOString(),
          participants: event.extendedProps.attendees || []
        });
        showToast("Updated", "Event was moved in multi-room view.");
        info.event.source?.refetch();
      } catch (err) {
        showError(`Failed to move event (multi-room): ${err.message}`);
        info.revert();
      } finally {
        hideSpinner();
      }
    },

    eventResize: async (info) => {
      if (!confirm("Resize this event? (Multi-room view)")) {
        info.revert();
        return;
      }
      const event = info.event;
      const newStart = event.start;
      const newEnd   = event.end;

      if (!newEnd) {
        info.revert();
        return;
      }

      const sourceUrl = event.source?.url || '';
      const match = sourceUrl.match(/calendarId=([^&]+)/);
      const calId = match ? decodeURIComponent(match[1]) : null;

      if (!calId) {
        info.revert();
        return;
      }

      showSpinner();
      try {
        await updateEvent({
          calendarId: calId,
          eventId: event.id,
          title: event.title,
          start: newStart.toISOString(),
          end:   newEnd.toISOString(),
          participants: event.extendedProps.attendees || []
        });
        showToast("Updated", "Event was resized in multi-room view.");
        info.event.source?.refetch();
      } catch (err) {
        showError(`Failed to resize event (multi-room): ${err.message}`);
        info.revert();
      } finally {
        hideSpinner();
      }
    },

    eventSources: []
  });
  multiCalendar.render();

  /* ------------------------------------------------------------------
     9) onRoomsCheckboxChange => Single or Multi
  ------------------------------------------------------------------ */
  function onRoomsCheckboxChange() {
    const checkboxes = roomsCheckboxBar.querySelectorAll('input[type="checkbox"]');
    const selectedIds = Array.from(checkboxes)
      .filter(ch => ch.checked)
      .map(ch => ch.value);

    localStorage.setItem('selectedRoomIds', JSON.stringify(selectedIds));

    if (selectedIds.length === 0) {
      selectedIds.push(rooms[0].id);
      const firstChk = document.getElementById(`roomChk_${rooms[0].id}`);
      if (firstChk) firstChk.checked = true;
      localStorage.setItem('selectedRoomIds', JSON.stringify(selectedIds));
    }

    if (selectedIds.length === 1) {
      // Single-Room View
      singleCalendarContainer.style.display = 'block';
      multiCalendarContainer.style.display  = 'none';

      singleRoomId = selectedIds[0];
      const theRoom = rooms.find(r => r.id === singleRoomId);
      selectedRoomName.textContent = theRoom ? theRoom.summary : '';

      singleCalendar.setOption('eventColor', roomColors[singleRoomId]);
      singleCalendar.refetchEvents();
    } else {
      // Multi-Room View
      singleCalendarContainer.style.display = 'none';
      multiCalendarContainer.style.display  = 'block';

      singleRoomId = null;
      selectedRoomName.textContent = '';

      multiCalendar.removeAllEventSources();
      selectedIds.forEach((roomId) => {
        const color = roomColors[roomId] || '#333';
        multiCalendar.addEventSource({
          url: `/api/room_data?calendarId=${encodeURIComponent(roomId)}`,
          method: 'GET',
          success: (data) => data.events || [],
          failure: (err) => {
            showError(`Failed to load multi-room events for ${roomId}: ${err.message}`);
          },
          color: color,
          textColor: '#fff'
        });
      });
    }
  }
  onRoomsCheckboxChange();

  /* ------------------------------------------------------------------
     10) View Event Modal
  ------------------------------------------------------------------ */
  let currentEventId = null;

  function renderReadOnlyChips(containerEl, items) {
    containerEl.innerHTML = '';
    items.forEach((item) => {
      const chip = document.createElement('span');
      chip.className = 'chip badge bg-secondary me-1';
      chip.textContent = item;
      containerEl.appendChild(chip);
    });
  }

  function openViewEventModal(event, calendarId) {
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

    const rawOrganizer = event.extendedProps?.organizer || event.extendedProps?.creator_email || '';
    const rawAttendees = event.extendedProps?.attendees || event.attendees?.map(a => a.email) || [];

    const orgObj = prefetchedUsers.find(u => u.email?.toLowerCase() === rawOrganizer.toLowerCase());
    const organizerLabel = orgObj
      ? `${orgObj.name} <${orgObj.email}>`
      : rawOrganizer;

    const attendeeLabels = rawAttendees.map(addr => {
      const found = prefetchedUsers.find(u => u.email?.toLowerCase() === addr.toLowerCase());
      return found
        ? `${found.name} <${found.email}>`
        : addr;
    });

    renderReadOnlyChips(viewEventOrganizerChips, [organizerLabel]);
    renderReadOnlyChips(viewEventAttendeesChips, attendeeLabels);

    const isLinked = (event.extendedProps?.is_linked === true || event.extendedProps?.is_linked === 'true');
    let canEditOrDelete = true;

    if (isLinked) {
      canEditOrDelete = false;
    } else {
      if (!rawAttendees.includes(currentUserEmail) && rawOrganizer !== currentUserEmail) {
        canEditOrDelete = false;
      }
    }

    viewEventEditBtn.style.display   = canEditOrDelete ? 'inline-block' : 'none';
    viewEventDeleteBtn.style.display = canEditOrDelete ? 'inline-block' : 'none';

    viewEventEditBtn.onclick = () => {
      if (canEditOrDelete) {
        openEventModal({
          calendarId,
          eventId: event.id,
          title: event.title,
          start: event.start,
          end: event.end,
          attendees: rawAttendees
        });
      }
      viewEventModal.hide();
    };

    viewEventDeleteBtn.onclick = async () => {
      if (!canEditOrDelete) return;
      const confirmDelete = confirm('Are you sure you want to delete this event?');
      if (!confirmDelete) return;

      try {
        await deleteEvent({ calendarId, id: event.id });
        event.remove();
        viewEventModal.hide();
        showToast("Deleted", "Event was successfully deleted.");
      } catch (err) {
        showError(`Failed to delete event: ${err.message}`);
      }
    };

    viewEventModal.show();
  }

  /* ------------------------------------------------------------------
     11) Create/Edit Modal => Chips
  ------------------------------------------------------------------ */
  function openEventModal({ calendarId, eventId, title, start, end, attendees }) {
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

    // If updating existing event => do NOT allow changing time in the modal
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
        await updateEvent({
          calendarId,
          eventId,
          title,
          start: startUTC,
          end: endUTC,
          participants
        });
        showToast("Updated", "Event was successfully updated.");
      } else {
        await createEvent({
          calendarId,
          title,
          start: startUTC,
          end: endUTC,
          participants
        });
        showToast("Created", "Event was successfully created.");
      }

      eventModal.hide();

      if (singleRoomId === calendarId) {
        singleCalendar.refetchEvents();
      }
      multiCalendar.getEventSources().forEach(src => src.refetch());

    } catch (err) {
      showError(`Failed to save event: ${err.message}`);
    } finally {
      hideSpinner();
    }
  });

  /* ------------------------------------------------------------------
     12) Chips for participants
  ------------------------------------------------------------------ */
  let inviteChips = [];
  const chipsInput = eventGuestsInput;

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
      eventGuestsContainer.insertBefore(chipEl, chipsInput);
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
     13) Event CRUD Helpers
  ------------------------------------------------------------------ */
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
     14) Polling for Room & User Updates
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
          if (singleRoomId === roomId) {
            singleCalendar.refetchEvents();
          }
          multiCalendar.getEventSources().forEach(src => {
            if (src.url?.includes(roomId)) {
              src.refetch();
            }
          });
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
      }
    } catch (err) {
      showError(`Failed to check user updates: ${err.message}`);
    }
  }

  checkRoomUpdates();
  checkUserUpdates();
});