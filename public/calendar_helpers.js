/* ------------------------------------------------------------------
   calendar_helpers.js
   - Contains helper methods that were previously in calendar.js
   - Expects references from main.js (like window.fetchJSON, showToast, etc.)
------------------------------------------------------------------ */

/**
 * Return ID of the first checked room from #roomsCheckboxBar
 */
function getFirstCheckedRoomId() {
  const roomsCheckboxBar = document.getElementById('roomsCheckboxBar');
  if (!roomsCheckboxBar) return null;
  const checkboxes = roomsCheckboxBar.querySelectorAll('input[type="checkbox"]');
  const checked = Array.from(checkboxes).filter(ch => ch.checked);
  return checked.length > 0 ? checked[0].value : null;
}

/**
 * Return the color of the first checked room, or a fallback color if none
 */
function getFirstCheckedRoomColor() {
  const roomId = getFirstCheckedRoomId();
  if (!roomId) return '#666'; // fallback color if no room is checked
  return window.roomColors && window.roomColors[roomId]
    ? window.roomColors[roomId]
    : '#666';
}

/**
 * Basic overlap check within the same room
 * movingEvent => an event-like object with .extendedProps.realCalendarId
 */
function doesOverlap(movingEvent, newStart, newEnd) {
  const allEvents = window.multiCalendar.getEvents(); // from the main calendar
  const newStartMs = newStart.getTime();
  const newEndMs   = newEnd.getTime();
  const movingRoomId = movingEvent.extendedProps?.realCalendarId || '';

  for (const ev of allEvents) {
    if (ev.id === movingEvent.id) continue; // skip same event

    const evRoomId = ev.extendedProps?.realCalendarId || '';
    if (evRoomId !== movingRoomId) continue; // different room => no conflict

    const evStart = ev.start ? ev.start.getTime() : null;
    const evEnd   = ev.end   ? ev.end.getTime()   : evStart;
    // Overlap check
    if (evStart < newEndMs && evEnd > newStartMs) {
      return true;
    }
  }
  return false;
}

/**
 * Create a new event by calling /api/create_event
 */
async function createEvent({ calendarId, title, start, end, participants, description }) {
  return window.fetchJSON('/api/create_event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendarId, title, start, end, participants, description }),
  });
}

/**
 * Update an existing event
 */
async function updateEvent({ calendarId, eventId, title, start, end, participants, description }) {
  return window.fetchJSON('/api/update_event', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendarId, eventId, title, start, end, participants, description }),
  });
}

/**
 * Delete an event
 */
async function deleteEvent({ calendarId, id }) {
  return window.fetchJSON('/api/delete_event', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendarId, id }),
  });
}

/**
 * Show the read-only ("view event") modal
 */
function openViewEventModal(event, calendarId) {
  const modalEl             = document.getElementById('viewEventModal');
  const viewEventTitleEl    = document.getElementById('viewEventTitle');
  const viewEventRoomEl     = document.getElementById('viewEventRoom');
  const viewEventAttendeesEl= document.getElementById('viewEventAttendeesList');
  const viewEventEditBtn    = document.getElementById('viewEventEditBtn');
  const viewEventDeleteBtn  = document.getElementById('viewEventDeleteBtn');
  const viewEventStartTimeEl= document.getElementById('viewEventStartTime');
  const viewEventEndTimeEl  = document.getElementById('viewEventEndTime');
  const colorCircleEl       = modalEl.querySelector('.color-circle');
  const viewEventDescriptionRow = document.getElementById('viewEventDescriptionRow');
  const viewEventDescriptionEl  = document.getElementById('viewEventDescription');

  // Get room info from global rooms
  const foundRoom = window.rooms.find(r => r.id === calendarId);
  const roomName  = foundRoom ? foundRoom.summary : "Unknown Room";
  const roomColor = window.roomColors[calendarId] || '#0d6efd';

  // Title
  viewEventTitleEl.textContent = event.title || 'Untitled';

  // Start/End
  const startTime = event.start ? new Date(event.start) : null;
  const endTime   = event.end   ? new Date(event.end)   : null;
  const formatOpts= { 
    year: 'numeric', month: 'long', day: 'numeric', 
    hour: '2-digit', minute: '2-digit' 
  };

  viewEventStartTimeEl.textContent = startTime
    ? startTime.toLocaleString([], formatOpts)
    : 'N/A';
  viewEventEndTimeEl.textContent   = endTime
    ? endTime.toLocaleString([], formatOpts)
    : 'N/A';

  // Room
  viewEventRoomEl.textContent = roomName;
  if (colorCircleEl) {
    colorCircleEl.style.backgroundColor = roomColor;
  }

  // Attendees
  const rawAttendees = event.extendedProps?.attendees || event.attendees?.map(a => a.email) || [];
  viewEventAttendeesEl.innerHTML = '';
  rawAttendees.forEach(email => {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'd-flex align-items-center gap-2 mb-2';
    const icon = document.createElement('i');
    icon.className = 'bi bi-envelope';
    const span = document.createElement('span');
    span.textContent = email;
    rowDiv.appendChild(icon);
    rowDiv.appendChild(span);
    viewEventAttendeesEl.appendChild(rowDiv);
  });

  // Description
  const description = event.extendedProps?.description || '';
  if (description) {
    viewEventDescriptionEl.textContent = description;
    viewEventDescriptionRow.classList.remove('d-none');
  } else {
    viewEventDescriptionEl.textContent = '';
    viewEventDescriptionRow.classList.add('d-none');
  }

  // Permissions
  const isLinked     = event.extendedProps?.is_linked === 'true';
  const creatorEmail = event.extendedProps?.organizer;
  let canEditOrDelete = true;

  if (isLinked) {
    // If it's a "linked" event, disallow direct editing
    canEditOrDelete = false;
  } else {
    // If user not in attendees and not the creator => no edit
    if (!rawAttendees.includes(window.currentUserEmail) && creatorEmail !== window.currentUserEmail) {
      canEditOrDelete = false;
    }
  }

  viewEventEditBtn.style.display   = canEditOrDelete ? 'inline-block' : 'none';
  viewEventDeleteBtn.style.display = canEditOrDelete ? 'inline-block' : 'none';

  // Edit => open create/edit
  viewEventEditBtn.onclick = () => {
    if (!canEditOrDelete) return;
    openEventModal({
      calendarId,
      eventId: event.id,
      title: event.title,
      start: event.start,
      end: event.end,
      attendees: rawAttendees,
      description
    });

    const bsInstance = bootstrap.Modal.getInstance(modalEl);
    if (bsInstance) bsInstance.hide();
  };

  // Delete => confirm => call /api
  viewEventDeleteBtn.onclick = async () => {
    if (!canEditOrDelete) return;
    const confirmDelete = confirm('Are you sure you want to delete this event?');
    if (!confirmDelete) return;

    try {
      await deleteEvent({ calendarId, id: event.id });
      // remove from local memory
      window.allEventsMap[calendarId] = window.allEventsMap[calendarId].filter(ev => ev.id !== event.id);
      // refresh the main calendar
      window.multiCalendar.refetchEvents();

      const bsInstance = bootstrap.Modal.getInstance(modalEl);
      if (bsInstance) bsInstance.hide();
      window.showToast("Deleted", "Event was successfully deleted.");
    } catch (err) {
      window.showError(`Failed to delete event: ${err.message}`);
    }
  };

  // Show modal
  const bsModal = new bootstrap.Modal(modalEl);
  bsModal.show();
}

/**
 * openEventModal(options)
 * Show the create/edit event modal
 */
function openEventModal({ calendarId, eventId, title, start, end, attendees, description }) {
  const {
    eventModal,
    calendarIdField,
    eventIdField,
    eventTitleField,
    eventStartField,
    eventEndField,
    inviteChips,
    prefetchedUsers
  } = window;

  const eventRoomSelect       = document.getElementById('eventRoomSelect');
  const roomColorSquare       = document.getElementById('roomColorSquare');
  const eventDescriptionField = document.getElementById('eventDescription');

  // Clear old <options> from the Room <select>
  eventRoomSelect.innerHTML = '';

  // Which rooms are currently checked?
  const roomsCheckboxBar = document.getElementById('roomsCheckboxBar');
  const checkboxes = roomsCheckboxBar.querySelectorAll('input[type="checkbox"]');
  const checkedRoomIds = Array.from(checkboxes).filter(ch => ch.checked).map(ch => ch.value);

  let defaultCalId = calendarId;
  if (!defaultCalId) {
    defaultCalId = (checkedRoomIds.length > 0)
      ? checkedRoomIds[0]
      : (window.rooms.length > 0 ? window.rooms[0].id : null);
  }

  // Populate the <select> with all known rooms
  window.rooms.forEach((room) => {
    const option = document.createElement('option');
    option.value = room.id;
    option.textContent = room.summary;
    if (room.id === defaultCalId) {
      option.selected = true;
    }
    eventRoomSelect.appendChild(option);
  });

  function setSquareColor(calId) {
    const c = window.roomColors[calId] || '#666';
    roomColorSquare.style.backgroundColor = c;
  }
  setSquareColor(defaultCalId);

  eventRoomSelect.addEventListener('change', () => {
    setSquareColor(eventRoomSelect.value);
  });

  // Hidden fields
  calendarIdField.value = defaultCalId || '';
  eventIdField.value    = eventId      || '';
  eventTitleField.value = title        || '';

  // If creating a new event => reset chips
  if (!eventId) {
    window.inviteChips = [];
    window.clearChipsUI();

    if (start) eventStartField.value = window.toLocalDateTimeInput(new Date(start));
    else       eventStartField.value = '';
    if (end)   eventEndField.value   = window.toLocalDateTimeInput(new Date(end));
    else       eventEndField.value   = '';
  } else {
    // editing => if we have start/end, ensure the field is filled
    if (!eventStartField.value && start) {
      eventStartField.value = window.toLocalDateTimeInput(new Date(start));
    }
    if (!eventEndField.value && end) {
      eventEndField.value = window.toLocalDateTimeInput(new Date(end));
    }
  }

  // Pre-populate chips if editing
  if (attendees && attendees.length > 0) {
    attendees.forEach(email => {
      const existing = inviteChips.find(ch => ch.email === email);
      if (!existing) {
        const userObj = prefetchedUsers?.find(u => u.email === email);
        if (userObj) {
          window.addChip({
            label: userObj.name ? `${userObj.name} <${userObj.email}>` : userObj.email,
            email: userObj.email
          });
        } else {
          window.addChip({ label: email, email });
        }
      }
    });
    window.renderChipsUI();
  }

  if (!eventId || !eventDescriptionField.value) {
    eventDescriptionField.value = description || '';
  }

  // Force "Event Details" tab in the modal
  const locationTabBtn = document.getElementById('location-tab');
  const blankTabBtn    = document.getElementById('blank-tab');
  const locationPane   = document.getElementById('location');
  const blankPane      = document.getElementById('blank');

  blankTabBtn.classList.remove('active');
  blankPane.classList.remove('show', 'active');
  locationTabBtn.classList.add('active');
  locationPane.classList.add('show', 'active');

  eventModal.show();
}

/* ------------------------------------------------------------------
   Expose them as a global object or individually
------------------------------------------------------------------ */
window.calendarHelpers = {
  getFirstCheckedRoomId,
  getFirstCheckedRoomColor,
  doesOverlap,
  createEvent,
  updateEvent,
  deleteEvent,
  openViewEventModal,
  openEventModal
};