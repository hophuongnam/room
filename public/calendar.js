/* ------------------------------------------------------------------
   calendar.js (TOT Version, with persisted user view in localStorage)
   - Single FullCalendar instance that can switch between resourceTimeGridDay,
     timeGridWeek, or dayGridMonth, while remembering the last-chosen view.
   - Uses extendedProps.realCalendarId to store the calendar ID.
   - Includes localStorage logic to persist the chosen view.
------------------------------------------------------------------ */

function initCalendar() {
  const multiCalendarEl = document.getElementById('multiCalendar');
  if (!multiCalendarEl) {
    console.error("Could not find #multiCalendar element in the DOM.");
    return;
  }

  // Retrieve last used view from localStorage, default to 'timeGridWeek'
  const savedView = localStorage.getItem('userSelectedView') || 'timeGridWeek';

  window.multiCalendar = new FullCalendar.Calendar(multiCalendarEl, {
    schedulerLicenseKey: 'GPL-My-Project-Is-Open-Source', // or your license key
    timeZone: 'local',
    height: 'auto',
    nowIndicator: true,
    slotMinTime: '08:00:00',
    slotMaxTime: '18:00:00',
    resourceOrder: 'orderIndex',
    
    // Use the stored view (or default to 'timeGridWeek') on load
    initialView: savedView,

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

    // Define the rooms as resources for the resourceTimeGridDay view
    resources: window.rooms.map((r) => ({
      id: r.id,
      title: r.summary,
      orderIndex: r._sortOrder
    })),

    // Called whenever the view changes (including initial load)
    datesSet(arg) {
      // Save the user’s chosen view in localStorage
      const currentViewType = arg.view.type;
      localStorage.setItem('userSelectedView', currentViewType);
    },

    /* 
       Build the event list by merging all selected rooms' events.
       We store realCalendarId in extendedProps so we can open the 
       correct calendar in eventClick.
    */
    events(info, successCallback) {
      const checkboxes = document.querySelectorAll('#roomsCheckboxBar input[type="checkbox"]');
      const selectedRoomIds = Array.from(checkboxes)
        .filter(ch => ch.checked)
        .map(ch => ch.value);

      const mergedEvents = [];
      for (const roomId of selectedRoomIds) {
        const roomEvents = window.allEventsMap[roomId] || [];
        for (const ev of roomEvents) {
          mergedEvents.push({
            ...ev,
            resourceId: roomId, // For resourceTimeGridDay
            backgroundColor: window.roomColors[roomId] || '#333',
            textColor: '#fff',
            extendedProps: {
              ...(ev.extendedProps || {}),
              // Store the actual calendar ID
              realCalendarId: roomId
            }
          });
        }
      }
      successCallback(mergedEvents);
    },

    // Prevent selecting in the past
    selectAllow(selectInfo) {
      if (selectInfo.start < new Date()) {
        return false;
      }
      return true;
    },

    // Handling select => open the "create event" modal
    select(info) {
      const firstSelectedRoomId = getFirstCheckedRoomId();
      if (!firstSelectedRoomId) {
        window.showToast('Notice', 'No room selected.');
        window.multiCalendar.unselect();
        return;
      }

      // Overlap check
      if (doesOverlap({ id: 'dummy', source: { id: firstSelectedRoomId } }, info.start, info.end)) {
        window.showToast('Error', 'Time slot overlaps an existing event in that room.');
        window.multiCalendar.unselect();
        return;
      }

      openEventModal({
        calendarId: firstSelectedRoomId,
        start: info.start,
        end: info.end
      });
    },

    // dateClick also used for quick creation if no range is selected
    dateClick(info) {
      const start = info.date;
      const end   = new Date(start.getTime() + 30 * 60 * 1000);

      const firstSelectedRoomId = getFirstCheckedRoomId();
      if (!firstSelectedRoomId) {
        window.showToast('Notice', 'No room selected.');
        return;
      }

      // Prevent in the past
      if (start < new Date()) {
        window.showToast('Error', 'Cannot create an event in the past.');
        return;
      }

      // Overlap check
      if (doesOverlap({ id: 'dummy', source: { id: firstSelectedRoomId } }, start, end)) {
        window.showToast('Error', 'Time slot overlaps an existing event in that room.');
        return;
      }

      openEventModal({
        calendarId: firstSelectedRoomId,
        start,
        end
      });
    },

    // eventClick => open the "View Event" modal
    eventClick(info) {
      const event = info.event;
      // Read from extendedProps
      const calendarId = event.extendedProps?.realCalendarId;

      if (!calendarId) {
        return;
      }

      openViewEventModal(event, calendarId);
    },

    // Dragging an event
    eventDrop(info) {
      const event   = info.event;
      const newStart= event.start;
      const newEnd  = event.end || new Date(newStart.getTime() + 30*60*1000);

      // Overlap check
      if (doesOverlap(event, newStart, newEnd)) {
        window.showToast('Error', "This move overlaps another event. Reverting.");
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
          window.showToast("Updated", "Event was successfully moved.");
          await window.resyncSingleRoom(roomId);
        } catch (err) {
          window.showError(`Failed to move event: ${err.message}`);
          info.revert();
        } finally {
          window.hideSpinner();
        }
      }, 0);
    },

    // Resizing an event
    eventResize(info) {
      const event   = info.event;
      const newStart= event.start;
      const newEnd  = event.end;

      if (!newEnd) {
        info.revert();
        return;
      }

      if (doesOverlap(event, newStart, newEnd)) {
        window.showToast('Error', "Resized event overlaps. Reverting.");
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
          window.showToast("Updated", "Event was resized successfully.");
          await window.resyncSingleRoom(roomId);
        } catch (err) {
          window.showError(`Failed to resize event: ${err.message}`);
          info.revert();
        } finally {
          window.hideSpinner();
        }
      }, 0);
    }
  });

  // Render the calendar
  window.multiCalendar.render();
}

/* ------------------------------------------------------------------
   doesOverlap(movingEvent, newStart, newEnd)
   - Overlap logic for a single room
------------------------------------------------------------------ */
function doesOverlap(movingEvent, newStart, newEnd) {
  const allEvents = window.multiCalendar.getEvents();
  const newStartMs = newStart.getTime();
  const newEndMs   = newEnd.getTime();

  for (const ev of allEvents) {
    if (ev.id === movingEvent.id) continue;

    const evRoomId = ev.extendedProps?.realCalendarId || '';
    const movingRoomId = movingEvent.extendedProps?.realCalendarId || '';

    if (evRoomId !== movingRoomId) continue;

    const evStart = ev.start ? ev.start.getTime() : null;
    const evEnd   = ev.end   ? ev.end.getTime()   : evStart;

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
   openViewEventModal(event, calendarId)
------------------------------------------------------------------ */
function openViewEventModal(event, calendarId) {
  const viewEventModalEl      = document.getElementById('viewEventModal');
  const viewEventTitleEl      = document.getElementById('viewEventTitle');
  const viewEventRoomEl       = document.getElementById('viewEventRoom');
  const viewEventAttendeesEl  = document.getElementById('viewEventAttendeesList');
  const viewEventEditBtn      = document.getElementById('viewEventEditBtn');
  const viewEventDeleteBtn    = document.getElementById('viewEventDeleteBtn');
  const viewEventStartTimeEl  = document.getElementById('viewEventStartTime');
  const viewEventEndTimeEl    = document.getElementById('viewEventEndTime');
  const colorCircleEl         = viewEventModalEl.querySelector('.color-circle');
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

  viewEventStartTimeEl.textContent = startTime ? startTime.toLocaleString([], formatOpts) : 'N/A';
  viewEventEndTimeEl.textContent   = endTime   ? endTime.toLocaleString([], formatOpts)   : 'N/A';

  // Room name
  viewEventRoomEl.textContent = roomName;

  // Color circle
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

  // Permissions check
  const isLinked     = event.extendedProps?.is_linked === 'true';
  const creatorEmail = event.extendedProps?.organizer;
  let canEditOrDelete = true;

  if (isLinked) {
    canEditOrDelete = false;
  } else {
    if (!rawAttendees.includes(window.currentUserEmail) && creatorEmail !== window.currentUserEmail) {
      canEditOrDelete = false;
    }
  }

  viewEventEditBtn.style.display   = canEditOrDelete ? 'inline-block' : 'none';
  viewEventDeleteBtn.style.display = canEditOrDelete ? 'inline-block' : 'none';

  // Edit => open the create/edit modal
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

    // Hide the view modal
    window.viewEventModal.hide();
  };

  // Delete => confirm, then call /api
  viewEventDeleteBtn.onclick = async () => {
    if (!canEditOrDelete) return;
    const confirmDelete = confirm('Are you sure you want to delete this event?');
    if (!confirmDelete) return;

    try {
      await deleteEvent({ calendarId, id: event.id });
      // Remove from local map
      window.allEventsMap[calendarId] = window.allEventsMap[calendarId].filter(ev => ev.id !== event.id);
      // Refresh the calendar
      window.multiCalendar.refetchEvents();

      window.viewEventModal.hide();
      window.showToast("Deleted", "Event was successfully deleted.");
    } catch (err) {
      window.showError(`Failed to delete event: ${err.message}`);
    }
  };

  // Show the "View Event" modal
  window.viewEventModal.show();
}

/* ------------------------------------------------------------------
   openEventModal(...)
   - Create/edit event modal
------------------------------------------------------------------ */
function openEventModal({ calendarId, eventId, title, start, end, attendees, description }) {
  const {
    eventModal,
    calendarIdField,
    eventIdField,
    eventTitleField,
    eventStartField,
    eventEndField
  } = window;

  const eventRoomSelect       = document.getElementById('eventRoomSelect');
  const roomColorSquare       = document.getElementById('roomColorSquare');
  const eventDescriptionField = document.getElementById('eventDescription');

  // Clear old <option> from the Room <select>
  eventRoomSelect.innerHTML = '';

  // Figure out which rooms are checked
  const roomsCheckboxBar = document.getElementById('roomsCheckboxBar');
  const checkboxes = roomsCheckboxBar.querySelectorAll('input[type="checkbox"]');
  const checkedRoomIds = Array.from(checkboxes).filter(ch => ch.checked).map(ch => ch.value);

  let defaultCalId = calendarId || (checkedRoomIds.length > 0 ? checkedRoomIds[0] : null);

  // Populate the <select>
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

  // If new => reset chips
  if (!eventId) {
    window.inviteChips = [];
    window.clearChipsUI();

    if (start) {
      eventStartField.value = window.toLocalDateTimeInput(new Date(start));
    } else {
      eventStartField.value = '';
    }
    if (end) {
      eventEndField.value = window.toLocalDateTimeInput(new Date(end));
    } else {
      eventEndField.value = '';
    }
  } else {
    // editing => keep existing times
    if (!eventStartField.value && start) {
      eventStartField.value = window.toLocalDateTimeInput(new Date(start));
    }
    if (!eventEndField.value && end) {
      eventEndField.value = window.toLocalDateTimeInput(new Date(end));
    }
  }

  // Pre-populate attendees
  if (attendees && attendees.length > 0) {
    attendees.forEach(email => {
      const existing = window.inviteChips.find(ch => ch.email === email);
      if (!existing) {
        const userObj = window.prefetchedUsers.find(u => u.email === email);
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

  // Force "Event Details" tab
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
   createEvent(...) / updateEvent(...) / deleteEvent(...)
   - CRUD calls to /api
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

// Expose main functions
window.initCalendar        = initCalendar;
window.openViewEventModal  = openViewEventModal;
window.openEventModal      = openEventModal;
window.createEvent         = createEvent;
window.updateEvent         = updateEvent;
window.deleteEvent         = deleteEvent;
