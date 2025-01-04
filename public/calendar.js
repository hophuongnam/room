/* ------------------------------------------------------------------
   calendar.js
   - Provides two FullCalendar configurations:
       1) "Multiple" => timeGridWeek with multiple event sources
       2) "Resource" => resourceTimeGridDay with each room as a row
   - Toggling is handled by window.switchCalendarView(...)
   - initCalendar() defaults to the "multiple" view.

   Make sure your index.html loads (in this order):
     <script src="https://cdn.jsdelivr.net/npm/fullcalendar@6.1.15/index.global.min.js"></script>
     <script src="https://cdn.jsdelivr.net/npm/@fullcalendar/timegrid@6.1.15/index.global.min.js"></script>
     <script src="https://cdn.jsdelivr.net/npm/@fullcalendar/resource@6.1.15/index.global.min.js"></script>
     <script src="https://cdn.jsdelivr.net/npm/@fullcalendar/resource-timegrid@6.1.15/index.global.min.js"></script>

   Then load main.js and this calendar.js in that order.
------------------------------------------------------------------ */

/* ------------------------------------------------------------------
   initCalendar()
   - Called by main.js after the page is ready and references are set.
   - Defaults to the "multiple" view.
------------------------------------------------------------------ */
function initCalendar() {
  switchCalendarView('multiple'); // default
}

/* ------------------------------------------------------------------
   switchCalendarView(viewMode)
   - Destroys any existing calendar instance (window.multiCalendar)
     if valid, then creates a new one for either "resource" or
     "multiple" mode, and calls .render().
------------------------------------------------------------------ */
window.switchCalendarView = function(viewMode) {
  // Defensive check: only call .destroy() if it’s actually a FullCalendar instance
  if (window.multiCalendar && typeof window.multiCalendar.destroy === 'function') {
    window.multiCalendar.destroy();
  }

  const multiCalendarEl = document.getElementById('multiCalendar');
  if (!multiCalendarEl) {
    console.error("Could not find #multiCalendar element in the DOM.");
    return;
  }

  if (viewMode === 'resource') {
    // ---------------------------
    // RESOURCE MODE
    // ---------------------------
    window.multiCalendar = new FullCalendar.Calendar(multiCalendarEl, {
      schedulerLicenseKey: 'GPL-My-Project-Is-Open-Source', // adjust if needed
      timeZone: 'local',
      height: 'auto',
      nowIndicator: true,
      slotMinTime: '08:00:00',
      slotMaxTime: '18:00:00',
      firstDay: 1,
      headerToolbar: {
        left: 'prev,next today',
        center: 'title',
        right: 'resourceTimeGridDay'
      },
      initialView: 'resourceTimeGridDay',
      editable: false, // set to true if you want drag in resource mode

      // Convert your known rooms array => resources
      resources: window.rooms.map(r => ({
        id: r.id,
        title: r.summary
      })),

      // For now, we don't show any events in resource view
      // Or adapt it to actually map events to resourceId.
      events(info, successCallback) {
        // Return empty => no events
        successCallback([]);
      }
    });

  } else {
    // ---------------------------
    // MULTIPLE MODE
    // ---------------------------
    window.multiCalendar = new FullCalendar.Calendar(multiCalendarEl, {
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
      unselectAuto: false,
      editable: true,
      eventResizableFromStart: true,

      selectAllow(selectInfo) {
        if (selectInfo.start < new Date()) {
          return false;
        }
        return true;
      },

      select(info) {
        const firstRoomId = getFirstCheckedRoomId();
        if (!firstRoomId) return;

        const color = window.roomColors[firstRoomId] || '#0d6efd';
        // highlight color
        setTimeout(() => {
          document.querySelectorAll('.fc-highlight').forEach(el => {
            el.style.backgroundColor = color;
          });
        }, 0);

        const dummyEvent = { id: 'dummy', source: { id: firstRoomId } };
        if (doesOverlap(dummyEvent, info.start, info.end, window.multiCalendar)) {
          window.showToast('Error', 'Time slot overlaps another event in that room.');
          window.multiCalendar.unselect();
          return;
        }

        openEventModal({
          calendarId: firstRoomId,
          start: info.start,
          end: info.end
        });
      },

      dateClick(info) {
        const start = info.date;
        const end   = new Date(start.getTime() + 30 * 60 * 1000);

        const firstRoomId = getFirstCheckedRoomId();
        if (!firstRoomId) return;

        if (start < new Date()) {
          window.showToast('Error', 'Cannot create an event in the past.');
          return;
        }

        const dummyEvent = { id: 'dummy', source: { id: firstRoomId } };
        if (doesOverlap(dummyEvent, start, end, window.multiCalendar)) {
          window.showToast('Error', 'Time slot overlaps another event in that room.');
          return;
        }

        openEventModal({
          calendarId: firstRoomId,
          start,
          end
        });
      },

      eventClick(clickInfo) {
        const calendarId = clickInfo.event.source?.id || null;
        if (calendarId) {
          openViewEventModal(clickInfo.event, calendarId);
        }
      },

      eventDrop(info) {
        const event   = info.event;
        const newStart= event.start;
        const newEnd  = event.end || new Date(newStart.getTime() + 30*60*1000);

        if (doesOverlap(event, newStart, newEnd, window.multiCalendar)) {
          window.showToast('Error', "This move overlaps another event. Reverting.");
          info.revert();
          return;
        }

        const roomId = event.source?.id;
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
            window.multiCalendar.getEventSourceById(roomId)?.refetch();
          } catch (err) {
            window.showError(`Failed to move event: ${err.message}`);
            info.revert();
          } finally {
            window.hideSpinner();
          }
        }, 0);
      },

      eventResize(info) {
        const event   = info.event;
        const newStart= event.start;
        const newEnd  = event.end;

        if (!newEnd) {
          info.revert();
          return;
        }

        if (doesOverlap(event, newStart, newEnd, window.multiCalendar)) {
          window.showToast('Error', "Resized event overlaps. Reverting.");
          info.revert();
          return;
        }

        const roomId = event.source?.id;
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
            window.multiCalendar.getEventSourceById(roomId)?.refetch();
          } catch (err) {
            window.showError(`Failed to resize event: ${err.message}`);
            info.revert();
          } finally {
            window.hideSpinner();
          }
        }, 0);
      },

      eventSources: []
    });
  }

  // Render the new instance
  window.multiCalendar.render();

  // In "multiple" mode, re-apply the checked rooms as event sources
  if (viewMode === 'multiple') {
    reapplyCheckedRoomSources();
  }
};

/*
  reapplyCheckedRoomSources():
  - Collect all checked rooms from #roomsCheckboxBar,
  - Add them as event sources to window.multiCalendar
*/
function reapplyCheckedRoomSources() {
  if (!window.multiCalendar) return;

  const roomsCheckboxBar = document.getElementById('roomsCheckboxBar');
  const checkboxes = roomsCheckboxBar.querySelectorAll('input[type="checkbox"]');
  const selectedIds = Array.from(checkboxes)
    .filter(ch => ch.checked)
    .map(ch => ch.value);

  window.multiCalendar.batchRendering(() => {
    window.multiCalendar.removeAllEventSources();

    selectedIds.forEach(roomId => {
      window.multiCalendar.addEventSource({
        id: roomId,
        events(fetchInfo, successCallback) {
          const data = window.allEventsMap[roomId] || [];
          successCallback(data);
        },
        color: window.roomColors[roomId] || '#333',
        textColor: '#fff'
      });
    });
  });
}

/* ------------------------------------------------------------------
   doesOverlap(movingEvent, newStart, newEnd, calendar)
   - Overlap logic from your existing code
------------------------------------------------------------------ */
function doesOverlap(movingEvent, newStart, newEnd, calendar) {
  const allEvents = calendar.getEvents();
  const newStartMs = newStart.getTime();
  const newEndMs   = newEnd.getTime();

  for (const ev of allEvents) {
    if (ev.id === movingEvent.id) continue;
    const evStart = ev.start?.getTime();
    const evEnd   = (ev.end || ev.start)?.getTime();

    // Overlap check
    if (evStart < newEndMs && evEnd > newStartMs) {
      if (sameRoomSource(movingEvent, ev)) {
        return true;
      }
    }
  }
  return false;
}

function sameRoomSource(evA, evB) {
  const srcIdA = evA.source?.id || '';
  const srcIdB = evB.source?.id || '';
  return (srcIdA === srcIdB);
}

/* ------------------------------------------------------------------
   getFirstCheckedRoomId()
   - returns the first checked room ID from #roomsCheckboxBar
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
   - from your existing code for viewing an event in a modal
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

  if (!calendarId) return;

  // Find the room’s name/color
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

  // Determine edit/delete perms
  const isLinked     = event.extendedProps?.is_linked === 'true';
  const creatorEmail = event.extendedProps?.organizer;
  let canEditOrDelete = true;

  if (isLinked) {
    canEditOrDelete = false;
  } else {
    // only if user is in attendees or is the creator
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

    const modalInstance = bootstrap.Modal.getInstance(viewEventModalEl);
    if (modalInstance) modalInstance.hide();
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
      // Refresh the source
      window.multiCalendar.getEventSourceById(calendarId)?.refetch();

      const modalInstance = bootstrap.Modal.getInstance(viewEventModalEl);
      if (modalInstance) modalInstance.hide();
      window.showToast("Deleted", "Event was successfully deleted.");
    } catch (err) {
      window.showError(`Failed to delete event: ${err.message}`);
    }
  };

  // Show the modal
  const bsModal = new bootstrap.Modal(viewEventModalEl);
  bsModal.show();
}

/* ------------------------------------------------------------------
   openEventModal(...)
   - Create/edit event logic
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

  // figure out which room is selected
  const roomsCheckboxBar = document.getElementById('roomsCheckboxBar');
  const checkboxes = roomsCheckboxBar.querySelectorAll('input[type="checkbox"]');
  const checkedRoomIds = Array.from(checkboxes).filter(ch => ch.checked).map(ch => ch.value);

  let defaultCalId = calendarId;
  if (!defaultCalId) {
    defaultCalId = (checkedRoomIds.length > 0)
      ? checkedRoomIds[0]
      : (window.rooms.length > 0 ? window.rooms[0].id : null);
  }

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

  // Fill hidden fields
  calendarIdField.value = defaultCalId || '';
  eventIdField.value    = eventId      || '';
  eventTitleField.value = title        || '';

  // For new events => reset chips
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
    // editing => keep existing chips
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
   - CRUD calls to your /api endpoints
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

// Expose main functions so main.js can call them
window.initCalendar        = initCalendar;
window.openViewEventModal  = openViewEventModal;
window.openEventModal      = openEventModal;
window.createEvent         = createEvent;
window.updateEvent         = updateEvent;
window.deleteEvent         = deleteEvent;
