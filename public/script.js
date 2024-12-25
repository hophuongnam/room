document.addEventListener('DOMContentLoaded', async () => {
  /* ------------------------------------------------------------------
     1) DOM References
  ------------------------------------------------------------------ */
  const loginBtn         = document.getElementById('loginBtn');
  const logoutBtn        = document.getElementById('logoutBtn');
  const errorAlert       = document.getElementById('errorAlert');
  const loadingSpinner   = document.getElementById('loadingSpinner');

  // Rooms dropdown
  const roomDropdown     = document.getElementById('roomDropdown');        // <a> tag
  const roomDropdownMenu = document.getElementById('roomDropdownMenu');    // <ul>

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
  const eventGuestsField       = document.getElementById('eventGuests');

  /* ------------------------------------------------------------------
     2) State Variables
  ------------------------------------------------------------------ */
  let currentUserEmail   = null;
  let isLoggedIn         = false;
  let currentRoomId      = null;
  const calendars        = {}; // { calendarId: FullCalendar instance }
  const lastKnownVersions= {}; // { calendarId: number }

  // We'll also store a map of room IDs => room summaries
  const roomMap = {};   // e.g., { "abc123@group.calendar.google.com": "Room A", ... }

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

  async function createEvent({ calendarId, title, start, end, participants }) {
    return fetchJSON('/api/create_event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId, title, start, end, participants }),
    });
  }

  async function deleteEvent({ calendarId, id }) {
    return fetchJSON('/api/delete_event', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId, id }),
    });
  }

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

  // Login/Logout handlers
  loginBtn?.addEventListener('click', () => {
    window.location.href = '/login';
  });
  logoutBtn?.addEventListener('click', () => {
    window.location.href = '/logout';
  });

  // If not logged in, stop here
  if (!isLoggedIn) {
    return;
  }

  /* ------------------------------------------------------------------
     5) Fetch Rooms
  ------------------------------------------------------------------ */
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

  // Populate the dropdown & store in roomMap
  rooms.forEach((room, index) => {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'dropdown-item';
    link.href = '#';
    link.textContent = room.summary; // This is the room name displayed in the dropdown
    link.addEventListener('click', () => {
      selectRoom(room.id);
    });

    li.appendChild(link);
    roomDropdownMenu.appendChild(li);

    // Add to our roomMap
    roomMap[room.id] = room.summary;

    // Auto-select the first room on page load
    if (index === 0) {
      selectRoom(room.id);
    }
  });

  /* ------------------------------------------------------------------
     6) Select Room => Update Dropdown Text & Load Calendar
  ------------------------------------------------------------------ */
  function selectRoom(roomId) {
    if (currentRoomId === roomId) return; // no change
    currentRoomId = roomId;
    hideError();
    showSpinner();

    // IMPORTANT: Update the dropdown toggle text to the *current room's* name
    roomDropdown.textContent = roomMap[roomId];

    // Initialize (or refetch) the calendar
    initCalendar(roomId);
  }

  /* ------------------------------------------------------------------
     7) Initialize FullCalendar for a Given Room
  ------------------------------------------------------------------ */
  function initCalendar(calendarId) {
    // If we already have a calendar object for this room, refetch events
    if (calendars[calendarId]) {
      calendars[calendarId].refetchEvents();
      hideSpinner();
      return;
    }

    // Otherwise, create a new calendar
    const calendar = new FullCalendar.Calendar(calendarContainer, {
      timeZone: 'local',
      height: 'auto',
      nowIndicator: true,
      slotMinTime: '08:00:00',
      slotMaxTime: '18:00:00',
      initialView: 'timeGridWeek',
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
        if (isPast(info.date)) return;
        openEventModal({
          calendarId,
          start: info.date,
          end: info.date
        });
      },
      selectable: true,
      selectAllow: (selectInfo) => {
        if (isPast(selectInfo.start)) return false;
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
      },
    });
    calendar.render();
    calendars[calendarId] = calendar;
  }

  /* ------------------------------------------------------------------
     8) View Existing Event (Bootstrap Modal)
  ------------------------------------------------------------------ */
  let currentEventId = null; // store the event ID being viewed

  function openViewEventModal(event, calendarId) {
    hideError();

    // Store for delete/edit reference
    currentEventId = event.id;

    // Fill the fields
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

    // Check permission: can edit or delete if user is organizer or attendee
    const canEditOrDelete = (
      attendees.includes(currentUserEmail) ||
      organizer === currentUserEmail
    );
    viewEventEditBtn.style.display   = canEditOrDelete ? 'inline-block' : 'none';
    viewEventDeleteBtn.style.display = canEditOrDelete ? 'inline-block' : 'none';

    // Show the modal
    viewEventModal.show();

    // Edit button
    viewEventEditBtn.onclick = () => {
      if (canEditOrDelete) {
        // Open the create/edit modal with the event data
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

    // Delete button
    viewEventDeleteBtn.onclick = async () => {
      if (!canEditOrDelete) return;
      const confirmDelete = confirm('Are you sure you want to delete this event?');
      if (!confirmDelete) return;

      try {
        await deleteEvent({ calendarId, id: event.id });
        // remove from FullCalendar
        const fcEvent = calendars[calendarId]?.getEventById(event.id);
        if (fcEvent) {
          fcEvent.remove();
        }
        viewEventModal.hide();
      } catch (err) {
        console.error(err);
        showError('Failed to delete event.');
      }
    };
  }

  /* ------------------------------------------------------------------
     9) Create/Edit Modal Logic
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

    if (attendees && attendees.length > 0) {
      eventGuestsField.value = attendees.join(', ');
    } else {
      eventGuestsField.value = '';
    }

    eventModal.show();
  }

  eventForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();

    const calendarId   = calendarIdField.value;
    const eventId      = eventIdField.value;
    const title        = eventTitleField.value.trim();
    const guestsStr    = eventGuestsField.value;
    const participants = guestsStr.split(',').map(s => s.trim()).filter(Boolean);

    const localStart = new Date(eventStartField.value);
    const localEnd   = new Date(eventEndField.value);
    const startUTC   = localStart.toISOString();
    const endUTC     = localEnd.toISOString();

    if (!calendarId || !title || !startUTC || !endUTC) {
      showError('Missing required fields.');
      return;
    }
    if (isPast(localStart)) {
      showError('Cannot create an event in the past.');
      return;
    }
    if (localEnd <= localStart) {
      showError('End time must be after start time.');
      return;
    }

    showSpinner();

    try {
      // If editing => remove old event first
      if (eventId) {
        await deleteEvent({ calendarId, id: eventId });
      }

      // Create on server
      const result = await createEvent({
        calendarId,
        title,
        start: startUTC,
        end: endUTC,
        participants
      });

      eventModal.hide();

      // Immediately add to FullCalendar
      calendars[calendarId]?.addEvent({
        id: result.event_id,
        title,
        start: localStart,
        end: localEnd,
        attendees: participants,
        extendedProps: {
          organizer: currentUserEmail,
          attendees: participants
        }
      });

    } catch (err) {
      console.error(err);
      showError('Failed to save event.');
    } finally {
      hideSpinner();
    }
  });

  /* ------------------------------------------------------------------
     10) Polling for Room Updates
  ------------------------------------------------------------------ */
  setInterval(checkRoomUpdates, 30000);

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

  // Initial check
  checkRoomUpdates();
});
