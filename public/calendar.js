/* ------------------------------------------------------------------
   calendar.js (THU + FB combined)
   - Uses dynamic resources(...) for main rooms => columns appear only for checked rooms.
   - Integrates a "Find a time" tab that fetches /api/freebusy and shows busy blocks.
   - Relies on global variables from main.js:
       showToast, showError, showSpinner, hideSpinner, fetchJSON, etc.
       currentUserEmail, rooms, roomColors, inviteChips, ...
------------------------------------------------------------------ */

function initCalendar() {
  const multiCalendarEl = document.getElementById('multiCalendar');
  if (!multiCalendarEl) {
    console.error("Could not find #multiCalendar element in the DOM.");
    return;
  }

  // Retrieve last used view from localStorage, or default
  const savedView = localStorage.getItem('userSelectedView') || 'timeGridWeek';

  window.multiCalendar = new FullCalendar.Calendar(multiCalendarEl, {
    schedulerLicenseKey: 'GPL-My-Project-Is-Open-Source',
    timeZone: 'local',
    height: 'auto',
    nowIndicator: true,
    slotMinTime: '08:00:00',
    slotMaxTime: '18:00:00',
    initialView: savedView,
    resourceOrder: 'orderIndex',
    firstDay: 1,

    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'resourceTimeGridDay,timeGridWeek,dayGridMonth'
    },
    editable: true,
    eventResizableFromStart: true,
    selectMirror: true,
    selectable: true,

    /**
     * 1) DYNAMIC RESOURCES:
     * Only show columns for rooms that are checked in #roomsCheckboxBar.
     */
    resources(fetchInfo, successCallback, failureCallback) {
      const checkboxes = document.querySelectorAll('#roomsCheckboxBar input[type="checkbox"]');
      const selectedRoomIds = Array.from(checkboxes)
        .filter(ch => ch.checked)
        .map(ch => ch.value);

      const displayedResources = window.rooms
        .filter(r => selectedRoomIds.includes(r.id))
        .map(r => ({
          id: r.id,
          title: r.summary,
          orderIndex: r._sortOrder || 9999 // optional sorting
        }));

      successCallback(displayedResources);
    },

    /**
     * 2) EVENTS:
     * Return events only for the checked rooms. We assign each event resourceId = roomId.
     */
    events(fetchInfo, successCallback, failureCallback) {
      const checkboxes = document.querySelectorAll('#roomsCheckboxBar input[type="checkbox"]');
      const selectedRoomIds = Array.from(checkboxes)
        .filter(ch => ch.checked)
        .map(ch => ch.value);

      const mergedEvents = [];
      for (const roomId of selectedRoomIds) {
        const roomEvents = window.allEventsMap[roomId] || [];
        roomEvents.forEach(ev => {
          mergedEvents.push({
            ...ev,
            resourceId: roomId,
            backgroundColor: window.roomColors[roomId] || '#333',
            textColor: '#fff',
            extendedProps: {
              ...(ev.extendedProps || {}),
              realCalendarId: roomId
            }
          });
        });
      }
      successCallback(mergedEvents);
    },

    /**
     * 3) Prevent selecting a past time.
     */
    selectAllow(selectInfo) {
      return selectInfo.start >= new Date();
    },

    /**
     * 4) Handle user drag-select => create event.
     */
    select(info) {
      const firstRoomId = getFirstCheckedRoomId();
      if (!firstRoomId) {
        window.showToast('Notice', 'No room selected.');
        window.multiCalendar.unselect();
        return;
      }

      // Overlap check
      const dummyEvent = { id: 'dummy', extendedProps: { realCalendarId: firstRoomId } };
      if (doesOverlap(dummyEvent, info.start, info.end)) {
        window.showToast('Error', 'Time slot overlaps an existing event in that room.');
        window.multiCalendar.unselect();
        return;
      }

      openEventModal({
        calendarId: firstRoomId,
        start: info.start,
        end: info.end
      });
    },

    /**
     * 5) dateClick => quick creation of a 30-min event if no range selected.
     */
    dateClick(info) {
      const start = info.date;
      const end   = new Date(start.getTime() + 30 * 60 * 1000);
      const firstRoomId = getFirstCheckedRoomId();
      if (!firstRoomId) {
        window.showToast('Notice', 'No room selected.');
        return;
      }
      if (start < new Date()) {
        window.showToast('Error', 'Cannot create an event in the past.');
        return;
      }

      // Overlap check
      const dummyEvent = { id: 'dummy', extendedProps: { realCalendarId: firstRoomId } };
      if (doesOverlap(dummyEvent, start, end)) {
        window.showToast('Error', 'Time slot overlaps an existing event in that room.');
        return;
      }

      openEventModal({
        calendarId: firstRoomId,
        start,
        end
      });
    },

    /**
     * 6) eventClick => open "View Event" modal
     */
    eventClick(info) {
      const event = info.event;
      const calendarId = event.extendedProps?.realCalendarId;
      if (!calendarId) return;

      openViewEventModal(event, calendarId);
    },

    /**
     * 7) Drag event => update
     */
    eventDrop(info) {
      const event   = info.event;
      const newStart= event.start;
      const newEnd  = event.end || new Date(newStart.getTime() + 30*60*1000);

      if (doesOverlap(event, newStart, newEnd)) {
        window.showToast('Error', 'This move overlaps another event. Reverting.');
        info.revert();
        return;
      }

      const roomId = event.extendedProps?.realCalendarId;
      if (!roomId) {
        info.revert();
        return;
      }

      window.showSpinner();
      setTimeout(async () => {
        try {
          await updateEvent({
            calendarId: roomId,
            eventId: event.id,
            title: event.title,
            start: newStart.toISOString(),
            end:   newEnd.toISOString(),
            participants: event.extendedProps.attendees || [],
            description: event.extendedProps.description || ""
          });
          window.showToast('Updated', 'Event was successfully moved.');
          await window.resyncSingleRoom(roomId);
          // Refresh the entire calendar
          window.multiCalendar.refetchEvents();
        } catch (err) {
          window.showError(`Failed to move event: ${err.message}`);
          info.revert();
        } finally {
          window.hideSpinner();
        }
      }, 0);
    },

    /**
     * 8) Resize event => update
     */
    eventResize(info) {
      const event   = info.event;
      const newStart= event.start;
      const newEnd  = event.end;

      if (!newEnd) {
        info.revert();
        return;
      }
      if (doesOverlap(event, newStart, newEnd)) {
        window.showToast('Error', 'Resized event overlaps. Reverting.');
        info.revert();
        return;
      }

      const roomId = event.extendedProps?.realCalendarId;
      if (!roomId) {
        info.revert();
        return;
      }

      window.showSpinner();
      setTimeout(async () => {
        try {
          await updateEvent({
            calendarId: roomId,
            eventId: event.id,
            title: event.title,
            start: newStart.toISOString(),
            end:   newEnd.toISOString(),
            participants: event.extendedProps.attendees || [],
            description: event.extendedProps.description || ""
          });
          window.showToast('Updated', 'Event was resized successfully.');
          await window.resyncSingleRoom(roomId);
          window.multiCalendar.refetchEvents();
        } catch (err) {
          window.showError(`Failed to resize event: ${err.message}`);
          info.revert();
        } finally {
          window.hideSpinner();
        }
      }, 0);
    }
  });

  // Render the main calendar
  window.multiCalendar.render();
}

/* ------------------------------------------------------------------
   doesOverlap(event, newStart, newEnd)
   Checks if [newStart, newEnd) overlaps any event in the same room.
------------------------------------------------------------------ */
function doesOverlap(movingEvent, newStart, newEnd) {
  const allEvents = window.multiCalendar.getEvents();
  const newStartMs = newStart.getTime();
  const newEndMs   = newEnd.getTime();
  const movingRoomId = movingEvent.extendedProps?.realCalendarId || '';

  for (const ev of allEvents) {
    if (ev.id === movingEvent.id) continue; // skip same event

    // Must be same room
    const evRoomId = ev.extendedProps?.realCalendarId || '';
    if (evRoomId !== movingRoomId) continue;

    const evStart = ev.start ? ev.start.getTime() : null;
    const evEnd   = ev.end   ? ev.end.getTime()   : evStart;
    // Basic interval overlap
    if (evStart < newEndMs && evEnd > newStartMs) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------
   getFirstCheckedRoomId()
------------------------------------------------------------------ */
function getFirstCheckedRoomId() {
  const roomsCheckboxBar = document.getElementById('roomsCheckboxBar');
  if (!roomsCheckboxBar) return null;
  const checkboxes = roomsCheckboxBar.querySelectorAll('input[type="checkbox"]');
  const checked = Array.from(checkboxes).filter(ch => ch.checked);
  return checked.length > 0 ? checked[0].value : null;
}

/* ------------------------------------------------------------------
   View Event Modal
------------------------------------------------------------------ */
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

  // Room name/color
  const foundRoom = window.rooms.find(r => r.id === calendarId);
  const roomName  = foundRoom ? foundRoom.summary : "Unknown Room";
  const roomColor = window.roomColors[calendarId] || '#0d6efd';

  // Title
  viewEventTitleEl.textContent = event.title || 'Untitled';

  // Start/End
  const startTime = event.start ? new Date(event.start) : null;
  const endTime   = event.end   ? new Date(event.end)   : null;
  const formatOpts= { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };

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
window.openViewEventModal = openViewEventModal;

/* ------------------------------------------------------------------
   Create/Edit Event Modal
------------------------------------------------------------------ */
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
        const userObj = prefetchedUsers.find(u => u.email === email);
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
window.openEventModal = openEventModal;

/* ------------------------------------------------------------------
   createEvent / updateEvent / deleteEvent
------------------------------------------------------------------ */
async function createEvent({ calendarId, title, start, end, participants, description }) {
  return window.fetchJSON('/api/create_event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendarId, title, start, end, participants, description }),
  });
}
async function updateEvent({ calendarId, eventId, title, start, end, participants, description }) {
  return window.fetchJSON('/api/update_event', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendarId, eventId, title, start, end, participants, description }),
  });
}
async function deleteEvent({ calendarId, id }) {
  return window.fetchJSON('/api/delete_event', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendarId, id }),
  });
}

/* ------------------------------------------------------------------
   Resync Single Room
------------------------------------------------------------------ */
window.resyncSingleRoom = async function(roomId) {
  try {
    const resp = await window.fetchJSON(`/api/room_data?calendarId=${encodeURIComponent(roomId)}`);
    window.allEventsMap[roomId] = resp.events || [];
  } catch (err) {
    window.showError(`Failed to refresh room data: ${err.message}`);
  }
};

/* ------------------------------------------------------------------
   "Find a time" Tab => Free/Busy logic from FB approach
------------------------------------------------------------------ */
document.addEventListener('DOMContentLoaded', () => {
  const findTimeTabBtn = document.getElementById('blank-tab');
  if (!findTimeTabBtn) return;

  findTimeTabBtn.addEventListener('shown.bs.tab', async () => {
    const {
      eventStartField,
      eventEndField,
      inviteChips,
      fetchJSON,
      showSpinner,
      hideSpinner,
      showError
    } = window;

    const resourceCalendarEl = document.getElementById('resourceCalendar');
    if (!resourceCalendarEl) return;

    // Clear old content
    resourceCalendarEl.innerHTML = '';

    const startVal = eventStartField.value;
    const endVal   = eventEndField.value;
    const participants = inviteChips.map(ch => ch.email);

    if (!startVal || !endVal || participants.length === 0) {
      resourceCalendarEl.innerHTML = `
        <div class="mt-3">
          <p class="text-muted">
            Please select start/end time and add attendees before checking free/busy.
          </p>
        </div>
      `;
      return;
    }

    // Convert to UTC
    const startIso = new Date(startVal).toISOString();
    const endIso   = new Date(endVal).toISOString();

    try {
      showSpinner();
      const resp = await fetchJSON('/api/freebusy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: startIso,
          end:   endIso,
          attendees: participants
        })
      });

      // Build resources from participants
      const resources = participants.map(email => ({
        id: email,
        title: email
      }));

      // For each busy interval => create a background event
      const events = [];
      for (const personId in resp.freebusy) {
        const intervals = resp.freebusy[personId] || [];
        intervals.forEach(block => {
          events.push({
            resourceId: personId,
            start: block.start,
            end:   block.end,
            display: 'background',
            color: '#ff0000'
          });
        });
      }

      // Initialize a single-day resourceTimeGrid
      const initDate = startIso.substring(0, 10); // 'YYYY-MM-DD'
      const resourceCalendar = new FullCalendar.Calendar(resourceCalendarEl, {
        schedulerLicenseKey: 'GPL-My-Project-Is-Open-Source',
        initialView: 'resourceTimeGridDay',
        initialDate: initDate,
        nowIndicator: true,
        slotMinTime: '08:00:00',
        slotMaxTime: '18:00:00',
        resources,
        events
      });

      resourceCalendar.render();
    } catch (err) {
      showError(`Failed to fetch free/busy info: ${err.message}`);
      resourceCalendarEl.innerHTML = '<p class="text-danger">Error loading free/busy.</p>';
    } finally {
      hideSpinner();
    }
  });
});
